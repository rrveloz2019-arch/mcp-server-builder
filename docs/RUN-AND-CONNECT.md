# Run the generated server and connect it to Claude

This guide starts after `mcp-builder generate`. It covers settings, running locally (stdio) and remotely (HTTP),
giving clients access with API keys or OAuth (including Azure AD), and connecting Claude Code, Claude Desktop and claude.ai.

## 1. Build and settings

```bash
cd my-company-sales          # the folder you passed to --out
npm install
npm run build                # compiles src/ to dist/
cp .env.example .env         # then fill in the values
```

`.env` is read from the server's own folder, even when Claude starts the server from somewhere else.
Real environment variables win over `.env`. Never commit `.env`.

| Variable | Needed for | Purpose |
|---|---|---|
| The `*Env` names from your manifest (e.g. `MY_COMPANY_API_KEY`) | always | Credentials for your company API |
| `*_KEY_SHA256` (one per `access.apiKeys` client) | HTTP with API keys | Hash of that client's key (section 3) |
| `API_BASE_URL` | optional | Use another API base URL, e.g. staging |
| `MCP_TRANSPORT` | optional | `stdio` or `http`; the `--stdio` / `--http` flag wins |
| `PORT`, `HOST` | HTTP | Listen address. Default: the manifest port, `127.0.0.1` |
| `AUDIT_LOG_PATH` | optional | Where the audit log goes (when `audit.sink: file`) |
| `MCP_OAUTH_JWKS_URL` | optional | Where OAuth signing keys are fetched from |

The generated `README.md` lists the exact variables for your manifest.

## 2. Run locally (stdio): one user on their own computer

Claude starts the server itself, so you only register it.

**Claude Code**

```bash
claude mcp add my-company-sales -- node /FULL/PATH/my-company-sales/dist/index.js --stdio
claude mcp list              # expect: my-company-sales ... ✓ Connected
```

**Claude Desktop**: *Settings → Developer → Edit Config*, add the server, save, then quit and reopen Claude Desktop.

```json
{
  "mcpServers": {
    "my-company-sales": {
      "command": "node",
      "args": ["/FULL/PATH/my-company-sales/dist/index.js", "--stdio"]
    }
  }
}
```

The path must be absolute. On Windows, write it with double backslashes, e.g. `"C:\\servers\\my-company-sales\\dist\\index.js"`.
A stdio user gets the scopes in `access.stdioScopes`.
In Claude Code, the manifest's prompts appear as slash commands, for example `/mcp__my-company-sales__prepare_quote`.

## 3. Run remotely (HTTP): many users or teams

The manifest must list `http` in `server.transports` and define `access.apiKeys`, `access.oauth`, or both.
The server refuses every request without a valid key or token; there are no open endpoints.

```bash
npm run start:http           # listens on 127.0.0.1:<port><path>, e.g. http://127.0.0.1:3000/mcp
HOST=0.0.0.0 PORT=8080 npm run start:http    # accept connections from other machines
curl http://127.0.0.1:3000/healthz            # {"ok":true,"name":...,"version":...}
```

The HTTP transport is stateless Streamable HTTP: clients use `POST` on the MCP path.

### Give a client an API key

```bash
npm run hash-key
# key:    mcp_ludmGQ2Y...      → give this to the client, once, privately
# sha256: c25aa415...          → put this in .env
```

1. Put the hash in the variable named by that client's `keyHashEnv`, e.g. `SALES_TEAM_KEY_SHA256=c25aa415...`.
2. Restart the server. At start-up it warns about any client whose hash is missing.
3. The client sends `Authorization: Bearer <key>`.

To revoke a key, delete its hash and restart. To rotate, run `npm run hash-key` again.

**Claude Code with an API key:**

```bash
claude mcp add --transport http my-company-sales https://mcp.my-company.com/mcp \
  --header "Authorization: Bearer mcp_ludmGQ2Y..."
```

### Sign in with OAuth (your identity provider)

With `access.oauth`, clients send OAuth access tokens from your company's identity provider.
The server checks the signature (JWKS), issuer, audience and expiry, reads permissions from `scopeClaim`,
and can bind tenant values from token claims (`contextClaims`). It never needs a client secret.

