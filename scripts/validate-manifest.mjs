#!/usr/bin/env node
// Validates a builder manifest: first against the JSON Schema, then with
// cross-field checks the schema cannot express (placeholders, mappings,
// scopes, tenant context, references between sections).
// Usage: node scripts/validate-manifest.mjs <manifest.yaml> [more.yaml...]

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(path.join(root, "schema/manifest.schema.json"), "utf8"));
export const catalog = JSON.parse(readFileSync(path.join(root, "src/catalog/tools.json"), "utf8"));

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

const PLACEHOLDER = /\{((?:ctx\.)?[a-z_][a-z0-9_]*)\}/g;

function collectPlaceholders(value, out = new Set()) {
  if (typeof value === "string") for (const m of value.matchAll(PLACEHOLDER)) out.add(m[1]);
  else if (Array.isArray(value)) value.forEach((v) => collectPlaceholders(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectPlaceholders(v, out));
  return out;
}

const requestParts = (r) => (r ? [r.path, r.query, r.headers, r.body] : []);

// Normalizes standard and custom tools into one list.
export function allTools(manifest) {
  const tools = [];
  for (const [name, binding] of Object.entries(manifest.tools ?? {})) {
    const spec = catalog[name];
    tools.push({ ...binding, name, where: `tools.${name}`, kind: spec.kind, args: spec.args, scope: binding.scope ?? spec.scope, mapping: binding.response?.mapping ?? spec.mapping });
  }
  (manifest.customTools ?? []).forEach((t, i) => {
    tools.push({ ...t, where: `customTools[${i}] (${t.name})`, mapping: t.response?.mapping ?? "raw" });
  });
  return tools;
}

// Tenant context keys that are guaranteed for every client that can connect.
function contextKeys(manifest) {
  const sets = [];
  for (const k of manifest.access?.apiKeys ?? []) sets.push(new Set(Object.keys(k.context ?? {})));
  if (manifest.access?.oauth) sets.push(new Set(Object.keys(manifest.access.oauth.contextClaims ?? {})));
  return sets;
}

export function validateManifest(manifest, { baseDir = "." } = {}) {
  const errors = [];
  if (!validateSchema(manifest)) {
    for (const e of validateSchema.errors) errors.push(`schema: ${e.instancePath || "/"} ${e.message}`);
    return errors;
  }

  const tools = allTools(manifest);
  const toolNames = new Set();
  const mappings = manifest.mappings ?? {};
  const ctxSets = contextKeys(manifest);

  const checkMapping = (where, mapping) => {
    if (mapping && mapping !== "raw" && !mappings[mapping]) errors.push(`${where}: uses mapping "${mapping}" but mappings.${mapping} is not defined`);
  };
  const checkCtx = (where, used) => {
    for (const p of used) {
      if (!p.startsWith("ctx.")) continue;
      const key = p.slice(4);
      if (ctxSets.length === 0 || ctxSets.some((s) => !s.has(key))) {
        errors.push(`${where}: {${p}} must be set in the context of every API key client and in oauth.contextClaims`);
      }
    }
  };

  for (const t of tools) {
    if (toolNames.has(t.name)) errors.push(`${t.where}: tool name "${t.name}" is used more than once`);
    toolNames.add(t.name);

    const args = new Set(Object.keys(t.args));
    const used = collectPlaceholders(requestParts(t.request));
    for (const p of used) {
      if (!p.startsWith("ctx.") && !args.has(p)) errors.push(`${t.where}: placeholder {${p}} is not an argument (allowed: ${[...args].join(", ") || "none"})`);
    }
    for (const [argName, arg] of Object.entries(t.args)) {
      if (arg.required && argName !== "confirm" && !used.has(argName)) errors.push(`${t.where}: required argument {${argName}} is never sent to the API`);
    }
    checkCtx(t.where, used);
    checkMapping(t.where, t.mapping);
    if (["GET", "DELETE"].includes(t.request.method) && t.request.body) errors.push(`${t.where}: ${t.request.method} requests cannot have a body`);
    if (t.kind === "read" && t.requireConfirmation) errors.push(`${t.where}: requireConfirmation only applies to write or destructive tools`);

    if (t.longRunning) {
      const lr = t.longRunning;
      const statusUsed = collectPlaceholders([...requestParts(lr.statusRequest), ...requestParts(lr.resultRequest)]);
      for (const p of statusUsed) {
        if (p !== "job_id" && !p.startsWith("ctx.") && !args.has(p)) errors.push(`${t.where}.longRunning: placeholder {${p}} is not an argument or {job_id}`);
      }
      if (statusUsed.has("job_id") && !lr.jobIdPath) errors.push(`${t.where}.longRunning: {job_id} is used but jobIdPath is not set`);
    }
  }

  for (const t of tools) {
    if (t.replacedBy && !toolNames.has(t.replacedBy)) errors.push(`${t.where}: replacedBy "${t.replacedBy}" is not a defined tool`);
    if (t.replacedBy && !t.deprecated) errors.push(`${t.where}: replacedBy is set, so deprecated must be true`);
  }

  const resourceUris = new Set();
  (manifest.resources ?? []).forEach((r, i) => {
    const where = `resources[${i}] (${r.name})`;
    if (resourceUris.has(r.uri)) errors.push(`${where}: uri "${r.uri}" is used more than once`);
    resourceUris.add(r.uri);
    const uriVars = collectPlaceholders(r.uri);
    if (r.file) {
      if (uriVars.size) errors.push(`${where}: a file resource cannot have {placeholders} in its uri`);
      const resolved = path.resolve(baseDir, r.file);
      if (path.isAbsolute(r.file) || path.relative(path.resolve(baseDir), resolved).startsWith("..")) errors.push(`${where}: file "${r.file}" must be inside the manifest's folder`);
      else if (!existsSync(resolved)) errors.push(`${where}: file "${r.file}" not found next to the manifest`);
    } else {
      const used = collectPlaceholders(requestParts(r.request));
      for (const p of used) if (!p.startsWith("ctx.") && !uriVars.has(p)) errors.push(`${where}: placeholder {${p}} is not in the uri template`);
      for (const v of uriVars) if (!used.has(v)) errors.push(`${where}: uri variable {${v}} is never sent to the API`);
      checkCtx(where, used);
      checkMapping(where, r.response?.mapping);
      checkMapping(where, r.listResponse?.mapping);
      if (r.list && uriVars.size === 0) errors.push(`${where}: list only applies to uri templates with {placeholders}`);
    }
  });

  (manifest.prompts ?? []).forEach((p, i) => {
    const where = `prompts[${i}] (${p.name})`;
    const args = new Set(Object.keys(p.args ?? {}));
    const used = collectPlaceholders(p.template);
    for (const u of used) if (!args.has(u)) errors.push(`${where}: template uses {${u}} but it is not declared in args`);
    for (const [a, spec] of Object.entries(p.args ?? {})) {
      if (spec.required && !used.has(a)) errors.push(`${where}: required arg {${a}} is not used in the template`);
      if (spec.completeFrom && !toolNames.has(spec.completeFrom)) errors.push(`${where}: completeFrom "${spec.completeFrom}" is not a defined tool`);
    }
    for (const uri of p.embedResources ?? []) if (!resourceUris.has(uri)) errors.push(`${where}: embedResources "${uri}" is not a defined resource`);
  });

  const transports = manifest.server.transports ?? ["stdio"];
  if (transports.includes("http")) {
    const a = manifest.access ?? {};
    if (!(a.apiKeys?.length || a.oauth)) errors.push("access: the http transport needs access.apiKeys or access.oauth, so the endpoint is never open to anyone");
    if (a.oauth && !manifest.server.http?.publicUrl) errors.push("server.http.publicUrl: required when access.oauth is set (used in OAuth metadata)");
  }
  const clientIds = new Set();
  for (const k of manifest.access?.apiKeys ?? []) {
    if (clientIds.has(k.clientId)) errors.push(`access.apiKeys: clientId "${k.clientId}" is used more than once`);
    clientIds.add(k.clientId);
  }

  const audit = manifest.audit;
  if (audit?.sink === "file" && !audit.path) errors.push("audit.path: required when audit.sink is file");
  if (audit?.sink === "http" && !audit.url) errors.push("audit.url: required when audit.sink is http");

  return errors;
}

export function summarize(manifest) {
  const tools = allTools(manifest).filter((t) => t.enabled !== false);
  return {
    tools: tools.map((t) => t.name),
    resources: (manifest.resources ?? []).map((r) => r.name),
    prompts: (manifest.prompts ?? []).map((p) => p.name),
    clients: (manifest.access?.apiKeys ?? []).map((k) => k.clientId).concat(manifest.access?.oauth ? ["oauth"] : []),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("Usage: node scripts/validate-manifest.mjs <manifest.yaml> [...]");
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    const manifest = YAML.parse(readFileSync(file, "utf8"));
    const errors = validateManifest(manifest, { baseDir: path.dirname(file) });
    if (errors.length) {
      failed = true;
      console.log(`✗ ${file}`);
      for (const e of errors) console.log(`  - ${e}`);
    } else {
      const s = summarize(manifest);
      console.log(`✓ ${file}`);
      console.log(`  tools (${s.tools.length}): ${s.tools.join(", ")}`);
      console.log(`  resources (${s.resources.length}): ${s.resources.join(", ") || "none"}`);
      console.log(`  prompts (${s.prompts.length}): ${s.prompts.join(", ") || "none"}`);
      console.log(`  clients (${s.clients.length}): ${s.clients.join(", ") || "local only"}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
