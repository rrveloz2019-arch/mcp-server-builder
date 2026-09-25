// The hosted dashboard: Microsoft (Entra ID) sign-in, invite-only access,
// one workspace per client company, encrypted manifests, admin view.
//
// Security model (see docs/DASHBOARD-SECURITY.md):
// - Every /api route needs a valid server-side session; every change also
//   needs the session's CSRF token and a same-origin request.
// - Workspace access is checked on every request; a workspace the user does
//   not belong to answers 404, exactly like one that does not exist.
// - Admin rights come only from ADMIN_OIDS (server setting), never from input.

import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as oidc from "openid-client";
import YAML from "yaml";
import { catalog } from "../../scripts/validate-manifest.mjs";
import { generate } from "../../src/generator/generate.mjs";
import { check, writeWorkspace } from "../../src/intake/server.mjs";
import { randomToken, safeEqual } from "./crypto.mjs";
import { findSecrets } from "./secrets-scan.mjs";
import { HttpError, clientIp, cookie, parseCookies, rateLimiter, readJson, securityHeaders } from "./http.mjs";
import { zipFolder } from "./zip.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,}$/i;
const SMALL_BODY = 64 * 1024;
const MANIFEST_BODY = 1024 * 1024;
const MAX_FILES = 20;
const MAX_FILE_CHARS = 256 * 1024;

const STATIC = {
  "/": [path.join(here, "../public/index.html"), "text/html; charset=utf-8"],
  "/app.js": [path.join(here, "../public/app.js"), "text/javascript; charset=utf-8"],
  "/app.css": [path.join(here, "../public/app.css"), "text/css; charset=utf-8"],
  "/wizard.js": [path.join(repoRoot, "src/ui/wizard.js"), "text/javascript; charset=utf-8"],
  "/wizard.css": [path.join(repoRoot, "src/ui/wizard.css"), "text/css; charset=utf-8"],
};

