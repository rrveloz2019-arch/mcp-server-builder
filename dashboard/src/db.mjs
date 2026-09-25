// Storage (PostgreSQL). Every manifest query takes the workspace id, so data
// from one workspace can never be read through another workspace's id.
// Manifest contents are sealed (crypto.mjs) before they reach the database.
// All queries use parameters ($1, $2, ...); nothing is concatenated into SQL.

import { randomUUID } from "node:crypto";
import pg from "pg";
import { open, seal, sha256 } from "./crypto.mjs";

// Timestamps are epoch milliseconds in BIGINT columns; read them back as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY, oid TEXT NOT NULL UNIQUE, email TEXT NOT NULL, name TEXT,
  created_at BIGINT NOT NULL, last_login_at BIGINT, disabled BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS users_email ON users(email);
CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY, name TEXT NOT NULL, created_at BIGINT NOT NULL, created_by UUID NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by UUID NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, accepted_at BIGINT
);
CREATE INDEX IF NOT EXISTS invites_email ON invites(email);
CREATE TABLE IF NOT EXISTS manifests (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sealed TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, updated_by UUID NOT NULL
);
CREATE INDEX IF NOT EXISTS manifests_ws ON manifests(workspace_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL, created_at BIGINT NOT NULL, last_seen_at BIGINT NOT NULL, expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_states (
  state_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, code_verifier TEXT NOT NULL, created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id BIGSERIAL PRIMARY KEY, ts BIGINT NOT NULL, user_id UUID, workspace_id UUID,
  action TEXT NOT NULL, target TEXT, outcome TEXT NOT NULL, ip TEXT
);
`;

const LOGIN_STATE_TTL = 10 * 60_000;
const INVITE_TTL = 14 * 24 * 3_600_000;

// ssl: false only for local development/tests (config enforces this);
// otherwise TLS with certificate verification against Node's trusted CAs.
export async function openDb({ url, ssl, max = 10 }, dataKey) {
  const pool = new pg.Pool({ connectionString: url, ssl: ssl ? { rejectUnauthorized: true } : false, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  // A dropped idle connection must not crash the server.
  pool.on("error", () => {});
  await pool.query(SCHEMA);

  const rows = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0] ?? null;
  const count = async (sql, params = []) => (await pool.query(sql, params)).rowCount;
  const now = () => Date.now();
  const aad = (workspaceId, id) => `manifest:${workspaceId}:${id}`;
  const unseal = (row) => ({ id: row.id, revision: row.revision, updatedAt: row.updated_at, ...JSON.parse(open(dataKey, row.sealed, aad(row.workspace_id, row.id))) });

  const db = {
    pool,
    query: (sql, params) => pool.query(sql, params),
    close: () => pool.end(),

    // ---- users ----
    userByOid: (oid) => one("SELECT * FROM users WHERE oid = $1", [oid]),
    userById: (id) => one("SELECT * FROM users WHERE id = $1", [id]),
    userByEmail: (email) => one("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]),
    async createUser({ oid, email, name }) {
      return one("INSERT INTO users (id, oid, email, name, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING *", [randomUUID(), oid, email, name ?? null, now()]);
    },
    touchLogin: (id, email, name) => pool.query("UPDATE users SET last_login_at = $1, email = $2, name = $3 WHERE id = $4", [now(), email, name ?? null, id]),
    listUsers: () => rows("SELECT id, email, name, created_at, last_login_at, disabled FROM users ORDER BY email"),
    setUserDisabled: (id, disabled) => pool.query("UPDATE users SET disabled = $1 WHERE id = $2", [!!disabled, id]),

    // ---- workspaces & membership ----
    async createWorkspace(name, createdBy) {
      const id = randomUUID();
      await pool.query("INSERT INTO workspaces (id, name, created_at, created_by) VALUES ($1, $2, $3, $4)", [id, name, now(), createdBy]);
      return { id, name };
    },
    workspace: (id) => one("SELECT id, name, created_at FROM workspaces WHERE id = $1", [id]),
    allWorkspaces: () => rows(`SELECT w.id, w.name, w.created_at,
        (SELECT COUNT(*)::int FROM memberships m WHERE m.workspace_id = w.id) AS members,
        (SELECT COUNT(*)::int FROM manifests x WHERE x.workspace_id = w.id) AS manifests
      FROM workspaces w ORDER BY w.name`),
    workspacesForUser: (userId) => rows("SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 ORDER BY w.name", [userId]),
    membership: (workspaceId, userId) => one("SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId]),
    members: (workspaceId) => rows("SELECT u.id, u.email, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY u.email", [workspaceId]),
    removeMember: (workspaceId, userId) => count("DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId]),
    deleteWorkspace: (id) => count("DELETE FROM workspaces WHERE id = $1", [id]),

    // ---- invites (matched by verified email at first sign-in) ----
    async createInvite(workspaceId, email, role, createdBy) {
      const id = randomUUID();
      await pool.query("INSERT INTO invites (id, workspace_id, email, role, created_by, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [id, workspaceId, email.toLowerCase(), role, createdBy, now(), now() + INVITE_TTL]);
      return { id, email: email.toLowerCase(), role };
    },
    hasOpenInvite: async (email) => !!(await one("SELECT 1 FROM invites WHERE email = $1 AND accepted_at IS NULL AND expires_at > $2", [email.toLowerCase(), now()])),
    invites: (workspaceId) => rows("SELECT id, email, role, created_at, expires_at, accepted_at FROM invites WHERE workspace_id = $1 ORDER BY created_at DESC", [workspaceId]),
    revokeInvite: (workspaceId, id) => count("DELETE FROM invites WHERE workspace_id = $1 AND id = $2 AND accepted_at IS NULL", [workspaceId, id]),
    // One transaction: memberships and "accepted" marks are written together or not at all.
    async acceptInvites(user) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const open = (await client.query("SELECT * FROM invites WHERE email = $1 AND accepted_at IS NULL AND expires_at > $2 FOR UPDATE", [user.email.toLowerCase(), now()])).rows;
        for (const inv of open) {
          await client.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role", [inv.workspace_id, user.id, inv.role]);
          await client.query("UPDATE invites SET accepted_at = $1 WHERE id = $2", [now(), inv.id]);
        }
        await client.query("COMMIT");
        return open.length;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally { client.release(); }
    },

    // ---- manifests (always scoped by workspace) ----
    async listManifests(workspaceId) {
      return (await rows("SELECT * FROM manifests WHERE workspace_id = $1 ORDER BY updated_at DESC", [workspaceId])).map((r) => {
        const m = unseal(r);
        return { id: m.id, name: m.name, revision: m.revision, updatedAt: m.updatedAt };
      });
    },
    async getManifest(workspaceId, id) {
      const row = await one("SELECT * FROM manifests WHERE workspace_id = $1 AND id = $2", [workspaceId, id]);
      return row ? unseal(row) : null;
    },
    async createManifest(workspaceId, { name, manifest, files }, userId) {
      const id = randomUUID();
      const t = now();
      await pool.query("INSERT INTO manifests (id, workspace_id, sealed, created_at, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, workspaceId, seal(dataKey, JSON.stringify({ name, manifest, files }), aad(workspaceId, id)), t, t, userId]);
      return db.getManifest(workspaceId, id);
    },
    // Optimistic locking: the caller sends the revision it edited; a stale save is refused.
    async updateManifest(workspaceId, id, { name, manifest, files }, revision, userId) {
      const changed = await count("UPDATE manifests SET sealed = $1, revision = revision + 1, updated_at = $2, updated_by = $3 WHERE workspace_id = $4 AND id = $5 AND revision = $6",
        [seal(dataKey, JSON.stringify({ name, manifest, files }), aad(workspaceId, id)), now(), userId, workspaceId, id, revision]);
      return changed ? db.getManifest(workspaceId, id) : null;
    },
    deleteManifest: (workspaceId, id) => count("DELETE FROM manifests WHERE workspace_id = $1 AND id = $2", [workspaceId, id]),

    // ---- sessions (only the token's hash is stored) ----
    createSession: (token, userId, csrf, absoluteMs) => {
      const t = now();
      return pool.query("INSERT INTO sessions (token_hash, user_id, csrf, created_at, last_seen_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)", [sha256(token), userId, csrf, t, t, t + absoluteMs]);
    },
    session: (token) => one("SELECT * FROM sessions WHERE token_hash = $1", [sha256(token)]),
    touchSession: (token) => pool.query("UPDATE sessions SET last_seen_at = $1 WHERE token_hash = $2", [now(), sha256(token)]),
    deleteSession: (token) => pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]),
    deleteUserSessions: (userId) => pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]),
    async purgeExpired(idleMs) {
      const t = now();
      await pool.query("DELETE FROM sessions WHERE expires_at < $1 OR last_seen_at < $2", [t, t - idleMs]);
      await pool.query("DELETE FROM login_states WHERE created_at < $1", [t - LOGIN_STATE_TTL]);
    },

    // ---- login state (single use: read and delete in one statement) ----
    saveLoginState: (state, nonce, codeVerifier) => pool.query("INSERT INTO login_states (state_hash, nonce, code_verifier, created_at) VALUES ($1, $2, $3, $4)", [sha256(state), nonce, codeVerifier, now()]),
    async takeLoginState(state) {
      const row = await one("DELETE FROM login_states WHERE state_hash = $1 RETURNING *", [sha256(state)]);
      return !row || now() - row.created_at > LOGIN_STATE_TTL ? null : row;
    },

    // ---- audit (never stores manifest contents) ----
    audit: ({ userId = null, workspaceId = null, action, target = null, outcome = "ok", ip = null }) =>
      pool.query("INSERT INTO audit (ts, user_id, workspace_id, action, target, outcome, ip) VALUES ($1, $2, $3, $4, $5, $6, $7)", [now(), userId, workspaceId, action, target, outcome, ip]),
    auditLog: (limit = 200) => rows("SELECT a.ts, a.action, a.target, a.outcome, a.ip, a.workspace_id, u.email FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT $1", [limit]),
  };
  return db;
}
