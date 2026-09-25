// MCP Server Intake wizard (shared by the local intake tool and the hosted dashboard).
// The page supplies a backend: { catalog, example, parse, validate, save, generate, describeResult }.
// No inline styles or scripts, so it runs under a strict Content-Security-Policy.
(function () {
"use strict";
let B;
let listening = false;
// ---------- state ----------
const STEPS = [
  { id: "company", title: "Company & server", roots: ["company", "server", "manifestVersion"] },
  { id: "api", title: "Company API", roots: ["api"] },
  { id: "tools", title: "Standard tools", roots: ["tools"] },
  { id: "mappings", title: "Field mappings", roots: ["mappings"] },
  { id: "custom", title: "Custom tools", roots: ["customTools"] },
  { id: "resources", title: "Resources & prompts", roots: ["resources", "prompts"] },
  { id: "access", title: "Access, limits & audit", roots: ["access", "audit"] },
  { id: "review", title: "Review & generate", roots: ["/"] },
];
const TOOL_ORDER = ["search_products", "get_product_details", "list_categories", "check_stock", "get_pricing", "create_quote", "create_order", "get_order_status"];
const DEFAULT_BINDINGS = {
  search_products: { request: { method: "GET", path: "/products", query: { q: "{query}", category: "{category}", limit: "{limit}", cursor: "{cursor}" } }, response: { itemsPath: "data", nextCursorPath: "meta.next", mapping: "product" } },
  get_product_details: { request: { method: "GET", path: "/products/{product_id}" }, response: { recordPath: "data", mapping: "product" } },
  list_categories: { request: { method: "GET", path: "/categories" }, response: { itemsPath: "data", mapping: "raw" } },
  check_stock: { request: { method: "GET", path: "/inventory/{product_id}", query: { warehouse: "{location}" } }, response: { itemsPath: "data", mapping: "stock" } },
  get_pricing: { request: { method: "POST", path: "/pricing/calculate", body: { sku: "{product_id}", qty: "{quantity}", customer: "{customer_id}" } }, response: { recordPath: "data", mapping: "price" } },
  create_quote: { requireConfirmation: true, request: { method: "POST", path: "/quotes", body: { customer: "{customer_id}", lines: "{items}", note: "{notes}" } }, response: { recordPath: "data", mapping: "quote" } },
  create_order: { enabled: false, requireConfirmation: true, maxTotal: 5000, request: { method: "POST", path: "/orders", body: { quote_id: "{quote_id}" } }, response: { recordPath: "data", mapping: "order" } },
  get_order_status: { request: { method: "GET", path: "/orders/{order_id}" }, response: { recordPath: "data", mapping: "order" } },
};
const DEFAULT_MAPPINGS = {
  product: { id: "id", name: "name", description: "description", category: "category", price: "price", currency: "currency", url: "url" },
  stock: { productId: "product_id", available: "available", location: "location" },
  price: { productId: "product_id", unitPrice: "unit_price", currency: "currency", quantity: "quantity", total: "total" },
  quote: { id: "id", status: "status", total: "total", currency: "currency", expiresAt: "expires_at" },
  order: { id: "id", status: "status", total: "total", currency: "currency", createdAt: "created_at" },
};
const clone = (v) => JSON.parse(JSON.stringify(v));
function blankManifest() {
  const tools = {};
  for (const t of TOOL_ORDER) if (t !== "create_order") tools[t] = clone(DEFAULT_BINDINGS[t]);
  return {
    manifestVersion: "1",
    company: { name: "", defaultCurrency: "USD" },
    server: { name: "", version: "0.1.0", transports: ["stdio"] },
    api: { baseUrl: "", timeoutMs: 10000, auth: { type: "api_key", in: "header", name: "X-Api-Key", valueEnv: "COMPANY_API_KEY" } },
    mappings: clone(DEFAULT_MAPPINGS),
    tools,
    audit: { enabled: true, sink: "stderr" },
  };
}
let M = blankManifest();
let FILES = {};
let CATALOG = {};
let step = 0;
let last = { errors: [], yaml: "", summary: null };
const toolCache = {};

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (sel) => document.querySelector(sel);
function getP(path) { return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), M); }
function setP(path, value) {
  const keys = path.split(".");
  let o = M;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (o[k] == null || typeof o[k] !== "object") o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  }
  const k = keys.at(-1);
  const empty = value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
  if (empty) { if (Array.isArray(o)) o[k] = undefined; else delete o[k]; } else o[k] = value;
  // Drop parents left empty (e.g. server.http after its last field is cleared).
  for (let i = keys.length - 1; i > 0; i--) {
    const parentPath = keys.slice(0, i).join(".");
    const parent = getP(parentPath);
    if (parent && typeof parent === "object" && !Array.isArray(parent) && Object.keys(parent).length === 0 && !KEEP_EMPTY.test(parentPath)) {
      const gp = i > 1 ? getP(keys.slice(0, i - 1).join(".")) : M;
      if (gp && !Array.isArray(gp)) delete gp[keys[i - 1]];
    } else break;
  }
}
const KEEP_EMPTY = /^(customTools\.\d+\.args|tools\.[a-z_]+|mappings\.[a-z_]+)$/;
function kvToText(obj, sep = ": ") { return Object.entries(obj ?? {}).map(([k, v]) => `${k}${sep}${v}`).join("\n"); }
function textToKv(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const s = line.trim();
    if (!s) continue;
    const i = s.indexOf(":");
    if (i <= 0) throw new Error(`"${s}" needs the form key: value`);
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}
const listToText = (v) => (Array.isArray(v) ? v.join(", ") : v ?? "");
const textToList = (t) => String(t).split(",").map((s) => s.trim()).filter(Boolean);

