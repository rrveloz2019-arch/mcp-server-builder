#!/usr/bin/env node
// Azure AD helper for the demo server (examples/acme-outdoor-azure.yaml).
//
//   node examples/azure/azure-demo.mjs token            get a token and show what is in it
//   node examples/azure/azure-demo.mjs check [mcp-url]  get a token and call the running MCP server
//
// Reads AZURE_CLIENT_SECRET from examples/azure/.env (never commit that file).
// Uses the client credentials flow, so the token carries the app roles granted
// to this app registration ("roles" claim).

import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

try { process.loadEnvFile(fileURLToPath(new URL(".env", import.meta.url))); } catch { /* use the real environment */ }

const TENANT = process.env.AZURE_TENANT_ID ?? "e8c9f1fa-4f30-41cc-b2bc-1e9fe8607b5a";
const CLIENT = process.env.AZURE_CLIENT_ID ?? "a676142a-7299-4189-a3ae-12c60fe37306";
const SECRET = process.env.AZURE_CLIENT_SECRET;

async function getToken() {
  if (!SECRET) throw new Error("AZURE_CLIENT_SECRET is not set. Put it in examples/azure/.env (see examples/azure/README.md, step 4).");
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT, client_secret: SECRET, scope: `api://${CLIENT}/.default` }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Azure refused the token request (${res.status}): ${json.error}: ${String(json.error_description).split("\r\n")[0]}`);
  return json.access_token;
}

const claims = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));

async function main([cmd, url = "http://127.0.0.1:3000/mcp"]) {
  if (cmd === "token") {
    const t = await getToken();
    const c = claims(t);
    console.log("✓ Got a token from Azure AD");
    console.log(`  version (ver): ${c.ver}   ${c.ver === "2.0" ? "" : "← set requestedAccessTokenVersion to 2 (README step 3)"}`);
    console.log(`  issuer (iss):  ${c.iss}`);
    console.log(`  audience (aud): ${c.aud}`);
    console.log(`  app roles (roles): ${(c.roles ?? []).join(", ") || "none ← grant app roles to this app (README step 5)"}`);
    console.log(`  expires: ${new Date(c.exp * 1000).toISOString()}`);
    return;
  }
  if (cmd === "check") {
    const t = await getToken();
    const client = new Client({ name: "azure-demo", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${t}` } } }));
    const { tools } = await client.listTools();
    console.log(`✓ Signed in with Azure AD. The server shows ${tools.length} tools: ${tools.map((x) => x.name).join(", ")}`);
    if (tools.some((x) => x.name === "list_categories")) {
      const r = await client.callTool({ name: "list_categories", arguments: {} });
      console.log(`✓ list_categories: ${r.content[0].text}`);
    }
    await client.close();
    return;
  }
  console.log("Usage: node examples/azure/azure-demo.mjs token | check [mcp-url]");
  process.exitCode = 2;
}

main(process.argv.slice(2)).catch((err) => { console.error(`✗ ${err.message}`); process.exitCode = 1; });
