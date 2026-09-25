# Writing a manifest for your own API

The manifest is one YAML file that describes your existing API. The builder reads it and generates the MCP server.
Your API does not change. This guide takes you from an empty folder to a working manifest, step by step.

- Full reference for every field: [SPEC.md](SPEC.md) and [`schema/manifest.schema.json`](../schema/manifest.schema.json)
- An example that uses every feature: [`examples/acme-outdoor.yaml`](../examples/acme-outdoor.yaml)

## Step 0: Start from the starter file

```bash
mcp-builder init my-server          # creates my-server/manifest.yaml
cd my-server
```

The starter works as-is against the demo API (`mcp-builder mock-api`), so you can generate and try it before changing anything.
Then change one section at a time, and run `mcp-builder validate manifest.yaml` after each change.
Prefer a form? `mcp-builder intake` opens a local web wizard that builds the same manifest step by step and validates it as you type.
The validator names the field and the problem, for example `tools.check_stock: placeholder {sku} is not an argument (allowed: product_id, location)`.

## Step 1: `company` and `server`

```yaml
manifestVersion: "1"          # always "1" for now

company:
  name: My Company
  defaultCurrency: USD

server:
  name: my-company-sales      # lowercase, dashes; becomes the package and command name
  version: 0.1.0              # bump it when you change the manifest (see "Changing a live server")
  description: Product search and stock for My Company.
  instructions: >-            # read by the AI: when to use the server and the rules it must follow
    Search first, then check stock before recommending a product.
  transports: [stdio]         # stdio = local; add http for remote clients (Step 6)
```

`instructions` matter: the AI reads them every time it connects. Put business rules here, such as
"never create a quote without showing the preview first".

## Step 2: `api`: where your API is and how to log in

```yaml
api:
  baseUrl: https://api.my-company.com/v1
  timeoutMs: 8000
  auth:
    type: api_key             # none | api_key | bearer | basic | oauth2_client_credentials
    in: header
    name: X-Api-Key
    valueEnv: MY_COMPANY_API_KEY
  rateLimit:
    requestsPerMinute: 120    # the server never calls your API faster than this
```

**Never paste a secret into the manifest.** Fields ending in `Env` hold the *name* of an environment variable.
The value goes in the generated server's `.env` file. A pasted key fails validation on purpose.

| `type` | Fields |
|---|---|
| `none` | none |
| `api_key` | `in` (`header` or `query`), `name`, `valueEnv` |
| `bearer` | `tokenEnv` |
| `basic` | `usernameEnv`, `passwordEnv` |
| `oauth2_client_credentials` | `tokenUrl`, `clientIdEnv`, `clientSecretEnv`, `scopes` |

## Step 3: `mappings`: translate your field names

The AI always sees the same standard field names, whatever your API calls them.
Left side is the standard field; right side is the dot path in **one record** of your API's JSON.

If your API returns this product:

```json
{ "sku": "TB-100", "title": "TrailBlazer Boot", "pricing": { "list": 149.0, "currency": "USD" }, "media": [{ "url": "https://..." }] }
```

the mapping is:

```yaml
mappings:
  product:
    id: sku
    name: title
    price: pricing.list
    currency: pricing.currency
    imageUrl: media.0.url      # numbers index into arrays
```

The standard fields used by the example are `product`, `stock`, `price`, `quote` and `order`
(see `mappings` in [`examples/acme-outdoor.yaml`](../examples/acme-outdoor.yaml)). Fields you do not map are left out.
To pass your records through unchanged, use `mapping: raw` in a tool instead.

## Step 4: `tools`: turn on the standard sales tools

There are 8 standard tools. Their arguments, descriptions and permissions are already written
([`src/catalog/tools.json`](../src/catalog/tools.json)). You only say which endpoint each one calls.

| Tool | Kind | Arguments you can use in the request |
|---|---|---|
| `search_products` | read | `query`, `category`, `limit`, `cursor` |
| `get_product_details` | read | `product_id` |
| `list_categories` | read | none |
| `check_stock` | read | `product_id`, `location` |
| `get_pricing` | read | `product_id`, `quantity`, `customer_id` |
| `create_quote` | write | `customer_id`, `items`, `notes` |
| `create_order` | write | `quote_id` |
| `get_order_status` | read | `order_id` |

