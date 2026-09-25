// Security tests for the hosted dashboard. Each test is an attack or a
// failure case, run against the real server with the mock identity provider.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import YAML from "yaml";
import { ConfigError, loadConfig } from "../src/config.mjs";
import { findSecrets } from "../src/secrets-scan.mjs";
import { sha256 } from "../src/crypto.mjs";
import { startDashboard, ADMIN, ALICE, BOB, VICTOR, MALLORY } from "./helpers.mjs";

const example = YAML.parse(readFileSync(new URL("../../examples/acme-outdoor.yaml", import.meta.url), "utf8"));
const policy = readFileSync(new URL("../../examples/docs/return-policy.md", import.meta.url), "utf8");
const MARKER = "Zebra Confidential Supply Co";

let d, admin, alice, bob, victor, wsA, wsB, manifestA;

before(async () => {
  // Shared instance with high limits so the many sign-ins below are not throttled;
  // the rate-limit tests start their own instance with the production limits.
  d = await startDashboard({}, { rateLimits: { auth: 10_000, anon: 10_000, generate: 10_000 } });
  admin = d.browser();
  await admin.signIn(ADMIN);
  wsA = (await admin.api("POST", "/api/admin/workspaces", { name: "Client A" })).data;
  wsB = (await admin.api("POST", "/api/admin/workspaces", { name: "Client B" })).data;
  await admin.api("POST", `/api/admin/workspaces/${wsA.id}/invites`, { email: ALICE.email, role: "editor" });
  await admin.api("POST", `/api/admin/workspaces/${wsA.id}/invites`, { email: VICTOR.email, role: "viewer" });
  await admin.api("POST", `/api/admin/workspaces/${wsB.id}/invites`, { email: BOB.email, role: "editor" });
  alice = d.browser(); await alice.signIn(ALICE);
  bob = d.browser(); await bob.signIn(BOB);
  victor = d.browser(); await victor.signIn(VICTOR);
  const m = { ...structuredClone(example), company: { ...example.company, name: MARKER } };
  manifestA = (await alice.api("POST", `/api/workspaces/${wsA.id}/manifests`, { manifest: m, files: { "docs/return-policy.md": policy } })).data;
});
after(() => d.close());