// Field renderers. Every input carries data-p (path into the manifest) and data-t (type).
function field(label, path, { type = "str", help = "", placeholder = "", input = "text", options, wide } = {}) {
  const v = getP(path);
  let control;
  if (options) {
    control = `<select data-p="${path}" data-t="${type}" ${input === "rerender" ? "data-rerender" : ""}>${options.map((o) => { const [val, txt] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(val)}" ${String(v ?? "") === String(val) ? "selected" : ""}>${esc(txt)}</option>`; }).join("")}</select>`;
  } else if (type === "kv" || type === "json" || type === "text") {
    const val = type === "kv" ? kvToText(v) : type === "json" ? (v === undefined ? "" : JSON.stringify(v, null, 2)) : v ?? "";
    control = `<textarea data-p="${path}" data-t="${type}" placeholder="${esc(placeholder)}" spellcheck="false">${esc(val)}</textarea>`;
  } else {
    const val = type === "list" ? listToText(v) : v ?? "";
    control = `<input type="${input === "number" || type === "int" ? "number" : "text"}" data-p="${path}" data-t="${type}" value="${esc(val)}" placeholder="${esc(placeholder)}">`;
  }
  return `<label class="f${wide ? " span-all" : ""}">${esc(label)}${help ? ` <span class="h">${help}</span>` : ""}${control}<span class="h err" data-err="${path}"></span></label>`;
}
function checkbox(label, path, { rerender = false, dflt = false } = {}) {
  const v = getP(path);
  return `<label class="check"><input type="checkbox" data-p="${path}" data-t="bool" ${(v ?? dflt) ? "checked" : ""} ${rerender ? "data-rerender" : ""}> ${label}</label>`;
}

function parseInput(el) {
  const t = el.dataset.t;
  if (t === "bool") return el.checked;
  const raw = el.value;
  if (t === "int") return raw === "" ? undefined : Number.isNaN(Number(raw)) ? raw : Number(raw);
  if (t === "list") return textToList(raw);
  if (t === "kv") return textToKv(raw);
  if (t === "json") return raw.trim() === "" ? undefined : JSON.parse(raw);
  if (t === "strOrList") { const l = textToList(raw); return l.length > 1 ? l : l[0]; }
  return raw.trim() === "" ? undefined : raw;
}

// ---------- scopes ----------
function allScopes() {
  const s = new Set();
  for (const [name, b] of Object.entries(M.tools ?? {})) if (b.enabled !== false) s.add(b.scope ?? CATALOG[name]?.scope);
  for (const t of M.customTools ?? []) if (t?.scope) s.add(t.scope);
  for (const r of M.resources ?? []) if (r?.scope) s.add(r.scope);
  for (const p of M.prompts ?? []) if (p?.scope) s.add(p.scope);
  for (const k of M.access?.apiKeys ?? []) for (const sc of k?.scopes ?? []) s.add(sc);
  for (const sc of M.access?.stdioScopes ?? []) s.add(sc);
  s.delete(undefined);
  return [...s].sort();
}
function scopePicker(path) {
  const cur = new Set(getP(path) ?? []);
  return `<div class="row">${allScopes().map((sc) => `<label class="check"><input type="checkbox" data-scope="${path}" value="${esc(sc)}" ${cur.has(sc) ? "checked" : ""}> <code>${esc(sc)}</code></label>`).join("")}</div>`;
}

// ---------- step renderers ----------
const R = {};
R.company = () => `
  <h2>Company & server</h2>
  <p class="lead">Who the server is for, and what the AI is told when it connects.</p>
  <div class="grid">
    ${field("Company name", "company.name", { placeholder: "Acme Outdoor Supply" })}
    ${field("Website", "company.website", { placeholder: "https://example.com", help: "optional" })}
    ${field("Default currency", "company.defaultCurrency", { placeholder: "USD", help: "3 capital letters" })}
    ${field("Server name", "server.name", { placeholder: "acme-outdoor-sales", help: "lowercase, digits and dashes" })}
    ${field("Server version", "server.version", { placeholder: "0.1.0" })}
    ${field("Short description", "server.description", { wide: true })}
    ${field("Instructions for the AI", "server.instructions", { type: "text", wide: true, placeholder: "Search first, then check stock and pricing before quoting…", help: "sent to the AI when it connects" })}
  </div>
  <h3>How clients connect</h3>
  <div class="row">
    <label class="check"><input type="checkbox" data-transport="stdio" ${(M.server?.transports ?? ["stdio"]).includes("stdio") ? "checked" : ""}> Local (stdio): Claude Desktop / Claude Code on the same computer</label>
    <label class="check"><input type="checkbox" data-transport="http" ${(M.server?.transports ?? []).includes("http") ? "checked" : ""}> Remote (HTTP): shared server for many clients</label>
  </div>
  ${(M.server?.transports ?? []).includes("http") ? `<div class="mt10 grid">
    ${field("HTTP port", "server.http.port", { type: "int", placeholder: "3000" })}
    ${field("HTTP path", "server.http.path", { placeholder: "/mcp" })}
    ${field("Public URL", "server.http.publicUrl", { placeholder: "https://mcp.example.com/mcp", help: "needed for OAuth / Azure AD" })}
  </div><div class="note warn">Remote access needs at least one API key client or OAuth sign-in (step 7).</div>` : ""}`;

const AUTH_TYPES = [["none", "No auth"], ["api_key", "API key"], ["bearer", "Bearer token"], ["basic", "Username + password"], ["oauth2_client_credentials", "OAuth2 client credentials"]];
R.api = () => {
  const a = M.api?.auth ?? { type: "none" };
  const fields = {
    none: "",
    api_key: `${field("Sent in", "api.auth.in", { options: ["header", "query"] })}${field("Header / parameter name", "api.auth.name", { placeholder: "X-Api-Key" })}${field("Env var holding the key", "api.auth.valueEnv", { placeholder: "COMPANY_API_KEY" })}`,
    bearer: field("Env var holding the token", "api.auth.tokenEnv", { placeholder: "COMPANY_API_TOKEN" }),
    basic: `${field("Env var: username", "api.auth.usernameEnv", { placeholder: "COMPANY_API_USER" })}${field("Env var: password", "api.auth.passwordEnv", { placeholder: "COMPANY_API_PASSWORD" })}`,
    oauth2_client_credentials: `${field("Token URL", "api.auth.tokenUrl", { placeholder: "https://login.example.com/oauth/token" })}${field("Env var: client id", "api.auth.clientIdEnv", { placeholder: "COMPANY_CLIENT_ID" })}${field("Env var: client secret", "api.auth.clientSecretEnv", { placeholder: "COMPANY_CLIENT_SECRET" })}${field("Scopes", "api.auth.scopes", { type: "list", help: "comma separated" })}`,
  }[a.type] ?? "";
  return `
  <h2>Company API</h2>
  <p class="lead">The backend the MCP server calls. Its code does not change.</p>
  <div class="grid">
    ${field("Base URL", "api.baseUrl", { placeholder: "https://api.example.com/v2", wide: true })}
    ${field("Timeout (ms)", "api.timeoutMs", { type: "int", placeholder: "10000" })}
    ${field("Calls per minute to the API", "api.rateLimit.requestsPerMinute", { type: "int", help: "optional, across all clients" })}
    ${field("Static headers", "api.headers", { type: "kv", placeholder: "Accept: application/json", help: "one per line, no secrets" })}
  </div>
  <h3>How the server signs in to the API</h3>
  <div class="grid">
    <label class="f">Auth type<select data-authtype>${AUTH_TYPES.map(([v, t]) => `<option value="${v}" ${a.type === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
    ${fields}
  </div>
  <div class="note ok">Secrets never go in the manifest. You only name the environment variable; the value goes in the server's <code>.env</code> file.</div>`;
};

function requestFields(base, { method = true } = {}) {
  return `
    ${method ? field("Method", `${base}.request.method`, { options: ["GET", "POST", "PUT", "PATCH", "DELETE"] }) : ""}
    ${field("Path", `${base}.request.path`, { placeholder: "/products/{product_id}" })}
    ${field("Query parameters", `${base}.request.query`, { type: "kv", placeholder: "q: {query}", help: "one per line" })}
    ${field("JSON body", `${base}.request.body`, { type: "json", placeholder: '{ "sku": "{product_id}" }', help: "POST/PUT/PATCH only" })}`;
}
function responseFields(base) {
  const maps = ["raw", ...Object.keys(M.mappings ?? {})];
  const cur = getP(`${base}.response.mapping`);
  if (cur && !maps.includes(cur)) maps.push(cur);
  return `
    ${field("List of records at", `${base}.response.itemsPath`, { placeholder: "data", help: "for list endpoints" })}
    ${field("Single record at", `${base}.response.recordPath`, { placeholder: "data", help: "for detail endpoints" })}
    ${field("Field mapping", `${base}.response.mapping`, { options: [["", "(default)"], ...maps] })}`;
}
R.tools = () => `
  <h2>Standard tools</h2>
  <p class="lead">Pick which of the 8 standard sales tools to offer, and which API endpoint each one calls. Use <code>{placeholders}</code> for the tool's arguments.</p>
  ${TOOL_ORDER.map((name) => {
    const spec = CATALOG[name] ?? {};
    const b = M.tools?.[name];
    const on = !!b;
    const args = Object.keys(spec.args ?? {}).filter((a) => a !== "confirm");
    const base = `tools.${name}`;
    return `<div class="card ${on ? "" : "off"}">
      <h3><label class="check"><input type="checkbox" data-tool="${name}" ${on ? "checked" : ""}> <code>${name}</code></label>
        <span class="muted">${esc(spec.title ?? "")} · ${spec.kind === "write" ? "write" : "read"} · scope <code>${esc(b?.scope ?? spec.scope)}</code></span></h3>
      <p class="mt6only muted">${esc(spec.description ?? "")}</p>
      ${on ? `<div class="body">
        ${name === "create_order" ? `<div class="note warn">Places real orders. It is added switched off; turn it on only when the company is ready.</div>${checkbox("Turned on (places real orders)", `${base}.enabled`, { dflt: true })}` : ""}
        <p class="muted">Arguments you can use: ${args.map((a) => `<code>{${a}}</code>`).join(" ") || "none"}${spec.kind === "write" ? " · asks the user to confirm a preview first" : ""}</p>
        <div class="grid">${requestFields(base)}${responseFields(base)}
          ${spec.kind === "write" ? field("Spending cap (maxTotal)", `${base}.maxTotal`, { type: "int", help: "not enforced yet; generator warns" }) : ""}
        </div></div>` : ""}
    </div>`;
  }).join("")}`;

function usedMappings() {
  const used = new Set();
  for (const [name, b] of Object.entries(M.tools ?? {})) used.add(b.response?.mapping ?? CATALOG[name]?.mapping);
  for (const t of M.customTools ?? []) if (t?.response?.mapping) used.add(t.response.mapping);
  for (const r of M.resources ?? []) { if (r?.response?.mapping) used.add(r.response.mapping); if (r?.listResponse?.mapping) used.add(r.listResponse.mapping); }
  used.delete("raw"); used.delete(undefined);
  return used;
}
R.mappings = () => {
  const used = usedMappings();
  const names = [...new Set([...used, ...Object.keys(M.mappings ?? {})])];
  return `
  <h2>Field mappings</h2>
  <p class="lead">Left: the field the AI sees. Right: where it is in your API's JSON (dot path, e.g. <code>pricing.list</code> or <code>media.0.url</code>).</p>
  ${names.map((n) => `<div class="card">
      <h3><code>${esc(n)}</code> ${used.has(n) ? `<span class="muted">used by your tools</span>` : `<span class="muted">not used</span>`}
        <button class="btn small danger" data-delmap="${esc(n)}">Remove</button></h3>
      <div class="body">${M.mappings?.[n] ? field("Fields (one per line, field: path)", `mappings.${n}`, { type: "kv", wide: true }) : `<div class="note bad">Missing. <button class="btn small" data-addmap="${esc(n)}">Create it</button></div>`}</div>
    </div>`).join("")}
  <div class="row"><input class="w280" type="text" id="newMapName" placeholder="new mapping name, e.g. warranty"><button class="btn" data-newmap>Add mapping</button></div>`;
};

const ARG_TYPES = ["string", "integer", "number", "boolean", "array", "object"];
function argTable(ci) {
  const args = M.customTools[ci].args ?? {};
  return `<table class="args"><thead><tr><th>Argument</th><th>Type</th><th>Required</th><th>Description</th><th></th></tr></thead><tbody>
    ${Object.entries(args).map(([n, a]) => `<tr>
      <td><input type="text" data-arg="${ci}" data-argname="${esc(n)}" data-f="name" value="${esc(n)}"></td>
      <td><select data-arg="${ci}" data-argname="${esc(n)}" data-f="type">${ARG_TYPES.map((t) => `<option ${a.type === t ? "selected" : ""}>${t}</option>`).join("")}</select></td>
      <td><input type="checkbox" data-arg="${ci}" data-argname="${esc(n)}" data-f="required" ${a.required ? "checked" : ""}></td>
      <td><input type="text" data-arg="${ci}" data-argname="${esc(n)}" data-f="description" value="${esc(a.description ?? "")}"></td>
      <td><button class="btn small danger" data-delarg="${ci}" data-argname="${esc(n)}">×</button></td></tr>`).join("")}
  </tbody></table><button class="mt6 btn small" data-addarg="${ci}">Add argument</button>`;
}
R.custom = () => `
  <h2>Custom tools</h2>
  <p class="lead">Company-specific actions beyond the sales catalog, e.g. <code>verify_qr_code</code> or <code>send_quote_email</code>.</p>
  ${(M.customTools ?? []).map((t, i) => t ? `<div class="card">
      <h3><code>${esc(t.name || "(unnamed)")}</code> <button class="btn small danger" data-del="customTools" data-i="${i}">Remove</button></h3>
      <div class="body grid">
        ${field("Name", `customTools.${i}.name`, { placeholder: "verify_qr_code", help: "lowercase and underscores" })}
        ${field("Title", `customTools.${i}.title`, { placeholder: "Verify product QR code" })}
        ${field("Kind", `customTools.${i}.kind`, { options: [["read", "read (no side effects)"], ["write", "write (creates/changes data)"], ["destructive", "destructive (deletes / cannot undo)"]], input: "rerender" })}
        ${field("Scope", `customTools.${i}.scope`, { placeholder: "catalog:read", help: "area:action" })}
        ${field("Description", `customTools.${i}.description`, { type: "text", wide: true, help: "at least 40 characters: what it does, when to use it, what it returns" })}
        <div>${argTable(i)}</div>
        ${requestFields(`customTools.${i}`)}${responseFields(`customTools.${i}`)}
        ${t.kind && t.kind !== "read" ? `<div>${checkbox("Ask the user to confirm a preview first", `customTools.${i}.requireConfirmation`, { dflt: true })}</div>` : ""}
      </div></div>` : "").join("")}
  <button class="btn" data-add="customTools">Add custom tool</button>
  <p class="muted">Long-running tools and deprecation are kept from imported manifests; edit them in the YAML on the last step.</p>`;

R.resources = () => `
  <h2>Resources & prompts</h2>
  <p class="lead">Resources are read-only data the AI can open (documents, records). Prompts are ready-made tasks offered to the user.</p>
  <h3>Resources</h3>
  ${(M.resources ?? []).map((r, i) => {
    if (!r) return "";
    const isFile = r.file !== undefined || !r.request;
    const loaded = r.file && FILES[r.file] !== undefined;
    return `<div class="card">
      <h3><code>${esc(r.name || "(unnamed)")}</code> <button class="btn small danger" data-del="resources" data-i="${i}">Remove</button></h3>
      <div class="body grid">
        ${field("Name", `resources.${i}.name`, { placeholder: "return_policy" })}
        ${field("Title", `resources.${i}.title`, { placeholder: "Return policy" })}
        ${field("URI", `resources.${i}.uri`, { placeholder: isFile ? "docs://policies/returns" : "catalog://products/{product_id}", help: isFile ? "fixed" : "may use {placeholders}" })}
        ${field("MIME type", `resources.${i}.mimeType`, { placeholder: isFile ? "text/markdown" : "application/json" })}
        ${field("Scope", `resources.${i}.scope`, { placeholder: "catalog:read", help: "optional" })}
        ${field("Description", `resources.${i}.description`, { wide: true, help: "at least 20 characters" })}
        <label class="f">Source<select data-ressource="${i}"><option value="file" ${isFile ? "selected" : ""}>A file bundled with the server</option><option value="api" ${!isFile ? "selected" : ""}>An API endpoint</option></select></label>
        ${isFile ? `${field("File path", `resources.${i}.file`, { placeholder: "docs/return-policy.md", help: "relative to the manifest" })}
          <label class="f">Upload the file<input type="file" data-upload="${i}"><span class="h">${r.file ? (loaded ? `✓ ${esc(r.file)} loaded (${FILES[r.file].length} characters)` : `✗ ${esc(r.file)} not uploaded yet`) : "set the file path first"}</span></label>`
          : `${requestFields(`resources.${i}`, { method: false })}${responseFields(`resources.${i}`)}`}
      </div></div>`;
  }).join("")}
  <button class="btn" data-add="resources">Add resource</button>
  <h3>Prompts</h3>
  ${(M.prompts ?? []).map((p, i) => p ? `<div class="card">
      <h3><code>${esc(p.name || "(unnamed)")}</code> <button class="btn small danger" data-del="prompts" data-i="${i}">Remove</button></h3>
      <div class="body grid">
        ${field("Name", `prompts.${i}.name`, { placeholder: "prepare_quote" })}
        ${field("Title", `prompts.${i}.title`, { placeholder: "Prepare a quote" })}
        ${field("Scope", `prompts.${i}.scope`, { help: "optional" })}
        ${field("Description", `prompts.${i}.description`, { wide: true, help: "at least 20 characters" })}
        ${field("Arguments", `prompts.${i}.args`, { type: "json", wide: true, placeholder: '{ "customer_id": { "description": "Customer account id", "required": true } }' })}
        ${field("Template", `prompts.${i}.template`, { type: "text", wide: true, placeholder: "Prepare a quote for customer {customer_id}…", help: "use {argument} placeholders" })}
        ${field("Attach resources (URIs)", `prompts.${i}.embedResources`, { type: "list", wide: true, placeholder: "docs://policies/returns" })}
      </div></div>` : "").join("")}
  <button class="btn" data-add="prompts">Add prompt</button>`;

function oauthMode() {
  const o = M.access?.oauth;
  if (!o) return "none";
  return /login\.microsoftonline\.com\//.test(o.issuer ?? "") ? "azure" : "generic";
}
const azureIds = () => {
  const o = M.access?.oauth ?? {};
  const tenant = (o.issuer ?? "").match(/microsoftonline\.com\/([^/]+)\//)?.[1] ?? "";
  const aud = [].concat(o.audience ?? []);
  const client = aud.find((a) => !a.startsWith("api://")) ?? "";
  return { tenant, client };
};
R.access = () => {
  const http = (M.server?.transports ?? []).includes("http");
  const mode = oauthMode();
  const az = azureIds();
  return `
  <h2>Access, limits & audit</h2>
  <p class="lead">Who may connect, what each client may use, and what gets logged.</p>
  ${http ? "" : `<div class="note ok">Local (stdio) only: the person running the server gets the scopes below. Add clients only if you also enable HTTP in step 1.</div>`}
  <h3>Local user scopes (stdio)</h3>
  <p class="m0 muted">Leave all unchecked to grant every read scope (the default).</p>
  ${scopePicker("access.stdioScopes")}
  <h3>API key clients</h3>
  <p class="mt4only muted">Each client gets its own key (only its SHA-256 hash is stored, in an env var), scopes, tenant context and rate limit.</p>
  ${(M.access?.apiKeys ?? []).map((k, i) => k ? `<div class="card">
      <h3><code>${esc(k.clientId || "(unnamed)")}</code> <button class="btn small danger" data-del="access.apiKeys" data-i="${i}">Remove</button></h3>
      <div class="body grid">
        ${field("Client id", `access.apiKeys.${i}.clientId`, { placeholder: "northwind-reseller" })}
        ${field("Env var with key hash", `access.apiKeys.${i}.keyHashEnv`, { placeholder: "NORTHWIND_KEY_SHA256" })}
        ${field("Requests per minute", `access.apiKeys.${i}.rateLimit.requestsPerMinute`, { type: "int" })}
        ${field("Description", `access.apiKeys.${i}.description`, { wide: true })}
        ${field("Tenant context", `access.apiKeys.${i}.context`, { type: "kv", placeholder: "customer_id: C-2044", help: "fixed values; this client only ever sees its own data" })}
        <div><span class="muted">Scopes</span>${scopePicker(`access.apiKeys.${i}.scopes`)}<span class="h err" data-err="access.apiKeys.${i}.scopes"></span></div>
      </div></div>` : "").join("")}
  <button class="btn" data-add="access.apiKeys">Add API key client</button>
  <h3>Sign-in with an identity provider (OAuth)</h3>
  <div class="grid">
    <label class="f">OAuth<select data-oauthmode><option value="none" ${mode === "none" ? "selected" : ""}>Off</option><option value="azure" ${mode === "azure" ? "selected" : ""}>Azure AD (Microsoft Entra ID)</option><option value="generic" ${mode === "generic" ? "selected" : ""}>Other OAuth 2.1 provider</option></select></label>
  </div>
  ${mode === "azure" ? `<div class="mt10 grid">
      <label class="f">Directory (tenant) id<input type="text" data-azure="tenant" value="${esc(az.tenant)}" placeholder="e8c9f1fa-…"></label>
      <label class="f">Application (client) id<input type="text" data-azure="client" value="${esc(az.client)}" placeholder="a676142a-…"></label>
      ${field("Requests per minute (per user)", "access.oauth.rateLimit.requestsPerMinute", { type: "int" })}
      ${field("Tenant context from claims", "access.oauth.contextClaims", { type: "kv", placeholder: "customer_id: extension_customerId", help: "optional" })}
    </div>
    <div class="note ok">Filled in for you: issuer (v2 + v1), audience (<code>client id</code> and <code>api://client id</code>), signing keys URL, and permissions from <code>roles</code> + <code>scp</code>. Name the Azure app roles exactly like your scopes (e.g. <code>catalog:read</code>). The server needs no client secret. See <code>examples/azure/README.md</code>.</div>`
  : mode === "generic" ? `<div class="mt10 grid">
      ${field("Issuer", "access.oauth.issuer", { placeholder: "https://login.example.com" })}
      ${field("Audience", "access.oauth.audience", { type: "strOrList", placeholder: "https://mcp.example.com/mcp", help: "comma separated for several" })}
      ${field("JWKS URL", "access.oauth.jwksUrl", { help: "optional; defaults to discovery" })}
      ${field("Scope claim", "access.oauth.scopeClaim", { type: "strOrList", placeholder: "scope" })}
      ${field("Requests per minute (per user)", "access.oauth.rateLimit.requestsPerMinute", { type: "int" })}
      ${field("Tenant context from claims", "access.oauth.contextClaims", { type: "kv", placeholder: "customer_id: org_id" })}
    </div>` : ""}
  <h3>Audit log</h3>
  <div class="grid">
    <div>${checkbox("Record every tool call, resource read and prompt", "audit.enabled", { dflt: true })}</div>
    ${field("Write to", "audit.sink", { options: [["stderr", "stderr (console)"], ["file", "file (JSON Lines)"], ["http", "HTTP endpoint"]], input: "rerender" })}
    ${M.audit?.sink === "file" ? field("File path", "audit.path", { placeholder: "logs/audit.jsonl" }) : ""}
    ${M.audit?.sink === "http" ? field("URL", "audit.url", { placeholder: "https://logs.example.com/mcp" }) : ""}
    ${field("Redact these fields", "audit.redactFields", { type: "list", placeholder: "message, email" })}
  </div>`;
};

R.review = () => {
  const ok = last.errors.length === 0;
  const s = last.summary;
  return `
  <h2>Review & generate</h2>
  <p class="lead">The manifest is checked by the builder's own validator (<code>scripts/validate-manifest.mjs</code>) as you type.</p>
  ${ok && s ? `<div class="note ok">✓ Valid. ${s.tools.length} tools (${s.tools.join(", ")}), ${s.resources.length} resources, ${s.prompts.length} prompts, clients: ${s.clients.join(", ") || "local only"}.</div>`
    : `<div class="note bad">✗ ${last.errors.length} problem${last.errors.length === 1 ? "" : "s"} to fix before generating:${errorList()}</div>`}
  <div class="my14 row">
    <button class="btn" data-download>Download manifest.yaml</button>
    <button class="btn" data-save ${ok ? "" : "disabled"}>Save to workspace</button>
    <button class="btn primary" data-generate ${ok ? "" : "disabled"}>Generate server</button>
  </div>
  <div id="result" class="result"></div>
  <details><summary>Edit the YAML directly (advanced)</summary>
    <p class="muted">For fields the form doesn't cover (long-running tools, deprecation). Apply replaces the form's contents.</p>
    <textarea class="h280" id="yamlEdit">${esc(last.yaml)}</textarea>
    <button class="mt6 btn" data-applyyaml>Apply YAML</button>
  </details>`;
};

// ---------- errors ----------
function errorPath(e) {
  const m = e.match(/^schema: (\/\S*)/);
  if (m) return m[1].split("/").filter(Boolean).join(".");
  const n = e.match(/^([a-zA-Z]+)(?:\[(\d+)\]|\.([a-zA-Z_.]+))?/);
  if (!n) return "";
  return [n[1], n[2], n[3]].filter((x) => x !== undefined).join(".");
}
function stepOf(e) {
  const p = errorPath(e);
  const root = p.split(".")[0];
  const i = STEPS.findIndex((s) => s.roots.includes(root));
  return i < 0 ? STEPS.length - 1 : i;
}
function errorList(only) {
  const errs = last.errors.filter((e) => only === undefined || stepOf(e) === only);
  if (!errs.length) return "";
  return `<ul class="errors">${errs.map((e) => `<li>${esc(e)} ${only === undefined ? `<a href="#" data-goto="${stepOf(e)}">(${esc(STEPS[stepOf(e)].title)})</a>` : ""}</li>`).join("")}</ul>`;
}
function markFields() {
  document.querySelectorAll(".invalid").forEach((el) => el.classList.remove("invalid"));
  document.querySelectorAll("[data-err]").forEach((el) => (el.textContent = ""));
  for (const e of last.errors) {
    const p = errorPath(e);
    if (!p) continue;
    // Highlight the deepest field that exists for this path.
    const parts = p.split(".");
    for (let n = parts.length; n > 0; n--) {
      const sub = parts.slice(0, n).join(".");
      const el = document.querySelector(`[data-p="${CSS.escape(sub)}"]`);
      if (el) {
        el.classList.add("invalid");
        const msg = document.querySelector(`[data-err="${CSS.escape(sub)}"]`);
        if (msg) msg.textContent = e.replace(/^schema: \S+ /, "").replace(/^[^:]+: /, "");
        break;
      }
    }
  }
}

// ---------- rendering ----------
function renderNav() {
  const counts = STEPS.map((_, i) => last.errors.filter((e) => stepOf(e) === i).length);
  $("#steps").innerHTML = STEPS.map((s, i) => `<li><button data-goto="${i}" ${i === step ? 'aria-current="step"' : ""}><span>${i + 1}. ${esc(s.title)}</span>${counts[i] ? `<span class="badge">${counts[i]}</span>` : ""}</button></li>`).join("");
}
function renderStatus() {
  const ok = last.errors.length === 0;
  $("#statusPanel").innerHTML = `<h3>Validation</h3>${ok ? `<div class="m0 note ok">✓ Manifest is valid</div>` : `<div class="m0 note bad">✗ ${last.errors.length} problem${last.errors.length === 1 ? "" : "s"}${errorList()}</div>`}`;
  $("#yamlPreview").textContent = last.yaml;
}
function render() {
  const s = STEPS[step];
  $("#stepBody").innerHTML = R[s.id]() + (s.id !== "review" ? `<div id="stepErrors">${stepErrorNote()}</div>` : "") +
    `<div class="navbtns"><button class="btn" data-goto="${step - 1}" ${step === 0 ? "disabled" : ""}>← Back</button>${step < STEPS.length - 1 ? `<button class="btn primary" data-goto="${step + 1}">Next →</button>` : ""}</div>`;
  renderNav();
  renderStatus();
  markFields();
}

// ---------- server calls ----------
const payload = () => ({ manifest: M, files: FILES });
let timer;
function scheduleValidate() { clearTimeout(timer); timer = setTimeout(validate, 350); }
async function validate() {
  try {
    last = await B.validate(payload());
  } catch (err) {
    last = { errors: [`request failed: ${err.message}`], yaml: last.yaml, summary: null };
  }
  renderNav(); renderStatus(); markFields();
  if (STEPS[step].id === "review" && !document.activeElement?.closest?.("#yamlEdit")) render();
  else refreshStepErrors();
}
function stepErrorNote() { const l = errorList(step); return l ? `<div class="mt16 note bad">Problems on this step:${l}</div>` : ""; }
function refreshStepErrors() {
  const box = $("#stepErrors");
  if (box) box.innerHTML = stepErrorNote();
}

// ---------- events ----------
function listen() {
document.addEventListener("input", (ev) => {
  const el = ev.target;
  if (el.dataset.p) {
    try { setP(el.dataset.p, parseInput(el)); el.classList.remove("invalid"); }
    catch (err) { el.classList.add("invalid"); const m = document.querySelector(`[data-err="${CSS.escape(el.dataset.p)}"]`); if (m) m.textContent = err.message; return; }
    if (el.dataset.rerender !== undefined) render();
    scheduleValidate();
  }
  if (el.dataset.arg !== undefined && el.type !== "checkbox" && el.tagName !== "SELECT") updateArg(el);
  if (el.dataset.azure) applyAzure();
});
document.addEventListener("change", (ev) => {
  const el = ev.target;
  if (el.dataset.p && (el.type === "checkbox" || el.tagName === "SELECT")) {
    setP(el.dataset.p, parseInput(el));
    if (el.dataset.rerender !== undefined) render();
    scheduleValidate();
  }
  if (el.dataset.arg !== undefined && (el.type === "checkbox" || el.tagName === "SELECT")) updateArg(el);
  if (el.dataset.transport) {
    const set = new Set(M.server.transports ?? ["stdio"]);
    el.checked ? set.add(el.dataset.transport) : set.delete(el.dataset.transport);
    M.server.transports = ["stdio", "http"].filter((t) => set.has(t));
    if (!M.server.transports.length) delete M.server.transports;
    if (!set.has("http")) delete M.server.http;
    render(); scheduleValidate();
  }
  if (el.dataset.tool) {
    const n = el.dataset.tool;
    M.tools ??= {};
    if (el.checked) M.tools[n] = toolCache[n] ?? clone(DEFAULT_BINDINGS[n]);
    else { toolCache[n] = M.tools[n]; delete M.tools[n]; }
    if (!Object.keys(M.tools).length) delete M.tools;
    render(); scheduleValidate();
  }
  if (el.dataset.scope) {
    const path = el.dataset.scope;
    const cur = new Set(getP(path) ?? []);
    el.checked ? cur.add(el.value) : cur.delete(el.value);
    setP(path, [...cur]);
    if (path === "access.stdioScopes" && !cur.size && M.access && !Object.keys(M.access).length) delete M.access;
    scheduleValidate();
  }
  if (el.dataset.authtype !== undefined) {
    const t = el.value;
    M.api.auth = { type: t, ...({ api_key: { in: "header", name: "X-Api-Key", valueEnv: "COMPANY_API_KEY" }, bearer: { tokenEnv: "COMPANY_API_TOKEN" }, basic: { usernameEnv: "COMPANY_API_USER", passwordEnv: "COMPANY_API_PASSWORD" }, oauth2_client_credentials: { tokenUrl: "", clientIdEnv: "COMPANY_CLIENT_ID", clientSecretEnv: "COMPANY_CLIENT_SECRET" } }[t] ?? {}) };
    if (M.api.auth.tokenUrl === "") delete M.api.auth.tokenUrl;
    render(); scheduleValidate();
  }
  if (el.dataset.oauthmode !== undefined) {
    M.access ??= {};
    if (el.value === "none") delete M.access.oauth;
    else if (el.value === "azure") { M.access.oauth = { issuer: "https://login.microsoftonline.com/TENANT/v2.0", audience: [] }; }
    else M.access.oauth = { issuer: "", audience: "" };
    if (!Object.keys(M.access).length) delete M.access;
    render(); if (el.value === "azure") applyAzure(); else scheduleValidate();
  }
  if (el.dataset.ressource !== undefined) {
    const r = M.resources[+el.dataset.ressource];
    if (el.value === "file") { delete r.request; delete r.response; delete r.list; delete r.listResponse; r.file = r.file ?? `docs/${r.name || "document"}.md`; r.mimeType = r.mimeType ?? "text/markdown"; }
    else { delete r.file; r.request = { method: "GET", path: "/" }; r.response = { recordPath: "data", mapping: "raw" }; if (r.mimeType === "text/markdown") delete r.mimeType; }
    render(); scheduleValidate();
  }
  if (el.dataset.upload !== undefined) {
    const r = M.resources[+el.dataset.upload];
    const f = el.files[0];
    if (!f) return;
    r.file = r.file ?? `docs/${f.name}`;
    f.text().then((text) => { FILES[r.file] = text; render(); scheduleValidate(); });
  }
  if (el.id === "importFile") {
    const f = el.files[0];
    if (!f) return;
    f.text().then(async (yaml) => {
      try { const { manifest } = await B.parse(yaml); M = manifest; FILES = {}; step = 0; render(); validate(); }
      catch (err) { alert(`Could not read that file: ${err.message}`); }
      el.value = "";
    });
  }
});
function applyAzure() {
  const tenant = document.querySelector('[data-azure="tenant"]')?.value.trim() ?? "";
  const client = document.querySelector('[data-azure="client"]')?.value.trim() ?? "";
  const o = M.access.oauth;
  o.issuer = `https://login.microsoftonline.com/${tenant || "TENANT"}/v2.0`;
  o.additionalIssuers = [`https://sts.windows.net/${tenant || "TENANT"}/`];
  o.audience = client ? [client, `api://${client}`] : [];
  o.jwksUrl = `https://login.microsoftonline.com/${tenant || "TENANT"}/discovery/v2.0/keys`;
  o.scopeClaim = ["roles", "scp"];
  scheduleValidate();
}
function updateArg(el) {
  const ci = +el.dataset.arg;
  const t = M.customTools[ci];
  const old = el.dataset.argname;
  const f = el.dataset.f;
  if (f === "name") {
    const nn = el.value.trim();
    if (!nn || nn === old || t.args[nn]) return;
    t.args = Object.fromEntries(Object.entries(t.args).map(([k, v]) => [k === old ? nn : k, v]));
    document.querySelectorAll(`[data-arg="${ci}"][data-argname="${CSS.escape(old)}"], [data-delarg="${ci}"][data-argname="${CSS.escape(old)}"]`).forEach((x) => (x.dataset.argname = nn));
  } else {
    const a = t.args[old];
    if (f === "required") { if (el.checked) a.required = true; else delete a.required; }
    else if (f === "type") a.type = el.value;
    else if (el.value.trim()) a[f] = el.value; else delete a[f];
  }
  scheduleValidate();
}
const NEW_ITEMS = {
  customTools: () => ({ name: "", title: "", description: "", kind: "read", args: {}, request: { method: "GET", path: "/" }, response: { recordPath: "data", mapping: "raw" } }),
  resources: () => ({ name: "", title: "", description: "", uri: "docs://", mimeType: "text/markdown", file: "" }),
  prompts: () => ({ name: "", title: "", description: "", template: "" }),
  "access.apiKeys": () => ({ clientId: "", keyHashEnv: "", scopes: [] }),
};
document.addEventListener("click", async (ev) => {
  const el = ev.target.closest("button, a");
  if (!el) return;
  const d = el.dataset;
  if (d.goto !== undefined) { ev.preventDefault(); const n = +d.goto; if (n >= 0 && n < STEPS.length) { step = n; render(); window.scrollTo({ top: 0 }); } return; }
  if (d.start) {
    if (d.start === "blank") { M = blankManifest(); FILES = {}; }
    else { const r = await B.example(d.start); M = r.manifest; FILES = r.files; }
    step = 0; render(); validate(); return;
  }
  if (d.add) {
    const arr = getP(d.add) ?? [];
    arr.push(NEW_ITEMS[d.add]());
    setP(d.add, arr.filter(Boolean));
    render(); scheduleValidate(); return;
  }
  if (d.del) {
    const arr = (getP(d.del) ?? []).filter((_, i) => i !== +d.i && _ !== undefined);
    setP(d.del, arr);
    if (M.access && !Object.keys(M.access).length) delete M.access;
    render(); scheduleValidate(); return;
  }
  if (d.addarg !== undefined) {
    const t = M.customTools[+d.addarg];
    let n = "arg", k = 1; while (t.args[`${n}${k}`]) k++;
    t.args[`${n}${k}`] = { type: "string" };
    render(); scheduleValidate(); return;
  }
  if (d.delarg !== undefined) { delete M.customTools[+d.delarg].args[d.argname]; render(); scheduleValidate(); return; }
  if (d.delmap) { delete M.mappings[d.delmap]; if (!Object.keys(M.mappings).length) delete M.mappings; render(); scheduleValidate(); return; }
  if (d.addmap) { M.mappings ??= {}; M.mappings[d.addmap] = clone(DEFAULT_MAPPINGS[d.addmap] ?? { id: "id" }); render(); scheduleValidate(); return; }
  if (d.newmap !== undefined) {
    const n = $("#newMapName").value.trim();
    if (!/^[a-z][a-z0-9_]*$/.test(n)) { alert("Use lowercase letters, digits and underscores."); return; }
    M.mappings ??= {}; M.mappings[n] ??= { id: "id" }; render(); scheduleValidate(); return;
  }
  if (d.download !== undefined) {
    const blob = new Blob([last.yaml], { type: "text/yaml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "manifest.yaml"; a.click(); URL.revokeObjectURL(a.href);
    return;
  }
  if (d.save !== undefined || d.generate !== undefined) {
    const out = $("#result");
    const gen = d.generate !== undefined;
    out.innerHTML = `<p class="muted">${gen ? "Generating…" : "Saving…"}</p>`;
    try {
      const r = await (gen ? B.generate(payload()) : B.save(payload()));
      if (r.errors?.length) { last = r; render(); return; }
      out.innerHTML = B.describeResult(r, gen, esc);
    } catch (err) { out.innerHTML = `<div class="note bad">✗ ${esc(err.message)}</div>`; }
    return;
  }
  if (d.applyyaml !== undefined) {
    try { const { manifest } = await B.parse($("#yamlEdit").value); M = manifest; await validate(); render(); }
    catch (err) { alert(`YAML error: ${err.message}`); }
  }
});
}

const LAYOUT = (extra) => `
<header>
  <h1>MCP Server Intake</h1>
  <div class="start">
    ${extra ?? ""}
    <span class="muted">Start from:</span>
    <button class="btn small" data-start="blank">Blank</button>
    <button class="btn small" data-start="example">Acme example</button>
    <button class="btn small" data-start="azure">Acme + Azure AD</button>
    <label class="btn small clickable">Import manifest.yaml<input id="importFile" type="file" accept=".yaml,.yml" hidden></label>
  </div>
</header>
<main>
  <nav aria-label="Steps"><ol id="steps"></ol></nav>
  <section class="step" id="stepBody"></section>
  <aside>
    <div class="panel" id="statusPanel"></div>
    <div class="panel"><h3>manifest.yaml (live)</h3><pre class="yaml" id="yamlPreview"></pre></div>
  </aside>
</main>`;

// mount({ container, backend, manifest?, files?, headerExtra? })
async function mount(opts) {
  B = opts.backend;
  M = opts.manifest ? clone(opts.manifest) : blankManifest();
  FILES = { ...(opts.files ?? {}) };
  step = 0;
  last = { errors: [], yaml: "", summary: null };
  opts.container.innerHTML = LAYOUT(opts.headerExtra);
  if (!listening) { listen(); listening = true; }
  CATALOG = await B.catalog();
  render();
  await validate();
}
const current = () => ({ manifest: clone(M), files: { ...FILES } });

window.McpWizard = { mount, current };
})();
