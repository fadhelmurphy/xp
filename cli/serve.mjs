// Static server untuk hasil xp build, dengan header yang dibutuhkan konsumen:
//   - CORS (browser memuat bundle dari domain lain)
//   - manifest.json / manifest.sig: cache singkat (menunjuk ke versi terbaru)
//   - file ber-hash: immutable (cache selamanya)
// Di production, CDN/bucket biasa dengan aturan header yang sama sudah cukup.
//
// Mode dev (xp dev) menambah:
//   - /__xp/events   Server-Sent Events: {"type":"update","components":[...]} setiap build
//   - /preview/<nama> pratinjau komponen di browser, dimuat ulang otomatis
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".sig": "text/plain; charset=utf-8",
};
const MUTABLE = new Set(["manifest.json", "manifest.sig"]);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const json = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

// Halaman kecil di "/" supaya jelas apa saja yang disajikan.
async function indexPage(dir, dev) {
  const manifest = await readFile(path.join(dir, "manifest.json"), "utf8").then(JSON.parse).catch(() => null);
  const signed = await stat(path.join(dir, "manifest.sig")).then(() => true, () => false);
  const rows = manifest
    ? Object.entries(manifest.components)
        .map(([name, c]) => {
          const link = (f) => (f ? `<a href="/${esc(f)}">${esc(f)}</a>` : "-");
          const title = dev ? `<a href="/preview/${esc(name)}">${esc(name)}</a>` : esc(name);
          return `<tr><td><b>${title}</b><br><small>${esc((c.primitives ?? []).join(", "))}</small></td>` +
            `<td>${link(c.web?.file)}</td><td>${link(c.native?.file)}</td><td>${link(c.types)}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="4">Belum ada manifest.json. Jalankan <code>xp build</code> dulu.</td></tr>`;
  return `<!doctype html><meta charset="utf-8"><title>xp ${dev ? "dev" : "serve"}</title>
<style>body{font:14px system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 16px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}
small{color:#666}code{background:#f3f3f3;padding:1px 4px}</style>
<h1>xp ${dev ? "dev" : "serve"}</h1>
<p>Remote ini dipakai konsumen lewat <a href="/manifest.json">manifest.json</a>${
    manifest ? ` · protokol ${esc(manifest.protocol)} · build ${esc(manifest.builtAt)}${signed ? ` · <a href="/manifest.sig">ditandatangani</a>` : ""}` : ""
  }.</p>
<table><tr><th>Komponen</th><th>Web</th><th>Native</th><th>Tipe</th></tr>${rows}</table>
${
  dev
    ? `<p><small>Klik nama komponen untuk pratinjau. Halaman ini dimuat ulang otomatis setiap build.</small></p>
<script>new EventSource("/__xp/events").onmessage = (e) => JSON.parse(e.data).type === "update" && location.reload();</script>`
    : ""
}`;
}

// Pratinjau satu komponen. Saat ada build baru, bundle baru dimuat dan state komponen xp
// dipertahankan lewat snapshot (komponen React/Vue/Svelte dimuat ulang dari awal).
function previewPage(name, props) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} · xp dev</title>
<style>body{font:14px system-ui,sans-serif;max-width:480px;margin:24px auto;padding:0 16px;background:#f6f8fa}
header{display:flex;justify-content:space-between;color:#57606a;margin-bottom:12px}#status{font-size:12px}</style>
<header><a href="/">← xp dev</a><span id="status">memuat…</span></header>
<div id="app"></div>
<script>
const NAME = ${json(name)};
const PROPS = ${json(props)};
const status = document.getElementById("status");
const app = document.getElementById("app");
let handle = null, file = null;
async function load() {
  const manifest = await (await fetch("/manifest.json", { cache: "no-store" })).json();
  const entry = manifest.components[NAME];
  if (!entry) throw new Error("komponen " + NAME + " tidak ada di manifest");
  if (entry.web.file === file) return;
  const evaluate = (code, require) => {
    const module = { exports: {} };
    new Function("module", "exports", "require", code)(module, module.exports, require);
    return module.exports;
  };
  // Komponen xp me-require runtime bersama (xp-runtime.<hash>.js).
  const runtime = entry.web.runtime ? evaluate(await (await fetch("/" + entry.web.runtime.file)).text()).modules : {};
  const module = { exports: evaluate(await (await fetch("/" + entry.web.file)).text(), (id) => runtime[id]) };
  const restore = handle && handle.snapshot ? handle.snapshot() : null;
  if (handle) handle.unmount();
  app.textContent = "";
  handle = module.exports.render(app, PROPS, { restore });
  file = entry.web.file;
  document.body.dataset.file = file;
  status.textContent = (restore ? "dimuat ulang, state dipertahankan · " : "") + new Date().toLocaleTimeString();
}
load().catch((e) => (status.textContent = e.message));
new EventSource("/__xp/events").onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "update" && msg.components.includes(NAME)) load().catch((err) => (status.textContent = err.message));
  if (msg.type === "error") status.textContent = "build gagal: " + msg.message;
};
</script>`;
}

/**
 * @param {string} dir folder hasil build
 * @param {number} port
 * @param {{ dev?: boolean, quiet?: boolean }} opts
 */
export function serve(dir, port, { dev = false, quiet = false } = {}) {
  const clients = new Set();
  const broadcast = (event) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const c of clients) c.write(line);
  };
  // Komentar berkala supaya koneksi SSE tidak diputus proxy atau OS mobile.
  const heartbeat = dev ? setInterval(() => clients.forEach((c) => c.write(": ping\n\n")), 15_000) : null;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const file = path.join(dir, path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ""));
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(await indexPage(dir, dev));
      return;
    }
    if (dev && url.pathname === "/__xp/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (dev && url.pathname.startsWith("/preview/")) {
      let props = {};
      try {
        props = JSON.parse(url.searchParams.get("props") ?? "{}");
      } catch {
        // props tidak valid: pakai props kosong
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(previewPage(decodeURIComponent(url.pathname.slice("/preview/".length)), props));
      return;
    }
    if (!file.startsWith(dir) || !(await stat(file).catch(() => null))?.isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    const name = path.basename(file);
    res.setHeader("Content-Type", TYPES[path.extname(file)] ?? TYPES[name.endsWith(".d.ts") ? ".ts" : ""] ?? "application/octet-stream");
    res.setHeader(
      "Cache-Control",
      MUTABLE.has(name) ? (dev ? "no-store" : "public, max-age=10") : "public, max-age=31536000, immutable",
    );
    res.end(await readFile(file));
  });
  server.on("close", () => heartbeat && clearInterval(heartbeat));
  server.listen(port, () => quiet || console.log(`xp ${dev ? "dev" : "serve"}: ${dir} → http://localhost:${port}`));
  return {
    server,
    broadcast,
    close() {
      clients.forEach((c) => c.end());
      server.close();
    },
  };
}
