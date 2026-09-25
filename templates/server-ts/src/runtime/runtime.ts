// Wires the pieces together and starts the chosen transport.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ClientIdentity, PromptDef, ResourceDef, ServerConfig, ToolDef } from "./types.js";
import { AuditLog } from "./audit.js";
import { ClientAuth, stdioIdentity } from "./auth.js";
import { UpstreamClient } from "./http.js";
import { RateLimiter } from "./rateLimit.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

export interface Runtime {
  config: ServerConfig;
  tools: ToolDef[];
  resources: ResourceDef[];
  prompts: PromptDef[];
  upstream: UpstreamClient;
  limiter: RateLimiter;
  audit: AuditLog;
  assetsDir: string;
}

export function createRuntime(config: ServerConfig, tools: ToolDef[], resources: ResourceDef[], prompts: PromptDef[]): Runtime {
  const limiter = new RateLimiter();
  const assetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets");
  return { config, tools, resources, prompts, limiter, upstream: new UpstreamClient(config.api, limiter), audit: new AuditLog(config.audit), assetsDir };
}

/** One MCP server per client: it only registers what that client's scopes allow. */
export function createServer(rt: Runtime, client: ClientIdentity): McpServer {
  const { server } = rt.config;
  const mcp = new McpServer({ name: server.name, version: server.version }, { instructions: server.instructions });
  registerTools(mcp, rt, client);
  registerResources(mcp, rt, client);
  registerPrompts(mcp, rt, client);
  return mcp;
}

function pickTransport(cfg: ServerConfig): "stdio" | "http" {
  const arg = process.argv.find((a) => a === "--http" || a === "--stdio")?.slice(2);
  const want = (arg ?? process.env.MCP_TRANSPORT ?? cfg.server.transports[0]) as "stdio" | "http";
  if (!cfg.server.transports.includes(want)) {
    process.stderr.write(`Transport "${want}" is not enabled in the manifest (enabled: ${cfg.server.transports.join(", ")}).\n`);
    process.exit(2);
  }
  return want;
}

async function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("Request body too large."), { status: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try { return text ? JSON.parse(text) : undefined; } catch { throw Object.assign(new Error("Body is not valid JSON."), { status: 400 }); }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

export async function startHttp(rt: Runtime): Promise<http.Server> {
  const cfg = rt.config;
  const auth = new ClientAuth(cfg);
  const mcpPath = cfg.server.http.path;
  const allScopes = [...new Set([...rt.tools, ...rt.resources, ...rt.prompts].map((x) => x.scope).filter((s): s is string => !!s))].sort();
  const metadataPaths = new Set(["/.well-known/oauth-protected-resource", `/.well-known/oauth-protected-resource${mcpPath}`]);
  const metadataUrl = cfg.server.http.publicUrl ? new URL("/.well-known/oauth-protected-resource" + mcpPath, cfg.server.http.publicUrl).href : undefined;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return sendJson(res, 200, { ok: true, name: cfg.server.name, version: cfg.server.version });
      if (req.method === "GET" && cfg.access.oauth && metadataPaths.has(url.pathname)) return sendJson(res, 200, auth.resourceMetadata(allScopes));
      if (url.pathname !== mcpPath) return sendJson(res, 404, { error: { code: "not_found", message: "Not found.", retryable: false } });
      if (req.method !== "POST") return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (this server is stateless: use POST)." }, id: null }, { allow: "POST" });

      const result = await auth.authenticate(req.headers.authorization);
      if (!result.ok) {
        const challenge = `Bearer error="${result.status === 401 ? "invalid_token" : "insufficient_scope"}"${metadataUrl && cfg.access.oauth ? `, resource_metadata="${metadataUrl}"` : ""}`;
        return sendJson(res, result.status, { error: { code: result.status === 401 ? "unauthorized" : "forbidden", message: result.reason, retryable: false } }, { "www-authenticate": challenge });
      }

      const body = await readBody(req);
      const mcp = createServer(rt, result.identity);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err: any) {
      if (!res.headersSent) sendJson(res, err?.status ?? 500, { jsonrpc: "2.0", error: { code: -32603, message: err?.status ? err.message : "Internal server error." }, id: null });
      if (!err?.status) process.stderr.write(`[http] ${err?.stack ?? err}\n`);
    }
  });

  const port = Number(process.env.PORT ?? cfg.server.http.port);
  const host = process.env.HOST ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  process.stderr.write(`${cfg.server.name} ${cfg.server.version} listening on http://${host}:${port}${mcpPath}\n`);
  return server;
}

export async function start(rt: Runtime): Promise<void> {
  if (pickTransport(rt.config) === "http") {
    await startHttp(rt);
  } else {
    const mcp = createServer(rt, stdioIdentity(rt.config));
    await mcp.connect(new StdioServerTransport());
    process.stderr.write(`${rt.config.server.name} ${rt.config.server.version} running on stdio\n`);
  }
}
