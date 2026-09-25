// Tool list and call handlers. Registered on the low-level server so that
// every outcome (bad input, unknown tool, missing scope, upstream failure)
// uses the same error shape.
import { z } from "zod/v4";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientIdentity, ResponseBinding, ToolDef } from "./types.js";
import type { Runtime } from "./runtime.js";
import { ToolError, asToolError, errorResult } from "./errors.js";
import { applyFields, getPath } from "./map.js";
import { fillRequest, valuesFor } from "./template.js";
import { sleep } from "./http.js";

export const allowed = (scope: string | undefined, client: ClientIdentity) => !scope || client.scopes.has(scope);

const jsonSchemaCache = new WeakMap<object, Record<string, unknown>>();
function jsonSchema(schema: z.ZodType, io: "input" | "output"): Tool["inputSchema"] {
  let s = jsonSchemaCache.get(schema);
  if (!s) {
    s = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Record<string, unknown>;
    delete s.$schema;
    jsonSchemaCache.set(schema, s);
  }
  return s as Tool["inputSchema"];
}

export function describeTool(t: ToolDef): Tool {
  const tool: Tool = {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: jsonSchema(t.input, "input"),
    outputSchema: jsonSchema(t.output, "output") as Tool["outputSchema"],
    annotations: {
      title: t.title,
      readOnlyHint: t.kind === "read",
      destructiveHint: t.kind === "destructive",
      idempotentHint: t.kind === "read" || t.idempotent,
      openWorldHint: true,
    },
  };
  if (t.deprecated) tool._meta = { deprecated: true, ...(t.replacedBy ? { replacedBy: t.replacedBy } : {}) };
  return tool;
}

/** Shapes one API response into the tool's fixed output. */
export function shapeResponse(data: unknown, r: ResponseBinding): Record<string, unknown> {
  if (r.itemsPath) {
    const raw = getPath(data, r.itemsPath);
    const items = Array.isArray(raw) ? raw.map((x) => applyFields(x, r.fields)) : [];
    const out: Record<string, unknown> = { items };
    const cursor = r.nextCursorPath ? getPath(data, r.nextCursorPath) : undefined;
    if (cursor !== undefined && cursor !== null && cursor !== "") out.nextCursor = String(cursor);
    return out;
  }
  return applyFields(getPath(data, r.recordPath), r.fields);
}

function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.length ? i.path.join(".") : "arguments"}: ${i.message}`).join("; ");
}

function ok(structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}

export function registerTools(mcp: McpServer, rt: Runtime, client: ClientIdentity) {
  const visible = rt.tools.filter((t) => allowed(t.scope, client));
  mcp.server.registerCapabilities({ tools: { listChanged: false } });
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visible.map(describeTool) }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const started = Date.now();
    const name = request.params.name;
    const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
    let upstreamStatus: number | undefined;
    let auditArgs: unknown = rawArgs;
    try {
      const def = rt.tools.find((t) => t.name === name);
      if (!def) throw new ToolError("not_found", `Unknown tool "${name}".`);
      if (!allowed(def.scope, client)) throw new ToolError("forbidden", `This client is not allowed to use "${name}" (needs scope ${def.scope}).`);
      rt.limiter.take(`client:${client.rateKey}`, client.rateLimit);

      // Tenant isolation: a client's context value always wins over what the AI sent.
      const args: Record<string, unknown> = { ...rawArgs };
      for (const [k, v] of Object.entries(client.context)) if (k in def.input.shape) args[k] = v;
      const parsed = def.input.safeParse(args);
      if (!parsed.success) throw new ToolError("invalid_input", zodMessage(parsed.error));
      const input = parsed.data as Record<string, unknown>;
      auditArgs = input;

      const values = valuesFor(input, client.context);
      const req = fillRequest(def.request, values);

      if (def.kind !== "read" && def.requireConfirmation && input.confirm !== true) {
        const preview = { status: "preview", message: `Nothing was saved. Show this preview to the user and call ${name} again with confirm=true only after they approve.`, preview: { method: req.method, path: req.path, ...(Object.keys(req.query).length ? { query: req.query } : {}), ...(req.body !== undefined ? { body: req.body } : {}) } };
        rt.audit.write({ clientId: client.clientId, type: "tool", name, args: auditArgs, outcome: "preview", durationMs: Date.now() - started });
        return ok(preview);
      }

      const retry = def.kind === "read" || def.idempotent;
      const first = await rt.upstream.send(req, { retry, signal: extra.signal });
      upstreamStatus = first.status;

      let structured: Record<string, unknown>;
      if (def.longRunning) {
        structured = await runJob(def, first.data, values, rt, extra);
      } else if (def.shape === "write") {
        structured = { status: "done", result: shapeResponse(first.data, def.response) };
      } else {
        structured = shapeResponse(first.data, def.response);
      }
      rt.audit.write({ clientId: client.clientId, type: "tool", name, args: auditArgs, outcome: "ok", durationMs: Date.now() - started, upstreamStatus, requestId: String(extra.requestId) });
      return ok(structured);
    } catch (err) {
      const e = asToolError(err);
      if (!(err instanceof ToolError)) process.stderr.write(`[${name}] ${(err as Error)?.stack ?? err}\n`);
      rt.audit.write({ clientId: client.clientId, type: "tool", name, args: auditArgs, outcome: "error", errorCode: e.code, durationMs: Date.now() - started, upstreamStatus: e.upstreamStatus ?? upstreamStatus, requestId: String(extra.requestId) });
      return errorResult(e);
    }
  });
}

/** Polls a background job, streaming progress until it finishes. */
async function runJob(def: ToolDef, startData: unknown, values: Record<string, unknown>, rt: Runtime, extra: any): Promise<Record<string, unknown>> {
  const lr = def.longRunning!;
  const jobIdRaw = lr.jobIdPath ? getPath(startData, lr.jobIdPath) : undefined;
  const jobId = jobIdRaw === undefined || jobIdRaw === null ? null : String(jobIdRaw);
  if (lr.jobIdPath && jobId === null) throw new ToolError("upstream_error", "The company API did not return a job id.");
  const jobValues = { ...values, job_id: jobId };
  const progressToken = extra._meta?.progressToken;
  const deadline = Date.now() + lr.timeoutMs;
  let lastProgress = -1;

  for (;;) {
    const status = await rt.upstream.send(fillRequest(lr.statusRequest, jobValues), { retry: true, signal: extra.signal });
    const state = String(getPath(status.data, lr.statusPath) ?? "");
    const pct = lr.progressPath ? Number(getPath(status.data, lr.progressPath)) : NaN;
    if (progressToken !== undefined && Number.isFinite(pct) && pct > lastProgress) {
      lastProgress = pct;
      await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: pct, total: 100, message: `${def.title}: ${state} (${pct}%)` } });
    }
    if (lr.doneValues.includes(state)) {
      const final = lr.resultRequest ? await rt.upstream.send(fillRequest(lr.resultRequest, jobValues), { retry: true, signal: extra.signal }) : status;
      return { jobId, state, result: shapeResponse(final.data, def.response) };
    }
    if (lr.failedValues?.includes(state)) throw new ToolError("upstream_error", `${def.title} failed (job state "${state}").`);
    if (Date.now() + lr.pollIntervalMs > deadline) throw new ToolError("timeout", `${def.title} did not finish within ${Math.round(lr.timeoutMs / 1000)} s${jobId ? ` (job ${jobId})` : ""}.`);
    await sleep(lr.pollIntervalMs, extra.signal);
  }
}
