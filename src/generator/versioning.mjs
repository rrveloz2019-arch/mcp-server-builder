// Compares two manifests and says which semver bump the change needs
// (SPEC section 12). Breaking changes must go through deprecation first:
// a tool can only be removed after a release where it was marked deprecated.

import { normalize } from "./generate.mjs";

const parse = (v) => v.split(".").map(Number);
const LEVEL = { none: 0, patch: 1, minor: 2, major: 3 };

export function actualBump(from, to) {
  const [a, b] = [parse(from), parse(to)];
  if (b[0] !== a[0]) return b[0] > a[0] ? "major" : "downgrade";
  if (b[1] !== a[1]) return b[1] > a[1] ? "minor" : "downgrade";
  if (b[2] !== a[2]) return b[2] > a[2] ? "patch" : "downgrade";
  return "none";
}

export function compareManifests(oldManifest, newManifest) {
  const before = normalize(oldManifest);
  const after = normalize(newManifest);
  const changes = [];
  const add = (level, message) => changes.push({ level, message });

  const oldTools = new Map(before.tools.map((t) => [t.name, t]));
  const newTools = new Map(after.tools.map((t) => [t.name, t]));

  for (const [name, t] of oldTools) {
    const n = newTools.get(name);
    if (!n) {
      add("major", t.deprecated ? `tool ${name} removed (was deprecated)` : `tool ${name} removed without being deprecated first; mark it deprecated with replacedBy in a minor release, then remove it in the next major`);
      if (!t.deprecated) changes[changes.length - 1].blocked = true;
      continue;
    }
    for (const [arg, spec] of Object.entries(t.args)) {
      const ns = n.args[arg];
      if (!ns) add("major", `tool ${name}: argument ${arg} removed`);
      else if (ns.type !== spec.type) add("major", `tool ${name}: argument ${arg} changed type ${spec.type} → ${ns.type}`);
      else if (ns.required && !spec.required) add("major", `tool ${name}: argument ${arg} became required`);
    }
    for (const [arg, spec] of Object.entries(n.args)) {
      if (!t.args[arg]) add(spec.required ? "major" : "minor", `tool ${name}: ${spec.required ? "required" : "optional"} argument ${arg} added`);
    }
    const oldFields = Object.keys(t.response.fields ?? {});
    const newFields = new Set(Object.keys(n.response.fields ?? {}));
    for (const f of oldFields) if (!newFields.has(f)) add("major", `tool ${name}: output field ${f} removed`);
    if (t.shape !== n.shape) add("major", `tool ${name}: output shape changed ${t.shape} → ${n.shape}`);
    if (!t.deprecated && n.deprecated) add("minor", `tool ${name} deprecated${n.replacedBy ? ` (use ${n.replacedBy})` : ""}`);
    if (t.description !== n.description) add("patch", `tool ${name}: description changed`);
  }
  for (const name of newTools.keys()) if (!oldTools.has(name)) add("minor", `tool ${name} added`);

  for (const [kind, key] of [["resources", "uri"], ["prompts", "name"]]) {
    const o = new Set(before[kind].map((x) => x[key]));
    const n = new Set(after[kind].map((x) => x[key]));
    for (const x of o) if (!n.has(x)) add("major", `${kind.slice(0, -1)} ${x} removed`);
    for (const x of n) if (!o.has(x)) add("minor", `${kind.slice(0, -1)} ${x} added`);
  }

  const required = changes.reduce((lvl, c) => (LEVEL[c.level] > LEVEL[lvl] ? c.level : lvl), "none");
  const from = before.config.server.version;
  const to = after.config.server.version;
  const actual = actualBump(from, to);
  const problems = [];
  if (actual === "downgrade") problems.push(`server.version went backwards (${from} → ${to})`);
  else if (LEVEL[actual] < LEVEL[required]) problems.push(`these changes need a ${required} version bump, but ${from} → ${to} is ${actual === "none" ? "no bump" : `a ${actual} bump`}`);
  for (const c of changes.filter((c) => c.blocked)) problems.push(c.message);
  return { from, to, required, actual, changes, problems, ok: problems.length === 0 };
}
