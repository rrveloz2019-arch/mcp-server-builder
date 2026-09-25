// End to end, Azure AD demo: builds the server from examples/acme-outdoor-azure.yaml
// and signs in with tokens shaped exactly like Azure AD (Microsoft Entra ID)
// v2 and v1 access tokens. Signing keys come from a local stand-in for the
// tenant's key endpoint, so this test needs no Azure secret or network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createMockApi } from "../examples/mock-api/acme-mock-api.mjs";
import { buildServer, root, httpClient, startHttpServer } from "./helpers.mjs";

const TENANT = "e8c9f1fa-4f30-41cc-b2bc-1e9fe8607b5a";
const CLIENT = "a676142a-7299-4189-a3ae-12c60fe37306";
const V2_ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const V1_ISSUER = `https://sts.windows.net/${TENANT}/`;

let api, server, mcpUrl, base, privateKey;
const clients = [];
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });

before(async () => {
  const serverDir = buildServer(path.join(root, "examples/acme-outdoor-azure.yaml"));
  api = createMockApi();
  const apiPort = await api.listen();
  const { publicKey, privateKey: pk } = await generateKeyPair("RS256");
  privateKey = pk;
  // Azure publishes RSA keys without an "alg" field; mimic that.
  api.setJwks({ keys: [{ ...(await exportJWK(publicKey)), kid: "azure-test-key", use: "sig" }] });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  mcpUrl = `${base}/mcp`;
  server = await startHttpServer(serverDir, { API_BASE_URL: `http://127.0.0.1:${apiPort}/v2`, ACME_API_KEY: "test-upstream-key", MCP_OAUTH_JWKS_URL: `http://127.0.0.1:${apiPort}/__jwks`, AUDIT_LOG_PATH: path.join(serverDir, "audit.jsonl") }, port);
});

after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  server?.child.kill();
  await api?.close();
});

const azureToken = (claims, { issuer = V2_ISSUER, audience = CLIENT } = {}) =>
  new SignJWT({ tid: TENANT, oid: "11111111-2222-3333-4444-555555555555", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "azure-test-key", typ: "JWT" })
    .setIssuer(issuer).setAudience(audience).setSubject("azure-subject").setIssuedAt().setExpirationTime("5m").sign(privateKey);
const connect = async (token) => { const c = await httpClient(mcpUrl, token); clients.push(c); return c; };
const status = async (token) => (await fetch(mcpUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status;

test("advertises the Azure AD tenant as the authorization server", async () => {
  const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.deepEqual(meta.authorization_servers, [V2_ISSUER]);
});

test("v2 token with app roles: sees and calls exactly what its roles allow", async () => {
  const c = await connect(await azureToken({ ver: "2.0", azp: CLIENT, roles: ["catalog:read", "pricing:read"] }));
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["get_pricing", "get_product_details", "list_categories", "search_products", "verify_qr_code"]);
  const r = await c.callTool({ name: "get_pricing", arguments: { product_id: "TB-100", customer_id: "C-1001" } });
  assert.equal(r.structuredContent.discountPercent, 5, "staff sign-ins are not bound to one customer");
});

test("v1 token with delegated scopes (scp) is also accepted", async () => {
  const c = await connect(await azureToken({ ver: "1.0", appid: CLIENT, scp: "catalog:read" }, { issuer: V1_ISSUER, audience: `api://${CLIENT}` }));
  const names = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("search_products") && !names.includes("get_pricing"));
});

test("refuses tokens from another tenant or for another app", async () => {
  assert.equal(await status(await azureToken({ roles: ["catalog:read"] }, { issuer: "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0" })), 401);
  assert.equal(await status(await azureToken({ roles: ["catalog:read"] }, { audience: "00000000-0000-0000-0000-000000000000" })), 401);
});

test("a valid token without any granted role sees nothing", async () => {
  const c = await connect(await azureToken({ ver: "2.0", azp: CLIENT }));
  assert.equal((await c.listTools()).tools.length, 0);
});