// ---------- configuration ----------
test("config: refuses to start without an encryption key, with http in production, or without admins", () => {
  const good = { PUBLIC_URL: "https://mcp.example.com", OIDC_ISSUER: "https://login.microsoftonline.com/e8c9f1fa-4f30-41cc-b2bc-1e9fe8607b5a/v2.0", OIDC_CLIENT_ID: "x", OIDC_CLIENT_SECRET: "y", DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"), ADMIN_OIDS: ADMIN.oid };
  assert.ok(loadConfig(good));
  assert.throws(() => loadConfig({ ...good, DATA_ENCRYPTION_KEY: "" }), ConfigError);
  assert.throws(() => loadConfig({ ...good, DATA_ENCRYPTION_KEY: randomBytes(16).toString("base64") }), /32 random bytes/);
  assert.throws(() => loadConfig({ ...good, PUBLIC_URL: "http://mcp.example.com" }), /https/);
  assert.throws(() => loadConfig({ ...good, PUBLIC_URL: "http://mcp.example.com", DASHBOARD_INSECURE_DEV: "1" }), /localhost/);
  assert.throws(() => loadConfig({ ...good, ADMIN_OIDS: "" }), /ADMIN_OIDS/);
  assert.throws(() => loadConfig({ ...good, ADMIN_OIDS: "rafael@example.com" }), /not an object id/);
  assert.throws(() => loadConfig({ ...good, OIDC_CLIENT_SECRET: "" }), /OIDC_CLIENT_SECRET/);
});

// ---------- headers ----------
test("headers: strict CSP, no framing, no sniffing, no caching", async () => {
  for (const p of ["/", "/api/me", "/app.js"]) {
    const res = await fetch(d.base + p);
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/, "no unsafe-inline scripts");
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
  const page = await (await fetch(d.base + "/")).text();
  assert.ok(!/<script>|\son[a-z]+=|style="/i.test(page), "page has no inline script, handlers or styles");
  for (const f of ["../public/app.js", "../../src/ui/wizard.js"]) {
    const js = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!/style="|\bon(click|change|input|load)=/.test(js), `${f} renders no inline styles or handlers`);
  }
});

// ---------- authentication ----------
test("auth: every API route refuses requests without a session", async () => {
  const anon = d.browser();
  const routes = [["GET", "/api/me"], ["GET", "/api/catalog"], ["GET", `/api/workspaces/${wsA.id}/manifests`], ["GET", `/api/workspaces/${wsA.id}/manifests/${manifestA.id}`],
    ["POST", `/api/workspaces/${wsA.id}/manifests/${manifestA.id}/generate`], ["GET", "/api/admin/overview"], ["POST", "/api/admin/workspaces"], ["POST", "/auth/logout"]];
  for (const [method, url] of routes) {
    const r = await anon.api(method, url, method === "GET" ? undefined : {});
    assert.equal(r.status, 401, `${method} ${url}`);
    assert.deepEqual(Object.keys(r.data), ["error"], "no data leaks in the error");
  }
});

test("auth: a forged or guessed session cookie is refused", async () => {
  const forged = d.browser();
  forged.jar.set("mcpb_session", randomBytes(32).toString("base64url"));
  assert.equal((await forged.api("GET", "/api/me")).status, 401);
  forged.jar.set("mcpb_session", "' OR 1=1 --");
  assert.equal((await forged.api("GET", "/api/me")).status, 401);
});

test("auth: someone who was never invited cannot get in", async () => {
  const m = d.browser();
  const to = await m.signIn(MALLORY);
  assert.equal(to, "/?signin_error=not_invited");
  assert.equal(m.jar.size, 0, "no session cookie was set");
});

test("auth: an ID token signed by someone else, or with the wrong nonce, is rejected", async () => {
  const a = d.browser();
  assert.equal(await a.signIn(ALICE, { misbehave: "signature" }), "/?signin_error=failed");
  assert.equal(a.jar.size, 0);
  const b = d.browser();
  assert.equal(await b.signIn(ALICE, { misbehave: "nonce" }), "/?signin_error=failed");
  assert.equal(b.jar.size, 0);
});

test("auth: a sign-in response cannot be replayed", async () => {
  const a = d.browser();
  await a.signIn(ALICE);
  const replay = d.browser();
  const r = await replay.raw("GET", a.lastCallback);
  assert.equal(r.headers.get("location"), "/?signin_error=expired");
  assert.equal(replay.jar.size, 0);
});

test("auth: an unverified email is refused", async () => {
  const u = d.browser();
  assert.equal(await u.signIn({ ...ALICE, email_verified: false }), "/?signin_error=unverified");
});

test("auth: sign out ends the session on the server, not only in the browser", async () => {
  const a = d.browser();
  await a.signIn(ALICE);
  const stolen = a.cookieHeader();
  assert.equal((await a.api("POST", "/auth/logout")).status, 204);
  const res = await fetch(d.base + "/api/me", { headers: { cookie: stolen } });
  assert.equal(res.status, 401);
});

test("auth: sessions expire when idle", async () => {
  const a = d.browser();
  await a.signIn(ALICE);
  d.db.raw.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(Date.now() - d.config.session.idleMs - 1000, sha256(a.jar.get("mcpb_session")));
  assert.equal((await a.api("GET", "/api/me")).status, 401);
});

test("auth: a new session id is issued on every sign-in (no session fixation)", async () => {
  const a = d.browser();
  a.jar.set("mcpb_session", "attacker-chosen-value");
  await a.signIn(ALICE);
  assert.notEqual(a.jar.get("mcpb_session"), "attacker-chosen-value");
  assert.equal((await a.api("GET", "/api/me")).status, 200);
});

// ---------- tenant isolation ----------
test("isolation: a client sees only its own workspace", async () => {
  assert.deepEqual(bob.me.workspaces.map((w) => w.id), [wsB.id]);
  assert.deepEqual(alice.me.workspaces.map((w) => w.id), [wsA.id]);
});

test("isolation: client B cannot read, change, delete, validate or download client A's manifest", async () => {
  const a = `/api/workspaces/${wsA.id}/manifests`;
  const viaB = `/api/workspaces/${wsB.id}/manifests/${manifestA.id}`;
  const attempts = [
    ["GET", a], ["POST", a, {}], ["GET", `${a}/${manifestA.id}`], ["PUT", `${a}/${manifestA.id}`, { manifest: {}, revision: 1 }],
    ["DELETE", `${a}/${manifestA.id}`], ["POST", `${a}/${manifestA.id}/validate`, { manifest: {} }], ["POST", `${a}/${manifestA.id}/generate`, {}],
    ["GET", viaB], ["PUT", viaB, { manifest: {}, revision: 1 }], ["DELETE", viaB], ["POST", `${viaB}/generate`, {}],
  ];
  for (const [method, url, body] of attempts) {
    const r = await bob.api(method, url, body);
    assert.equal(r.status, 404, `${method} ${url} → ${r.status}`);
    assert.ok(!JSON.stringify(r.data ?? "").includes(MARKER));
  }
  const still = await alice.api("GET", `${a}/${manifestA.id}`);
  assert.equal(still.status, 200);
  assert.equal(still.data.manifest.company.name, MARKER, "A's manifest is untouched");
});

test("isolation: a ciphertext moved to another workspace does not decrypt", () => {
  const row = d.db.raw.prepare("SELECT sealed FROM manifests WHERE id = ?").get(manifestA.id);
  const b = d.db.createManifest(wsB.id, { name: "x", manifest: {}, files: {} }, "test");
  d.db.raw.prepare("UPDATE manifests SET sealed = ? WHERE id = ?").run(row.sealed, b.id);
  assert.throws(() => d.db.getManifest(wsB.id, b.id), /Unsupported state or unable to authenticate data/);
  d.db.deleteManifest(wsB.id, b.id);
});

test("roles: a viewer can open and download but not change or delete", async () => {
  const base = `/api/workspaces/${wsA.id}/manifests`;
  assert.equal((await victor.api("GET", `${base}/${manifestA.id}`)).status, 200);
  assert.equal((await victor.api("PUT", `${base}/${manifestA.id}`, { manifest: {}, revision: 1 })).status, 403);
  assert.equal((await victor.api("DELETE", `${base}/${manifestA.id}`)).status, 403);
  assert.equal((await victor.api("POST", base, {})).status, 403);
  assert.equal((await victor.api("POST", `${base}/${manifestA.id}/generate`, {})).status, 200);
});

test("roles: clients cannot use admin routes, and the attempt is logged", async () => {
  for (const [method, url, body] of [["GET", "/api/admin/overview"], ["POST", "/api/admin/workspaces", { name: "Mine" }], ["POST", `/api/admin/workspaces/${wsB.id}/invites`, { email: ALICE.email, role: "editor" }], ["PUT", `/api/admin/users/${bob.me ? "x" : "x"}/disabled`, { disabled: true }]]) {
    assert.equal((await alice.api(method, url, body)).status, 403, `${method} ${url}`);
  }
  const log = d.db.auditLog(50);
  assert.ok(log.some((e) => e.action === "admin.denied" && e.email === ALICE.email));
});

test("roles: removing a member cuts access immediately", async () => {
  const eve = { oid: "3f8b3a54-6d1b-4b39-9d55-2a0c1e1c9f10", email: "eve@client-a.example" };
  await admin.api("POST", `/api/admin/workspaces/${wsA.id}/invites`, { email: eve.email, role: "editor" });
  const e = d.browser(); await e.signIn(eve);
  assert.equal((await e.api("GET", `/api/workspaces/${wsA.id}/manifests`)).status, 200);
  const users = (await admin.api("GET", `/api/admin/workspaces/${wsA.id}`)).data.members;
  const id = users.find((u) => u.email === eve.email).id;
  assert.equal((await admin.api("DELETE", `/api/admin/workspaces/${wsA.id}/members/${id}`)).status, 204);
  assert.equal((await e.api("GET", `/api/workspaces/${wsA.id}/manifests`)).status, 404);
});

test("roles: disabling a user ends their sessions", async () => {
  const b2 = d.browser(); await b2.signIn(BOB);
  const users = (await admin.api("GET", "/api/admin/overview")).data.users;
  const bobId = users.find((u) => u.email === BOB.email).id;
  assert.equal((await admin.api("PUT", `/api/admin/users/${bobId}/disabled`, { disabled: true })).status, 200);
  assert.equal((await b2.api("GET", "/api/me")).status, 401);
  assert.equal(await d.browser().signIn(BOB), "/?signin_error=disabled");
  await admin.api("PUT", `/api/admin/users/${bobId}/disabled`, { disabled: false });
  await bob.signIn(BOB);
});

// ---------- CSRF ----------
test("csrf: changes need the session's token, the same origin and JSON", async () => {
  const url = `/api/workspaces/${wsA.id}/manifests`;
  assert.equal((await alice.api("POST", url, {}, { "x-csrf-token": "" })).status, 403, "no token");
  assert.equal((await alice.api("POST", url, {}, { "x-csrf-token": bob.csrf })).status, 403, "someone else's token");
  assert.equal((await alice.api("POST", url, {}, { origin: "https://evil.example.com" })).status, 403, "other origin");
  assert.equal((await alice.api("POST", url, {}, { "sec-fetch-site": "cross-site" })).status, 403, "cross-site fetch");
  const form = await alice.raw("POST", url, { body: "a=1", json: false, headers: { "content-type": "application/x-www-form-urlencoded", origin: d.base, "x-csrf-token": alice.csrf } });
  assert.equal(form.status, 415, "HTML form posts are refused");
});

// ---------- secrets ----------
test("secrets: manifests containing credentials are refused, without echoing them", async () => {
  const key = "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc";
  const m = structuredClone(example);
  m.api.headers = { Authorization: `Bearer ${key}` };
  const r = await alice.api("POST", `/api/workspaces/${wsA.id}/manifests`, { manifest: m, files: {} });
  assert.equal(r.status, 422);
  assert.ok(r.data.details.some((x) => x.includes("api.headers.Authorization")));
  assert.ok(!JSON.stringify(r.data).includes(key), "the secret is not echoed back");
  assert.ok(!d.logs.join("\n").includes(key), "the secret is not logged");
  assert.ok(findSecrets({ api: { baseUrl: "https://user:pa55@api.example.com" } }).length);
  assert.ok(findSecrets({}, { "docs/x.md": "-----BEGIN RSA PRIVATE KEY-----" }).length);
  assert.deepEqual(findSecrets(example), [], "the normal example is not flagged");
});

test("secrets: manifests are encrypted at rest and session tokens are stored only as hashes", () => {
  const bytes = readFileSync(d.dbPath);
  const wal = (() => { try { return readFileSync(d.dbPath + "-wal"); } catch { return Buffer.alloc(0); } })();
  for (const buf of [bytes, wal]) {
    assert.ok(!buf.includes(MARKER), "company name not in plain text");
    assert.ok(!buf.includes("acme-outdoor-sales"), "server name not in plain text");
    assert.ok(!buf.includes("ACME_API_KEY"), "manifest body not in plain text");
    assert.ok(!buf.includes(alice.jar.get("mcpb_session")), "session token not stored");
  }
});

test("secrets: logs contain no tokens, codes or manifest contents", () => {
  const all = d.logs.join("\n");
  assert.ok(!/code=|state=/.test(all), "no sign-in codes");
  assert.ok(!all.includes(alice.csrf) && !all.includes(alice.jar.get("mcpb_session")), "no CSRF or session tokens");
  assert.ok(!all.includes(MARKER), "no manifest contents");
  assert.ok(!all.includes(d.env.OIDC_CLIENT_SECRET) && !all.includes(d.env.DATA_ENCRYPTION_KEY), "no configuration secrets");
});

// ---------- input and abuse ----------
test("input: file paths outside the manifest folder are refused", async () => {
  for (const name of ["../../etc/passwd", "/etc/passwd", "docs/../../x", "a\\..\\..\\b"]) {
    const r = await alice.api("POST", `/api/workspaces/${wsA.id}/manifests`, { manifest: {}, files: { [name]: "x" } });
    assert.equal(r.status, 400, name);
  }
});

test("input: oversized bodies and malformed ids are refused", async () => {
  const big = { manifest: {}, files: { "docs/a.md": "x".repeat(1_100_000) } };
  assert.equal((await alice.api("POST", `/api/workspaces/${wsA.id}/manifests`, big)).status, 413);
  assert.equal((await alice.api("GET", `/api/workspaces/not-a-uuid/manifests`)).status, 404);
  assert.equal((await alice.api("GET", `/api/workspaces/${wsA.id}/manifests/1%20OR%201=1`)).status, 404);
});

test("abuse: sign-in attempts are rate limited per address", async () => {
  const fresh = await startDashboard();
  try {
    const r = fresh.browser();
    let limited = 0;
    for (let i = 0; i < 25; i++) if ((await r.raw("GET", "/auth/login")).status === 429) limited++;
    assert.ok(limited > 0, "sign-in was throttled");
  } finally { fresh.close(); }
});

test("abuse: server generation is rate limited per user", async () => {
  const fresh = await startDashboard();
  try {
    const adm = fresh.browser(); await adm.signIn(ADMIN);
    const ws = (await adm.api("POST", "/api/admin/workspaces", { name: "Limits" })).data;
    await adm.api("POST", `/api/admin/workspaces/${ws.id}/invites`, { email: ALICE.email, role: "editor" });
    const a = fresh.browser(); await a.signIn(ALICE);
    const m = (await a.api("POST", `/api/workspaces/${ws.id}/manifests`, { manifest: example, files: { "docs/return-policy.md": policy } })).data;
    const url = `/api/workspaces/${ws.id}/manifests/${m.id}/generate`;
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await a.api("POST", url, {})).status);
    assert.ok(codes.includes(429), codes.join(","));
  } finally { fresh.close(); }
});

