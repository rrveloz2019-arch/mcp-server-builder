# MCP Server Builder

Turn a company's existing backend API into an **MCP server**, so AI assistants like Claude can use it:
search products, check stock and pricing, create quotes, read documents, and run company-specific actions.
The company's own code does not change.

> **Status:** v0.2, design phase. The manifest format, schema, tool catalog and validator are ready.
> The generator that produces the server comes next.

## What a generated server provides

- **Tools**: 8 standard sales tools plus any custom tools (for example, verify a QR code or email a quote)
- **Resources**: product records and documents the AI can read directly
- **Prompts**: ready-made tasks such as "Prepare a quote"
- **Access control**: per-client API keys or OAuth, scopes, and tenant isolation on a shared server
- **Rate limits and an audit log** of everything the AI did
- **Progress updates** for long-running actions
- **Versioning** with safe deprecation

## Try the validator

Requires Node.js 20 or newer.

```bash
npm install
npm run validate -- examples/acme-outdoor.yaml
npm test
```

Expected output:

```
✓ examples/acme-outdoor.yaml
  tools (10): search_products, get_product_details, list_categories, check_stock, get_pricing, create_quote, get_order_status, verify_qr_code, send_quote_email, generate_sales_report
  resources (2): product_record, return_policy
  prompts (2): prepare_quote, compare_products
  clients (3): acme-sales-team, northwind-reseller, oauth
```

`npm test` runs 20 tests. All should pass.

## Repository layout

```
docs/SPEC.md                    Spec & architecture (start here)
schema/manifest.schema.json     JSON Schema for the manifest
examples/acme-outdoor.yaml      Complete example manifest (uses every feature)
examples/docs/return-policy.md  File served as a resource by the example
src/catalog/tools.json          Standard sales tools: arguments, scopes, descriptions
scripts/validate-manifest.mjs   Manifest validator (+ tests)
templates/                      Generated server template (next phase)
```
