// One error shape for every tool, resource and prompt:
//   { error: { code, message, retryable, retryAfterMs? } }
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ErrorCode =
  | "not_found"
  | "invalid_input"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "upstream_error"
  | "timeout"
  | "limit_exceeded"
  | "confirmation_required"
  | "cancelled";

const RETRYABLE: Record<ErrorCode, boolean> = {
  not_found: false,
  invalid_input: false,
  unauthorized: false,
  forbidden: false,
  rate_limited: true,
  upstream_error: false,
  timeout: true,
  limit_exceeded: false,
  confirmation_required: false,
  cancelled: false,
};

export class ToolError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public retryable: boolean = RETRYABLE[code],
    public retryAfterMs?: number,
    /** HTTP status from the company API, for the audit log only. */
    public upstreamStatus?: number,
  ) {
    super(message);
  }

  toJSON() {
    const error: Record<string, unknown> = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.retryAfterMs !== undefined) error.retryAfterMs = this.retryAfterMs;
    return { error };
  }
}

export function asToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  // Never leak stack traces or internal details to the client.
  return new ToolError("upstream_error", "Unexpected server error.", false);
}

export function errorResult(err: unknown): CallToolResult {
  const e = asToolError(err);
  const body = e.toJSON();
  // The error JSON goes in the text content only: MCP clients check any
  // structuredContent against the tool's outputSchema, even on errors.
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
}
