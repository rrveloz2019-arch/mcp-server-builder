// Backend for the local intake tool: talks to src/intake/server.mjs.
"use strict";
(function () {
  async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    return data;
  }
  function describeResult(r, generated, esc) {
    let html = `<div class="note ok">✓ Saved <code>${esc(r.manifestPath)}</code></div>`;
    if (!generated) {
      return html + `<p class="muted">Generate it from the command line:</p><pre>node src/cli/mcp-builder.mjs generate ${esc(r.manifestPath)} --out ${esc(r.manifestPath.replace(/manifest\.yaml$/, "server"))}</pre>`;
    }
    if (!r.generated) return html + `<div class="note bad">✗ Generation failed:<pre>${esc(r.generateError)}</pre></div>`;
    html += `<div class="note ok">✓ Generated the server in <code>${esc(r.outDir)}</code>: ${r.counts.tools} tools, ${r.counts.resources} resources, ${r.counts.prompts} prompts.</div>`;
    if (r.warnings?.length) html += `<div class="note warn">${r.warnings.map((w) => `! ${esc(w)}`).join("<br>")}</div>`;
    html += `<p><strong>Next steps, in a terminal:</strong></p><pre>${r.nextSteps.map((s, i) => `${i + 1}. ${esc(s)}`).join("\n")}</pre>`;
    return html + `<p class="muted">Same result from the command line:</p><pre>${esc(r.command)}</pre>`;
  }
  const backend = {
    catalog: () => api("/api/catalog"),
    example: (name) => api(`/api/example?name=${encodeURIComponent(name)}`),
    parse: (yaml) => api("/api/parse", { yaml }),
    validate: (p) => api("/api/validate", p),
    save: (p) => api("/api/save", p),
    generate: (p) => api("/api/generate", p),
    describeResult,
  };
  window.McpWizard.mount({ container: document.getElementById("app"), backend });
})();
