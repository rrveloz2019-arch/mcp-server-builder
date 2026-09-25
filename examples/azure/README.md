# Azure AD (Microsoft Entra ID) sign-in for the demo server

The demo manifest `examples/acme-outdoor-azure.yaml` lets remote clients sign in with your Azure AD app registration:

| Setting | Value |
|---|---|
| Application (client) ID | `a676142a-7299-4189-a3ae-12c60fe37306` |
| Directory (tenant) ID | `e8c9f1fa-4f30-41cc-b2bc-1e9fe8607b5a` |

These IDs are not secrets. **The MCP server itself never needs the client secret.** It checks each token against your tenant's public signing keys. The secret is only used by `azure-demo.mjs` below, which gets a test token.

## Where the client secret goes

| Put it here | Never put it here |
|---|---|
| `examples/azure/.env` as `AZURE_CLIENT_SECRET=...` (git ignores this file) | the manifest, the generated server's code, a commit, or a chat message |

## One-time setup in the Azure portal

Open **portal.azure.com → Microsoft Entra ID → App registrations →** your app, then:

1. **Expose an API**: next to *Application ID URI*, click **Add**, keep the suggested `api://a676142a-7299-4189-a3ae-12c60fe37306`, then click **Save**.
2. **App roles → Create app role**: create one role per permission. Set *Allowed member types* to **Both**, and set *Value* to exactly one of the following:
   `catalog:read`, `stock:read`, `pricing:read`, `orders:read`, `quotes:write`, `reports:read`
   The role value becomes the permission. A client only sees the tools its roles allow.
3. **Manifest**: find `"requestedAccessTokenVersion": null` and change it to `2`, then click **Save**. In the older manifest format the field is called `accessTokenAcceptedVersion`. The server also accepts v1 tokens, but v2 is the recommended setting.
4. **Certificates & secrets → Client secrets → New client secret**. Copy the **Value** column, not the *Secret ID*. The value is shown only once. Then:
   ```bash
   cp examples/azure/.env.example examples/azure/.env
   # edit examples/azure/.env and paste the value after AZURE_CLIENT_SECRET=
   ```
5. **API permissions → Add a permission → My APIs →** this app **→ Application permissions**. Tick the roles from step 2, click **Add permissions**, then click **Grant admin consent**. This lets the test script act as the app.
   To give people access, go to **Enterprise applications →** this app **→ Users and groups → Add user/group** and choose a role.

## Try it

```bash
npm install
npm run mock-api                                                   # terminal 1: fake Acme API
npm run generate -- examples/acme-outdoor-azure.yaml --out ../acme-azure
cd ../acme-azure && npm install && npm run build
ACME_API_KEY=test-upstream-key API_BASE_URL=http://127.0.0.1:4010/v2 npm run start:http   # terminal 2
cd ../mcp-server-builder
node examples/azure/azure-demo.mjs token     # terminal 3: shows the token's version, audience and roles
node examples/azure/azure-demo.mjs check     # signs in and calls the server
```

`token` warns you if the token is still v1 (step 3) or has no roles (step 5).

## What is tested

- `test/e2e-azure.test.mjs` signs tokens shaped exactly like Azure AD v2 and v1 access tokens, then checks the following:
  - app roles and delegated scopes both work
  - tokens from another tenant or for another app are refused
  - a token with no roles sees nothing
- Checked against the real tenant, without a secret:
  - your tenant's discovery document and signing keys load
  - a forged token is rejected
  - Azure recognises the client ID and only refuses the (deliberately wrong) secret
- Not tested yet: a real token issued by Azure. That needs steps 1–5 done and the secret in place.
