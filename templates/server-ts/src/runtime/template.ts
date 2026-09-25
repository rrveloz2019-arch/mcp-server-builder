// Fills {placeholders} in a request template from tool arguments and the
// client's tenant context ({ctx.key}).
import type { RequestTemplate } from "./types.js";
import { ToolError } from "./errors.js";

const WHOLE = /^\{((?:ctx\.)?[a-z_][a-z0-9_]*)\}$/;
const ANY = /\{((?:ctx\.)?[a-z_][a-z0-9_]*)\}/g;

export type Values = Record<string, unknown>;

export function valuesFor(args: Record<string, unknown>, context: Record<string, string>, extra: Values = {}): Values {
  const v: Values = { ...args, ...extra };
  for (const [k, val] of Object.entries(context)) v[`ctx.${k}`] = val;
  return v;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "";

function substitute(text: string, values: Values, encode: boolean): string {
  return text.replace(ANY, (_, key) => {
    const v = values[key];
    if (isEmpty(v)) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return encode ? encodeURIComponent(s) : s;
  });
}

function fillBody(node: unknown, values: Values): unknown {
  if (typeof node === "string") {
    const whole = node.match(WHOLE);
    if (whole) return values[whole[1]]; // keeps the argument's type; undefined is dropped
    return substitute(node, values, false);
  }
  if (Array.isArray(node)) return node.map((n) => fillBody(n, values)).filter((n) => n !== undefined);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const filled = fillBody(v, values);
      if (filled !== undefined && filled !== null) out[k] = filled;
    }
    return out;
  }
  return node;
}

export interface FilledRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
}

export function fillRequest(t: RequestTemplate, values: Values): FilledRequest {
  for (const m of t.path.matchAll(ANY)) {
    if (isEmpty(values[m[1]])) throw new ToolError("invalid_input", `Missing value for "${m[1].replace(/^ctx\./, "")}".`);
  }
  const path = substitute(t.path, values, true);

  const query: Record<string, string> = {};
  for (const [k, raw] of Object.entries(t.query ?? {})) {
    if (typeof raw !== "string") { query[k] = String(raw); continue; }
    const whole = raw.match(WHOLE);
    if (whole) {
      const v = values[whole[1]];
      if (!isEmpty(v)) query[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
    } else {
      query[k] = substitute(raw, values, false);
    }
  }

  const headers: Record<string, string> = {};
  for (const [k, raw] of Object.entries(t.headers ?? {})) {
    const s = substitute(raw, values, false);
    if (s !== "") headers[k] = s;
  }

  const body = t.body === undefined ? undefined : fillBody(t.body, values);
  return { method: t.method, path, query, headers, body };
}
