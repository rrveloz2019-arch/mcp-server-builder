#!/usr/bin/env node
// mcp-builder CLI.
//   mcp-builder validate <manifest.yaml>
//   mcp-builder generate <manifest.yaml> --out <folder>
//   mcp-builder check-version <old-manifest.yaml> <new-manifest.yaml>
//   mcp-builder intake [--port 4321] [--out-root intake-output]

import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { validateManifest, summarize } from "../../scripts/validate-manifest.mjs";
import { generate, ManifestError } from "../generator/generate.mjs";
import { compareManifests } from "../generator/versioning.mjs";
import { startIntake } from "../intake/server.mjs";

const USAGE = `Usage:
  mcp-builder validate <manifest.yaml>
  mcp-builder generate <manifest.yaml> --out <folder>
  mcp-builder check-version <old-manifest.yaml> <new-manifest.yaml>
  mcp-builder intake [--port 4321] [--out-root intake-output]`;

const load = (file) => YAML.parse(readFileSync(file, "utf8"));

function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest.splice(i, 2)[1] : undefined; };

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
    startIntake({ port, outRoot }).then((server) => {
      console.log(`Intake wizard: http://127.0.0.1:${server.address().port}/`);
      console.log(`Manifests and generated servers are saved under ${outRoot}`);
      console.log("Press Ctrl+C to stop.");
    });
    return 0;
  }

  return fail(USAGE);
}

function fail(message) {
  console.error(message);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
