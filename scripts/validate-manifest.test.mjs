import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import YAML from "yaml";
import { validateManifest, summarize } from "./validate-manifest.mjs";

const examplePath = fileURLToPath(new URL("../examples/acme-outdoor.yaml", import.meta.url));
const baseDir = path.dirname(examplePath);
const load = () => YAML.parse(readFileSync(examplePath, "utf8"));
const check = (m) => validateManifest(m, { baseDir });
const has = (m, text) => check(m).some((e) => e.includes(text));

test("example manifest is valid and uses every feature", () => {
  const m = load();
  assert.deepEqual(check(m), []);
  const s = summarize(m);
  assert.equal(s.tools.length, 10);
  assert.deepEqual(s.resources, ["product_record", "return_policy"]);
  assert.deepEqual(s.prompts, ["prepare_quote", "compare_products"]);
  assert.deepEqual(s.clients, ["acme-sales-team", "northwind-reseller", "oauth"]);
});

// Tools
test("rejects a secret written inline instead of an env var name", () => {
  const m = load();
  m.api.auth.valueEnv = "sk_live_abc123";
  assert.ok(has(m, "/api/auth"));
});

test("rejects an unknown placeholder", () => {
  const m = load();
  m.tools.get_product_details.request.path = "/products/{sku}";
  assert.ok(has(m, "{sku}"));
});

test("rejects a required argument that is never sent", () => {
  const m = load();
  m.tools.check_stock.request.path = "/inventory";
  assert.ok(has(m, "{product_id}"));
});

test("rejects an unknown standard tool name", () => {
  const m = load();
  m.tools.delete_everything = { request: { method: "POST", path: "/x" } };
  assert.ok(check(m).length > 0);
});

test("rejects a missing mapping", () => {
  const m = load();
  delete m.mappings.stock;
  assert.ok(has(m, "mappings.stock"));
});

test("rejects a vague custom tool description", () => {
  const m = load();
  m.customTools[0].description = "Verifies codes.";
  assert.ok(has(m, "/customTools/0/description"));
});

test("rejects a custom tool that reuses a standard tool name", () => {
  const m = load();
  m.customTools[0].name = "search_products";
  assert.ok(has(m, "used more than once"));
});

test("rejects confirmation on a read tool", () => {
  const m = load();
  m.customTools[0].requireConfirmation = true;
  assert.ok(has(m, "requireConfirmation only applies"));
});

test("rejects replacedBy pointing at a missing tool", () => {
  const m = load();
  m.tools.get_order_status.deprecated = true;
  m.tools.get_order_status.replacedBy = "get_order_status_v2";
  assert.ok(has(m, "replacedBy"));
});

test("rejects a long-running tool that uses {job_id} without jobIdPath", () => {
  const m = load();
  delete m.customTools[2].longRunning.jobIdPath;
  assert.ok(has(m, "jobIdPath"));
});

// Resources and prompts
test("rejects a resource whose uri variable is never sent", () => {
  const m = load();
  m.resources[0].request.path = "/products";
  assert.ok(has(m, "uri variable {product_id}"));
});

test("rejects a file resource whose file does not exist", () => {
  const m = load();
  m.resources[1].file = "docs/missing.md";
  assert.ok(has(m, "not found"));
});

test("rejects a prompt placeholder that is not declared", () => {
  const m = load();
  m.prompts[0].template += " Use {currency}.";
  assert.ok(has(m, "{currency}"));
});

test("rejects a prompt embedding an unknown resource", () => {
  const m = load();
  m.prompts[1].embedResources = ["docs://policies/shipping"];
  assert.ok(has(m, "docs://policies/shipping"));
});

// Access, tenancy, audit
test("rejects http transport with no client access configured", () => {
  const m = load();
  delete m.access.apiKeys;
  delete m.access.oauth;
  assert.ok(has(m, "http transport needs"));
});

test("rejects a {ctx.*} value that some client does not have", () => {
  const m = load();
  m.tools.get_order_status.request.query = { customer: "{ctx.customer_id}" };
  // acme-sales-team has no customer_id context, so a tenant-scoped call would be unbound.
  assert.ok(has(m, "{ctx.customer_id}"));
});

test("accepts {ctx.*} once every client defines it", () => {
  const m = load();
  m.tools.get_order_status.request.query = { customer: "{ctx.customer_id}" };
  m.access.apiKeys[0].context = { customer_id: "*" };
  assert.deepEqual(check(m), []);
});

test("rejects a malformed scope", () => {
  const m = load();
  m.access.apiKeys[0].scopes = ["everything"];
  assert.ok(has(m, "/access/apiKeys/0/scopes/0"));
});

test("rejects audit to file without a path", () => {
  const m = load();
  delete m.audit.path;
  assert.ok(has(m, "audit.path"));
});
