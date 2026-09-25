// End to end, remote mode: one shared HTTP server, several clients.
// Covers API keys, OAuth tokens, scopes, tenant isolation, rate limits and
// deprecation. Uses a copy of the example manifest with a few test additions.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import YAML from "yaml";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createMockApi } from "../examples/mock-api/acme-mock-api.mjs";
import { buildServer, examplePath, writeManifest, httpClient, startHttpServer, sha256, structured, errorOf } from "./helpers.mjs";

const KEYS = { sales: "sales-team-key-123", northwind: "northwind-key-456", catalogOnly: "catalog-only-key-789" };
const ISSUER = "https://login.acme-outdoor.example.com";
const AUDIENCE = "https://mcp.acme-outdoor.example.com/mcp";

let api, server, mcpUrl, base, privateKey;
const clients = [];

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });

before(async () => {
  const m = YAML.parse(readFileSync(examplePath, "utf8"));
  m.access.apiKeys.push({ clientId: "catalog-only", keyHashEnv: "CATALOG_ONLY_KEY_SHA256", scopes: ["catalog:read"], rateLimit: { requestsPerMinute: 3 } });
  const qr = m.customTools.find((t) => t.name === "verify_qr_code");
  Object.assign(qr, { deprecated: true, replacedBy: "get_product_details" });
  m.customTools.find((t) => t.name === "generate_sales_report").longRunning.pollIntervalMs = 250;
  m.audit.sink = "stderr";
  m.prompts.find((p) => p.name === "compare_products").args.products.completeFrom = "search_products";
  const serverDir = buildServer(writeManifest(m));

  api = createMockApi();
  const apiPort = await api.listen();
  const { publicKey, privateKey: pk } = await generateKeyPair("RS256");
  privateKey = pk;
  api.setJwks({ keys: [{ ...(await exportJWK(publicKey)), kid: "test", alg: "RS256", use: "sig" }] });

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  mcpUrl = `${base}/mcp`;
  server = await startHttpServer(serverDir, {
    API_BASE_URL: `http://127.0.0.1:${apiPort}/v2`,
    ACME_API_KEY: "test-upstream-key",
    ACME_SALES_TEAM_KEY_SHA256: sha256(KEYS.sales),
    NORTHWIND_KEY_SHA256: sha256(KEYS.northwind),
    CATALOG_ONLY_KEY_SHA256: sha256(KEYS.catalogOnly),
    MCP_OAUTH_JWKS_URL: `http://127.0.0.1:${apiPort}/__jwks`,
  }, port);
});

after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  server?.child.kill();
  await api?.close();
});

const connect = async (token) => { const c = await httpClient(mcpUrl, token); clients.push(c); return c; };
const token = (claims, { audience = AUDIENCE, issuer = ISSUER, exp = "5m" } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(issuer).setAudience(audience).setSubject(claims.sub ?? "user-1").setIssuedAt().setExpirationTime(exp).sign(privateKey);
const rawPost = (headers = {}) => fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });

test("refuses requests without a valid key or token (no open endpoint)", async () => {
  let res = await rawPost();
  assert.equal(res.status, 401);
  assert.deepEqual((await res.json()).error.code, "unauthorized");
  assert.match(res.headers.get("www-authenticate"), /resource_metadata="https:\/\/mcp\.acme-outdoor\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/);
  res = await rawPost({ authorization: "Bearer wrong-key" });
  assert.equal(res.status, 401);
});

test("publishes OAuth protected-resource metadata (RFC 9728)", async () => {
  const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(meta.resource, AUDIENCE);
  assert.deepEqual(meta.authorization_servers, [ISSUER]);
  assert.ok(meta.scopes_supported.includes("quotes:write"));
});

test("each client only sees and calls what its scopes allow", async () => {
  const c = await connect(KEYS.catalogOnly);
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["get_product_details", "list_categories", "search_products", "verify_qr_code"]);
  const r = await c.callTool({ name: "create_quote", arguments: { customer_id: "C-1", items: [] } });
  assert.equal(errorOf(r).error.code, "forbidden");
  const prompts = (await c.listPrompts()).prompts.map((p) => p.name);
  assert.deepEqual(prompts, ["compare_products"], "prepare_quote needs quotes:write");
});

test("tenant isolation: a reseller's context overrides the customer id the AI sends", async () => {
  const c = await connect(KEYS.northwind);
  const r = await c.callTool({ name: "get_pricing", arguments: { product_id: "TB-100", quantity: 1, customer_id: "C-1001" } });
  assert.equal(structured(r).discountPercent, 10, "C-2044's discount, not C-1001's");
  assert.equal(api.requests.at(-1).body.customer, "C-2044");

  const q = await c.callTool({ name: "create_quote", arguments: { customer_id: "C-9999", items: [{ product_id: "TB-100", quantity: 1 }] } });
  assert.equal(structured(q).preview.body.customer, "C-2044");
});

