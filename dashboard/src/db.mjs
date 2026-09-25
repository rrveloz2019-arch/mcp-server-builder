// Storage. Every manifest query takes the workspace id, so data from one
// workspace can never be read through another workspace's id. Manifest
// contents are sealed (crypto.mjs) before they reach the database.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { open, seal, sha256 } from "./crypto.mjs";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, oid TEXT NOT NULL UNIQUE, email TEXT NOT NULL, name TEXT,
  created_at INTEGER NOT NULL, last_login_at INTEGER, disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accepted_at INTEGER
);
CREATE TABLE IF NOT EXISTS manifests (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sealed TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS manifests_ws ON manifests(workspace_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_states (
  state_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, code_verifier TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, workspace_id TEXT,
  action TEXT NOT NULL, target TEXT, outcome TEXT NOT NULL, ip TEXT
);
`;

const LOGIN_STATE_TTL = 10 * 60_000;
const INVITE_TTL = 14 * 24 * 3_600_000;

export function openDb(dbPath, dataKey) {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);
  const now = () => Date.now();
  const aad = (workspaceId, id) => `manifest:${workspaceId}:${id}`;
  const unseal = (row) => ({ id: row.id, revision: row.revision, updatedAt: row.updated_at, ...JSON.parse(open(dataKey, row.sealed, aad(row.workspace_id, row.id))) });

  return {
    raw: db,
    close: () => db.close(),

    // ---- users ----
    userByOid: (oid) => q("SELECT * FROM users WHERE oid = ?").get(oid),
    userById: (id) => q("SELECT * FROM users WHERE id = ?").get(id),
    createUser({ oid, email, name }) {
      const id = randomUUID();
      q("INSERT INTO users (id, oid, email, name, created_at) VALUES (?, ?, ?, ?, ?)").run(id, oid, email, name ?? null, now());
      return this.userById(id);
    },
    touchLogin: (id, email, name) => q("UPDATE users SET last_login_at = ?, email = ?, name = ? WHERE id = ?").run(now(), email, name ?? null, id),
    listUsers: () => q("SELECT id, email, name, created_at, last_login_at, disabled FROM users ORDER BY email").all(),
    setUserDisabled: (id, disabled) => q("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, id),

    // ---- workspaces & membership ----
    createWorkspace(name, createdBy) {
      const id = randomUUID();
      q("INSERT INTO workspaces (id, name, created_at, created_by) VALUES (?, ?, ?, ?)").run(id, name, now(), createdBy);
      return { id, name };
    },
    workspace: (id) => q("SELECT id, name, created_at FROM workspaces WHERE id = ?").get(id),
    allWorkspaces: () => q(`SELECT w.id, w.name, w.created_at,
        (SELECT COUNT(*) FROM memberships m WHERE m.workspace_id = w.id) AS members,
        (SELECT COUNT(*) FROM manifests x WHERE x.workspace_id = w.id) AS manifests
      FROM workspaces w ORDER BY w.name`).all(),
    workspacesForUser: (userId) => q("SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.name").all(userId),
    membership: (workspaceId, userId) => q("SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?").get(workspaceId, userId),
    members: (workspaceId) => q("SELECT u.id, u.email, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY u.email").all(workspaceId),
    removeMember: (workspaceId, userId) => q("DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?").run(workspaceId, userId).changes,
    deleteWorkspace: (id) => q("DELETE FROM workspaces WHERE id = ?").run(id).changes,

    // ---- invites (matched by verified email at first sign-in) ----
    createInvite(workspaceId, email, role, createdBy) {
      const id = randomUUID();
      q("INSERT INTO invites (id, workspace_id, email, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, workspaceId, email.toLowerCase(), role, createdBy, now(), now() + INVITE_TTL);
      return { id, email: email.toLowerCase(), role };
    },
    invites: (workspaceId) => q("SELECT id, email, role, created_at, expires_at, accepted_at FROM invites WHERE workspace_id = ? ORDER BY created_at DESC").all(workspaceId),
    revokeInvite: (workspaceId, id) => q("DELETE FROM invites WHERE workspace_id = ? AND id = ? AND accepted_at IS NULL").run(workspaceId, id).changes,
    acceptInvites(user) {
      const open = q("SELECT * FROM invites WHERE email = ? AND accepted_at IS NULL AND expires_at > ?").all(user.email.toLowerCase(), now());
      for (const inv of open) {
        q("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role").run(inv.workspace_id, user.id, inv.role);
        q("UPDATE invites SET accepted_at = ? WHERE id = ?").run(now(), inv.id);
      }
      return open.length;
    },

    // ---- manifests (always scoped by workspace) ----
    listManifests(workspaceId) {
      return q("SELECT * FROM manifests WHERE workspace_id = ? ORDER BY updated_at DESC").all(workspaceId).map((r) => {
        const m = unseal(r);
        return { id: m.id, name: m.name, revision: m.revision, updatedAt: m.updatedAt };
      });
    },
    getManifest(workspaceId, id) {
      const row = q("SELECT * FROM manifests WHERE workspace_id = ? AND id = ?").get(workspaceId, id);
      return row ? unseal(row) : null;
    },
    createManifest(workspaceId, { name, manifest, files }, userId) {
      const id = randomUUID();
      const t = now();
      q("INSERT INTO manifests (id, workspace_id, sealed, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, workspaceId, seal(dataKey, JSON.stringify({ name, manifest, files }), aad(workspaceId, id)), t, t, userId);
      return this.getManifest(workspaceId, id);
    },
    // Optimistic locking: the caller sends the revision it edited; a stale save is refused.
    updateManifest(workspaceId, id, { name, manifest, files }, revision, userId) {
      const r = q("UPDATE manifests SET sealed = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE workspace_id = ? AND id = ? AND revision = ?")
        .run(seal(dataKey, JSON.stringify({ name, manifest, files }), aad(workspaceId, id)), now(), userId, workspaceId, id, revision);
      return r.changes ? this.getManifest(workspaceId, id) : null;
    },
    deleteManifest: (workspaceId, id) => q("DELETE FROM manifests WHERE workspace_id = ? AND id = ?").run(workspaceId, id).changes,

    // ---- sessions (only the token's hash is stored) ----
    createSession(token, userId, csrf, absoluteMs) {
      const t = now();
      q("INSERT INTO sessions (token_hash, user_id, csrf, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(sha256(token), userId, csrf, t, t, t + absoluteMs);
    },
    session: (token) => q("SELECT * FROM sessions WHERE token_hash = ?").get(sha256(token)),
    touchSession: (token) => q("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(now(), sha256(token)),
    deleteSession: (token) => q("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token)),
    deleteUserSessions: (userId) => q("DELETE FROM sessions WHERE user_id = ?").run(userId),
    purgeExpired(idleMs) {
      const t = now();
      q("DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?").run(t, t - idleMs);
      q("DELETE FROM login_states WHERE created_at < ?").run(t - LOGIN_STATE_TTL);
    },

    // ---- login state (single use) ----
    saveLoginState: (state, nonce, codeVerifier) => q("INSERT INTO login_states (state_hash, nonce, code_verifier, created_at) VALUES (?, ?, ?, ?)").run(sha256(state), nonce, codeVerifier, now()),
    takeLoginState(state) {
      const row = q("SELECT * FROM login_states WHERE state_hash = ?").get(sha256(state));
      if (!row) return null;
      q("DELETE FROM login_states WHERE state_hash = ?").run(row.state_hash);
      return now() - row.created_at > LOGIN_STATE_TTL ? null : row;
    },

    // ---- audit (never stores manifest contents) ----
    audit: ({ userId = null, workspaceId = null, action, target = null, outcome = "ok", ip = null }) =>
      q("INSERT INTO audit (ts, user_id, workspace_id, action, target, outcome, ip) VALUES (?, ?, ?, ?, ?, ?, ?)").run(now(), userId, workspaceId, action, target, outcome, ip),
    auditLog: (limit = 200) => q("SELECT a.ts, a.action, a.target, a.outcome, a.ip, a.workspace_id, u.email FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT ?").all(limit),
  };
}
