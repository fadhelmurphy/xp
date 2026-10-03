// Static server untuk hasil xp build, dengan header yang dibutuhkan konsumen:
//   - CORS (browser memuat bundle dari domain lain)
//   - manifest.json: cache singkat (menunjuk ke versi terbaru)
//   - file ber-hash: immutable (cache selamanya)
// Di production, CDN/bucket biasa dengan aturan header yang sama sudah cukup.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const TYPES = { ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".ts": "text/plain; charset=utf-8" };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Halaman kecil di "/" supaya jelas apa saja yang disajikan.
async function indexPage(dir) {
  const manifest = await readFile(path.join(dir, "manifest.json"), "utf8").then(JSON.parse).catch(() => null);
  const rows = manifest
    ? Object.entries(manifest.components)
        .map(([name, c]) => {
          const link = (f) => (f ? `<a href="/${esc(f)}">${esc(f)}</a>` : "-");
          return `<tr><td><b>${esc(name)}</b><br><small>${esc((c.primitives ?? []).join(", "))}</small></td>` +
            `<td>${link(c.web?.file)}</td><td>${link(c.native?.file)}</td><td>${link(c.types)}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="4">Belum ada manifest.json. Jalankan <code>xp build</code> dulu.</td></tr>`;
  return `<!doctype html><meta charset="utf-8"><title>xp serve</title>
<style>body{font:14px system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 16px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}
small{color:#666}code{background:#f3f3f3;padding:1px 4px}</style>
<h1>xp serve</h1>
<p>Remote ini dipakai konsumen lewat <a href="/manifest.json">manifest.json</a>${manifest ? ` · protokol ${esc(manifest.protocol)} · build ${esc(manifest.builtAt)}` : ""}.</p>
<table><tr><th>Komponen</th><th>Web</th><th>Native</th><th>Tipe</th></tr>${rows}</table>`;
}

export function serve(dir, port) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const file = path.join(dir, path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\\\])+/, ""));
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(await indexPage(dir));
      return;
    }
    if (!file.startsWith(dir) || !(await stat(file).catch(() => null))?.isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    const name = path.basename(file);
    res.setHeader("Content-Type", TYPES[path.extname(file)] ?? TYPES[name.endsWith(".d.ts") ? ".ts" : ""] ?? "application/octet-stream");
    res.setHeader("Cache-Control", name === "manifest.json" ? "public, max-age=10" : "public, max-age=31536000, immutable");
    res.end(await readFile(file));
  });
  server.listen(port, () => console.log(`xp serve: ${dir} → http://localhost:${port}`));
  return server;
}
