// Reads and checks the dashboard's settings. Fails closed: a missing or weak
// setting stops the server at start-up instead of running insecurely.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ConfigError extends Error {}

export function loadConfig(env = process.env) {
  const problems = [];
  const need = (name) => {
    const v = env[name]?.trim();
    if (!v) problems.push(`${name} is required`);
    return v;
  };

  const publicUrl = need("PUBLIC_URL")?.replace(/\/+$/, "");
  const insecureDev = env.DASHBOARD_INSECURE_DEV === "1";
  if (publicUrl && !publicUrl.startsWith("https://")) {
    const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(publicUrl);
    if (!(insecureDev && local)) problems.push("PUBLIC_URL must use https:// (http is only allowed for localhost with DASHBOARD_INSECURE_DEV=1)");
  }

  const issuer = need("OIDC_ISSUER");
  if (issuer && !issuer.startsWith("https://") && !insecureDev) problems.push("OIDC_ISSUER must use https://");
  const clientId = need("OIDC_CLIENT_ID");
  const clientSecret = need("OIDC_CLIENT_SECRET");

  // 32-byte key, base64. Encrypts manifests at rest; kept outside the database.
  const keyB64 = need("DATA_ENCRYPTION_KEY");
  let dataKey;
  if (keyB64) {
    dataKey = Buffer.from(keyB64, "base64");
    if (dataKey.length !== 32) problems.push("DATA_ENCRYPTION_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32)");
  }

  // Admins are identified by their Entra object id (oid), which cannot be changed by the user.
  const adminOids = (env.ADMIN_OIDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!adminOids.length) problems.push("ADMIN_OIDS is required (comma-separated Entra object ids of the admins)");
  for (const oid of adminOids) if (!UUID.test(oid)) problems.push(`ADMIN_OIDS: "${oid}" is not an object id (GUID)`);

  const idleMin = Number(env.SESSION_IDLE_MINUTES ?? 60), maxHours = Number(env.SESSION_MAX_HOURS ?? 8);
  if (!(idleMin >= 5 && idleMin <= 24 * 60)) problems.push("SESSION_IDLE_MINUTES must be a number from 5 to 1440");
  if (!(maxHours >= 1 && maxHours <= 24 * 7)) problems.push("SESSION_MAX_HOURS must be a number from 1 to 168");

  if (problems.length) throw new ConfigError(`Dashboard configuration is not safe to start:\n  - ${problems.join("\n  - ")}`);

  const url = new URL(publicUrl);
  return {
    publicUrl,
    secureCookies: url.protocol === "https:",
    insecureDev,
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? (insecureDev ? "127.0.0.1" : "0.0.0.0"),
    trustProxy: env.TRUST_PROXY === "1",
    dbPath: env.DB_PATH ?? "data/dashboard.db",
    oidc: { issuer, clientId, clientSecret, redirectUri: `${publicUrl}/auth/callback`, scope: "openid profile email" },
    dataKey,
    adminOids: new Set(adminOids.map((s) => s.toLowerCase())),
    session: { idleMs: idleMin * 60_000, absoluteMs: maxHours * 3_600_000 },
  };
}
