// Resources: data the AI can read without calling a tool. Backed by a bundled
// file or by an API request (fixed URI or URI template).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError, type ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClientIdentity, ResourceDef } from "./types.js";
import type { Runtime } from "./runtime.js";
import { asToolError } from "./errors.js";
import { fillRequest, valuesFor } from "./template.js";
import { shapeResponse, allowed } from "./tools.js";

const PROTOCOL_CODE: Record<string, number> = { not_found: -32002, invalid_input: ErrorCode.InvalidParams, forbidden: ErrorCode.InvalidRequest };

/** Converts a ToolError into a protocol error that carries the same fixed error shape in `data`. */
export function protocolError(err: unknown): McpError {
  const e = asToolError(err);
  return new McpError(PROTOCOL_CODE[e.code] ?? ErrorCode.InternalError, e.message, e.toJSON());
}

export async function readResourceContents(def: ResourceDef, uri: string, vars: Record<string, unknown>, rt: Runtime, client: ClientIdentity, signal?: AbortSignal): Promise<ReadResourceResult> {
  if (def.file) {
    const text = await readFile(path.join(rt.assetsDir, def.file), "utf8");
    return { contents: [{ uri, mimeType: def.mimeType, text }] };
  }
  // Tenant isolation: context values override URI variables of the same name.
  const values = valuesFor({ ...vars }, client.context);
  for (const [k, v] of Object.entries(client.context)) if (k in values) values[k] = v;
  const res = await rt.upstream.send(fillRequest(def.request!, values), { retry: true, signal });
  const data = shapeResponse(res.data, def.response ?? {});
  return { contents: [{ uri, mimeType: def.mimeType, text: JSON.stringify(data) }] };
}

export function registerResources(mcp: McpServer, rt: Runtime, client: ClientIdentity) {
  for (const def of rt.resources) {
    if (!allowed(def.scope, client)) continue;
    const meta = { title: def.title, description: def.description, mimeType: def.mimeType };

    const read = async (uri: URL, vars: Record<string, unknown>, extra: { signal?: AbortSignal; requestId?: unknown }) => {
      const started = Date.now();
      const flat: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(vars)) flat[k] = Array.isArray(v) ? v[0] : v;
      try {
        rt.limiter.take(`client:${client.rateKey}`, client.rateLimit);
        const out = await readResourceContents(def, uri.href, flat, rt, client, extra.signal);
        rt.audit.write({ clientId: client.clientId, type: "resource", name: def.name, args: { uri: uri.href }, outcome: "ok", durationMs: Date.now() - started });
        return out;
      } catch (err) {
        const e = asToolError(err);
        rt.audit.write({ clientId: client.clientId, type: "resource", name: def.name, args: { uri: uri.href }, outcome: "error", errorCode: e.code, upstreamStatus: e.upstreamStatus, durationMs: Date.now() - started });
        throw protocolError(e);
      }
    };

    if (!def.uri.includes("{")) {
      mcp.registerResource(def.name, def.uri, meta, (uri, extra) => read(uri, {}, extra));
      continue;
    }

    const vars = [...def.uri.matchAll(/\{([a-z_][a-z0-9_]*)\}/g)].map((m) => m[1]);
    const list = def.list
      ? async (extra: { signal?: AbortSignal }) => {
          try {
            rt.limiter.take(`client:${client.rateKey}`, client.rateLimit);
            const res = await rt.upstream.send(fillRequest(def.list!, valuesFor({}, client.context)), { retry: true, signal: extra.signal });
            const { items } = shapeResponse(res.data, def.listResponse ?? { itemsPath: "" }) as { items?: Record<string, unknown>[] };
            return {
              resources: (items ?? []).flatMap((item) => {
                let uri = def.uri;
                for (const v of vars) {
                  const val = item[v] ?? (vars.length === 1 ? item.id : undefined);
                  if (val === undefined || val === null) return [];
                  uri = uri.replace(`{${v}}`, encodeURIComponent(String(val)));
                }
                return [{ uri, name: String(item.name ?? uri), mimeType: def.mimeType }];
              }),
            };
          } catch (err) {
            throw protocolError(err);
          }
        }
      : undefined;
    mcp.registerResource(def.name, new ResourceTemplate(def.uri, { list }), meta, (uri, v, extra) => read(uri, v, extra));
  }
}
