#!/usr/bin/env node
// mcp-builder CLI.
//   mcp-builder validate <manifest.yaml>
//   mcp-builder generate <manifest.yaml> --out <folder>
//   mcp-builder check-version <old-manifest.yaml> <new-manifest.yaml>
//   mcp-builder init [folder] [--example]
//   mcp-builder intake [--port 4321] [--out-root intake-output]
//   mcp-builder mock-api [port]

import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { validateManifest, summarize } from "../../scripts/validate-manifest.mjs";
import { generate, ManifestError } from "../generator/generate.mjs";
import { compareManifests } from "../generator/versioning.mjs";
import { startIntake } from "../intake/server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

const USAGE = `mcp-builder ${version}

Usage:
  mcp-builder init [folder] [--example]      Create a starter manifest.yaml (--example: the full Acme example)
  mcp-builder validate <manifest.yaml>       Check a manifest and list what it exposes
  mcp-builder generate <manifest.yaml> --out <folder>
                                             Generate the TypeScript MCP server
  mcp-builder check-version <old.yaml> <new.yaml>
                                             Compare two manifests and check the version bump
  mcp-builder intake [--port 4321] [--out-root intake-output]
                                             Open a web form that writes, validates and generates a manifest
  mcp-builder mock-api [port]                Run the demo Acme API (default port 4010)
  mcp-builder --version`;

const load = (file) => {
  if (!existsSync(file)) throw new Error(`✗ File not found: ${file}`);
  return YAML.parse(readFileSync(file, "utf8"));
};

async function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest.splice(i, 2)[1] : undefined; };
  const bool = (name) => { const i = rest.indexOf(name); if (i >= 0) rest.splice(i, 1); return i >= 0; };

  if (cmd === "--version" || cmd === "-v") {
    console.log(version);
    return 0;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(USAGE);
    return 0;
  }

  if (cmd === "init") {
    const example = bool("--example");
    const dir = rest[0] ?? ".";
    const dest = path.join(dir, "manifest.yaml");
    if (existsSync(dest)) return fail(`✗ ${dest} already exists. Choose another folder.`);
    mkdirSync(dir, { recursive: true });
    if (example) {
      cpSync(path.join(root, "examples/acme-outdoor.yaml"), dest);
      cpSync(path.join(root, "examples/docs"), path.join(dir, "docs"), { recursive: true });
    } else {
      cpSync(path.join(root, "templates/starter/manifest.yaml"), dest);
    }
    console.log(`✓ Created ${dest}${example ? ` and ${path.join(dir, "docs")}/` : ""}`);
    console.log(`\nNext steps:\n  1. Edit ${dest} to describe your API (it already works with: mcp-builder mock-api)\n  2. mcp-builder validate ${dest}\n  3. mcp-builder generate ${dest} --out <server-folder>`);
    return 0;
  }

  if (cmd === "mock-api") {
    const { createMockApi } = await import("../../examples/mock-api/acme-mock-api.mjs");
    const key = process.env.ACME_API_KEY ?? "test-upstream-key";
    const port = await createMockApi({ apiKey: key }).listen(Number(rest[0] ?? 4010));
    console.log(`Mock Acme API on http://127.0.0.1:${port}/v2 (X-Api-Key: ${key}). Press Ctrl+C to stop.`);
    return undefined;
  }

  if (cmd === "validate") {
    const [file] = rest;
    if (!file) return fail(USAGE);
    const m = load(file);
    const errors = validateManifest(m, { baseDir: path.dirname(file) });
    if (errors.length) return fail(`✗ ${file}\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    const s = summarize(m);
    console.log(`✓ ${file}\n  tools (${s.tools.length}): ${s.tools.join(", ")}\n  resources (${s.resources.length}): ${s.resources.join(", ") || "none"}\n  prompts (${s.prompts.length}): ${s.prompts.join(", ") || "none"}\n  clients (${s.clients.length}): ${s.clients.join(", ") || "local only"}`);
    return 0;
  }

  if (cmd === "generate") {
    const out = flag("--out");
    const [file] = rest;
    if (!file || !out) return fail(USAGE);
    try {
      const r = generate(file, out);
      console.log(`✓ Generated ${r.config.server.name} ${r.config.server.version} in ${out}`);
      console.log(`  ${r.tools.length} tools, ${r.resources.length} resources, ${r.prompts.length} prompts`);
      for (const w of r.warnings) console.log(`  ! ${w}`);
      console.log(`\nNext steps:\n  1. cd ${out}\n  2. npm install\n  3. npm run build\n  4. cp .env.example .env   (then fill in the values)\n  5. npm run start:stdio${r.config.server.transports.includes("http") ? "   or   npm run start:http" : ""}`);
      return 0;
    } catch (err) {
      return fail(err instanceof ManifestError ? err.message : `✗ ${err.message}`);
    }
  }

  if (cmd === "check-version") {
    const [oldFile, newFile] = rest;
    if (!oldFile || !newFile) return fail(USAGE);
    const r = compareManifests(load(oldFile), load(newFile));
    console.log(`${r.ok ? "✓" : "✗"} ${r.from} → ${r.to} (needs: ${r.required}, got: ${r.actual})`);
    for (const c of r.changes) console.log(`  [${c.level}] ${c.message}`);
    for (const p of r.problems) console.log(`  ✗ ${p}`);
    return r.ok ? 0 : 1;
  }

  if (cmd === "intake") {
    const port = Number(flag("--port") ?? 4321);
    const outRoot = path.resolve(flag("--out-root") ?? "intake-output");
    const server = await startIntake({ port, outRoot });
    console.log(`Intake wizard: http://127.0.0.1:${server.address().port}/`);
    console.log(`Manifests and generated servers are saved under ${outRoot}`);
    console.log("Press Ctrl+C to stop.");
    return undefined;
  }

  return fail(USAGE);
}

function fail(message) {
  console.error(message);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => { if (code !== undefined) process.exitCode = code; },
  (err) => { process.exitCode = fail(err.message); },
);
