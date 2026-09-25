// Token bucket rate limiter. One bucket per key (client id, or "upstream").
import type { RateLimitConfig } from "./types.js";
import { ToolError } from "./errors.js";

interface Bucket { tokens: number; updated: number }

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  /** Takes one token or throws rate_limited with a retry hint. */
  take(key: string, limit: RateLimitConfig | undefined, who = "this client"): void {
    if (!limit) return;
    const capacity = limit.burst ?? limit.requestsPerMinute;
    const perMs = limit.requestsPerMinute / 60_000;
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: capacity, updated: now };
    b.tokens = Math.min(capacity, b.tokens + (now - b.updated) * perMs);
    b.updated = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      const retryAfterMs = Math.ceil((1 - b.tokens) / perMs);
      throw new ToolError("rate_limited", `Rate limit reached for ${who} (${limit.requestsPerMinute} requests per minute). Try again shortly.`, true, retryAfterMs);
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
  }
}