// rateLimits lets tests raise the numbers; production always uses the defaults below.
export async function createApp({ config, db, log = console, rateLimits = {} }) {
  // enableNonRepudiationChecks: also verify the ID token's signature against the
  // provider's published keys (openid-client skips this by default for tokens
  // fetched directly from the token endpoint). Defence in depth.
  const execute = [oidc.enableNonRepudiationChecks, ...(config.insecureDev ? [oidc.allowInsecureRequests] : [])];
  const oidcConfig = await oidc.discovery(new URL(config.oidc.issuer), config.oidc.clientId, config.oidc.clientSecret, undefined, { execute });
  if (config.insecureDev) oidc.allowInsecureRequests(oidcConfig);
  // For Microsoft Entra, the tenant is part of the issuer; tokens must come from that tenant.
  const expectedTenant = config.oidc.issuer.match(/login\.microsoftonline\.com\/([0-9a-f-]{36})\//i)?.[1]?.toLowerCase();

  const cookieName = config.secureCookies ? "__Host-mcpb_session" : "mcpb_session";
  const origin = new URL(config.publicUrl).origin;
  const limits = {
    auth: rateLimiter({ limit: rateLimits.auth ?? 20, windowMs: 60_000 }),
    anon: rateLimiter({ limit: rateLimits.anon ?? 60, windowMs: 60_000 }),
    api: rateLimiter({ limit: rateLimits.api ?? 300, windowMs: 60_000 }),
    generate: rateLimiter({ limit: rateLimits.generate ?? 10, windowMs: 60_000 }),
  };
  const purge = setInterval(() => db.purgeExpired(config.session.idleMs).catch((err) => log.error(`purge failed: ${err.code ?? err.name}`)), 60_000);
  purge.unref();

  // ---------- sessions ----------
  async function loadSession(req) {
    const token = parseCookies(req.headers.cookie)[cookieName];
    if (!token || token.length > 100) return null;
    const s = await db.session(token);
    if (!s) return null;
    const t = Date.now();
    if (s.expires_at < t || s.last_seen_at + config.session.idleMs < t) { await db.deleteSession(token); return null; }
    const user = await db.userById(s.user_id);
    if (!user || user.disabled) { await db.deleteSession(token); return null; }
    await db.touchSession(token);
    return { token, csrf: s.csrf, user, isAdmin: config.adminOids.has(user.oid.toLowerCase()) };
  }

  function requireSameOrigin(req, session) {
    const o = req.headers.origin;
    if (o && o !== origin) throw new HttpError(403, "cross-origin request refused");
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin") throw new HttpError(403, "cross-site request refused");
    if (!safeEqual(req.headers["x-csrf-token"], session.csrf)) throw new HttpError(403, "missing or invalid CSRF token");
  }

  // Workspace access. Not a member (and not admin) = 404, same as not found.
  async function access(session, workspaceId, { edit = false } = {}) {
    if (!UUID.test(workspaceId)) throw new HttpError(404, "not found");
    const ws = await db.workspace(workspaceId);
    if (!ws) throw new HttpError(404, "not found");
    if (session.isAdmin) return { ws, role: "admin" };
    const m = await db.membership(workspaceId, session.user.id);
    if (!m) throw new HttpError(404, "not found");
    if (edit && m.role !== "editor") throw new HttpError(403, "your role in this workspace is read-only");
    return { ws, role: m.role };
  }

  // ---------- input checks ----------
  function cleanFiles(files) {
    if (files === undefined) return {};
    if (!files || typeof files !== "object" || Array.isArray(files)) throw new HttpError(400, "files must be an object");
    const entries = Object.entries(files);
    if (entries.length > MAX_FILES) throw new HttpError(400, `at most ${MAX_FILES} files`);
    const out = {};
    for (const [name, text] of entries) {
      const norm = path.posix.normalize(String(name).replaceAll("\\", "/"));
      if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(norm) || norm.startsWith("..") || norm.startsWith("/")) throw new HttpError(400, `file "${name}" must be a relative path inside the manifest folder`);
      if (typeof text !== "string" || text.length > MAX_FILE_CHARS) throw new HttpError(400, `file "${name}" must be text up to ${MAX_FILE_CHARS} characters`);
      out[norm] = text;
    }
    return out;
  }
  function cleanManifest(m) {
    if (!m || typeof m !== "object" || Array.isArray(m)) throw new HttpError(400, "manifest must be an object");
    return m;
  }
  const displayName = (m) => (typeof m?.server?.name === "string" && m.server.name.trim() ? m.server.name.trim().slice(0, 80) : "untitled");

  function validateWithSecrets(manifest, files) {
    const secrets = findSecrets(manifest, files);
    const r = check(manifest, files);
    return { ...r, errors: [...secrets.map((s) => `secret: ${s}`), ...r.errors], summary: secrets.length ? null : r.summary };
  }

  // ---------- routes ----------
  async function route(req, res, ctx) {
    const url = new URL(req.url, origin);
    const p = url.pathname;
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };

    if (req.method === "GET" && p === "/healthz") return send(200, { ok: true });
    if (req.method === "GET" && STATIC[p]) {
      const [file, type] = STATIC[p];
      res.writeHead(200, { "content-type": type });
      return res.end(readFileSync(file));
    }

    // ---- sign-in ----
    if (p === "/auth/login" && req.method === "GET") {
      if (limits.auth(`ip:${ctx.ip}`)) throw new HttpError(429, "too many sign-in attempts, try again in a minute");
      const state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
      await db.saveLoginState(state, nonce, verifier);
      const target = oidc.buildAuthorizationUrl(oidcConfig, {
        redirect_uri: config.oidc.redirectUri, scope: config.oidc.scope, state, nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256", prompt: "select_account",
      });
      res.writeHead(302, { location: target.href });
      return res.end();
    }
    if (p === "/auth/callback" && req.method === "GET") {
      try {
        return await callback(req, res, ctx, url);
      } catch (err) {
        // Back to the page with a fixed code (never reflect free text into the URL).
        const code = err instanceof HttpError && err.code ? err.code : "failed";
        if (!(err instanceof HttpError)) log.error(`sign-in error: ${err.stack}`);
        res.writeHead(302, { location: `/?signin_error=${code}` });
        return res.end();
      }
    }

    if (!p.startsWith("/api/") && p !== "/auth/logout") throw new HttpError(404, "not found");
    return api(req, res, ctx, url, send);
  }

  async function callback(req, res, ctx, url) {
    {
      const fail = (code, status, msg) => Object.assign(new HttpError(status, msg), { code });
      if (limits.auth(`ip:${ctx.ip}`)) throw fail("rate", 429, "too many sign-in attempts");
      const state = url.searchParams.get("state") ?? "";
      const saved = state && state.length < 200 ? await db.takeLoginState(state) : null;
      if (!saved) { await db.audit({ action: "login", outcome: "bad_state", ip: ctx.ip }); throw fail("expired", 400, "sign-in expired"); }
      let claims;
      try {
        // Build the callback URL from PUBLIC_URL, never from the Host header.
        const current = new URL(`${config.oidc.redirectUri}${url.search}`);
        const tokens = await oidc.authorizationCodeGrant(oidcConfig, current, { pkceCodeVerifier: saved.code_verifier, expectedState: state, expectedNonce: saved.nonce, idTokenExpected: true });
        claims = tokens.claims();
      } catch (err) {
        await db.audit({ action: "login", outcome: "token_rejected", ip: ctx.ip });
        log.error(`sign-in rejected: ${err.code ?? err.name}`);
        throw fail("failed", 401, "sign-in failed");
      }
      const oid = String(claims.oid ?? claims.sub ?? "");
      const email = String(claims.email ?? claims.preferred_username ?? "").toLowerCase();
      if (!oid || !EMAIL.test(email)) throw fail("missing_claims", 401, "no account id or email");
      if (claims.email_verified === false) { await db.audit({ action: "login", target: email, outcome: "email_unverified", ip: ctx.ip }); throw fail("unverified", 403, "email not verified"); }
      if (expectedTenant && String(claims.tid ?? "").toLowerCase() !== expectedTenant) { await db.audit({ action: "login", target: email, outcome: "wrong_tenant", ip: ctx.ip }); throw fail("tenant", 403, "wrong tenant"); }

      let user = await db.userByOid(oid);
      const isAdmin = config.adminOids.has(oid.toLowerCase());
      if (!user) {
        const invited = await db.hasOpenInvite(email);
        if (!isAdmin && !invited) {
          await db.audit({ action: "login", target: email, outcome: "not_invited", ip: ctx.ip });
          throw fail("not_invited", 403, "not invited");
        }
        user = await db.createUser({ oid, email, name: claims.name });
      }
      if (user.disabled) { await db.audit({ userId: user.id, action: "login", outcome: "disabled", ip: ctx.ip }); throw fail("disabled", 403, "disabled"); }
      await db.touchLogin(user.id, email, claims.name);
      await db.acceptInvites({ ...user, email });
      // New random session on every sign-in (no session fixation).
      const old = parseCookies(req.headers.cookie)[cookieName];
      if (old) await db.deleteSession(old);
      const token = randomToken();
      await db.createSession(token, user.id, randomToken(), config.session.absoluteMs);
      await db.audit({ userId: user.id, action: "login", ip: ctx.ip });
      res.writeHead(302, { location: "/", "set-cookie": cookie(cookieName, token, { secure: config.secureCookies, maxAgeSec: Math.floor(config.session.absoluteMs / 1000) }) });
      return res.end();
    }
  }

  async function api(req, res, ctx, url, send) {
    const p = url.pathname;
    let m;

    // ---- everything below needs a session ----
    const session = await loadSession(req);
    if (!session) {
      if (limits.anon(`ip:${ctx.ip}`)) throw new HttpError(429, "too many requests");
      throw new HttpError(401, "please sign in");
    }
    ctx.userId = session.user.id;
    if (limits.api(`user:${session.user.id}`)) throw new HttpError(429, "too many requests, slow down");
    const changing = req.method !== "GET";
    if (changing) requireSameOrigin(req, session);
    const body = changing && req.method !== "DELETE" && p !== "/auth/logout" ? await readJson(req, p.includes("/manifests") || p === "/api/parse" ? MANIFEST_BODY : SMALL_BODY) : undefined;
    const audit = (action, extra = {}) => db.audit({ userId: session.user.id, ip: ctx.ip, action, ...extra });

    if (p === "/auth/logout" && req.method === "POST") {
      await db.deleteSession(session.token);
      await audit("logout");
      res.writeHead(204, { "set-cookie": cookie(cookieName, "", { secure: config.secureCookies, maxAgeSec: 0 }) });
      return res.end();
    }

    if (p === "/api/me" && req.method === "GET") {
      const workspaces = session.isAdmin ? (await db.allWorkspaces()).map((w) => ({ id: w.id, name: w.name, role: "admin" })) : await db.workspacesForUser(session.user.id);
      return send(200, { user: { email: session.user.email, name: session.user.name }, isAdmin: session.isAdmin, csrf: session.csrf, workspaces });
    }
    if (p === "/api/catalog" && req.method === "GET") return send(200, catalog);
    if (p === "/api/example" && req.method === "GET") {
      const name = url.searchParams.get("name") === "azure" ? "acme-outdoor-azure.yaml" : "acme-outdoor.yaml";
      const manifest = YAML.parse(readFileSync(path.join(repoRoot, "examples", name), "utf8"));
      return send(200, { manifest, files: { "docs/return-policy.md": readFileSync(path.join(repoRoot, "examples/docs/return-policy.md"), "utf8") } });
    }
    if (p === "/api/parse" && req.method === "POST") {
      let manifest;
      try { manifest = YAML.parse(String(body.yaml ?? ""), { maxAliasCount: 50 }); } catch (err) { throw new HttpError(400, `YAML error: ${err.message.split("\n")[0]}`); }
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new HttpError(400, "the YAML must describe a manifest object");
      return send(200, { manifest });
    }

    // ---- workspace manifests ----
    m = p.match(/^\/api\/workspaces\/([^/]+)\/manifests(?:\/([^/]+)(?:\/(validate|generate))?)?$/);
    if (m) {
      const [, wsId, id, action] = m;
      if (!id) {
        if (req.method === "GET") { await access(session, wsId); return send(200, { manifests: await db.listManifests(wsId) }); }
        if (req.method === "POST") {
          await access(session, wsId, { edit: true });
          const manifest = body.manifest === undefined ? {} : cleanManifest(body.manifest);
          const files = cleanFiles(body.files);
          const secrets = findSecrets(manifest, files);
          if (secrets.length) throw Object.assign(new HttpError(422, "the manifest looks like it contains secrets"), { details: secrets });
          const created = await db.createManifest(wsId, { name: displayName(manifest), manifest, files }, session.user.id);
          await audit("manifest.create", { workspaceId: wsId, target: created.id });
          return send(201, created);
        }
      }
      if (id && !UUID.test(id)) throw new HttpError(404, "not found");
      if (id && !action) {
        if (req.method === "GET") {
          await access(session, wsId);
          const found = await db.getManifest(wsId, id);
          if (!found) throw new HttpError(404, "not found");
          return send(200, found);
        }
        if (req.method === "PUT") {
          await access(session, wsId, { edit: true });
          const manifest = cleanManifest(body.manifest);
          const files = cleanFiles(body.files);
          if (!Number.isInteger(body.revision)) throw new HttpError(400, "revision is required");
          const secrets = findSecrets(manifest, files);
          if (secrets.length) throw Object.assign(new HttpError(422, "the manifest looks like it contains secrets"), { details: secrets });
          if (!await db.getManifest(wsId, id)) throw new HttpError(404, "not found");
          const updated = await db.updateManifest(wsId, id, { name: displayName(manifest), manifest, files }, body.revision, session.user.id);
          if (!updated) throw new HttpError(409, "someone else saved this manifest in the meantime; reload it first");
          await audit("manifest.update", { workspaceId: wsId, target: id });
          return send(200, updated);
        }
        if (req.method === "DELETE") {
          await access(session, wsId, { edit: true });
          if (!await db.deleteManifest(wsId, id)) throw new HttpError(404, "not found");
          await audit("manifest.delete", { workspaceId: wsId, target: id });
          res.writeHead(204);
          return res.end();
        }
      }
      if (action === "validate" && req.method === "POST") {
        await access(session, wsId);
        if (!await db.getManifest(wsId, id)) throw new HttpError(404, "not found");
        return send(200, validateWithSecrets(cleanManifest(body.manifest), cleanFiles(body.files)));
      }
      if (action === "generate" && req.method === "POST") {
        await access(session, wsId);
        if (limits.generate(`user:${session.user.id}`)) throw new HttpError(429, "too many generations, try again in a minute");
        // Always generate from the saved copy, so the download matches what is stored.
        const saved = await db.getManifest(wsId, id);
        if (!saved) throw new HttpError(404, "not found");
        const v = validateWithSecrets(saved.manifest, saved.files);
        if (v.errors.length) return send(422, { error: "the saved manifest has problems; fix and save it first", errors: v.errors });
        const tmp = mkdtempSync(path.join(os.tmpdir(), "mcpb-dash-"));
        try {
          const { file } = writeWorkspace(path.join(tmp, "project"), saved.manifest, saved.files);
          const outDir = path.join(tmp, "server");
          const r = generate(file, outDir);
          const name = r.config.server.name;
          const zip = zipFolder(outDir, name);
          await audit("manifest.generate", { workspaceId: wsId, target: id });
          res.writeHead(200, {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${name}-${r.config.server.version}.zip"`,
            "x-generated-counts": JSON.stringify({ tools: r.tools.length, resources: r.resources.length, prompts: r.prompts.length }),
            "x-generated-warnings": encodeURIComponent(JSON.stringify(r.warnings ?? [])),
          });
          return res.end(zip);
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      }
      throw new HttpError(405, "method not allowed");
    }

    // ---- admin ----
    if (p.startsWith("/api/admin/")) {
      if (!session.isAdmin) { await audit("admin.denied", { target: p, outcome: "forbidden" }); throw new HttpError(403, "admins only"); }
      if (p === "/api/admin/overview" && req.method === "GET") {
        return send(200, { workspaces: await db.allWorkspaces(), users: await db.listUsers(), audit: await db.auditLog(100) });
      }
      if (p === "/api/admin/workspaces" && req.method === "POST") {
        const name = String(body.name ?? "").trim();
        if (name.length < 2 || name.length > 80) throw new HttpError(400, "workspace name must be 2 to 80 characters");
        const ws = await db.createWorkspace(name, session.user.id);
        await audit("workspace.create", { workspaceId: ws.id });
        return send(201, ws);
      }
      if ((m = p.match(/^\/api\/admin\/workspaces\/([^/]+)$/))) {
        const { ws } = await access(session, m[1]);
        if (req.method === "GET") return send(200, { ...ws, members: await db.members(ws.id), invites: await db.invites(ws.id) });
        if (req.method === "DELETE") { await db.deleteWorkspace(ws.id); await audit("workspace.delete", { workspaceId: ws.id }); res.writeHead(204); return res.end(); }
      }
      if ((m = p.match(/^\/api\/admin\/workspaces\/([^/]+)\/invites$/)) && req.method === "POST") {
        const { ws } = await access(session, m[1]);
        const email = String(body.email ?? "").trim().toLowerCase();
        const role = body.role === "viewer" ? "viewer" : body.role === "editor" ? "editor" : null;
        if (!EMAIL.test(email)) throw new HttpError(400, "enter a valid email address");
        if (!role) throw new HttpError(400, "role must be editor or viewer");
        const inv = await db.createInvite(ws.id, email, role, session.user.id);
        // An existing user with that email is added right away.
        const existing = await db.userByEmail(email);
        if (existing) await db.acceptInvites(existing);
        await audit("invite.create", { workspaceId: ws.id, target: email });
        return send(201, inv);
      }
      if ((m = p.match(/^\/api\/admin\/workspaces\/([^/]+)\/invites\/([^/]+)$/)) && req.method === "DELETE") {
        const { ws } = await access(session, m[1]);
        if (!UUID.test(m[2]) || !await db.revokeInvite(ws.id, m[2])) throw new HttpError(404, "not found");
        await audit("invite.revoke", { workspaceId: ws.id, target: m[2] });
        res.writeHead(204); return res.end();
      }
      if ((m = p.match(/^\/api\/admin\/workspaces\/([^/]+)\/members\/([^/]+)$/)) && req.method === "DELETE") {
        const { ws } = await access(session, m[1]);
        if (!UUID.test(m[2]) || !await db.removeMember(ws.id, m[2])) throw new HttpError(404, "not found");
        await audit("member.remove", { workspaceId: ws.id, target: m[2] });
        res.writeHead(204); return res.end();
      }
      if ((m = p.match(/^\/api\/admin\/users\/([^/]+)\/disabled$/)) && req.method === "PUT") {
        if (!UUID.test(m[1]) || !await db.userById(m[1])) throw new HttpError(404, "not found");
        if (m[1] === session.user.id) throw new HttpError(400, "you cannot disable your own account");
        await db.setUserDisabled(m[1], body.disabled === true);
        if (body.disabled === true) await db.deleteUserSessions(m[1]);
        audit(body.disabled === true ? "user.disable" : "user.enable", { target: m[1] });
        return send(200, { ok: true });
      }
    }
    throw new HttpError(404, "not found");
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const ctx = { ip: clientIp(req, config.trustProxy), userId: null };
    securityHeaders(res, { hsts: config.secureCookies });
    try {
      // Plain HTTP behind the TLS front end: send the browser to HTTPS.
      if (config.trustProxy && config.secureCookies && req.headers["x-forwarded-proto"] === "http") {
        res.writeHead(308, { location: `${config.publicUrl}${new URL(req.url, origin).pathname}` });
        return res.end();
      }
      await route(req, res, ctx);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log.error(`500 ${req.method} ${new URL(req.url, origin).pathname}: ${err.stack}`);
      if (!res.headersSent) {
        if (status === 429) res.setHeader("retry-after", "60");
        if (err.closeConnection) res.setHeader("connection", "close");
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: status === 500 ? "internal error" : err.message, ...(err.details ? { details: err.details } : {}) }));
      } else res.end();
    } finally {
      // Access log: path only (no query string: the sign-in callback carries a code).
      log.info?.(`${req.method} ${new URL(req.url, origin).pathname} ${res.statusCode} ${Date.now() - started}ms user=${ctx.userId ?? "-"}`);
    }
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  return server;
}
