#!/usr/bin/env node
// Starts the hosted dashboard. All settings come from environment variables
// (see dashboard/.env.example); an unsafe or missing setting stops start-up.

import { ConfigError, loadConfig } from "./config.mjs";
import { openDb } from "./db.mjs";
import { createApp } from "./app.mjs";

try { process.loadEnvFile(new URL("../.env", import.meta.url)); } catch { /* settings come from the environment */ }

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) { console.error(err.message); process.exit(1); }
  throw err;
}
const db = openDb(config.dbPath, config.dataKey);
const server = await createApp({ config, db });
server.listen(config.port, config.host, () => console.log(`MCP Builder dashboard on ${config.host}:${config.port} (public URL ${config.publicUrl})`));

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
