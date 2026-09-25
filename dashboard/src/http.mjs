// HTTP helpers: security headers, cookies, bounded JSON bodies, rate limits.

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

export function securityHeaders(res, { hsts }) {
  res.setHeader("content-security-policy", CSP);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("cache-control", "no-store");
  if (hsts) res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { secure, maxAgeSec }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
  return parts.join("; ");
}

export function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers["content-type"] ?? "");
    if (!type.startsWith("application/json")) return reject(new HttpError(415, "expected application/json"));
    let size = 0;
    const chunks = [];
    // Too large: answer 413 and discard the rest (never buffer it). The response
    // closes the connection; a client that keeps sending far past the limit is cut off.
    const tooLarge = () => {
      reject(Object.assign(new HttpError(413, "request too large"), { closeConnection: true }));
      chunks.length = 0;
      req.removeAllListeners("data");
      let drained = 0;
      req.on("data", (c) => { drained += c.length; if (drained > limit * 4) req.destroy(); });
      req.resume();
    };
    if (Number(req.headers["content-length"]) > limit) return tooLarge();
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) return tooLarge();
      chunks.push(c);
    });
    req.on("end", () => {
      if (size > limit) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new HttpError(400, "invalid JSON")); }
    });
    req.on("error", () => reject(new HttpError(400, "request aborted")));
  });
}

// Client address. Behind Azure App Service, the platform appends the real
// client address as the last X-Forwarded-For entry; earlier entries can be
// forged by the client, so only the last one is used.
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff.at(-1).replace(/:\d+$/, "");
  }
  return req.socket.remoteAddress ?? "unknown";
}

// Fixed-window counters, in memory (one instance). Returns seconds to wait, or 0.
export function rateLimiter({ limit, windowMs }) {
  const hits = new Map();
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v.reset <= t) hits.delete(k); }, windowMs).unref();
  return (key) => {
    const t = Date.now();
    let e = hits.get(key);
    if (!e || e.reset <= t) { e = { n: 0, reset: t + windowMs }; hits.set(key, e); }
    e.n++;
    return e.n > limit ? Math.ceil((e.reset - t) / 1000) : 0;
  };
}
