// Kode browser yang dipakai bersama oleh adapter: muat bundle web (dicek sha256-nya)
// dan ikuti build baru dari `xp dev`.

// --- sha256 ---
// WebCrypto hanya ada di secure context (https atau localhost). Saat app dibuka lewat
// http://192.168.x.x (mis. tes dari HP), pakai implementasi JS di bawah.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** sha256 murni JS (hex). Hanya dipakai kalau WebCrypto tidak tersedia. */
export function sha256Js(text) {
  const data = new TextEncoder().encode(text);
  const bitLen = data.length * 8;
  const total = ((data.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[data.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(bitLen / 2 ** 32));
  view.setUint32(total - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => (h[i] = (h[i] + v) >>> 0));
  }
  return [...h].map((v) => v.toString(16).padStart(8, "0")).join("");
}

export async function sha256(text) {
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return sha256Js(text);
}

// --- muat bundle ---

const cache = new Map(); // src → Promise<exports>

async function fetchVerified(src, expectedHash) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`${src} → HTTP ${res.status}`);
  const code = await res.text();
  if (expectedHash && (await sha256(code)) !== expectedHash) {
    throw new Error(`${src}: hash tidak cocok dengan manifest, bundle ditolak`);
  }
  return code;
}

function once(src, load) {
  if (!cache.has(src)) {
    cache.set(
      src,
      load().catch((e) => {
        cache.delete(src); // coba lagi nanti
        throw e;
      }),
    );
  }
  return cache.get(src);
}

function evaluate(code, require) {
  const module = { exports: {} };
  new Function("module", "exports", "require", code)(module, module.exports, require);
  return module.exports;
}

/**
 * Unduh bundle web, cocokkan dengan sha256 dari manifest, lalu jalankan. Hasilnya di-cache per URL.
 * `runtime` ({ src, sha256 }): runtime xp bersama yang di-require bundle komponen xp. Dimuat sekali
 * untuk semua komponen dari remote yang sama.
 */
export function loadBundle(src, expectedHash, runtime) {
  return once(src, async () => {
    const [code, modules] = await Promise.all([
      fetchVerified(src, expectedHash),
      runtime ? once(runtime.src, async () => evaluate(await fetchVerified(runtime.src, runtime.sha256))) : null,
    ]);
    return evaluate(code, (id) => {
      const mod = modules?.modules?.[id];
      if (!mod) throw new Error(`${src} membutuhkan ${id}, tapi runtime xp tidak dimuat`);
      return mod;
    });
  });
}

/** Lokasi runtime bersama untuk satu entri manifest, atau null (bundle mandiri / framework lain). */
export function runtimeOf(base, web) {
  return web.runtime ? { src: `${base}/${web.runtime.file}`, sha256: web.runtime.sha256 } : null;
}

// --- xp dev ---

/**
 * Ikuti build baru dari `xp dev`. `onUpdate({ src, sha256, runtime })` dipanggil setiap komponen `name`
 * di-build ulang. Mengembalikan fungsi untuk berhenti.
 */
export function watchDev(base, name, onUpdate) {
  if (typeof EventSource === "undefined") return () => {};
  const events = new EventSource(`${base}/__xp/events`);
  events.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type !== "update" || !msg.components.includes(name)) return;
    try {
      const manifest = await (await fetch(`${base}/manifest.json`, { cache: "no-store" })).json();
      const entry = manifest.components?.[name];
      if (entry) await onUpdate({ src: `${base}/${entry.web.file}`, sha256: entry.web.sha256, runtime: runtimeOf(base, entry.web) });
    } catch (err) {
      console.error("[xp] reload gagal", err);
    }
  };
  return () => events.close();
}

/** Ganti instance yang sedang tampil dengan bundle baru. State useState dibawa (komponen xp). */
export async function swapInstance(el, instance, next, props) {
  const mod = await loadBundle(next.src, next.sha256, next.runtime);
  const restore = instance?.snapshot?.() ?? null;
  instance?.unmount();
  el.textContent = "";
  return mod.render(el, props, { restore });
}