test("a reseller is not asked for the customer id its connection fixes", async () => {
  const c = await connect(KEYS.northwind);
  const quote = (await c.listTools()).tools.find((t) => t.name === "create_quote");
  assert.ok(!("customer_id" in quote.inputSchema.properties), "customer_id hidden from the schema");
  assert.ok(!(quote.inputSchema.required ?? []).includes("customer_id"));
  assert.match(quote.description, /customer_id is always "C-2044"/);
  const q = await c.callTool({ name: "create_quote", arguments: { items: [{ product_id: "TB-100", quantity: 1 }] } });
  assert.equal(structured(q).preview.body.customer, "C-2044");

  const sales = await connect(KEYS.sales);
  const salesQuote = (await sales.listTools()).tools.find((t) => t.name === "create_quote");
  assert.ok("customer_id" in salesQuote.inputSchema.properties, "the sales team still chooses the customer");
});

test("the internal sales team is not bound to one customer", async () => {
  const c = await connect(KEYS.sales);
  const r = await c.callTool({ name: "get_pricing", arguments: { product_id: "TB-100", customer_id: "C-1001" } });
  assert.equal(structured(r).discountPercent, 5);
  assert.equal((await c.listTools()).tools.length, 10);
});

test("per-client rate limit returns rate_limited with a retry hint", async () => {
  const c = await connect(KEYS.catalogOnly);
  // 3 requests per minute: calls 1-3 pass, call 4 is refused. (The refused
  // create_quote in the scopes test is rejected before it counts.)
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await c.callTool({ name: "list_categories", arguments: {} }));
  const limited = results.filter((r) => r.isError).map(errorOf);
  assert.equal(limited.length, 1);
  assert.equal(results[3].isError, true, "the 4th call is the refused one");
  assert.equal(limited[0].error.code, "rate_limited");
  assert.equal(limited[0].error.retryable, true);
  assert.ok(limited[0].error.retryAfterMs > 0);
  const other = await connect(KEYS.sales);
  assert.equal((await other.callTool({ name: "list_categories", arguments: {} })).isError, undefined, "other clients are unaffected");
});

test("OAuth: valid token gets its scopes and tenant claim", async () => {
  const c = await connect(await token({ scope: "catalog:read pricing:read", acme_customer_id: "C-1001" }));
  const names = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("get_pricing") && !names.includes("create_quote"));
  const r = await c.callTool({ name: "get_pricing", arguments: { product_id: "TN-300", customer_id: "C-2044" } });
  assert.equal(api.requests.at(-1).body.customer, "C-1001");
  assert.equal(structured(r).discountPercent, 5);
});

test("OAuth: refuses wrong audience, expired tokens and tokens without the tenant claim", async () => {
  assert.equal((await rawPost({ authorization: `Bearer ${await token({ scope: "catalog:read", acme_customer_id: "C-1" }, { audience: "https://other" })}` })).status, 401);
  assert.equal((await rawPost({ authorization: `Bearer ${await token({ scope: "catalog:read", acme_customer_id: "C-1" }, { exp: Math.floor(Date.now() / 1000) - 60 })}` })).status, 401);
  assert.equal((await rawPost({ authorization: `Bearer ${await token({ scope: "catalog:read" })}` })).status, 403);
  assert.equal((await rawPost({ authorization: `Bearer ${await token({ scope: "catalog:read", acme_customer_id: "C-1" }, { issuer: "https://evil.example.com" })}` })).status, 401);
});

test("deprecated tools stay callable and point to the replacement", async () => {
  const c = await connect(KEYS.sales);
  const t = (await c.listTools()).tools.find((x) => x.name === "verify_qr_code");
  assert.match(t.description, /^Deprecated: use get_product_details instead\. /);
  assert.deepEqual(t._meta, { deprecated: true, replacedBy: "get_product_details" });
  const r = await c.callTool({ name: "verify_qr_code", arguments: { code: "ACME:TB-100:B1" } });
  assert.equal(structured(r).genuine, true);
});

test("prompt arguments autocomplete from a read tool", async () => {
  const c = await connect(KEYS.sales);
  const r = await c.complete({ ref: { type: "ref/prompt", name: "compare_products" }, argument: { name: "products", value: "boot" } });
  assert.deepEqual(r.completion.values, ["TB-100", "TB-200"]);
});

test("progress notifications also stream over HTTP", async () => {
  const c = await connect(KEYS.sales);
  const progress = [];
  const r = await c.callTool({ name: "generate_sales_report", arguments: { customer_id: "C-1001", from: "2026-01-01", to: "2026-03-31" } }, undefined, { onprogress: (p) => progress.push(p.progress) });
  assert.equal(structured(r).state, "complete");
  assert.deepEqual(progress, [0, 40, 100]);
});

test("the audit log names the real client for every call", async () => {
  const lines = server.stderr().split("\n").filter((l) => l.startsWith("[audit] ")).map((l) => JSON.parse(l.slice(8)));
  const ids = new Set(lines.map((e) => e.clientId));
  for (const id of ["catalog-only", "northwind-reseller", "acme-sales-team", "oauth:user-1"]) assert.ok(ids.has(id), id);
  assert.ok(lines.some((e) => e.clientId === "catalog-only" && e.errorCode === "forbidden"));
  assert.ok(lines.some((e) => e.errorCode === "rate_limited"));
  for (const k of Object.values(KEYS)) assert.ok(!server.stderr().includes(k), "API keys never logged");
});