```yaml
server:
  http:
    publicUrl: https://mcp.my-company.com/mcp     # the address clients use
access:
  oauth:
    issuer: https://login.my-company.com
    audience: https://mcp.my-company.com/mcp
    scopeClaim: scope                            # or [roles, scp] for Azure AD
    contextClaims:
      customer_id: my_customer_id_claim
```

The server publishes OAuth protected-resource metadata at `/.well-known/oauth-protected-resource<path>`
(for example `/.well-known/oauth-protected-resource/mcp`), as the MCP authorization spec requires, so clients can find your identity provider.

**Azure AD (Microsoft Entra ID):** use [`examples/acme-outdoor-azure.yaml`](../examples/acme-outdoor-azure.yaml) as the pattern
and follow the portal steps in [`examples/azure/README.md`](../examples/azure/README.md).

## 4. Put it on the internet

A generated server is a plain Node.js app. Any host that runs Node.js 20.12 or newer works (a VM, a container, a PaaS).

1. Build it: `npm install && npm run build`.
2. On the host, install only runtime packages: `npm ci --omit=dev`, then copy `dist/`, `assets/` and `.env` (or set the variables in the host's settings).
3. Start it with `HOST=0.0.0.0 node dist/index.js --http`, under a process manager that restarts it.
4. Put **HTTPS** in front of it (a load balancer or reverse proxy). Set `server.http.publicUrl` to the public `https://` address and regenerate.
5. Check `https://<your-host>/healthz`.

## 5. Add it to claude.ai (and Claude Desktop) as a custom connector

Requirements, from Claude's help center:

- The server must be reachable **over the public internet** from Anthropic's IP ranges, even when you use Claude Desktop.
  A laptop, VPN or private network does not work.
- Authentication is **OAuth**. The form has no field for a fixed API-key header, so use the OAuth setup (section 3), not API keys.
- Claude's OAuth callback URL is `https://claude.ai/api/mcp/auth_callback`. Add it as a redirect URI in your identity provider's app.
- If your identity provider does not support dynamic client registration (Azure AD does not), enter a client ID and secret under *Advanced settings*.

Steps (Pro and Max plans): *Customize → Connectors → + → Add custom connector*, enter `https://<your-host>/mcp`,
optionally open *Advanced settings* for the OAuth client ID and secret, then click *Add*.
Team and Enterprise owners add it under *Organization settings → Connectors*.

> **Status:** this route has not been tested end to end yet. The server side (tokens, metadata) is covered by automated tests,
> but a real sign-in from claude.ai needs a public HTTPS host.

Sources: [Get started with custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp),
[Building custom connectors](https://claude.com/docs/connectors/building).

## 6. Check what happened

- **Audit log**: every tool call with the client, tool, arguments (minus `redactFields`) and result, as JSON Lines
  (`logs/audit.jsonl` in the example, or stderr).
- **Write tools**: the log shows an entry with outcome `preview`, then one with outcome `ok` only after the user confirmed.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| HTTP `401 Missing bearer token.` | The client sends no `Authorization: Bearer ...` header. |
| HTTP `401 Unknown API key or token.` | The key is wrong, or its hash is not in `.env`. Restart after changing `.env`. |
| HTTP `401 Invalid or expired token.` | The OAuth token failed the signature, issuer, audience or expiry check. |
| HTTP `403 Token is missing the "..." claim.` | The OAuth token lacks a claim listed in `contextClaims`, so it is refused rather than reaching any tenant's data. |
| Tool error `forbidden` | The client's scopes do not allow that tool, resource or prompt. |
| `Transport "http" is not enabled in the manifest` | Add `http` to `server.transports` and regenerate. |
| Tool error `upstream_error`: *refused the server's credentials* | Your company API key in `.env` is wrong. |
| Tool error `upstream_error`: *Could not reach the company API* | `API_BASE_URL` or `api.baseUrl` is wrong, or the API is down. |
| Tool error `rate_limited` | The client hit its `rateLimit`. The error says when to retry. |
| A tool is missing in Claude | The client's scopes do not include that tool's scope, or the tool has `enabled: false`. |
