// Server Component pembungkus: ambil bundle dari URL, render HTML (SSR),
// lalu serahkan ke island client untuk hydrate & interaksi.
import { createElement } from "react";
import { XPIsland } from "./island.js";

const modules = new Map(); // src (ber-hash) → exports; aman di-cache selamanya

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadModule(src, expectedHash) {
  const hit = modules.get(src);
  if (hit) return hit;
  const res = await fetch(src, { cache: "force-cache" });
  if (!res.ok) throw new Error(`[xp] ${src} → HTTP ${res.status}`);
  const code = await res.text();
  if (expectedHash && (await sha256(code)) !== expectedHash) {
    throw new Error(`[xp] ${src}: hash tidak cocok dengan manifest, bundle ditolak`);
  }
  const module = { exports: {} };
  new Function("module", "exports", code)(module, module.exports);
  modules.set(src, module.exports);
  return module.exports;
}

export function remote(base, name, { revalidate = 30 } = {}) {
  async function XPRemote(props) {
    // Manifest di-revalidate berkala → deploy remote terbaru terpakai tanpa rebuild app ini.
    const res = await fetch(`${base}/manifest.json`, { next: { revalidate } });
    if (!res.ok) throw new Error(`[xp] ${base}/manifest.json → HTTP ${res.status}`);
    const manifest = await res.json();
    const entry = manifest.components?.[name];
    if (!entry) throw new Error(`[xp] komponen "${name}" tidak ada di ${base}/manifest.json`);

    const src = `${base}/${entry.web.file}`;
    const mod = await loadModule(src, entry.web.sha256);
    const html = mod.renderHTML(props);
    return createElement(XPIsland, { src, html, props });
  }
  XPRemote.displayName = `XP(${name})`;
  return XPRemote;
}