test("concurrency: a stale save is refused instead of overwriting someone else's work", async () => {
  const url = `/api/workspaces/${wsA.id}/manifests/${manifestA.id}`;
  const cur = (await alice.api("GET", url)).data;
  assert.equal((await alice.api("PUT", url, { manifest: cur.manifest, files: cur.files, revision: cur.revision })).status, 200);
  assert.equal((await alice.api("PUT", url, { manifest: cur.manifest, files: cur.files, revision: cur.revision })).status, 409);
});

// ---------- the feature itself ----------
test("generate: returns a zip of a working server project for the saved manifest", async () => {
  const fresh = d.browser(); await fresh.signIn(VICTOR);
  const r = await fresh.api("POST", `/api/workspaces/${wsA.id}/manifests/${manifestA.id}/generate`, {});
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /attachment; filename="acme-outdoor-sales-0\.1\.0\.zip"/);
  const dir = mkdtempSync(path.join(os.tmpdir(), "mcpb-zip-"));
  writeFileSync(path.join(dir, "s.zip"), r.data);
  const listing = execFileSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print('\\n'.join(z.namelist()))", path.join(dir, "s.zip")], { encoding: "utf8" });
  for (const f of ["acme-outdoor-sales/package.json", "acme-outdoor-sales/src/tools/search_products.ts", "acme-outdoor-sales/assets/docs/return-policy.md", "acme-outdoor-sales/.env.example"]) assert.ok(listing.includes(f), f);
  assert.ok(!/\.env\n|node_modules/.test(listing), "no .env or dependencies in the download");
});

test("audit: sign-ins, changes and downloads are recorded", () => {
  const actions = new Set(d.db.auditLog(500).map((e) => e.action));
  for (const a of ["login", "workspace.create", "invite.create", "manifest.create", "manifest.update", "manifest.generate", "logout", "admin.denied"]) assert.ok(actions.has(a), a);
});
