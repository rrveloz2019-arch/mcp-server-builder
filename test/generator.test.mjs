// Unit tests for the generator and the version checker (no server started).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { generate, zodForArg, ManifestError } from "../src/generator/generate.mjs";
import { compareManifests } from "../src/generator/versioning.mjs";
import { buildServer, examplePath, root, writeManifest } from "./helpers.mjs";

const load = () => YAML.parse(readFileSync(examplePath, "utf8"));
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "mcpb-gen-"));
const cli = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [path.join(root, "src/cli/mcp-builder.mjs"), ...args], { encoding: "utf8", stdio: "pipe" }) }; }
  catch (e) { return { code: e.status, out: e.stdout + e.stderr }; }
};

test("argument specs become zod code", () => {
  assert.equal(zodForArg({ type: "integer", min: 1, max: 50, default: 10, description: "Max." }), 'z.number().int().min(1).max(50).describe("Max.").default(10)');
  assert.equal(zodForArg({ type: "string", required: true }), "z.string()");
  assert.equal(zodForArg({ type: "string", enum: ["a", "b"] }), 'z.enum(["a","b"]).optional()');
  assert.match(zodForArg({ type: "array", required: true, items: { sku: { type: "string", required: true } } }), /^z\.array\(z\.object\(\{\n\s+"sku": z\.string\(\),\n\s+\}\)\.strict\(\)\)$/);
});

test("generates one file per tool, resource and prompt, and skips disabled tools", () => {
  const out = tmp();
  const r = generate(examplePath, out);
  assert.equal(r.tools.length, 10);
  for (const f of ["src/tools/search_products.ts", "src/tools/verify_qr_code.ts", "src/resources/product_record.ts", "src/prompts/prepare_quote.ts", "src/runtime/tools.ts", "assets/docs/return-policy.md", ".env.example", "README.md", "manifest.yaml"]) {
    assert.ok(existsSync(path.join(out, f)), f);
  }
  assert.ok(!existsSync(path.join(out, "src/tools/create_order.ts")), "create_order is disabled");
  const env = readFileSync(path.join(out, ".env.example"), "utf8");
  assert.match(env, /^ACME_API_KEY=$/m);
  assert.match(env, /^NORTHWIND_KEY_SHA256=$/m);
  const pkg = JSON.parse(readFileSync(path.join(out, "package.json"), "utf8"));
  assert.equal(pkg.name, "acme-outdoor-sales");
  assert.equal(pkg.version, "0.1.0");
  const config = readFileSync(path.join(out, "src/config.ts"), "utf8");
  assert.ok(!config.includes("test-upstream-key") && !/sk_live/.test(config), "no secrets in generated code");
});

test("write tools without a confirm argument get one added", () => {
  const out = tmp();
  generate(examplePath, out);
  const src = readFileSync(path.join(out, "src/tools/send_quote_email.ts"), "utf8");
  assert.match(src, /"confirm": z\.boolean\(\)/);
  assert.match(src, /"requireConfirmation": true/);
});

test("regenerating into its own folder works; a foreign non-empty folder is refused", () => {
  const out = tmp();
  generate(examplePath, out);
  generate(examplePath, out);
  const foreign = tmp();
  writeFileSync(path.join(foreign, "notes.txt"), "mine");
  assert.throws(() => generate(examplePath, foreign), /not empty/);
});

test("an invalid manifest is refused with the validator's messages", () => {
  const m = load();
  m.tools.get_product_details.request.path = "/products/{sku}";
  assert.throws(() => generate(writeManifest(m), tmp()), (e) => e instanceof ManifestError && /\{sku\}/.test(e.message));
});

test("a resource file outside the manifest folder is refused", () => {
  const m = load();
  m.resources[1].file = "../../etc/passwd";
  assert.throws(() => generate(writeManifest(m), tmp()), /must be inside the manifest's folder/);
});

test("CLI: validate, generate and check-version", () => {
  assert.equal(cli("validate", examplePath).code, 0);
  const g = cli("generate", examplePath, "--out", tmp());
  assert.equal(g.code, 0);
  assert.match(g.out, /Generated acme-outdoor-sales 0\.1\.0/);
  assert.equal(cli("check-version", examplePath, examplePath).code, 0);
  assert.equal(cli("nonsense").code, 1);
});

// Versioning (SPEC section 12)
test("check-version: adding a tool needs a minor bump", () => {
  const a = load();
  const b = load();
  b.tools.create_order.enabled = true;
  let r = compareManifests(a, b);
  assert.equal(r.required, "minor");
  assert.equal(r.ok, false);
  b.server.version = "0.2.0";
  r = compareManifests(a, b);
  assert.equal(r.ok, true);
});

test("check-version: removing a tool without deprecating it first is blocked", () => {
  const a = load();
  const b = load();
  b.customTools = b.customTools.filter((t) => t.name !== "verify_qr_code");
  b.server.version = "1.0.0";
  const r = compareManifests(a, b);
  assert.equal(r.required, "major");
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /without being deprecated first/.test(p)));
});

test("check-version: the safe path (deprecate in a minor, remove in the next major) passes", () => {
  const v1 = load();
  const v2 = load();
  Object.assign(v2.customTools[0], { deprecated: true, replacedBy: "get_product_details" });
  v2.server.version = "0.2.0";
  assert.equal(compareManifests(v1, v2).ok, true);
  const v3 = structuredClone(v2);
  v3.customTools = v3.customTools.filter((t) => t.name !== "verify_qr_code");
  v3.server.version = "1.0.0";
  const r = compareManifests(v2, v3);
  assert.equal(r.ok, true, r.problems.join("; "));
  assert.equal(r.required, "major");
});

test("check-version: breaking argument and output changes need a major bump", () => {
  const a = load();
  const b = load();
  b.customTools[0].args.code.type = "integer";
  delete b.mappings.product.imageUrl;
  b.server.version = "0.1.1";
  const r = compareManifests(a, b);
  assert.equal(r.required, "major");
  assert.ok(r.changes.some((c) => /argument code changed type/.test(c.message)));
  assert.ok(r.changes.some((c) => /output field imageUrl removed/.test(c.message)));
  assert.ok(!r.ok);
});

test("Azure AD demo manifest is valid (multiple audiences, issuers and scope claims)", () => {
  assert.equal(cli("validate", path.join(root, "examples/acme-outdoor-azure.yaml")).code, 0);
  const out = tmp();
  const r = generate(path.join(root, "examples/acme-outdoor-azure.yaml"), out);
  assert.deepEqual(r.config.access.oauth.scopeClaim, ["roles", "scp"]);
  assert.equal(r.config.access.oauth.audience.length, 2);
  assert.ok(!readFileSync(path.join(out, ".env.example"), "utf8").includes("AZURE_CLIENT_SECRET"), "the server never needs the Azure secret");
});

test("a read custom tool returning a raw single record compiles", () => {
  const m = load();
  m.customTools = [{ name: "get_warranty", title: "Get warranty", description: "Look up the warranty record for one product by its id and return it as is.", kind: "read", scope: "catalog:read", args: { product_id: { type: "string", required: true } }, request: { method: "GET", path: "/warranty/{product_id}" }, response: { recordPath: "data", mapping: "raw" } }];
  const out = buildServer(writeManifest(m));
  assert.match(readFileSync(path.join(out, "src/tools/get_warranty.ts"), "utf8"), /output: z\.object\(\{\}\)\.catchall\(z\.unknown\(\)\)/);
});
