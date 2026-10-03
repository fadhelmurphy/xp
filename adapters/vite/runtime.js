// Runtime isomorfik (server & browser), tanpa framework.
// Dipakai oleh wrapper per framework (Vue, Svelte, ...) yang dibuat plugin xp().
import { loadBundle } from "./client.js";
import { verifyManifest } from "./verify.js";

export { swapInstance, watchDev } from "./client.js";

const PROTOCOL = 1;
const manifests = new Map(); // base → { data, expires }
const serverModules = new Map(); // src → exports

function evaluate(code) {
  // Bundle web xp = CJS mandiri (runtime ikut di dalamnya), tidak me-require apa pun.
  const module = { exports: {} };
  new Function("module", "exports", code)(module, module.exports);
  return module.exports;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Manifest di-cache `revalidate` detik. Remote mati → pakai versi terakhir yang ada.
 * Dengan `publicKey`, manifest harus ditandatangani kunci itu (`xp build --sign`).
 */
export async function getManifest(base, revalidate = 30, publicKey = null) {
  const hit = manifests.get(base);
  if (hit && hit.expires > Date.now()) return hit.data;
  try {
    const res = await fetch(`${base}/manifest.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (publicKey) {
      const sig = await fetch(`${base}/manifest.sig`, { cache: "no-store" });
      if (!sig.ok) throw new Error(`manifest.sig → HTTP ${sig.status} (remote belum ditandatangani?)`);
      if (!(await verifyManifest(text, await sig.text(), publicKey))) throw new Error("tanda tangan tidak valid, remote ditolak");
    }
    const data = JSON.parse(text);
    if (data.protocol !== PROTOCOL) throw new Error(`protokol ${data.protocol} tidak didukung (adapter: ${PROTOCOL})`);
    manifests.set(base, { data, expires: Date.now() + revalidate * 1000 });
    return data;
  } catch (e) {
    if (hit) {
      console.warn(`[xp] ${base}/manifest.json gagal (${e.message}), memakai versi cache`);
      return hit.data;
    }
    throw new Error(`[xp] ${base}/manifest.json gagal: ${e.message}`);
  }
}

/** Server: ambil bundle (diverifikasi sha256) lalu render HTML. */
export async function renderRemote(base, name, props, revalidate = 30, publicKey = null, dev = false) {
  if (dev) revalidate = 0; // dev server: selalu manifest terbaru
  let manifest = await getManifest(base, revalidate, publicKey);
  let entry = manifest.components?.[name];
  if (!entry) {
    // Manifest di cache bisa lebih lama dari komponen yang di-import: ambil ulang sekali.
    manifests.delete(base);
    manifest = await getManifest(base, revalidate, publicKey);
    entry = manifest.components?.[name];
  }
  if (!entry) throw new Error(`[xp] komponen "${name}" tidak ada di ${base}/manifest.json`);
  // Browser memuat bundle `web`. Server memakai bundle `ssr` kalau ada (komponen React/Vue/Svelte).
  const src = `${base}/${entry.web.file}`;
  const server = entry.ssr ?? entry.web;
  const serverSrc = `${base}/${server.file}`;
  let mod = serverModules.get(serverSrc);
  if (!mod) {
    const res = await fetch(serverSrc);
    if (!res.ok) throw new Error(`[xp] ${serverSrc} → HTTP ${res.status}`);
    const code = await res.text();
    if (server.sha256 && (await sha256(code)) !== server.sha256) {
      throw new Error(`[xp] ${serverSrc}: hash tidak cocok dengan manifest, bundle ditolak`);
    }
    mod = evaluate(code);
    serverModules.set(serverSrc, mod);
  }
  return {
    src,
    sha256: entry.web.sha256,
    html: await mod.renderHTML(props), // Vue: Promise, lainnya: string
    // live: hanya kalau app dijalankan di dev server Vite dan remote-nya `xp dev`.
    live: dev && manifest.dev === true,
  };
}

/** Browser: muat bundle web (file ber-hash → cache browser/CDN), dicek sha256-nya. */
export function loadClient(src, sha256) {
  return loadBundle(src, sha256);
}

/** Props untuk komponen xp harus bisa di-JSON-kan. Buang function & undefined. */
export function plainProps(obj) {
  return JSON.parse(JSON.stringify(obj ?? {}));
}
