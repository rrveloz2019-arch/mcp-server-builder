# Quickstart: from nothing to Claude using your server (about 10 minutes)

You will install the builder, generate an MCP server for the demo company **Acme Outdoor**,
run it against a fake Acme API, and ask Claude a sales question that it answers with the server's tools.

The commands are for macOS or Linux (bash or zsh). On Windows, use Git Bash or WSL.

## What you need

- **Node.js 20.12 or newer**. Check with `node --version`.
- **A Claude client**: Claude Code (`claude` command) or the Claude Desktop app.

## Step 1: Install the builder

```bash
npm install -g github:rrveloz2019-arch/mcp-server-builder
mcp-builder --version
```

You should see a version number such as `0.4.0`.

## Step 2: Start the demo company API (terminal 1)

```bash
mcp-builder mock-api
```

Expected: `Mock Acme API on http://127.0.0.1:4010/v2 (X-Api-Key: test-upstream-key). Press Ctrl+C to stop.`
Leave this terminal open. It stands in for a real company API.

## Step 3: Create, check and generate (terminal 2)

```bash
mkdir mcp-demo && cd mcp-demo
mcp-builder init . --example                        # copies the Acme example manifest
mcp-builder validate manifest.yaml                  # ✓ 10 tools, 2 resources, 2 prompts
mcp-builder generate manifest.yaml --out acme-outdoor-sales
```

## Step 4: Build the server and give it its settings

```bash
cd acme-outdoor-sales
npm install
npm run build
printf 'ACME_API_KEY=test-upstream-key\nAPI_BASE_URL=http://127.0.0.1:4010/v2\n' > .env
```

`.env` holds the secret the server uses to call the company API. It is never committed (it is in `.gitignore`).

## Step 5: Connect it to Claude

**Claude Code** (run inside `acme-outdoor-sales`):

```bash
claude mcp add acme-outdoor-sales -- node "$(pwd)/dist/index.js" --stdio
claude mcp list                                     # expect: acme-outdoor-sales ... ✓ Connected
```

**Claude Desktop**: open *Settings → Developer → Edit Config* and add the block below.
Replace the path with the output of `echo "$(pwd)/dist/index.js"`, save, then fully quit and reopen Claude Desktop.

```json
{
  "mcpServers": {
    "acme-outdoor-sales": {
      "command": "node",
      "args": ["/FULL/PATH/acme-outdoor-sales/dist/index.js", "--stdio"]
    }
  }
}
```

The server reads `.env` from its own folder, so no `env` block is needed.

## Step 6: Ask Claude

> Search Acme for waterproof hiking boots, check stock, and price 10 of the best match for customer C-1001.

Expected answer (the numbers come from the demo API):

- TrailBlazer Hiking Boot (TB-100)
- 42 in stock in NYC, 0 in LAX (restock 2026-10-15)
- $141.55 per unit with a 5% discount, $1,415.50 total

Then try *"Create the quote"*. Claude first shows a **preview** and waits. The quote is created only after you say yes.

## Next steps

| I want to... | Read |
|---|---|
| Describe my own company's API | [docs/MANIFEST-GUIDE.md](docs/MANIFEST-GUIDE.md) (start with `mcp-builder init my-server`) |
| Run it for remote users, with API keys or Azure AD sign-in, or add it to claude.ai | [docs/RUN-AND-CONNECT.md](docs/RUN-AND-CONNECT.md) |
| Understand every option | [docs/SPEC.md](docs/SPEC.md) |

## If something goes wrong

| Symptom | Fix |
|---|---|
| `mcp-builder: command not found` | Your npm global folder is not on `PATH`. Run `npm prefix -g` and add its `bin` folder to `PATH`. |
| `EADDRINUSE` when starting the mock API | Port 4010 is taken. Run `mcp-builder mock-api 4011` and use `4011` in `API_BASE_URL`. |
| Error `upstream_error`: *The company API refused the server's credentials* | `ACME_API_KEY` in `.env` is missing or wrong. |
| Error `upstream_error`: *Could not reach the company API* | The mock API (terminal 1) is not running, or `API_BASE_URL` in `.env` is wrong. |
| Claude shows no Acme tools | Run `claude mcp list`. For Claude Desktop, check the path is absolute and restart the app. |
