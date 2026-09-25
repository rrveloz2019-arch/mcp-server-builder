// Dashboard screens: sign-in, workspaces, manifests, editor (shared wizard), admin.
// All text from the server is escaped before it reaches innerHTML.
"use strict";
(function () {
  const root = document.getElementById("app");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const when = (t) => (t ? new Date(t).toLocaleString() : "—");
  let me = null;

  const SIGNIN_ERRORS = {
    expired: "The sign-in took too long or was already used. Please try again.",
    failed: "Microsoft sign-in did not complete. Please try again.",
    missing_claims: "Your Microsoft account did not share an email address.",
    unverified: "Your email address is not verified.",
    tenant: "This Microsoft account is not part of the dashboard's directory. Ask the admin to invite you.",
    not_invited: "This account has not been invited yet. Ask the admin to invite your email address.",
    disabled: "This account has been disabled. Contact the admin.",
    rate: "Too many sign-in attempts. Wait a minute and try again.",
  };

  async function api(method, path, body) {
    const headers = {};
    if (method !== "GET") headers["x-csrf-token"] = me?.csrf ?? "";
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
    if (res.status === 401) { me = null; showSignIn(); throw new Error("Your session ended. Please sign in again."); }
    if (res.status === 204) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) { if (!res.ok) throw new Error(res.statusText); return res; }
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error ?? res.statusText);
      err.details = data.details; err.errors = data.errors; err.status = res.status;
      throw err;
    }
    return data;
  }

  function flash(text) {
    const n = document.createElement("div");
    n.className = "note ok flash";
    n.textContent = text;
    document.body.append(n);
    setTimeout(() => n.remove(), 2500);
  }

  function showError(err) {
    const extra = [...(err.details ?? []), ...(err.errors ?? [])];
    alert(err.message + (extra.length ? `\n\n- ${extra.join("\n- ")}` : ""));
  }

  // ---------- screens ----------
  function showSignIn() {
    const code = new URLSearchParams(location.search).get("signin_error");
    const msg = SIGNIN_ERRORS[code];
    root.innerHTML = `<div class="signin">
      <h1>MCP Server Builder</h1>
      <p class="muted">Create and download your company's MCP server. Access is by invitation.</p>
      ${msg ? `<div class="note bad">${esc(msg)}</div>` : ""}
      <p><a class="btn primary" href="/auth/login">Sign in with Microsoft</a></p>
    </div>`;
  }

  function topbar() {
    return `<div class="topbar"><h1>MCP Server Builder</h1><div class="who">
      <button class="btn small" data-act="home">Projects</button>
      ${me.isAdmin ? `<button class="btn small" data-act="admin">Admin</button>` : ""}
      <span class="muted">${esc(me.user.email)}</span>
      <button class="btn small" data-act="logout">Sign out</button></div></div>`;
  }

  async function showHome() {
    me = await api("GET", "/api/me");
    history.replaceState(null, "", "/");
    if (me.workspaces.length === 1) return showWorkspace(me.workspaces[0]);
    root.innerHTML = `${topbar()}<div class="page">
      <h2>Your workspaces</h2>
      ${me.workspaces.length ? `<div class="cards">${me.workspaces.map((w) => `<button class="wscard" data-act="ws" data-id="${esc(w.id)}"><strong>${esc(w.name)}</strong><span class="pill">${esc(w.role)}</span></button>`).join("")}</div>`
        : `<div class="note warn">You are not in any workspace yet.${me.isAdmin ? " Create one in Admin." : " Ask the admin to invite you to your company's workspace."}</div>`}
    </div>`;
  }

  async function showWorkspace(ws) {
    const { manifests } = await api("GET", `/api/workspaces/${ws.id}/manifests`);
    const canEdit = ws.role === "editor" || ws.role === "admin";
    root.innerHTML = `${topbar()}<div class="page">
      <h2>${esc(ws.name)}</h2>
      <p class="muted">Your role: ${esc(ws.role)}${canEdit ? "" : " (read-only: you can open and download, not change)"}</p>
      ${canEdit ? `<div class="inline-form"><button class="btn primary" data-act="new" data-ws="${esc(ws.id)}">New MCP server</button></div>` : ""}
      ${manifests.length ? `<div class="tablewrap"><table class="list"><thead><tr><th>Server</th><th>Revision</th><th>Last saved</th><th></th></tr></thead><tbody>
        ${manifests.map((m) => `<tr><td><code>${esc(m.name)}</code></td><td>${esc(m.revision)}</td><td>${esc(when(m.updatedAt))}</td>
          <td class="actions"><button class="btn small" data-act="open" data-ws="${esc(ws.id)}" data-id="${esc(m.id)}">Open</button>
          ${canEdit ? `<button class="btn small danger" data-act="delete" data-ws="${esc(ws.id)}" data-id="${esc(m.id)}" data-name="${esc(m.name)}">Delete</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">No MCP servers yet.</p>`}
    </div>`;
    current.ws = ws;
  }
  const current = { ws: null };

  async function openEditor(ws, id) {
    const record = await api("GET", `/api/workspaces/${ws.id}/manifests/${id}`);
    let revision = record.revision;
    const base = `/api/workspaces/${ws.id}/manifests/${id}`;
    const save = async (p) => {
      const saved = await api("PUT", base, { ...p, revision });
      revision = saved.revision;
      return saved;
    };
    const backend = {
      catalog: () => api("GET", "/api/catalog"),
      example: (name) => api("GET", `/api/example?name=${encodeURIComponent(name)}`),
      parse: (yaml) => api("POST", "/api/parse", { yaml }),
      validate: (p) => api("POST", `${base}/validate`, p),
      save: async (p) => {
        try { return { saved: await save(p) }; } catch (err) { return { failed: err }; }
      },
      generate: async (p) => {
        try { await save(p); } catch (err) { return { failed: err }; }
        try {
          const res = await api("POST", `${base}/generate`, {});
          const blob = await res.blob();
          const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "server.zip";
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob); a.download = name; a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
          return { downloaded: name, size: blob.size, counts: JSON.parse(res.headers.get("x-generated-counts") ?? "{}"), warnings: JSON.parse(decodeURIComponent(res.headers.get("x-generated-warnings") ?? "%5B%5D")) };
        } catch (err) { return { failed: err }; }
      },
      describeResult(r, generated, e) {
        if (r.failed) {
          const extra = [...(r.failed.details ?? []), ...(r.failed.errors ?? [])];
          return `<div class="note bad">✗ ${e(r.failed.message)}${extra.length ? `<ul class="errors">${extra.map((x) => `<li>${e(x)}</li>`).join("")}</ul>` : ""}</div>`;
        }
        if (!generated) return `<div class="note ok">✓ Saved (revision ${e(r.saved.revision)}).</div>`;
        let html = `<div class="note ok">✓ Saved and downloaded <code>${e(r.downloaded)}</code>: ${e(r.counts.tools)} tools, ${e(r.counts.resources)} resources, ${e(r.counts.prompts)} prompts.</div>`;
        if (r.warnings?.length) html += `<div class="note warn">${r.warnings.map((w) => `! ${e(w)}`).join("<br>")}</div>`;
        return html + `<p><strong>Next steps, on the computer or server that will run it:</strong></p><pre>1. Unzip ${e(r.downloaded)} and open the folder in a terminal
2. npm install
3. npm run build
4. cp .env.example .env   (then fill in the values)
5. npm run start:stdio   or   npm run start:http</pre>`;
      },
    };
    current.save = async () => {
      try { const r = await save(window.McpWizard.current()); flash(`Saved draft (revision ${r.revision})`); } catch (err) { showError(err); }
    };
    const readOnly = ws.role === "viewer" ? `<span class="pill">read-only</span>` : `<button class="btn small" data-act="savedraft">Save draft</button>`;
    await window.McpWizard.mount({
      container: root, backend, manifest: Object.keys(record.manifest ?? {}).length ? record.manifest : undefined, files: record.files,
      headerExtra: `<button class="btn small" data-act="back">← ${esc(ws.name)}</button>${readOnly}`,
    });
    current.ws = ws;
  }

  async function showAdmin(selected) {
    const o = await api("GET", "/api/admin/overview");
    const sel = selected ? await api("GET", `/api/admin/workspaces/${selected}`) : null;
    root.innerHTML = `${topbar()}<div class="page">
      <h2>Admin</h2>
      <p class="muted">Only accounts listed in the server's ADMIN_OIDS setting see this page.</p>
      <h3 class="sub sub-18-6">Workspaces (one per client company)</h3>
      <form class="inline-form" data-form="newws"><input type="text" name="name" placeholder="Company name" maxlength="80" required><button class="btn primary">Create workspace</button></form>
      <div class="tablewrap"><table class="list"><thead><tr><th>Workspace</th><th>Members</th><th>MCP servers</th><th></th></tr></thead><tbody>
        ${o.workspaces.map((w) => `<tr><td>${esc(w.name)}</td><td>${esc(w.members)}</td><td>${esc(w.manifests)}</td><td class="actions">
          <button class="btn small" data-act="adminws" data-id="${esc(w.id)}">Members</button>
          <button class="btn small" data-act="ws" data-id="${esc(w.id)}">Open</button>
          <button class="btn small danger" data-act="delws" data-id="${esc(w.id)}" data-name="${esc(w.name)}">Delete</button></td></tr>`).join("")}
      </tbody></table></div>
      ${sel ? `<div class="card"><h3>${esc(sel.name)}: people</h3>
        <form class="inline-form" data-form="invite" data-ws="${esc(sel.id)}"><input type="text" name="email" placeholder="person@company.com" required>
          <select name="role"><option value="editor">editor (can change)</option><option value="viewer">viewer (read and download)</option></select>
          <button class="btn primary">Invite</button></form>
        <p class="muted">They sign in with Microsoft using this email. Invitations expire after 14 days.</p>
        <div class="tablewrap"><table class="list"><thead><tr><th>Member</th><th>Role</th><th></th></tr></thead><tbody>
          ${sel.members.map((m) => `<tr><td>${esc(m.email)}</td><td>${esc(m.role)}</td><td class="actions"><button class="btn small danger" data-act="rmmember" data-ws="${esc(sel.id)}" data-id="${esc(m.id)}">Remove</button></td></tr>`).join("") || `<tr><td colspan="3" class="muted">No members yet</td></tr>`}
        </tbody></table></div>
        <div class="tablewrap"><table class="list"><thead><tr><th>Invitation</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
          ${sel.invites.map((i) => `<tr><td>${esc(i.email)}</td><td>${esc(i.role)}</td><td>${i.accepted_at ? `accepted ${esc(when(i.accepted_at))}` : i.expires_at < Date.now() ? "expired" : "pending"}</td>
            <td class="actions">${i.accepted_at ? "" : `<button class="btn small danger" data-act="revoke" data-ws="${esc(sel.id)}" data-id="${esc(i.id)}">Revoke</button>`}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No invitations</td></tr>`}
        </tbody></table></div></div>` : ""}
      <h3 class="sub sub-18-6">Users</h3>
      <div class="tablewrap"><table class="list"><thead><tr><th>Email</th><th>Last sign-in</th><th>Status</th><th></th></tr></thead><tbody>
        ${o.users.map((u) => `<tr><td>${esc(u.email)}</td><td>${esc(when(u.last_login_at))}</td><td>${u.disabled ? "disabled" : "active"}</td>
          <td class="actions"><button class="btn small ${u.disabled ? "" : "danger"}" data-act="toggleuser" data-id="${esc(u.id)}" data-disabled="${u.disabled ? "0" : "1"}">${u.disabled ? "Enable" : "Disable"}</button></td></tr>`).join("")}
      </tbody></table></div>
      <h3 class="sub sub-18-6">Audit log (latest 100)</h3>
      <div class="tablewrap"><table class="list"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Result</th><th>IP</th></tr></thead><tbody>
        ${o.audit.map((a) => `<tr><td>${esc(when(a.ts))}</td><td>${esc(a.email ?? "—")}</td><td>${esc(a.action)}${a.target ? ` <span class="muted">${esc(a.target)}</span>` : ""}</td><td>${esc(a.outcome)}</td><td>${esc(a.ip)}</td></tr>`).join("")}
      </tbody></table></div>
    </div>`;
  }

  // ---------- events (no inline handlers; CSP forbids them) ----------
  const findWs = (id) => me.workspaces.find((w) => w.id === id) ?? (me.isAdmin ? { id, name: "Workspace", role: "admin" } : null);
  root.addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-act]");
    if (!el) return;
    const d = el.dataset;
    try {
      if (d.act === "home") return await showHome();
      if (d.act === "admin") return await showAdmin();
      if (d.act === "logout") { await api("POST", "/auth/logout"); me = null; return showSignIn(); }
      if (d.act === "ws") { me = await api("GET", "/api/me"); return await showWorkspace(findWs(d.id)); }
      if (d.act === "back") return await showWorkspace(current.ws);
      if (d.act === "savedraft") return await current.save();
      if (d.act === "new") { const r = await api("POST", `/api/workspaces/${d.ws}/manifests`, {}); return await openEditor(findWs(d.ws), r.id); }
      if (d.act === "open") return await openEditor(findWs(d.ws), d.id);
      if (d.act === "delete") {
        if (!confirm(`Delete "${d.name}"? This cannot be undone.`)) return;
        await api("DELETE", `/api/workspaces/${d.ws}/manifests/${d.id}`); return await showWorkspace(findWs(d.ws));
      }
      if (d.act === "adminws") return await showAdmin(d.id);
      if (d.act === "delws") {
        if (prompt(`This deletes workspace "${d.name}" and all its MCP servers. Type the name to confirm.`) !== d.name) return;
        await api("DELETE", `/api/admin/workspaces/${d.id}`); me = await api("GET", "/api/me"); return await showAdmin();
      }
      if (d.act === "rmmember") { await api("DELETE", `/api/admin/workspaces/${d.ws}/members/${d.id}`); return await showAdmin(d.ws); }
      if (d.act === "revoke") { await api("DELETE", `/api/admin/workspaces/${d.ws}/invites/${d.id}`); return await showAdmin(d.ws); }
      if (d.act === "toggleuser") { await api("PUT", `/api/admin/users/${d.id}/disabled`, { disabled: d.disabled === "1" }); return await showAdmin(); }
    } catch (err) { showError(err); }
  });
  root.addEventListener("submit", async (ev) => {
    const form = ev.target.closest("form[data-form]");
    if (!form) return;
    ev.preventDefault();
    const f = new FormData(form);
    try {
      if (form.dataset.form === "newws") { await api("POST", "/api/admin/workspaces", { name: f.get("name") }); me = await api("GET", "/api/me"); return await showAdmin(); }
      if (form.dataset.form === "invite") { await api("POST", `/api/admin/workspaces/${form.dataset.ws}/invites`, { email: f.get("email"), role: f.get("role") }); return await showAdmin(form.dataset.ws); }
    } catch (err) { showError(err); }
  });

  // ---------- start ----------
  fetch("/api/me", { credentials: "same-origin" }).then(async (res) => {
    if (res.status !== 200) return showSignIn();
    me = await res.json();
    await showHome();
  }).catch(() => showSignIn());
})();
