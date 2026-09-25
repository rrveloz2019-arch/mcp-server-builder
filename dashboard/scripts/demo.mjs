#!/usr/bin/env node
// Demo mode: try the dashboard on your own computer with one command.
//   cd dashboard && npm install && npm run demo    then open http://127.0.0.1:8080
//
// Nothing here is used in production. It runs the real dashboard code, but:
// - the database is PostgreSQL running inside this process (PGlite), kept in memory
//   and gone when you stop the demo;
// - "Sign in with Microsoft" goes to a local demo page where you pick who to be;
// - it only listens on 127.0.0.1, so nobody else on your network can reach it.

import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { loadConfig } from "../src/config.mjs";
import { openDb } from "../src/db.mjs";
import { createApp } from "../src/app.mjs";
import { startMockOidc } from "../test/mock-oidc.mjs";

const PORT = Number(process.env.PORT ?? 8080);
const DB_PORT = Number(process.env.DEMO_DB_PORT ?? 54329);

const USERS = [
  { oid: randomUUID(), email: "rafael@demo.example", name: "Rafael (admin)", note: "Admin: creates workspaces, invites people, sees the audit log" },
  { oid: randomUUID(), email: "alice@acme-outdoor.example", name: "Alice, Acme Outdoor", note: "Editor in the Acme Outdoor workspace" },
  { oid: randomUUID(), email: "bob@northwind.example", name: "Bob, Northwind", note: "Editor in the Northwind workspace" },
  { oid: randomUUID(), email: "victor@acme-outdoor.example", name: "Victor, Acme Outdoor", note: "Viewer in Acme Outdoor: can open and download, not change" },
  { oid: randomUUID(), email: "mallory@not-invited.example", name: "Mallory (never invited)", note: "Should be refused" },
];

// 1. PostgreSQL in this process, reachable only from this computer.
const pglite = new PGlite();
const pgServer = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: DB_PORT, maxConnections: 1 });
await pgServer.start();

// 2. The stand-in for Microsoft sign-in.
const clientId = "demo-client";
const clientSecret = randomBytes(24).toString("base64url");
const idp = await startMockOidc({ clientId, clientSecret, users: USERS.map((u) => ({ ...u, tid: "demo-tenant" })) });

// 3. The real dashboard, with demo settings (a fresh random encryption key every run).
const config = loadConfig({
  PUBLIC_URL: `http://127.0.0.1:${PORT}`,
  DASHBOARD_INSECURE_DEV: "1",
  OIDC_ISSUER: idp.issuer,
  OIDC_CLIENT_ID: clientId,
  OIDC_CLIENT_SECRET: clientSecret,
  DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  ADMIN_OIDS: USERS[0].oid,
  DATABASE_URL: `postgres://postgres@127.0.0.1:${DB_PORT}/postgres`,
  DATABASE_SSL: "off",
});
const db = await openDb({ ...config.database, max: 1 }, config.dataKey);

// 4. Two client workspaces with invitations, so there is something to look at.
const system = randomUUID();
const acme = await db.createWorkspace("Acme Outdoor (demo)", system);
const northwind = await db.createWorkspace("Northwind (demo)", system);
await db.createInvite(acme.id, USERS[1].email, "editor", system);
await db.createInvite(acme.id, USERS[3].email, "viewer", system);
await db.createInvite(northwind.id, USERS[2].email, "editor", system);

const server = await createApp({ config, db, log: { info: () => {}, error: (m) => console.error(m) } });
server.listen(PORT, "127.0.0.1", () => {
  console.log(`
  MCP Server Builder dashboard: DEMO MODE
  Open  http://127.0.0.1:${PORT}  in your browser.

  Click "Sign in with Microsoft" and pick who you want to be:
    - Rafael (admin), Alice (Acme Outdoor), Bob (Northwind),
      Victor (Acme Outdoor, read-only), Mallory (never invited)
  Use a private window (or another browser) to be two people at once.

  Data is kept in memory and is gone when you stop the demo (Ctrl+C).
`);
});

const stop = async () => { server.close(); await db.close(); await pgServer.stop(); await pglite.close(); idp.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
