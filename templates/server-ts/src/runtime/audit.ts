// Audit log: one JSON event per tool call, resource read and prompt fetch.
// Fields in redactFields are replaced with "[redacted]". Credentials and
// auth headers never reach this module.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./types.js";

export interface AuditEvent {
  clientId: string;
  type: "tool" | "resource" | "prompt";
  name: string;
  args?: unknown;
  outcome: "ok" | "error" | "preview";
  errorCode?: string;
  durationMs: number;
  upstreamStatus?: number;
  requestId?: string;
}

function redact(value: unknown, fields: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => redact(v, fields));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = fields.has(k) ? "[redacted]" : redact(v, fields);
    return out;
  }
  return value;
}

export class AuditLog {
  private redactFields: Set<string>;
  private filePath?: string;

  constructor(private cfg: ServerConfig["audit"]) {
    this.redactFields = new Set(cfg.redactFields);
    if (cfg.enabled && cfg.sink === "file") {
      // Relative paths are resolved from the server's own folder, not the current folder.
      const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
      this.filePath = path.resolve(packageRoot, process.env.AUDIT_LOG_PATH ?? cfg.path ?? "logs/audit.jsonl");
      mkdirSync(path.dirname(this.filePath), { recursive: true });
    }
  }

  write(e: AuditEvent): void {
    if (!this.cfg.enabled) return;
    const event: Record<string, unknown> = { ts: new Date().toISOString(), ...e };
    if (!this.cfg.includeArguments) delete event.args;
    else if (event.args !== undefined) event.args = redact(event.args, this.redactFields);
    const line = JSON.stringify(event);
    try {
      if (this.cfg.sink === "file") appendFileSync(this.filePath!, line + "\n");
      else if (this.cfg.sink === "http") {
        fetch(this.cfg.url!, { method: "POST", headers: { "content-type": "application/json" }, body: line }).catch(() => {
          process.stderr.write(`[audit] could not deliver event: ${line}\n`);
        });
      } else process.stderr.write(`[audit] ${line}\n`); // stdout is reserved for the MCP protocol on stdio
    } catch (err) {
      process.stderr.write(`[audit] write failed: ${(err as Error).message}\n`);
    }
  }
}
