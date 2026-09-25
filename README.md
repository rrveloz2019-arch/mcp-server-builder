# MCP Server Builder

Turn a company's existing backend API into an **MCP server**, so AI assistants like Claude can use it:
search products, check stock and pricing, create quotes, read documents, and run company-specific actions.
The company's own code does not change.

> **Status:** v0.3. The manifest format, validator and **generator** work. A server generated from the
> example manifest passes 64 automated tests against a mock company API, over stdio and HTTP.

## What a generated server provides

- **Tools**: 8 standard sales tools plus any custom tools (for example, verify a QR code or email a quote)
- **Resources**: product records and documents the AI can read directly
- **Prompts**: ready-made tasks such as "Prepare a quote"
- **Access control**: per-client API keys or OAuth, scopes, and tenant isolation on a shared server
- **Rate limits and an audit log** of everything the AI did
- **Progress updates** for long-running actions
- **Versioning** with safe deprecation, checked by `mcp-builder check-version`

## Quick start

Requires Node.js 20.12 or newer.

```bash
npm install
npm run validate -- examples/acme-outdoor.yaml          # 1. check the manifest
npm run generate -- examples/acme-outdoor.yaml --out ../acme-outdoor-sales   # 2. generate the server
cd ../acme-outdoor-sales
npm install && npm run build                              # 3. build it
cp .env.example .env                                      # 4. fill in the values
npm run start:stdio                                       # 5. run it (or npm run start:http)
```

To try it without a real company API, start the mock API in another terminal and point the server at it:

```bash
npm run mock-api                     # in this repo: fake Acme API on http://127.0.0.1:4010/v2
# in the generated server's .env:
ACME_API_KEY=test-upstream-key
API_BASE_URL=http://127.0.0.1:4010/v2
```

### Sign in with Azure AD (Microsoft Entra ID)

`examples/acme-outdoor-azure.yaml` is the same example, set up for Azure AD sign-in.
Setup steps, and where the client secret goes, are in [`examples/azure/README.md`](examples/azure/README.md).

### Connect it to Claude Desktop (local, stdio)

Add this to `claude_desktop_config.json`, with the absolute path of the generated folder:

```json
{
  "mcpServers": {
    "acme-outdoor-sales": {
      "command": "node",
      "args": ["/path/to/acme-outdoor-sales/dist/index.js", "--stdio"],
      "env": { "ACME_API_KEY": "…", "API_BASE_URL": "http://127.0.0.1:4010/v2" }
    }
  }
}
```

### Connect it to Claude Code

```bash
# local (stdio)
claude mcp add acme-outdoor-sales -- node /path/to/acme-outdoor-sales/dist/index.js --stdio
# remote (HTTP) with a client API key
claude mcp add --transport http acme-outdoor-sales http://127.0.0.1:3000/mcp --header "Authorization: Bearer <client-api-key>"
```

Prompts appear as slash commands, for example `/mcp__acme-outdoor-sales__prepare_quote`.

## Commands

| Command | What it does |
|---|---|
| `mcp-builder validate <manifest>` | Checks the manifest and lists what it exposes |
| `mcp-builder generate <manifest> --out <folder>` | Generates the TypeScript server. Refuses to write into a non-empty folder it did not create. |
| `mcp-builder check-version <old> <new>` | Lists the changes between two manifests, the version bump they need, and blocks unsafe removals |

Inside this repo, run them as `node src/cli/mcp-builder.mjs <command> …` or with the npm scripts above.

## Tests

```bash
npm test
```

64 tests: 20 validator tests, 12 generator and versioning tests, 14 end-to-end tests over stdio, 13 over HTTP and 5 with Azure AD sign-in
(API keys, OAuth tokens, scopes, tenant isolation, rate limits, deprecation, autocomplete, progress, audit log).

## Repository layout

```
docs/SPEC.md                    Spec & architecture (start here; section 17 = generator notes)
schema/manifest.schema.json     JSON Schema for the manifest
examples/acme-outdoor.yaml      Complete example manifest (uses every feature)
examples/docs/return-policy.md  File served as a resource by the example
examples/mock-api/              Fake Acme API for demos and tests
examples/acme-outdoor-azure.yaml  The example with Azure AD sign-in
examples/azure/                 Azure AD setup guide and token helper
src/catalog/tools.json          Standard sales tools: arguments, scopes, descriptions
src/cli/mcp-builder.mjs         CLI
src/generator/                  Code generator and version checker
templates/server-ts/            Runtime copied into every generated server
scripts/validate-manifest.mjs   Manifest validator (+ tests)
test/                           Generator and end-to-end tests
```

## Known limits

- `maxTotal` (spending cap on write tools) is not enforced yet. The generator warns when it is set. See SPEC section 17.
- `mcp-builder init` and `dev` are not built yet.
