# Generated server template (TypeScript)

`server-ts/` is copied into every generated server:

- `src/runtime/`: the shared runtime (company API client, client auth, scopes, tenant context, rate limits, audit log, long-running jobs, resources, prompts)
- `scripts/hash-key.mjs`: creates client API keys and their SHA-256 hashes
- `tsconfig.json`

The generator (`src/generator/generate.mjs`) adds the per-manifest files: `src/config.ts`, one file per tool, resource and prompt, `package.json`, `.env.example` and `README.md`.

`starter/manifest.yaml` is the file `mcp-builder init` copies. It is a small, commented manifest that works against the demo API (`mcp-builder mock-api`).
