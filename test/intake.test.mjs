// Tests for the intake wizard's local API (src/intake/server.mjs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { startIntake } from "../src/intake/server.mjs";
import { examplePath, root } from "./helpers.mjs";

const outRoot = mkdtempSync(path.join(os.tmpdir(), "mcpb-intake-test-"));
const server = await startIntake({ port: 0, outRoot });
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const example = () => YAML.parse(readFileSync(examplePath, "utf8"));
const files = { "docs/return-policy.md": readFileSync(path.join(root, "examples/docs/return-policy.md"), "utf8") };
const post = async (p, body, headers = {}) => {
  const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test("serves the wizard page and the tool catalog", async () => {
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /MCP Server Intake/);
  const catalog = await (await fetch(base + "/api/catalog")).json();
  assert.deepEqual(Object.keys(catalog).length, 8);
});

test("the example manifest validates, and its YAML round-trips", async () => {
  const r = await post("/api/validate", { manifest: example(), files });
  assert.deepEqual(r.body.errors, []);
  assert.equal(r.body.summary.tools.length, 10);
  assert.deepEqual(YAML.parse(r.body.yaml), example());
});

test("problems come back from the real validator", async () => {
  const m = example();
  m.company.website = "not a url";
  const r = await post("/api/validate", { manifest: m, files });
  assert.ok(r.body.errors.some((e) => e.includes("/company/website")));
  const noFile = await post("/api/validate", { manifest: example(), files: {} });
  assert.ok(noFile.body.errors.some((e) => e.includes('file "docs/return-policy.md" not found')), "missing uploaded file is reported");
});

test("an invalid manifest is not saved or generated", async () => {
  const m = example();
  delete m.api.baseUrl;
  const r = await post("/api/generate", { manifest: m, files });
  assert.equal(r.body.saved, false);
  assert.ok(!existsSync(path.join(outRoot, "acme-outdoor-sales")));
});

test("generate saves manifest.yaml and writes the server next to it", async () => {
  const r = await post("/api/generate", { manifest: example(), files });
  assert.equal(r.body.generated, true, r.body.generateError);
  const dir = path.join(outRoot, "acme-outdoor-sales");
  assert.equal(r.body.manifestPath, path.join(dir, "manifest.yaml"));
  assert.ok(existsSync(path.join(dir, "docs/return-policy.md")));
  assert.ok(existsSync(path.join(dir, "server/src/tools/search_products.ts")));
  assert.equal(r.body.counts.tools, 10);
  // Regenerating over its own output works.
  assert.equal((await post("/api/generate", { manifest: example(), files })).body.generated, true);
});

test("file paths outside the manifest folder and cross-site requests are refused", async () => {
  const r = await post("/api/save", { manifest: example(), files: { "../escape.md": "x" } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /inside the manifest folder/);
  const x = await post("/api/validate", { manifest: example(), files }, { origin: "https://evil.example.com" });
  assert.equal(x.status, 403);
});
