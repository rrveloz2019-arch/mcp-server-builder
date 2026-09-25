# MCP Server Builder

Turn a company's existing backend API into an **MCP server**, so AI assistants like Claude can use it:
search products, check stock and pricing, create quotes, read documents, and run company-specific actions.
The company's own code does not change.

> **Status:** v0.4. The manifest format, validator, generator and CLI work. A server generated from the
> example manifest passes 74 automated tests against a mock company API, over stdio and HTTP,
> and was used by a live Claude client (Claude Code) over both.

**New here? Follow the [Quickstart](QUICKSTART.md)**: about 10 minutes from install to Claude answering with your server's tools.

## Documentation

| Guide | For |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) | Install, generate the demo server, connect Claude |
| [Intake wizard](#or-fill-in-a-form-instead-of-writing-yaml) | A web form that writes the manifest for you |
| [docs/MANIFEST-GUIDE.md](docs/MANIFEST-GUIDE.md) | Writing a manifest for your own API, step by step |
| [docs/RUN-AND-CONNECT.md](docs/RUN-AND-CONNECT.md) | Settings, stdio and HTTP, API keys, OAuth / Azure AD, hosting, claude.ai connectors |
| [docs/SPEC.md](docs/SPEC.md) | Full spec and design decisions |
| [examples/azure/README.md](examples/azure/README.md) | Azure AD (Microsoft Entra ID) portal setup |

## What a generated server provides

- **Tools**: 8 standard sales tools plus any custom tools (for example, verify a QR code or email a quote)
- **Resources**: product records and documents the AI can read directly
- **Prompts**: ready-made tasks such as "Prepare a quote"
- **Access control**: per-client API keys or OAuth, scopes, and tenant isolation on a shared server
- **Rate limits and an audit log** of everything the AI did
- **Progress updates** for long-running actions
- **Versioning** with safe deprecation, checked by `mcp-builder check-version`

## Install

Requires Node.js 20.12 or newer.

```bash
npm install -g github:rrveloz2019-arch/mcp-server-builder    # installs the mcp-builder command
mcp-builder --help
```

You do not need to clone this repository to use the builder. The package is not on the npm registry yet.

### Or fill in a form instead of writing YAML

```bash
mcp-builder intake        # starts a local wizard at http://127.0.0.1:4321/  (in a clone: npm run intake)
```

The wizard walks through 8 steps (company and server, company API and its sign-in, the 8 standard tools,
field mappings, custom tools, resources and prompts, access / rate limits / Azure AD / audit), shows the
manifest live, and checks it with the same validator as `mcp-builder validate` as you type. When it is valid,
**Generate server** saves `intake-output/<server-name>/manifest.yaml` and generates the server into
`intake-output/<server-name>/server`, then shows the next commands. You can also start from the Acme examples
or import an existing manifest. It listens on 127.0.0.1 only and never asks for secrets, only env var names.

## Commands

| Command | What it does |
|---|---|
| `mcp-builder init [folder] [--example]` | Creates a starter `manifest.yaml` (or, with `--example`, the full Acme example). Never overwrites. |
| `mcp-builder validate <manifest>` | Checks the manifest and lists what it exposes |
| `mcp-builder generate <manifest> --out <folder>` | Generates the TypeScript server. Refuses to write into a non-empty folder it did not create. |
| `mcp-builder check-version <old> <new>` | Lists the changes between two manifests, the version bump they need, and blocks unsafe removals |
| `mcp-builder intake [--port 4321] [--out-root intake-output]` | Starts the intake wizard: a local web form that writes, validates and generates a manifest |
| `mcp-builder mock-api [port]` | Runs the fake Acme API used by the quickstart and tests (default port 4010) |
| `mcp-builder --version`, `--help` | Version and usage |

Inside a clone of this repo, run them as `node src/cli/mcp-builder.mjs <command> …` or `npm run validate|generate|mock-api -- …`.

## Tests

```bash
npm test
```

74 tests: 20 validator tests, 16 generator, CLI and versioning tests, 14 end-to-end tests over stdio, 13 over HTTP, 5 with Azure AD sign-in and 6 for the intake wizard
(API keys, OAuth tokens, scopes, tenant isolation, rate limits, deprecation, autocomplete, progress, audit log).

## Repository layout

```
QUICKSTART.md                   10-minute golden path
docs/MANIFEST-GUIDE.md          Writing a manifest
docs/RUN-AND-CONNECT.md         Running, auth, hosting, connecting Claude
docs/SPEC.md                    Spec & architecture (section 17 = generator notes)
schema/manifest.schema.json     JSON Schema for the manifest
examples/acme-outdoor.yaml      Complete example manifest (uses every feature)
examples/docs/return-policy.md  File served as a resource by the example
examples/mock-api/              Fake Acme API for demos and tests
examples/acme-outdoor-azure.yaml  The example with Azure AD sign-in
examples/azure/                 Azure AD setup guide and token helper
src/catalog/tools.json          Standard sales tools: arguments, scopes, descriptions
src/cli/mcp-builder.mjs         CLI
src/intake/                     Intake wizard (local web form + API)
src/generator/                  Code generator and version checker
templates/server-ts/            Runtime copied into every generated server
templates/starter/              Starter manifest used by mcp-builder init
scripts/validate-manifest.mjs   Manifest validator (+ tests)
test/                           Generator and end-to-end tests
```

## Known limits

- `maxTotal` (spending cap on write tools) is not enforced yet. The generator warns when it is set. See SPEC section 17.
- `mcp-builder dev` (watch and regenerate) is not built yet.
- Adding the server to claude.ai as a custom connector has not been tested end to end (it needs a public HTTPS host).
