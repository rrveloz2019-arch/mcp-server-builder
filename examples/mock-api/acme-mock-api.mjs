#!/usr/bin/env node
// A fake "Acme Outdoor" backend with the endpoints used by
// examples/acme-outdoor.yaml. Used by the end-to-end tests and for demos.
//
//   node examples/mock-api/acme-mock-api.mjs [port]
//   then run the generated server with API_BASE_URL=http://127.0.0.1:<port>/v2
//
// Test helpers (no auth): GET /__requests (log of calls), POST /__fail?count=N
// (next N API calls return 503), GET /__jwks (keys set via setJwks()).

import http from "node:http";
import { fileURLToPath } from "node:url";

const PRODUCTS = [
  { sku: "TB-100", title: "TrailBlazer Hiking Boot", summary: "Waterproof leather hiking boot.", category: { id: "footwear", name: "Footwear" }, pricing: { list: 149.0, currency: "USD" }, links: { web: "https://acme-outdoor.example.com/p/TB-100" }, media: [{ url: "https://cdn.example.com/tb100.jpg" }], internal_cost: 61.2 },
  { sku: "TB-200", title: "TrailBlazer Waterproof Boot Pro", summary: "Insulated waterproof boot for winter hikes.", category: { id: "footwear", name: "Footwear" }, pricing: { list: 189.0, currency: "USD" }, links: { web: "https://acme-outdoor.example.com/p/TB-200" }, media: [] },
  { sku: "TN-300", title: "Summit 2-Person Tent", summary: "Three-season backpacking tent.", category: { id: "camping", name: "Camping" }, pricing: { list: 329.0, currency: "USD" }, links: { web: "https://acme-outdoor.example.com/p/TN-300" }, media: [] },
];
const STOCK = { "TB-100": [{ code: "NYC", available: 42 }, { code: "LAX", available: 0, next_restock: "2026-10-15" }], "TB-200": [{ code: "NYC", available: 7 }], "TN-300": [{ code: "LAX", available: 12 }] };
// Loose search like a real catalog: every word must appear, plurals match singulars ("boots" finds "Boot").
const matches = (text, q) => q.split(/\s+/).filter(Boolean).every((w) => text.toLowerCase().includes(w.replace(/(?<=\w{3})s$/, "")));
const DISCOUNTS = { "C-2044": 10, "C-1001": 5 };

