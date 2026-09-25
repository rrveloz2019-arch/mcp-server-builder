// Prompts: reusable task templates the client offers to the user (for
// example as slash commands). Arguments can autocomplete from a read tool.
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClientIdentity, PromptDef } from "./types.js";
import type { Runtime } from "./runtime.js";
import { asToolError } from "./errors.js";
import { fillRequest, valuesFor } from "./template.js";
import { allowed, shapeResponse } from "./tools.js";
import { protocolError, readResourceContents } from "./resources.js";

/** Suggests values for a prompt argument by running a read tool with what the user typed so far. */
async function complete(toolName: string, typed: string, rt: Runtime, client: ClientIdentity): Promise<string[]> {
  const def = rt.tools.find((t) => t.name === toolName);
  if (!def || def.kind !== "read" || !allowed(def.scope, client) || !typed) return [];
  const argName = Object.keys(def.input.shape).find((k) => !def.input.shape[k].safeParse(undefined).success) ?? "query";
  try {
    const parsed = def.input.safeParse({ [argName]: typed });
    if (!parsed.success) return [];
    const res = await rt.upstream.send(fillRequest(def.request, valuesFor(parsed.data as Record<string, unknown>, client.context)), { retry: false });
    const shaped = shapeResponse(res.data, def.response) as Record<string, unknown>;
    const records = Array.isArray(shaped.items) ? (shaped.items as Record<string, unknown>[]) : [shaped];
    return records.map((r) => r.id ?? r.name).filter((v): v is string | number => v !== null && v !== undefined).map(String).slice(0, 20);
  } catch {
    return [];
  }
}

export function registerPrompts(mcp: McpServer, rt: Runtime, client: ClientIdentity) {
  for (const def of rt.prompts) {
    if (!allowed(def.scope, client)) continue;
    const shape: Record<string, any> = {};
    for (const [name, a] of Object.entries(def.args)) {
      let s: any = z.string();
      if (a.description) s = s.describe(a.description);
      if (!a.required) s = s.optional();
      if (a.completeFrom) s = completable(s, (value: string) => complete(a.completeFrom!, value ?? "", rt, client));
      shape[name] = s;
    }

    mcp.registerPrompt(def.name, { title: def.title, description: def.description, argsSchema: shape }, async (args: Record<string, string | undefined>, extra: any): Promise<GetPromptResult> => {
      const started = Date.now();
      try {
        rt.limiter.take(`client:${client.rateKey}`, client.rateLimit);
        const values: Record<string, string> = {};
        for (const [k, v] of Object.entries(args)) if (v !== undefined) values[k] = v;
        for (const [k, v] of Object.entries(client.context)) if (k in def.args) values[k] = v;
        const text = def.template.replace(/\{([a-z_][a-z0-9_]*)\}/g, (_, k) => values[k] ?? "");

        const messages: GetPromptResult["messages"] = [];
        for (const uri of def.embedResources) {
          const res = rt.resources.find((r) => r.uri === uri);
          if (!res || !allowed(res.scope, client)) continue;
          const read = await readResourceContents(res, uri, {}, rt, client, extra?.signal);
          const c = read.contents[0] as { uri: string; mimeType?: string; text: string };
          messages.push({ role: "user", content: { type: "resource", resource: { uri: c.uri, mimeType: c.mimeType, text: c.text } } });
        }
        messages.push({ role: "user", content: { type: "text", text } });
        rt.audit.write({ clientId: client.clientId, type: "prompt", name: def.name, args: values, outcome: "ok", durationMs: Date.now() - started });
        return { description: def.description, messages };
      } catch (err) {
        const e = asToolError(err);
        rt.audit.write({ clientId: client.clientId, type: "prompt", name: def.name, args, outcome: "error", errorCode: e.code, durationMs: Date.now() - started });
        throw protocolError(e);
      }
    });
  }
}
