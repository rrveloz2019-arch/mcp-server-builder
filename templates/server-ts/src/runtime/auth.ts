// Who is connecting. stdio = the local user; HTTP = a client with its own API
// key (only a SHA-256 hash is stored) or an OAuth 2.1 access token.
import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { ClientIdentity, ServerConfig } from "./types.js";

export function stdioIdentity(cfg: ServerConfig): ClientIdentity {
  return { clientId: "local-stdio", rateKey: "local-stdio", scopes: new Set(cfg.access.stdioScopes), context: {} };
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export type AuthResult = { ok: true; identity: ClientIdentity } | { ok: false; status: 401 | 403; reason: string };

export class ClientAuth {
  private jwks?: Promise<JWTVerifyGetKey>;

  constructor(private cfg: ServerConfig) {
    for (const k of cfg.access.apiKeys) {
      if (!process.env[k.keyHashEnv]) process.stderr.write(`[auth] ${k.keyHashEnv} is not set, so client "${k.clientId}" cannot connect.\n`);
    }
  }

  private async keySet(): Promise<JWTVerifyGetKey> {
    const o = this.cfg.access.oauth!;
    this.jwks ??= (async () => {
      let url = process.env.MCP_OAUTH_JWKS_URL ?? o.jwksUrl;
      if (!url) {
        for (const wk of ["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"]) {
          const res = await fetch(o.issuer.replace(/\/$/, "") + wk).catch(() => undefined);
          if (res?.ok) { url = ((await res.json()) as any).jwks_uri; if (url) break; }
        }
      }
      if (!url) throw new Error("Could not find the identity provider's JWKS URL.");
      return createRemoteJWKSet(new URL(url));
    })();
    this.jwks.catch(() => { this.jwks = undefined; });
    return this.jwks;
  }

  async authenticate(authorization: string | undefined): Promise<AuthResult> {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!token) return { ok: false, status: 401, reason: "Missing bearer token." };

    const hash = sha256(token);
    for (const k of this.cfg.access.apiKeys) {
      const expected = process.env[k.keyHashEnv]?.trim().toLowerCase();
      if (expected && sameHex(hash, expected)) {
        return { ok: true, identity: { clientId: k.clientId, rateKey: `key:${k.clientId}`, scopes: new Set(k.scopes), context: { ...k.context }, rateLimit: k.rateLimit } };
      }
    }

    const o = this.cfg.access.oauth;
    if (o && token.split(".").length === 3) {
      try {
        const { payload } = await jwtVerify(token, await this.keySet(), { issuer: [o.issuer, ...(o.additionalIssuers ?? [])], audience: o.audience });
        // Scopes can come from several claims (Azure AD: "scp" for delegated scopes, "roles" for app roles).
        const scopes: string[] = [];
        for (const claim of [o.scopeClaim].flat()) {
          const raw = payload[claim];
          if (typeof raw === "string") scopes.push(...raw.split(/\s+/).filter(Boolean));
          else if (Array.isArray(raw)) scopes.push(...raw.map(String));
        }
        const context: Record<string, string> = {};
        for (const [key, claim] of Object.entries(o.contextClaims)) {
          const v = payload[claim];
          // A token without the tenant claim could reach any tenant's data, so it is refused.
          if (typeof v !== "string" && typeof v !== "number") return { ok: false, status: 403, reason: `Token is missing the "${claim}" claim.` };
          context[key] = String(v);
        }
        // Azure AD puts the stable user/app id in "oid" and the calling app in "azp" (v2) or "appid" (v1).
        const sub = String(payload.oid ?? payload.sub ?? payload.client_id ?? "unknown");
        const clientId = String(payload.azp ?? payload.appid ?? payload.client_id ?? sub);
        return { ok: true, identity: { clientId: `oauth:${clientId}`, rateKey: `oauth:${sub}`, scopes: new Set(scopes), context, rateLimit: o.rateLimit } };
      } catch {
        return { ok: false, status: 401, reason: "Invalid or expired token." };
      }
    }
    return { ok: false, status: 401, reason: "Unknown API key or token." };
  }

  /** RFC 9728 protected resource metadata, required by the MCP authorization spec. */
  resourceMetadata(allScopes: string[]) {
    const o = this.cfg.access.oauth!;
    return { resource: this.cfg.server.http.publicUrl, authorization_servers: [o.issuer], scopes_supported: allScopes, bearer_methods_supported: ["header"] };
  }
}