export function createMockApi({ apiKey = "test-upstream-key", jobSteps = [0, 40, 100] } = {}) {
  const requests = [];
  const quotes = new Map();
  const orders = new Map([["SO-5001", { order_number: "SO-5001", customer: "C-2044", status: "shipped", totals: { grand_total: 1341, currency: "USD" }, created_at: "2026-09-01T10:00:00Z" }], ["SO-7002", { order_number: "SO-7002", customer: "C-1001", status: "processing", totals: { grand_total: 329, currency: "USD" }, created_at: "2026-09-20T10:00:00Z" }]]);
  const jobs = new Map();
  let failNext = 0;
  let jwks = { keys: [] };
  let seq = 1;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)); };
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;

    if (url.pathname === "/__requests") return send(200, requests);
    if (url.pathname === "/__fail") { failNext = Number(url.searchParams.get("count") ?? 1); return send(200, { failNext }); }
    if (url.pathname === "/__jwks") return send(200, jwks);

    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, apiKey: req.headers["x-api-key"] });
    if (req.headers["x-api-key"] !== apiKey) return send(401, { message: "bad api key" });
    if (failNext > 0) { failNext--; return send(503, { message: "temporarily unavailable" }); }

    const p = url.pathname.replace(/^\/v2/, "");
    let m;
    if (req.method === "GET" && p === "/products") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const cat = url.searchParams.get("category");
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const all = PRODUCTS.filter((x) => matches(`${x.title} ${x.summary}`, q) && (!cat || x.category.id === cat || x.category.name === cat));
      const page = all.slice(start, start + limit);
      return send(200, { data: page, meta: { next: start + limit < all.length ? String(start + limit) : null } });
    }
    if (req.method === "GET" && (m = p.match(/^\/products\/([^/]+)$/))) {
      const prod = PRODUCTS.find((x) => x.sku === decodeURIComponent(m[1]));
      return prod ? send(200, { data: prod }) : send(404, { message: `No product ${m[1]}` });
    }
    if (req.method === "GET" && p === "/categories") return send(200, { data: [{ id: "footwear", name: "Footwear" }, { id: "camping", name: "Camping" }] });
    if (req.method === "GET" && (m = p.match(/^\/inventory\/([^/]+)$/))) {
      const sku = decodeURIComponent(m[1]);
      if (!STOCK[sku]) return send(404, { message: `No product ${sku}` });
      const wh = url.searchParams.get("warehouse");
      return send(200, { data: STOCK[sku].filter((s) => !wh || s.code === wh).map((s) => ({ sku, inventory: { available: s.available, next_restock: s.next_restock ?? null }, warehouse: { code: s.code } })) });
    }
    if (req.method === "POST" && p === "/pricing/calculate") {
      const prod = PRODUCTS.find((x) => x.sku === body?.sku);
      if (!prod) return send(404, { message: `No product ${body?.sku}` });
      const qty = Number(body.qty ?? 1);
      const disc = DISCOUNTS[body.customer] ?? 0;
      const unit = +(prod.pricing.list * (1 - disc / 100)).toFixed(2);
      return send(200, { data: { sku: prod.sku, unit_price: unit, currency: "USD", qty, discount_pct: disc, line_total: +(unit * qty).toFixed(2) } });
    }
    if (req.method === "POST" && p === "/quotes") {
      if (!body?.customer || !Array.isArray(body.lines) || body.lines.length === 0) return send(422, { message: "customer and lines are required" });
      let total = 0;
      for (const l of body.lines) {
        const prod = PRODUCTS.find((x) => x.sku === l.product_id);
        if (!prod) return send(422, { message: `Unknown product ${l.product_id}` });
        total += prod.pricing.list * (1 - (DISCOUNTS[body.customer] ?? 0) / 100) * l.quantity;
      }
      const id = `Q-${1000 + seq++}`;
      const q = { quote_id: id, customer: body.customer, state: "open", totals: { grand_total: +total.toFixed(2), currency: "USD" }, valid_until: "2026-10-24", links: { pdf: `https://acme-outdoor.example.com/q/${id}.pdf` }, note: body.note };
      quotes.set(id, q);
      return send(201, { data: q });
    }
    if (req.method === "POST" && (m = p.match(/^\/quotes\/([^/]+)\/send$/))) {
      const q = quotes.get(decodeURIComponent(m[1]));
      return q ? send(200, { data: { quote_id: q.quote_id, delivered: true, to: `buyer@${q.customer.toLowerCase()}.example.com` } }) : send(404, { message: "No such quote" });
    }
    if (req.method === "GET" && (m = p.match(/^\/orders\/([^/]+)$/))) {
      const o = orders.get(decodeURIComponent(m[1]));
      return o ? send(200, { data: o }) : send(404, { message: "No such order" });
    }
    if (req.method === "POST" && p === "/authenticity/verify") {
      const ok = /^ACME:TB-100:/.test(body?.qr ?? "");
      return send(200, { data: { is_authentic: ok, sku: ok ? "TB-100" : null, batch_code: ok ? body.qr.split(":")[2] : null, warranty: { expires: ok ? "2028-03-01" : null } } });
    }
    if (req.method === "POST" && p === "/reports") {
      const id = `job-${seq++}`;
      jobs.set(id, { polls: 0, customer: body?.customer, from: body?.from, to: body?.to });
      return send(202, { data: { job_id: id } });
    }
    if (req.method === "GET" && (m = p.match(/^\/reports\/([^/]+)$/))) {
      const job = jobs.get(m[1]);
      if (!job) return send(404, { message: "No such job" });
      const pct = jobSteps[Math.min(job.polls++, jobSteps.length - 1)];
      const done = pct >= 100;
      return send(200, { data: { state: done ? "complete" : "running", percent: pct, ...(done ? { customer: job.customer, period: `${job.from}..${job.to}`, orders: 12, revenue: 18430.5, top_products: ["TB-100", "TN-300"] } : {}) } });
    }
    return send(404, { message: `No route ${req.method} ${p}` });
  });

  return {
    server,
    requests,
    setJwks: (k) => { jwks = k; },
    listen: (port = 0) => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const api = createMockApi({ apiKey: process.env.ACME_API_KEY ?? "test-upstream-key" });
  const port = await api.listen(Number(process.argv[2] ?? 4010));
  console.log(`Mock Acme API on http://127.0.0.1:${port}/v2 (X-Api-Key: ${process.env.ACME_API_KEY ?? "test-upstream-key"})`);
}