```yaml
tools:
  search_products:
    request:
      method: GET
      path: /products
      query:
        q: "{query}"             # {argument} is replaced by the tool argument; empty ones are dropped
        limit: "{limit}"
    response:
      itemsPath: data            # where the list is in the response
      nextCursorPath: meta.next  # optional: for paging
      mapping: product

  get_product_details:
    request:
      method: GET
      path: /products/{product_id}
    response:
      recordPath: data           # where the single record is
      mapping: product
```

Leave out a tool you do not want. A tool can also be listed with `enabled: false` to keep its setup but hide it.

**Write tools are safe by default.** `create_quote`, `create_order` and custom `write` tools first return a
**preview** of the exact request; the call only happens when the AI calls again with `confirm: true`
after the user agreed. Keep `requireConfirmation: true` unless you have a strong reason.

## Step 5 (optional): custom tools, resources and prompts

**Custom tools** turn any other endpoint into a tool. You write the description and arguments:

```yaml
customTools:
  - name: verify_qr_code
    title: Verify product QR code
    description: >-                 # say what it does AND when to use it; the AI picks tools by this text
      Check whether a QR code scanned from a product label is genuine. Use when a customer
      asks if an item is authentic.
    kind: read                      # read | write | destructive
    scope: catalog:read             # the permission a client needs to see it
    args:
      code: { type: string, required: true, description: The raw text decoded from the QR code. }
    request:
      method: POST
      path: /authenticity/verify
      body: { qr: "{code}" }
    response: { recordPath: data, mapping: raw }
```

For an endpoint that starts a job and must be polled, add `longRunning` (see `generate_sales_report` in the example).

**Resources** are data the AI can open directly: an API record (`request`) or a bundled file (`file`, path relative to the manifest).
**Prompts** are ready-made tasks that appear in Claude as slash commands.
Both are shown in [`examples/acme-outdoor.yaml`](../examples/acme-outdoor.yaml) and explained in SPEC sections 7 and 8.

## Step 6: `access`: who may connect

Every tool, resource and prompt has a **scope** such as `catalog:read` or `quotes:write`.
A client only sees the items its scopes allow.

```yaml
access:
  stdioScopes: [catalog:read, stock:read]   # the local user (stdio)

  # Needed only when transports include http. Pick API keys, OAuth, or both.
  apiKeys:
    - clientId: sales-team
      keyHashEnv: SALES_TEAM_KEY_SHA256     # only the hash of the key is stored
      scopes: [catalog:read, stock:read, pricing:read, quotes:write]
    - clientId: reseller-northwind
      keyHashEnv: NORTHWIND_KEY_SHA256
      scopes: [catalog:read, pricing:read]
      context:
        customer_id: C-2044                 # this client can only ever act as customer C-2044
```

`context` locks a value for that client: whatever the AI sends as `customer_id`, the server uses `C-2044`.
How to create keys and set up OAuth (for example Azure AD) is in [RUN-AND-CONNECT.md](RUN-AND-CONNECT.md).

## Step 7: `audit`

```yaml
audit:
  enabled: true
  sink: file                  # stderr | file | http
  path: logs/audit.jsonl
  redactFields: [message]     # arguments to hide in the log
```

Every tool call is logged with the client, the tool, the arguments and the result status.

## Step 8: Validate, generate, try

```bash
mcp-builder validate manifest.yaml
mcp-builder generate manifest.yaml --out ../my-company-sales
```

Then follow [RUN-AND-CONNECT.md](RUN-AND-CONNECT.md), or steps 4 to 6 of the [Quickstart](../QUICKSTART.md).
Run `generate` again after every manifest change; it only overwrites folders it created itself.

## Changing a live server

Keep the old manifest, then compare:

```bash
mcp-builder check-version old-manifest.yaml manifest.yaml
```

It lists every change, says which version bump it needs (major, minor or patch), and refuses to remove a tool
that was not first marked `deprecated: true` in an earlier version, so connected clients do not break without warning.
