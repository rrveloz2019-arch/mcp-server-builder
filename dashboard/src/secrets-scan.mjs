// Refuses manifests that look like they contain a real secret. Manifests are
// meant to hold only the NAMES of environment variables; a pasted key would
// otherwise end up stored, generated into code and downloaded.
// Findings name the location, never the value.

const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\b(sk|rk)_(live|test)_[0-9a-zA-Z]{16,}/, "a Stripe key"],
  [/\bgh[pousr]_[0-9A-Za-z]{30,}/, "a GitHub token"],
  [/\bxox[abposr]-[0-9A-Za-z-]{10,}/, "a Slack token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/\bsk-(ant-)?[0-9A-Za-z_-]{20,}/, "an API secret key"],
  [/\beyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}/, "a JWT access token"],
  [/:\/\/[^/\s:@{}]+:[^/\s@{}]+@/, "a password inside a URL"],
];
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token)$/i;
const PLACEHOLDER_ONLY = /^\s*(\{[a-z_.]+\}\s*)*$/i;

function walk(value, where, out) {
  if (typeof value === "string") {
    for (const [re, what] of PATTERNS) if (re.test(value)) out.push(`${where}: looks like ${what}`);
  } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${where}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, where ? `${where}.${k}` : k, out);
}

function checkHeaders(headers, where, out) {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (SECRET_HEADER.test(name) && !PLACEHOLDER_ONLY.test(String(value))) {
      out.push(`${where}.${name}: credentials must not be written in the manifest; use api.auth with an environment variable name`);
    }
  }
}

export function findSecrets(manifest, files = {}) {
  const out = [];
  walk(manifest, "", out);
  checkHeaders(manifest?.api?.headers, "api.headers", out);
  const requests = [];
  for (const [n, t] of Object.entries(manifest?.tools ?? {})) requests.push([`tools.${n}.request.headers`, t?.request?.headers]);
  (manifest?.customTools ?? []).forEach((t, i) => requests.push([`customTools[${i}].request.headers`, t?.request?.headers]));
  (manifest?.resources ?? []).forEach((r, i) => requests.push([`resources[${i}].request.headers`, r?.request?.headers]));
  for (const [where, h] of requests) checkHeaders(h, where, out);
  for (const [name, text] of Object.entries(files)) walk(text, `file ${name}`, out);
  return [...new Set(out)];
}
