// End to end, local mode: generate the server from the unmodified example
// manifest, compile it, run it over stdio against the mock API, and drive it
// with the official MCP client.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMockApi } from "../examples/mock-api/acme-mock-api.mjs";
import { buildServer, examplePath, stdioClient, structured, errorOf } from "./helpers.mjs";

let api, client, serverDir, auditPath;

before(async () => {
  serverDir = buildServer(examplePath);
  api = createMockApi();
  const port = await api.listen();
  auditPath = path.join(mkdtempSync(path.join(os.tmpdir(), "mcpb-audit-")), "audit.jsonl");
  client = await stdioClient(serverDir, { API_BASE_URL: `http://127.0.0.1:${port}/v2`, ACME_API_KEY: "test-upstream-key", AUDIT_LOG_PATH: auditPath });
});

after(async () => {
  await client?.close();
  await api?.close();
});

const call = (name, args, opts) => client.callTool({ name, arguments: args }, undefined, opts);
const lastRequest = () => api.requests.at(-1);

test("server identifies itself with the manifest name and version", () => {
  assert.deepEqual(client.getServerVersion(), { name: "acme-outdoor-sales", version: "0.1.0" });
  assert.match(client.getInstructions(), /Search first/);
});

test("lists the 10 enabled tools with schemas and safety annotations", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["check_stock", "create_quote", "generate_sales_report", "get_order_status", "get_pricing", "get_product_details", "list_categories", "search_products", "send_quote_email", "verify_qr_code"]);
  assert.ok(!names.includes("create_order"), "create_order is disabled in the manifest");
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.equal(t.outputSchema.type, "object", t.name);
    assert.equal(t.annotations.openWorldHint, true);
  }
  const quote = tools.find((t) => t.name === "create_quote");
  assert.equal(quote.annotations.readOnlyHint, false);
  assert.deepEqual(quote.inputSchema.required.sort(), ["customer_id", "items"]);
  const search = tools.find((t) => t.name === "search_products");
  assert.equal(search.annotations.readOnlyHint, true);
  assert.equal(search.inputSchema.properties.limit.maximum, 50);
});

test("search_products returns mapped items only (internal fields dropped) and a cursor", async () => {
  const r = await call("search_products", { query: "boot", limit: 1 });
  assert.equal(r.isError, undefined);
  const s = structured(r);
  assert.deepEqual(s.items[0], { id: "TB-100", name: "TrailBlazer Hiking Boot", description: "Waterproof leather hiking boot.", category: "Footwear", price: 149, currency: "USD", url: "https://acme-outdoor.example.com/p/TB-100", imageUrl: "https://cdn.example.com/tb100.jpg" });
  assert.equal(s.nextCursor, "1");
  assert.deepEqual(lastRequest().query, { q: "boot", limit: "1" }, "empty placeholders are dropped");
  assert.deepEqual(JSON.parse(r.content[0].text), s, "text content mirrors structured content");
});

test("missing fields come back as null, so the shape never changes", async () => {
  const s = structured(await call("get_product_details", { product_id: "TB-200" }));
  assert.equal(s.imageUrl, null);
  assert.equal(Object.keys(s).length, 8);
});

test("errors use one fixed shape: not_found", async () => {
  const r = await call("get_product_details", { product_id: "NOPE" });
  assert.equal(r.isError, true);
  assert.deepEqual(errorOf(r), { error: { code: "not_found", message: "Not found: No product NOPE", retryable: false } });
});

test("errors use one fixed shape: invalid_input (bad value, unknown argument)", async () => {
  let r = await call("search_products", { query: "boot", limit: 500 });
  assert.equal(r.isError, true);
  assert.equal(errorOf(r).error.code, "invalid_input");
  assert.match(errorOf(r).error.message, /limit/);
  r = await call("search_products", { query: "boot", colour: "red" });
  assert.equal(errorOf(r).error.code, "invalid_input");
  r = await call("no_such_tool", {});
  assert.equal(errorOf(r).error.code, "not_found");
});

test("check_stock and get_pricing map list and record outputs", async () => {
  const stock = structured(await call("check_stock", { product_id: "TB-100" }));
  assert.deepEqual(stock.items[1], { productId: "TB-100", available: 0, location: "LAX", restockDate: "2026-10-15" });
  const price = structured(await call("get_pricing", { product_id: "TB-100", quantity: 3, customer_id: "C-1001" }));
  assert.deepEqual(price, { productId: "TB-100", unitPrice: 141.55, currency: "USD", quantity: 3, discountPercent: 5, total: 424.65 });
  assert.deepEqual(lastRequest().body, { sku: "TB-100", qty: 3, customer: "C-1001" }, "numbers keep their type in the body");
});

