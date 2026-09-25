// Test helpers: generate + compile a server from a manifest, start the mock
// API, and connect real MCP clients to the generated server.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync, cpSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generate } from "../src/generator/generate.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const examplePath = path.join(root, "examples/acme-outdoor.yaml");
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Writes a manifest object (plus the example's docs folder) to a temp dir, returns its path. */
export function writeManifest(manifest) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mcpb-manifest-"));
  cpSync(path.join(root, "examples/docs"), path.join(dir, "docs"), { recursive: true });
  const file = path.join(dir, "manifest.yaml");
  writeFileSync(file, YAML.stringify(manifest));
  return file;
}

/** Generates and type-checks/compiles a server. Returns its folder. */
export function buildServer(manifestPath) {
  const out = mkdtempSync(path.join(os.tmpdir(), "mcpb-server-"));
  generate(manifestPath, out);
  symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "dir");
  execFileSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", out], { stdio: "pipe" });
  return out;
}

export async function stdioClient(serverDir, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(serverDir, "dist/index.js"), "--stdio"], env: { PATH: process.env.PATH, ...env }, stderr: "pipe" });
  const client = new Client({ name: "e2e-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

export async function httpClient(url, token) {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} } });
  const client = new Client({ name: "e2e-test-http", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** Starts the generated server over HTTP and waits until it answers. */
export async function startHttpServer(serverDir, env, port) {
  const child = spawn(process.execPath, [path.join(serverDir, "dist/index.js"), "--http"], { env: { PATH: process.env.PATH, PORT: String(port), ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return { child, stderr: () => stderr }; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server did not start:\n${stderr}`);
}

export const structured = (r) => r.structuredContent;

/** The fixed error body of a failed tool call ({ error: { code, message, retryable } }). */
export const errorOf = (r) => {
  if (!r.isError) throw new Error(`expected an error, got ${JSON.stringify(r)}`);
  return JSON.parse(r.content[0].text);
};
