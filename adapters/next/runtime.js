// Server Component pembungkus: ambil bundle dari URL, render HTML (SSR),
// lalu serahkan ke island client untuk hydrate & interaksi.
import { createElement } from "react";
import { XPIsland } from "./island.js";
import { verifyManifest } from "./verify.js";

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

async function fetchManifest(base, init, query, publicKey) {
  const res = await fetch(`${base}/manifest.json${query}`, init);
  if (!res.ok) throw new Error(`[xp] ${base}/manifest.json → HTTP ${res.status}`);
  const text = await res.text();
  if (publicKey) {
    const sig = await fetch(`${base}/manifest.sig${query}`, init);
    if (!sig.ok) throw new Error(`[xp] ${base}/manifest.sig → HTTP ${sig.status} (remote belum ditandatangani?)`);
    if (!(await verifyManifest(text, await sig.text(), publicKey))) return null;
  }
  return JSON.parse(text);
}

// URL dibedakan supaya tidak di-dedupe dengan fetch pertama (request memoization Next).
const fresh = () => [{ cache: "no-store" }, `?t=${Date.now()}`];

async function getManifest(base, init, publicKey) {
  // Manifest dan manifest.sig di-cache terpisah; tepat setelah deploy keduanya bisa beda versi.
  // Tanda tangan tidak cocok → ambil ulang keduanya tanpa cache sebelum menolak.
  const manifest = (await fetchManifest(base, init, "", publicKey)) ?? (await fetchManifest(base, ...fresh(), publicKey));
  if (!manifest) throw new Error(`[xp] tanda tangan ${base}/manifest.json tidak valid, remote ditolak`);
  return manifest;
}

/**
 * @param {string} base URL remote
 * @param {string} name nama komponen
 * @param {{ revalidate?: number, publicKey?: string, dev?: boolean }} options
 *   publicKey: hanya terima manifest yang ditandatangani kunci ini (`xp build --sign`)
 *   dev: `next dev`; manifest tidak di-cache dan island mengikuti build baru dari `xp dev`
 */
export function remote(base, name, { revalidate = 30, publicKey, dev = false } = {}) {
  async function XPRemote(props) {
    // Manifest di-revalidate berkala → deploy remote terbaru terpakai tanpa rebuild app ini.
    const init = dev ? { cache: "no-store" } : { next: { revalidate } };
    const manifest = await getManifest(base, init, publicKey);
    let entry = manifest.components?.[name];
    if (!entry) {
      // Manifest di cache bisa lebih lama dari komponen yang di-import (mis. komponen baru):
      // ambil ulang tanpa cache sebelum menyerah.
      const [init, query] = fresh();
      entry = (await fetchManifest(base, init, query, publicKey))?.components?.[name];
    }
    if (!entry) throw new Error(`[xp] komponen "${name}" tidak ada di ${base}/manifest.json`);

    // Browser memuat bundle `web`. Server memakai bundle `ssr` kalau ada (komponen React/Vue/Svelte),
    // kalau tidak ada, bundle `web` yang sama (komponen xp).
    const src = `${base}/${entry.web.file}`;
    const server = entry.ssr ?? entry.web;
    const mod = await loadModule(`${base}/${server.file}`, server.sha256);
    const html = await mod.renderHTML(props); // Vue: Promise, lainnya: string
    // live: hanya kalau app dijalankan dengan `next dev` dan remote-nya `xp dev`.
    const live = dev && manifest.dev === true;
    return createElement(XPIsland, { src, sha256: entry.web.sha256, html, props, base, name, live });
  }
  XPRemote.displayName = `XP(${name})`;
  return XPRemote;
}
