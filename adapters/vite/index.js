// Plugin Vite inti untuk xp. Framework (Nuxt, SvelteKit, ...) cukup menyediakan:
//   framework.code({ base, name, revalidate, publicKey, dev }) → kode modul pembungkus komponen
//   framework.dts({ spec, props })             → deklarasi TypeScript untuk "xp:<remote>/<nama>"
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PROTOCOL = 1;

async function fetchText(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    // "fetch failed" saja tidak membantu; tampilkan penyebabnya (mis. ECONNREFUSED).
    const cause = e.cause?.code ?? e.cause?.message ?? e.message;
    const hint = /localhost|127\.0\.0\.1/.test(url)
      ? " Pastikan remote jalan di mesin yang sama dengan app ini (Windows dan WSL punya localhost berbeda)."
      : "";
    throw new Error(`${url} tidak bisa diakses (${cause}).${hint}`);
  }
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

/**
 * Ambil manifest setiap remote (fallback ke cache di <dir>), tulis file tipe.
 * @returns {Promise<{ entries: Map<string, {base: string, name: string}>, dtsPath: string }>}
 */
export async function syncRemotes({ remotes, root = process.cwd(), dir = ".xp", framework, log = console }) {
  if (!remotes || !Object.keys(remotes).length) throw new Error("[xp] isi `remotes`, mis. { ui: 'https://cdn.kamu/xp' }");
  const outDir = path.resolve(root, dir);
  await mkdir(outDir, { recursive: true });
  const entries = new Map();
  const decls = [];

  for (const [ns, rawUrl] of Object.entries(remotes)) {
    if (!/^[a-z][\w-]*$/i.test(ns)) throw new Error(`[xp] nama remote tidak valid: ${ns}`);
    const base = rawUrl.replace(/\/$/, "");
    const cacheFile = path.join(outDir, `${ns}.manifest.json`);
    let manifest;
    try {
      manifest = JSON.parse(await fetchText(`${base}/manifest.json`));
      await writeFile(cacheFile, JSON.stringify(manifest, null, 2));
    } catch (e) {
      const cached = await readFile(cacheFile, "utf8").catch(() => null);
      if (!cached) throw new Error(`[xp] remote "${ns}" (${base}) tidak bisa diakses dan belum ada cache: ${e.message}`);
      log.warn(`[xp] remote "${ns}" tidak bisa diakses, memakai manifest cache (${e.message})`);
      manifest = JSON.parse(cached);
    }
    if (manifest.protocol !== PROTOCOL) {
      throw new Error(`[xp] remote "${ns}" memakai protokol ${manifest.protocol}, adapter ini ${PROTOCOL}`);
    }

    for (const [name, entry] of Object.entries(manifest.components)) {
      const spec = `xp:${ns}/${name}`;
      entries.set(spec, { base, name });
      let props = "export interface Props {}";
      if (entry.types) {
        try {
          props = (await fetchText(`${base}/${entry.types}`)).trim();
        } catch (e) {
          log.warn(`[xp] tipe ${spec} gagal diambil: ${e.message}`);
        }
      }
      decls.push(framework.dts({ spec, props }));
    }
  }

  const dtsPath = path.join(outDir, "xp-env.d.ts");
  await writeFile(dtsPath, `// Dibuat otomatis oleh xp dari manifest remote. Jangan diedit.\n\n${decls.join("\n\n")}\n`);
  return { entries, dtsPath };
}

/** Plugin Vite: "xp:<remote>/<nama>" → modul virtual dari framework.code(). */
export function xp({ remotes, revalidate = 30, dir = ".xp", root, framework, synced, publicKey = null }) {
  let entries = synced?.entries ?? null;
  const PREFIX = "\0xp:";

  let dev = false;
  return {
    name: "xp",
    enforce: "pre",
    configResolved(config) {
      dev = config.command === "serve";
    },
    async buildStart() {
      if (!entries) entries = (await syncRemotes({ remotes, root: root ?? process.cwd(), dir, framework })).entries;
    },
    resolveId(id) {
      if (!id.startsWith("xp:")) return null;
      if (entries && !entries.has(id)) {
        this.error(`[xp] "${id}" tidak ada di manifest remote. Tersedia: ${[...entries.keys()].join(", ") || "(kosong)"}`);
      }
      return PREFIX + id.slice(3);
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const spec = "xp:" + id.slice(PREFIX.length);
      const entry = entries?.get(spec);
      if (!entry) this.error(`[xp] "${spec}" tidak ada di manifest remote`);
      return framework.code({ base: entry.base, name: entry.name, revalidate, publicKey, dev });
    },
  };
}
