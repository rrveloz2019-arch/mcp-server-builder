// Calls the company's existing API: upstream auth, timeout, retries, upstream
// rate limit, and translation of HTTP failures into the fixed error codes.
import type { ServerConfig } from "./types.js";
import type { FilledRequest } from "./template.js";
import { ToolError } from "./errors.js";
import { RateLimiter } from "./rateLimit.js";

export interface UpstreamResult { status: number; data: unknown }

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new ToolError("upstream_error", `Server is missing the ${name} setting. Ask the administrator to set it.`, false);
  return v;
};

export class UpstreamClient {
  private token?: { value: string; expires: number };

  constructor(private cfg: ServerConfig["api"], private limiter: RateLimiter) {}

  private async oauthToken(): Promise<string> {
    const a = this.cfg.auth;
    if (a.type !== "oauth2_client_credentials") throw new Error("unreachable");
    if (this.token && this.token.expires > Date.now() + 30_000) return this.token.value;
    const form = new URLSearchParams({ grant_type: "client_credentials" });
    if (a.scopes?.length) form.set("scope", a.scopes.join(" "));
    const basic = Buffer.from(`${env(a.clientIdEnv)}:${env(a.clientSecretEnv)}`).toString("base64");
    const res = await fetch(a.tokenUrl, { method: "POST", headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" }, body: form });
    if (!res.ok) throw new ToolError("upstream_error", "Could not get an access token for the company API.", true, undefined, res.status);
    const json: any = await res.json();
    this.token = { value: json.access_token, expires: Date.now() + (Number(json.expires_in) || 300) * 1000 };
    return this.token.value;
  }

  private async authorize(url: URL, headers: Record<string, string>) {
    const a = this.cfg.auth;
    switch (a.type) {
      case "none": return;
      case "api_key":
        if (a.in === "header") headers[a.name] = env(a.valueEnv);
        else url.searchParams.set(a.name, env(a.valueEnv));
        return;
      case "bearer": headers.authorization = `Bearer ${env(a.tokenEnv)}`; return;
      case "basic": headers.authorization = `Basic ${Buffer.from(`${env(a.usernameEnv)}:${env(a.passwordEnv)}`).toString("base64")}`; return;
      case "oauth2_client_credentials": headers.authorization = `Bearer ${await this.oauthToken()}`; return;
    }
  }

  /**
   * Sends one request. Retries 5xx and timeouts twice with backoff, but only
   * when `retry` is true (reads and idempotent tools), so a write is never
   * submitted twice.
   */
  async send(req: FilledRequest, opts: { retry: boolean; signal?: AbortSignal }): Promise<UpstreamResult> {
    const attempts = opts.retry ? 3 : 1;
    let last: ToolError | undefined;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(200 * 2 ** (i - 1), opts.signal);
      try {
        return await this.once(req, opts.signal);
      } catch (err) {
        if (!(err instanceof ToolError) || !(err.code === "timeout" || (err.code === "upstream_error" && err.retryable))) throw err;
        last = err;
      }
    }
    throw last!;
  }

  private async once(req: FilledRequest, signal?: AbortSignal): Promise<UpstreamResult> {
    this.limiter.take("upstream", this.cfg.rateLimit, "the company API");
    // API_BASE_URL lets the same build point at a staging or test API.
    const url = new URL((process.env.API_BASE_URL ?? this.cfg.baseUrl).replace(/\/$/, "") + req.path);
    for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: "application/json", ...this.cfg.headers, ...req.headers };
    await this.authorize(url, headers);
    let body: string | undefined;
    if (req.body !== undefined && req.method !== "GET" && req.method !== "DELETE") {
      headers["content-type"] = "application/json";
      body = JSON.stringify(req.body);
    }

    const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, { method: req.method, headers, body, signal: combined });
    } catch (err: any) {
      if (signal?.aborted) throw new ToolError("cancelled", "The request was cancelled.");
      if (timeout.aborted) throw new ToolError("timeout", `The company API did not answer within ${this.cfg.timeoutMs} ms.`);
      throw new ToolError("upstream_error", "Could not reach the company API.", true);
    }

    const text = await res.text();
    let data: unknown = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }

    if (res.ok) return { status: res.status, data };
    const upstreamMsg = typeof data === "object" && data ? String((data as any).message ?? (data as any).error?.message ?? (data as any).error ?? "") : "";
    const detail = upstreamMsg ? `: ${upstreamMsg.slice(0, 200)}` : ".";
    const s = res.status;
    if (s === 404) throw new ToolError("not_found", `Not found${detail}`, false, undefined, s);
    if (s === 400 || s === 409 || s === 422) throw new ToolError("invalid_input", `The company API rejected the request${detail}`, false, undefined, s);
    if (s === 401 || s === 403) throw new ToolError("upstream_error", "The company API refused the server's credentials.", false, undefined, s);
    if (s === 429) {
      const ra = Number(res.headers.get("retry-after"));
      throw new ToolError("rate_limited", "The company API is busy. Try again shortly.", true, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined, s);
    }
    throw new ToolError("upstream_error", `The company API failed (HTTP ${s}).`, s >= 500, undefined, s);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ToolError("cancelled", "The request was cancelled."));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new ToolError("cancelled", "The request was cancelled.")); }, { once: true });
  });
}
