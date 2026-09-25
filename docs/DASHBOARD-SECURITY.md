# Hosted dashboard: security and deployment

The dashboard (`dashboard/`) lets you and invited client staff build MCP server
manifests in the browser and download the generated server as a .zip. It signs
people in with Microsoft Entra ID (Azure AD) and keeps every client company in
its own workspace.

## 1. What protects what

| Risk | Protection | Checked by (dashboard/test/security.test.mjs) |
|---|---|---|
| Someone uninvited signs in | Invite-only: an account is created only for an admin (ADMIN_OIDS) or an email with an open invitation | `auth: someone who was never invited` |
| Forged or replayed sign-in | OIDC authorization code flow with PKCE (S256), `state` and `nonce`, single-use 10-minute login state; ID token signature verified against the provider's keys | `forged signature / wrong nonce`, `cannot be replayed` |
| Wrong tenant | For Entra issuers, the token's `tid` must match the tenant in OIDC_ISSUER | code review only (the test provider is not Entra) |
| Stolen or fixed session | Random 256-bit session id, stored only as a SHA-256 hash; new id on every sign-in; 60-minute idle and 8-hour absolute expiry; sign out deletes it on the server; `HttpOnly`, `SameSite=Lax`, `Secure`, `__Host-` cookie | `sign out`, `expire when idle`, `no session fixation`, `stored only as hashes` |
| Client A sees client B's data | Every manifest query is filtered by workspace id and membership; other workspaces answer 404 (no existence leak) | `client B cannot read, change, delete, validate or download` |
| Database file copied | Manifests encrypted with AES-256-GCM; the key lives outside the database; the workspace and manifest ids are bound in (a row moved to another workspace fails to decrypt) | `encrypted at rest`, `ciphertext moved to another workspace` |
| Credentials pasted into a manifest | Saving is refused when a manifest contains a private key, cloud or API key, token, password in a URL, or a literal Authorization/API-key header. The reply names the place, never the value | `manifests containing credentials are refused` |
| Cross-site requests (CSRF) | Changes need the session's CSRF header, the dashboard's own Origin, not `Sec-Fetch-Site: cross-site`, and a JSON body (plain form posts are 415) | `csrf: changes need...` |
| Script injection (XSS) | Strict Content-Security-Policy (no inline scripts or styles, `default-src 'none'`), all server text escaped | `headers: strict CSP`, browser test with `<img onerror>` workspace name |
| Clickjacking, sniffing, caching | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-store`, `no-referrer`, HSTS on https | `headers` |
| Viewer changes things / client uses admin | Roles: viewer (read, download), editor, admin; admin routes refuse and audit others | `roles: ...` |
| Brute force and abuse | Per-IP sign-in limit (20/min), per-user API (300/min) and generation (10/min) limits; body limits (1 MB manifests, 64 KB other); max 20 files of 256 KB; strict file names (no `..`) | `abuse: ...`, `input: ...` |
| Lost update | Saves carry a revision; a stale save gets 409 | `concurrency` |
| Secrets in logs | Access log has method, path (no query), status and user id only; errors return "internal error" | `logs contain no tokens, codes or manifest contents` |
| Unsafe settings | The server will not start without https, an encryption key of 32 bytes, admins as GUIDs, and sane session times | `config: refuses to start...` |
| Who did what | Audit log of sign-ins (including refused ones), workspace, invite, member, manifest and download actions | `audit: ...` |

Known limits, stated plainly:
- Rate limits and the database are for **one instance**. Do not scale out to several instances without moving to a shared database and rate limiter.
- `node:sqlite` is marked experimental by Node.js (it works on Node 22.13+). The start and test scripts hide the warning; it is not an error.
- The `tid` check is only exercised against real Entra, not in the automated tests.
- The dashboard does not scan uploaded Markdown resource files for malware; it only stores them as text.

## 2. Deploy on Azure App Service (Linux, Node 22 LTS)

Do these steps in order. Nothing here is done automatically.

1. **Register the app in Entra ID** (Entra admin center > App registrations > New registration).
   - Supported account types: *Accounts in this organizational directory only* (single tenant).
   - Redirect URI: platform **Web**, value `https://<your-dashboard-host>/auth/callback`.
   - Note the **Application (client) ID** and **Directory (tenant) ID**.
   - Certificates & secrets > New client secret. Copy the value once; it goes to Key Vault.
   - Token configuration > Add optional claim > ID token > `email` (guests need it).
2. **Create a Key Vault** and add two secrets: `oidc-client-secret` (from step 1) and `data-encryption-key` (from `openssl rand -base64 32`). Keep a copy of the encryption key somewhere safe offline: without it, saved manifests cannot be read.
3. **Create the Web App**: runtime *Node 22 LTS*, Linux, one instance. Turn on a system-assigned managed identity and give it *Key Vault Secrets User* on the vault.
4. **Settings** (Web App > Environment variables). Secrets are Key Vault references:
   ```
   PUBLIC_URL          = https://<your-dashboard-host>
   OIDC_ISSUER         = https://login.microsoftonline.com/<tenant-id>/v2.0
   OIDC_CLIENT_ID      = <client-id>
   OIDC_CLIENT_SECRET  = @Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/oidc-client-secret/)
   DATA_ENCRYPTION_KEY = @Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/data-encryption-key/)
   ADMIN_OIDS          = <your Entra object id>
   TRUST_PROXY         = 1
   DB_PATH             = /home/data/dashboard.db
   ```
   Startup command: `cd dashboard && npm start`.
5. **Turn on** *HTTPS Only*, minimum TLS 1.2, and turn **off** FTP/basic-auth publishing.
6. **Deploy** the whole repository (GitHub Actions or `az webapp up`): the dashboard uses the builder's generator and validator from the repository root. Run `npm ci --omit=dev` both at the root and in `dashboard/`.
7. **First sign-in**: open the dashboard, sign in with the admin account, then Admin > create one workspace per client company > invite people by email.
8. **Client staff outside your tenant**: invite them as guests first (Entra admin center > Users > Invite external user), then invite the same email in the dashboard. Remove them in both places when they leave.
9. **Back up** `/home/data/dashboard.db` (App Service backups or a scheduled copy). The file is useless without the encryption key, and the key is useless without the file, so store them apart.

## 3. Keep it safe over time

- Run `npm audit` in `dashboard/` before every release (0 vulnerabilities at the time of writing) and keep `openid-client` current.
- Rotate the client secret before it expires (Entra shows the date). Rotating the data encryption key needs a re-encryption step that is not built yet.
- Review the Admin > Audit log for `login … not_invited`, `token_rejected` and `admin.denied` entries.
- Run the tests after any change: `cd dashboard && npm test` (29 security tests) and `npm test` at the repository root.

## 4. Local development

```
cd dashboard && npm install
cp .env.example .env    # set PUBLIC_URL=http://127.0.0.1:8080 and DASHBOARD_INSECURE_DEV=1
npm start
```
`DASHBOARD_INSECURE_DEV=1` allows plain http on localhost only; the server refuses it for any other address.

Microsoft references: [Configure Node.js apps](https://learn.microsoft.com/en-us/azure/app-service/configure-language-nodejs), [App Service on Linux FAQ](https://learn.microsoft.com/en-us/troubleshoot/azure/app-service/faqs-app-service-linux-new), [Key Vault references](https://learn.microsoft.com/en-us/azure/app-service/app-service-key-vault-references), [Register an app](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), [Add B2B guest users](https://learn.microsoft.com/en-us/entra/external-id/add-users-administrator).
