// Starts a dashboard wired to the mock identity provider, and a tiny
// "browser" (cookie jar + manual redirects) to drive it like a real user.

import net from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { loadConfig } from "../src/config.mjs";
import { openDb } from "../src/db.mjs";
import { createApp } from "../src/app.mjs";
import { startMockOidc } from "./mock-oidc.mjs";

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });

export const ADMIN = { oid: randomUUID(), email: "rafael@builder.example", name: "Rafael (admin)" };
export const ALICE = { oid: randomUUID(), email: "alice@client-a.example", name: "Alice" };
export const BOB = { oid: randomUUID(), email: "bob@client-b.example", name: "Bob" };
export const VICTOR = { oid: randomUUID(), email: "victor@client-a.example", name: "Victor (viewer)" };
export const MALLORY = { oid: randomUUID(), email: "mallory@evil.example", name: "Mallory (never invited)" };

// Tests need a PostgreSQL server. Each dashboard gets its own new database,
// dropped again on close. Default: a local server on port 55432 (see dashboard/README.md).
export const TEST_PG = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";

async function createTestDatabase() {
  const name = `mcpb_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_PG });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(TEST_PG);
  url.pathname = `/${name}`;
  return {
    name, url: url.href,
    async drop() {
      const c = new pg.Client({ connectionString: TEST_PG });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export async function startDashboard(overrides = {}, { rateLimits } = {}) {
  const clientId = "test-client", clientSecret = randomBytes(24).toString("base64url");
  const idp = await startMockOidc({ clientId, clientSecret });
  const port = await freePort();
  const testDb = await createTestDatabase();
  const env = {
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    DASHBOARD_INSECURE_DEV: "1",
    OIDC_ISSUER: idp.issuer,
    OIDC_CLIENT_ID: clientId,
    OIDC_CLIENT_SECRET: clientSecret,
    DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ADMIN_OIDS: ADMIN.oid,
    DATABASE_URL: testDb.url,
    DATABASE_SSL: "off",
    ...overrides,
  };
  const config = loadConfig(env);
  const db = await openDb(config.database, config.dataKey);
  const logs = [];
  const log = { info: (m) => logs.push(m), error: (m) => logs.push(m) };
  const server = await createApp({ config, db, log, rateLimits });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const base = env.PUBLIC_URL;
  return {
    base, idp, db, config, logs, env, testDb,
    browser: () => new Browser(base, idp),
    close: async () => { server.close(); idp.close(); await db.close(); await testDb.drop(); },
  };
}

export class Browser {
  constructor(base, idp) { this.base = base; this.idp = idp; this.jar = new Map(); this.csrf = null; }
  cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  store(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = c.split(";");
      const [k, v] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (attrs.some((a) => /max-age=0/i.test(a)) || v === "") this.jar.delete(k); else this.jar.set(k, v);
    }
  }
  async raw(method, url, { body, headers = {}, json = true } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.cookie = this.cookieHeader();
    if (body !== undefined && json) h["content-type"] ??= "application/json";
    const res = await fetch(url.startsWith("http") ? url : this.base + url, { method, headers: h, body: body === undefined ? undefined : json ? JSON.stringify(body) : body, redirect: "manual" });
    this.store(res);
    return res;
  }
  // Full sign-in round trip through the identity provider. Returns the final redirect target.
  async signIn(user, { misbehave = null } = {}) {
    this.idp.state.nextUser = { tid: "test-tenant", ...user };
    this.idp.state.misbehave = misbehave;
    const start = await this.raw("GET", "/auth/login");
    const toIdp = start.headers.get("location");
    const fromIdp = await fetch(toIdp, { redirect: "manual" });
    this.lastCallback = fromIdp.headers.get("location");
    const done = await this.raw("GET", this.lastCallback);
    this.idp.state.misbehave = null;
    if (this.jar.size) {
      const me = await this.raw("GET", "/api/me");
      if (me.status === 200) this.me = await me.json(), this.csrf = this.me.csrf;
    }
    return done.headers.get("location");
  }
  async api(method, url, body, headers = {}) {
    const h = { origin: this.base, ...headers };
    if (method !== "GET" && this.csrf && !("x-csrf-token" in headers)) h["x-csrf-token"] = this.csrf;
    const res = await this.raw(method, url, { body, headers: h });
    const type = res.headers.get("content-type") ?? "";
    const data = type.includes("json") ? await res.json() : type.includes("zip") ? Buffer.from(await res.arrayBuffer()) : null;
    return { status: res.status, data, headers: res.headers };
  }
}
