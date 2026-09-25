// A small OpenID Connect provider for tests, standing in for Microsoft Entra ID.
// Signs real RS256 ID tokens, checks PKCE and the client secret. Tests choose
// who "signs in" with nextUser, and can make it misbehave (bad signature, wrong nonce).

import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

// With users (demo mode), /authorize shows a page to pick who signs in instead of using nextUser.
export async function startMockOidc({ clientId, clientSecret, users = null }) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const attacker = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map();
  const state = { nextUser: null, misbehave: null, issuer: "" };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, state.issuer);
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer: state.issuer,
        authorization_endpoint: `${state.issuer}/authorize`,
        token_endpoint: `${state.issuer}/token`,
        jwks_uri: `${state.issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const p = url.searchParams;
      if (p.get("client_id") !== clientId || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) return json(400, { error: "invalid_request" });
      let user = state.nextUser;
      if (users) {
        const pick = p.has("pick") ? Number(p.get("pick")) : NaN;
        if (!Number.isInteger(pick) || !users[pick]) return pickerPage(res, p, users);
        user = users[pick];
      }
      const code = randomBytes(16).toString("hex");
      codes.set(code, { user, nonce: p.get("nonce"), challenge: p.get("code_challenge"), redirect: p.get("redirect_uri") });
      const back = new URL(p.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", p.get("state"));
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      const f = new URLSearchParams(body);
      let id = f.get("client_id"), secret = f.get("client_secret");
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
      if (basic) [id, secret] = Buffer.from(basic[1], "base64").toString().split(":").map(decodeURIComponent);
      if (id !== clientId || secret !== clientSecret) return json(401, { error: "invalid_client" });
      const entry = codes.get(f.get("code"));
      codes.delete(f.get("code"));
      if (!entry || entry.redirect !== f.get("redirect_uri")) return json(400, { error: "invalid_grant" });
      const challenge = createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url");
      if (challenge !== entry.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE check failed" });
      const u = entry.user;
      const claims = { oid: u.oid, email: u.email, name: u.name ?? u.email, tid: u.tid, nonce: state.misbehave === "nonce" ? "wrong-nonce" : entry.nonce };
      if (u.email_verified !== undefined) claims.email_verified = u.email_verified;
      const key = state.misbehave === "signature" ? attacker.privateKey : privateKey;
      const idToken = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(state.issuer)
        .setAudience(clientId).setSubject(u.oid).setIssuedAt().setExpirationTime("5m").sign(key);
      return json(200, { access_token: randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: 300, id_token: idToken });
    }
    json(404, { error: "not_found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  state.issuer = `http://127.0.0.1:${server.address().port}`;
  return { state, issuer: state.issuer, close: () => server.close() };
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function pickerPage(res, params, users) {
  const hidden = [...params].filter(([k]) => k !== "pick").map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  const buttons = users.map((u, i) => `<button name="pick" value="${i}"><strong>${esc(u.name)}</strong><br><small>${esc(u.email)}</small><br><small>${esc(u.note ?? "")}</small></button>`).join("");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action *" });
  res.end(`<!doctype html><title>Demo sign-in</title><style>body{font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px}button{display:block;width:100%;text-align:left;margin:8px 0;padding:12px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer}button:hover{background:#f3f6ff}.w{background:#fff7e0;padding:10px;border-radius:8px}</style>
<h1>Demo sign-in</h1><p class="w">This page stands in for the Microsoft sign-in. It exists only in demo mode on your own computer. Pick who you want to be:</p>
<form method="get" action="/authorize">${hidden}${buttons}</form>`);
}