test("create_quote: first call is a preview that saves nothing; confirm=true submits", async () => {
  const before = api.requests.length;
  const args = { customer_id: "C-1001", items: [{ product_id: "TB-100", quantity: 2 }] };
  const preview = structured(await call("create_quote", args));
  assert.equal(preview.status, "preview");
  assert.deepEqual(preview.preview, { method: "POST", path: "/quotes", body: { customer: "C-1001", lines: [{ product_id: "TB-100", quantity: 2 }] } });
  assert.equal(api.requests.length, before, "no API call for a preview");

  const done = structured(await call("create_quote", { ...args, confirm: true }));
  assert.equal(done.status, "done");
  assert.match(done.result.id, /^Q-\d+$/);
  assert.equal(done.result.total, 283.1);
});

test("custom tools work: verify_qr_code and send_quote_email", async () => {
  const v = structured(await call("verify_qr_code", { code: "ACME:TB-100:B42" }));
  assert.deepEqual(v, { genuine: true, productId: "TB-100", batch: "B42", warrantyUntil: "2028-03-01" });
  const q = structured(await call("create_quote", { customer_id: "C-1001", items: [{ product_id: "TN-300", quantity: 1 }], confirm: true }));
  const sent = structured(await call("send_quote_email", { quote_id: q.result.id, message: "Thanks, Dana!", confirm: true }));
  assert.equal(sent.status, "done");
  assert.equal(sent.result.delivered, true);
});

test("long-running tool streams progress and returns the final report", async () => {
  const progress = [];
  const r = await call("generate_sales_report", { customer_id: "C-2044", from: "2026-01-01", to: "2026-06-30" }, { onprogress: (p) => progress.push(p), timeout: 30000 });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  const s = structured(r);
  assert.match(s.jobId, /^job-/);
  assert.equal(s.state, "complete");
  assert.equal(s.result.revenue, 18430.5);
  // The SDK client handles a response before notifications queued just ahead of it and then drops that
  // call's progress handler, so the final 100% can be lost when both arrive together. The server sends all three.
  assert.deepEqual(progress.map((p) => p.progress), [0, 40, 100].slice(0, Math.max(2, progress.length)));
  assert.equal(progress[0].total, 100);
});

test("resources: bundled file, templated API record, and browsing", async () => {
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri);
  assert.ok(uris.includes("docs://policies/returns"));
  assert.ok(uris.includes("catalog://products/TB-100"), "template instances are listed");
  const { resourceTemplates } = await client.listResourceTemplates();
  assert.equal(resourceTemplates[0].uriTemplate, "catalog://products/{product_id}");

  const policy = await client.readResource({ uri: "docs://policies/returns" });
  assert.equal(policy.contents[0].mimeType, "text/markdown");
  assert.match(policy.contents[0].text, /return/i);

  const rec = await client.readResource({ uri: "catalog://products/TN-300" });
  assert.equal(JSON.parse(rec.contents[0].text).name, "Summit 2-Person Tent");

  await assert.rejects(client.readResource({ uri: "catalog://products/NOPE" }), /Not found/);
});

test("prompts: list, fill arguments, embed resources", async () => {
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ["compare_products", "prepare_quote"]);
  const p = await client.getPrompt({ name: "compare_products", arguments: { products: "TB-100, TB-200" } });
  assert.equal(p.messages.length, 2);
  assert.equal(p.messages[0].content.type, "resource");
  assert.equal(p.messages[0].content.resource.uri, "docs://policies/returns");
  assert.match(p.messages[1].content.text, /Compare these products side by side: TB-100, TB-200\./);
  const q = await client.getPrompt({ name: "prepare_quote", arguments: { customer_id: "C-1001", items: "20 boots" } });
  assert.match(q.messages[0].content.text, /customer C-1001\. They want: 20 boots\./);
});

test("read tools retry upstream 5xx errors; write tools never retry", async () => {
  await fetch(`http://127.0.0.1:${api.server.address().port}/__fail?count=2`);
  const ok = await call("get_product_details", { product_id: "TB-100" });
  assert.equal(ok.isError, undefined, "succeeded on the third attempt");

  await fetch(`http://127.0.0.1:${api.server.address().port}/__fail?count=1`);
  const before = api.requests.length;
  const r = await call("create_quote", { customer_id: "C-1001", items: [{ product_id: "TB-100", quantity: 1 }], confirm: true });
  assert.deepEqual(errorOf(r), { error: { code: "upstream_error", message: "The company API failed (HTTP 503).", retryable: true } });
  assert.equal(api.requests.length, before + 1, "exactly one attempt");
});

test("audit log records every call as JSON Lines, with redaction", async () => {
  const events = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(events.length >= 10);
  for (const e of events) {
    assert.equal(e.clientId, "local-stdio");
    assert.ok(e.ts && e.type && e.name && e.outcome && typeof e.durationMs === "number");
  }
  const email = events.find((e) => e.name === "send_quote_email");
  assert.equal(email.args.message, "[redacted]");
  assert.ok(events.some((e) => e.outcome === "preview" && e.name === "create_quote"));
  assert.ok(events.some((e) => e.outcome === "error" && e.errorCode === "not_found"));
  assert.ok(events.some((e) => e.type === "resource") && events.some((e) => e.type === "prompt"));
  assert.ok(!readFileSync(auditPath, "utf8").includes("test-upstream-key"), "credentials never logged");
});
