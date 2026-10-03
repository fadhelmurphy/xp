// Runtime isomorfik (server & browser), tanpa framework.
// Dipakai oleh wrapper per framework (Vue, Svelte, ...) yang dibuat plugin xp().
const PROTOCOL = 1;
const manifests = new Map(); // base → { data, expires }
const serverModules = new Map(); // src → exports
const clientModules = new Map(); // src → Promise<exports>

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

/** Manifest di-cache `revalidate` detik. Remote mati → pakai versi terakhir yang ada. */
export async function getManifest(base, revalidate = 30) {
  const hit = manifests.get(base);
  if (hit && hit.expires > Date.now()) return hit.data;
  try {
    const res = await fetch(`${base}/manifest.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
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
export async function renderRemote(base, name, props, revalidate = 30) {
  let entry = (await getManifest(base, revalidate)).components?.[name];
  if (!entry) {
    // Manifest di cache bisa lebih lama dari komponen yang di-import: ambil ulang sekali.
    manifests.delete(base);
    entry = (await getManifest(base, revalidate)).components?.[name];
  }
  if (!entry) throw new Error(`[xp] komponen "${name}" tidak ada di ${base}/manifest.json`);
  const src = `${base}/${entry.web.file}`;
  let mod = serverModules.get(src);
  if (!mod) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`[xp] ${src} → HTTP ${res.status}`);
    const code = await res.text();
    if (entry.web.sha256 && (await sha256(code)) !== entry.web.sha256) {
      throw new Error(`[xp] ${src}: hash tidak cocok dengan manifest, bundle ditolak`);
    }
    mod = evaluate(code);
    serverModules.set(src, mod);
  }
  return { src, html: mod.renderHTML(props) };
}

/** Browser: muat bundle yang sama (file ber-hash → cache browser/CDN). */
export function loadClient(src) {
  if (!clientModules.has(src)) {
    clientModules.set(
      src,
      fetch(src)
        .then((r) => {
          if (!r.ok) throw new Error(`${src} → HTTP ${r.status}`);
          return r.text();
        })
        .then(evaluate)
        .catch((e) => {
          clientModules.delete(src); // coba lagi nanti
          throw e;
        }),
    );
  }
  return clientModules.get(src);
}

/** Props untuk komponen xp harus bisa di-JSON-kan. Buang function & undefined. */
export function plainProps(obj) {
  return JSON.parse(JSON.stringify(obj ?? {}));
}
