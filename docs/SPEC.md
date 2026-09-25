# MCP Server Builder: Spec & Architecture (v0.3)

**Status:** Draft for review · **Date:** 2026-09-24 · **Scope:** design + generator (v0.3 adds the working generator; see section 17)

## 1. Goal

A company describes its existing backend in one YAML file (the **manifest**). The builder reads it and
generates a ready-to-run **MCP server** that sits between that backend and AI assistants (Claude or any
MCP client). The company does not rewrite its core logic. The server translates MCP calls into
calls to the API the company already has.

```
 company API ──► manifest.yaml ──► mcp-builder generate ──► generated MCP server ──► Claude / AI assistant
 (unchanged)     (what to expose)   (validate + codegen)     tools · resources ·       (discovers & uses them)
                                                             prompts · auth · audit
```

**Non-goals for v1:** a web UI, hosting the server for the company, direct database connections
(v1 goes through the company's HTTP API; a SQL source is on the roadmap), GraphQL back ends.

## 2. Requirements coverage

The table maps each requirement to where the design covers it.

| Requirement | How the design covers it | Section |
|---|---|---|
| **Tools** (functions the AI calls, with name, description, input/output schema) | 8 standard sales tools + unlimited `customTools` (e.g. `verify_qr_code`, `send_quote_email`). Each has an input schema (zod) and an output schema. | 5, 6 |
| **Resources** (data the AI reads without a function call) | `resources`: fixed or templated URIs (`catalog://products/{product_id}`) backed by an API call or a bundled file | 7 |
| **Prompts** (reusable templates offered to the user) | `prompts`: named templates with arguments, optional autocomplete and embedded resources | 8 |
| **Authentication / authorization** | Per-client API keys or OAuth 2.1 tokens. Every tool, resource and prompt has a `scope`. | 9 |
| **Translation layer** | `api` + request/response bindings + `mappings` turn existing endpoints into MCP without code changes | 4 |
| Clear, precise tool descriptions | Schema requires ≥40 characters for tool descriptions. Built-in descriptions follow a what/when/returns pattern. Server `instructions` explain how the tools fit together. | 5.3 |
| Structured, predictable outputs | Every tool declares an `outputSchema` and returns `structuredContent` built from a field map. Errors use one fixed shape. | 6 |
| Scoped permissions per client | Scopes per client. Tenant `context` values (e.g. `customer_id`) are forced into every call. | 9.3 |
| Rate limiting and audit logging | Limits per client and toward the upstream API. JSON Lines audit log of every call, with redaction. | 10 |
| Streaming / background support | `longRunning`: the server polls the API job and streams MCP progress notifications | 11 |
| Versioning | Semver server version, deprecation with `replacedBy`, compatibility rules | 12 |

## 3. Tech stack decision

**Choice: TypeScript on Node.js 20+, using the official `@modelcontextprotocol/sdk` (v1.x; 1.30.1 is current on npm).**

| Need | TypeScript | Python |
|---|---|---|
| Official MCP SDK | Yes, reference implementation | Yes (`mcp` / FastMCP) |
| Remote transport (Streamable HTTP) + OAuth helpers | First-class in SDK | Supported |
| Input and output validation | zod → JSON Schema; SDK validates `structuredContent` against `outputSchema` | pydantic |
| Code generation | Emits typed code; `tsc` catches mistakes at build time | Untyped by default |
| Deploy targets | Node, Docker, serverless | Docker, Lambda |
| Distribute to a company | one npm package / `npx` | pip/venv |

Verified in the SDK docs (v1.29/1.30):
- `registerTool` (with `inputSchema`, `outputSchema`, `annotations`), `registerResource` (+ `ResourceTemplate`), `registerPrompt` (+ `completable` for autocomplete).
- `StdioServerTransport` (local) and `StreamableHTTPServerTransport` (remote; HTTP+SSE is deprecated).
- Progress via `notifications/progress`. Verified OAuth token info reaches handlers as `extra.authInfo` (clientId, scopes).
- Task-based execution exists but is experimental, so v1 uses progress notifications (section 11).

## 4. Manifest overview

Schema: [`schema/manifest.schema.json`](../schema/manifest.schema.json). Complete example using every
feature: [`examples/acme-outdoor.yaml`](../examples/acme-outdoor.yaml).

| Section | Purpose |
|---|---|
| `manifestVersion` | Always `"1"` for now |
| `company` | Name, website, default currency |
| `server` | Name, version, `instructions` for the AI, transports, HTTP port/path/public URL |
| `api` | The existing backend: base URL, timeout, headers, upstream auth, upstream rate limit |
| `mappings` | Named field maps: standard field ← dot path in the company's JSON |
| `tools` | Standard sales tools to enable, each bound to an endpoint |
| `customTools` | Company-specific tools |
| `resources` | Readable data |
| `prompts` | Reusable prompt templates |
| `access` | Who may connect and what each client may use |
| `audit` | Where the audit log goes |

### 4.1 Upstream auth (server → company API)

| `type` | Fields |
|---|---|
| `none` | – |
| `api_key` | `in` (header/query), `name`, `valueEnv` |
| `bearer` | `tokenEnv` |
| `basic` | `usernameEnv`, `passwordEnv` |
| `oauth2_client_credentials` | `tokenUrl`, `clientIdEnv`, `clientSecretEnv`, `scopes` |

**Rule:** secrets never appear in the manifest. Credential fields hold environment variable *names*
(`^[A-Z][A-Z0-9_]*$`), so a pasted key such as `sk_live_…` fails validation.

### 4.2 Request/response binding (the translation layer)

```yaml
request:
  method: GET | POST | PUT | PATCH | DELETE
  path: /products/{product_id}     # {arg} from tool arguments, {ctx.key} from the client's tenant context
  query:   { q: "{query}" }        # empty placeholders are dropped
  headers: { X-Locale: "{locale}" }
  body:    { lines: "{items}" }    # a whole-string placeholder keeps the argument's type (array, number…)
response:
  itemsPath: data                  # list endpoints
  recordPath: data                 # detail endpoints
  nextCursorPath: meta.next        # pagination
  mapping: product                 # a name from `mappings`, or raw
```

## 5. Tools

### 5.1 Standard sales tools

Source of truth: [`src/catalog/tools.json`](../src/catalog/tools.json).

| Tool | Kind | Default scope | Arguments (* = required) |
|---|---|---|---|
| `search_products` | read | catalog:read | query*, category, limit (1–50), cursor |
| `get_product_details` | read | catalog:read | product_id* |
| `list_categories` | read | catalog:read | – |
| `check_stock` | read | stock:read | product_id*, location |
| `get_pricing` | read | pricing:read | product_id*, quantity, customer_id |
| `create_quote` | write | quotes:write | customer_id*, items*, notes, confirm |
| `create_order` | write | orders:write | quote_id*, confirm |
| `get_order_status` | read | orders:read | order_id* |

### 5.2 Custom tools

Any endpoint can become a tool. The example defines `verify_qr_code` (read), `send_quote_email` (write)
and `generate_sales_report` (long-running). A custom tool declares `name`, `title`, `description`,
`kind` (`read` | `write` | `destructive`), `args`, `scope`, `request` and `response`.

MCP annotations are set from `kind`:

| kind | readOnlyHint | destructiveHint | confirmation default |
|---|---|---|---|
| read | true | false | none |
| write | false | false | preview + `confirm: true` |
| destructive | false | true | preview + `confirm: true` |

All tools set `openWorldHint: true`, because they call an external API. `idempotent: true` sets `idempotentHint`.

### 5.3 Description quality rules

The AI picks tools from their description text, so descriptions are held to a standard:
1. Say **what** the tool does, **when** to use it, and **what it returns**, in 1–3 sentences.
2. Name related tools where order matters ("Use only after create_quote succeeded").
3. Describe every argument, with a format example (`YYYY-MM-DD`, "SKU or product id").
4. The schema rejects tool descriptions under 40 characters and resource/prompt descriptions under 20.
5. `server.instructions` gives the AI the overall workflow (search → stock → price → preview → confirm).

## 6. Structured, predictable outputs

- Each tool's `outputSchema` is generated from its field map (e.g. `product` → `{id, name, price, currency, url, …}`). List tools return `{items: [...], nextCursor?}`.
- The handler returns `structuredContent` (validated by the SDK against `outputSchema`) plus the same JSON as text, for older clients.
- Unmapped fields are dropped, so the AI always sees the same shape whatever the upstream API sends.
- Errors return `isError: true` with a fixed shape: `{ error: { code, message, retryable } }`, where `code` is one of `not_found`, `invalid_input`, `unauthorized`, `forbidden`, `rate_limited`, `upstream_error`, `timeout`, `limit_exceeded`, `confirmation_required`.
- Upstream 5xx errors and timeouts are retried twice with backoff. 4xx errors are not retried.

## 7. Resources

```yaml
resources:
  - name: product_record
    uri: catalog://products/{product_id}   # template → registered with ResourceTemplate
    request: { method: GET, path: /products/{product_id} }
    response: { recordPath: data, mapping: product }
    list: { method: GET, path: /products }  # lets clients browse instances
  - name: return_policy
    uri: docs://policies/returns            # fixed URI
    file: docs/return-policy.md             # bundled file, served as-is
```

A resource is backed by either an API `request` or a bundled `file`, never both. Every URI template
variable must be sent to the API. Resources honour `scope` and tenant context, like tools do.

## 8. Prompts

```yaml
prompts:
  - name: prepare_quote
    args: { customer_id: { required: true }, items: { required: true } }
    template: "Prepare a quote for customer {customer_id}. They want: {items}. … only create the quote after I approve it."
    embedResources: [docs://policies/returns]   # attached as context
```

Prompts appear in the client as ready-made tasks (for example as slash commands in Claude). An argument can set
`completeFrom: <tool>` for autocomplete. The validator checks that every placeholder is declared and
that embedded resources exist.

## 9. Authentication and authorization

### 9.1 Who can connect

| Transport | Identity |
|---|---|
| `stdio` | The local user. Gets `access.stdioScopes`. |
| `http` + `access.apiKeys` | Each client sends its own key (`Authorization: Bearer <key>`). The server stores only a SHA-256 hash (`keyHashEnv`). |
| `http` + `access.oauth` | OAuth 2.1 access tokens from the company's identity provider, checked against `issuer`, `audience` and JWKS. The server publishes protected-resource metadata (RFC 9728), as the MCP authorization spec requires. |

The validator refuses an `http` transport with no `apiKeys` or `oauth`. There are no open endpoints.

### 9.2 Scopes

Every tool, resource and prompt has a scope (`area:action`, e.g. `quotes:write`). A client sees only the
items its scopes allow. `tools/list`, `resources/list` and `prompts/list` are filtered per client, and
calls outside a client's scopes return `forbidden`.

### 9.3 Tenant isolation on a shared server

A client can carry fixed `context` values (API keys) or claim-mapped values (OAuth `contextClaims`),
e.g. `customer_id: C-2044`. When a request uses `{customer_id}` and the client has a `customer_id`
context, **the context value wins over whatever the AI passed**. Endpoints can also use `{ctx.customer_id}`
directly. The validator requires every client to define any `ctx.*` key that is used, so no call goes
out unbound. Result: a reseller's assistant can only price, quote and read orders for its own account.

## 10. Rate limiting and audit logging

- **Per client:** `access.apiKeys[].rateLimit` / `access.oauth.rateLimit` (token bucket, requests per minute and burst). Over the limit returns `rate_limited` with a retry-after hint.
- **Upstream:** `api.rateLimit` protects the company API across all clients.
- **Audit log:** one JSON event per tool call, resource read or prompt fetch:

```json
{"ts":"2026-09-24T19:30:00Z","clientId":"northwind-reseller","type":"tool","name":"create_quote",
 "args":{"customer_id":"C-2044","items":[{"product_id":"TB-100","quantity":20}],"confirm":true},
 "outcome":"ok","durationMs":412,"upstreamStatus":201,"requestId":"…"}
```

Sinks: `stderr`, `file` (JSON Lines) or `http`. Fields listed in `redactFields` are replaced with
`"[redacted]"`. Secrets and auth headers are never logged.

## 11. Long-running actions

For endpoints that start a background job (reports, bulk imports):

```yaml
longRunning:
  jobIdPath: data.job_id
  statusRequest: { method: GET, path: /reports/{job_id} }
  statusPath: data.state
  doneValues: [complete]
  failedValues: [failed]
  progressPath: data.percent
  pollIntervalMs: 2000
  timeoutMs: 300000
```

The generated handler starts the job, polls the status, and sends `notifications/progress` (when the
client supplies a progress token), so the user sees progress instead of a frozen call. It honours
cancellation (`extra.signal`) and returns the final result as structured output. When MCP tasks
leave experimental status, the same config will also map to task-based execution.

## 12. Versioning

| What | Rule |
|---|---|
| Manifest format | `manifestVersion: "1"`. A future `"2"` ships with a migration command. |
| Generated server | `server.version` (semver), sent to clients in the MCP `serverInfo` |
| Adding a tool, resource, prompt or optional argument | minor bump, non-breaking |
| Better descriptions, bug fixes | patch bump |
| Removing or renaming a tool or argument, changing the output shape | **breaking**: add a new tool (e.g. `get_pricing_v2`), mark the old one `deprecated: true, replacedBy: get_pricing_v2`, keep it for at least one minor release, then remove it in the next major |
| MCP protocol version | negotiated automatically by the SDK |

Deprecated tools stay callable. Their description is prefixed with "Deprecated: use X instead.", so the AI switches over.

## 13. Safety model for write tools

1. **Off unless listed.** A tool missing from the manifest is never generated. `create_order` in the example is `enabled: false`.
2. **Two-step confirmation** (default for write/destructive): the first call returns a preview and saves nothing. Only a second call with `confirm: true` submits.
3. **Spending cap:** `maxTotal` refuses submissions above a set amount.
4. **Least privilege:** scopes per client. Upstream API key limited to what the manifest uses.
5. **No secrets in output or logs.**

## 14. Components and next phases

| Component | Folder | Status |
|---|---|---|
| Manifest schema | `schema/manifest.schema.json` | **Done** |
| Tool catalog | `src/catalog/tools.json` | **Done** |
| Validator + 20 tests | `scripts/` | **Done** |
| CLI (`validate`, `generate`, `check-version`) | `src/cli/` | **Done** (v0.3). `init` and `dev` are still to do. |
| Generator + TS server template + runtime (http client, auth, mapping, scopes, rate limit, audit, long-running) | `src/generator/`, `templates/server-ts/` | **Done** (v0.3) |
| Mock API, end-to-end tests with an MCP client | `examples/mock-api/`, `test/` | **Done** (v0.3): 37 new tests |
| Claude demo, company setup guide, packaging | `docs/` | Thread 3 |

### Generated server layout (target)

```
acme-outdoor-sales/
  src/index.ts          # stdio or http; server instructions
  src/tools/*.ts        # one file per tool (input + output schema, handler)
  src/resources/*.ts    # one file per resource
  src/prompts/*.ts      # one file per prompt
  src/runtime/          # http, upstreamAuth, clientAuth, scopes, tenant, rateLimit, audit, longRunning, map
  manifest.yaml, .env.example, README.md
```

## 15. How a company will use it (target flow)

1. `npx mcp-builder init` → creates `manifest.yaml`.
2. Fill in API, tools, resources, prompts, clients.
3. `npx mcp-builder validate manifest.yaml` → fix reported issues.
4. `npx mcp-builder generate manifest.yaml --out ./acme-outdoor-sales`.
5. Set env vars from `.env.example`. Run `npm install && npm run build`.
6. Connect it to Claude (stdio locally, or the HTTP URL as a custom connector).

## 16. Open questions (defaults chosen)

1. Direct database source in v1? *Default: no, go through the HTTP API. Add it as a v2 `source` type.*
2. Hosting? *Default: the company self-hosts.*
3. OAuth provider to test against in thread 2? *Default: a local mock issuer in tests.*

## 17. Implementation notes (v0.3 generator)

Decisions made while building the generator. Each one is covered by a test in `test/`.

| Topic | What the generated server does | Why |
|---|---|---|
| Error format | `isError: true` and the fixed `{ error: { code, message, retryable, retryAfterMs? } }` JSON in the **text** content. `structuredContent` is left out on errors. | The official MCP client checks any `structuredContent` against the tool's `outputSchema`, even on errors, and rejects the call if it does not match (found in testing). |
| Bad input, unknown tool, missing scope | Same fixed error shape (`invalid_input`, `not_found`, `forbidden`). Unknown arguments are rejected. | Tools are registered on the low-level server so the SDK's own plain-text errors never reach the AI. |
| Output shapes | read record → mapped object; list → `{ items, nextCursor? }`; write → `{ status: "preview" \| "done", preview?, result? }`; long-running → `{ jobId, state, result }`. Mapped fields are always present (null when missing). | One predictable shape per tool. |
| Retries | Only read and `idempotent` tools are retried (5xx and timeouts, twice). Write tools are sent once. | Retrying a write could create a quote or order twice. |
| HTTP transport | Stateless Streamable HTTP: each POST is authenticated and served by a server built for that client, so `tools/list`, `resources/list` and `prompts/list` only show what the client's scopes allow. Listens on `127.0.0.1` unless `HOST` is set. | No session state to leak between tenants. |
| Items without a `scope` | Visible to every authenticated client (e.g. the return policy). | The example leaves public documents unscoped. |
| OAuth tenant claim | A token without a claim listed in `contextClaims` is refused (403). | Otherwise the client would not be bound to its own tenant. |
| `stdioScopes` default | Every scope used by a read tool. | Matches the schema description. |
| Versioning | `mcp-builder check-version old.yaml new.yaml` lists the changes, the semver bump they need, and blocks removing a tool that was never deprecated. | Section 12 rules, enforced. |
| OAuth providers (v0.3.1) | `audience` may be a list, `additionalIssuers` adds accepted issuers, and `scopeClaim` may list several claims that are merged. Azure AD: `scopeClaim: [roles, scp]`, audience `[<client id>, api://<client id>]`. The subject is `oid` when present. See `examples/acme-outdoor-azure.yaml`. | Azure AD issues v1 or v2 tokens depending on app settings, and puts permissions in `roles` (app roles) or `scp` (delegated). |
| Test/staging | `API_BASE_URL` overrides `api.baseUrl`; `MCP_OAUTH_JWKS_URL` overrides the OAuth key location; `AUDIT_LOG_PATH` overrides the audit file. | Same build runs against a mock, staging or production API. |
| **Not done yet** | `maxTotal` is accepted but **not enforced**: the generator prints a warning. The example keeps `create_order` disabled. | The amount is only known after the company API computes it; needs a design decision (e.g. a price-check request before submitting). |

