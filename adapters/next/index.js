// withXP(): plugin next.config.
// Untuk setiap remote, ambil manifest.json lalu:
//   - buat modul pembungkus di .xp/<remote>/<nama>.js
//   - alias "xp:<remote>/<nama>" → modul itu (webpack & turbopack)
//   - tulis xp-env.d.ts supaya import bertipe (props dari .d.ts hasil xp build)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PROTOCOL = 1;

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

/**
 * @param {import("next").NextConfig | Function} nextConfig
 * @param {{ remotes: Record<string, string>, revalidate?: number, dir?: string }} options
 */
export function withXP(nextConfig = {}, { remotes, revalidate = 30, dir = ".xp" } = {}) {
  if (!remotes || !Object.keys(remotes).length) throw new Error("withXP: isi `remotes`, mis. { ui: 'https://ui.kamu/xp' }");

  return async (phase, ctx) => {
    const base = typeof nextConfig === "function" ? await nextConfig(phase, ctx) : nextConfig;
    const root = process.cwd();
    const outDir = path.join(root, dir);
    const alias = {};
    const decls = [];

    for (const [ns, rawUrl] of Object.entries(remotes)) {
      if (!/^[a-z][\w-]*$/i.test(ns)) throw new Error(`withXP: nama remote tidak valid: ${ns}`);
      const url = rawUrl.replace(/\/$/, "");
      const cacheFile = path.join(outDir, `${ns}.manifest.json`);
      await mkdir(path.join(outDir, ns), { recursive: true });

      // Remote mati saat build: pakai manifest terakhir supaya build tetap jalan.
      let manifest;
      try {
        manifest = JSON.parse(await fetchText(`${url}/manifest.json`));
        await writeFile(cacheFile, JSON.stringify(manifest, null, 2));
      } catch (e) {
        const cached = await readFile(cacheFile, "utf8").catch(() => null);
        if (!cached) throw new Error(`withXP: remote "${ns}" (${url}) tidak bisa diakses dan belum ada cache: ${e.message}`);
        console.warn(`[xp] remote "${ns}" tidak bisa diakses, memakai manifest cache (${e.message})`);
        manifest = JSON.parse(cached);
      }
      if (manifest.protocol !== PROTOCOL) {
        throw new Error(`withXP: remote "${ns}" memakai protokol ${manifest.protocol}, adapter ini ${PROTOCOL}`);
      }

      for (const [name, entry] of Object.entries(manifest.components)) {
        const spec = `xp:${ns}/${name}`;
        const file = path.join(outDir, ns, `${name}.js`);
        await writeFile(
          file,
          `// Dibuat otomatis oleh @xp/next. Jangan diedit.\n` +
            `import { remote } from "@xp/next/runtime";\n` +
            `export default remote(${JSON.stringify(url)}, ${JSON.stringify(name)}, { revalidate: ${revalidate} });\n`,
        );
        alias[spec] = file;

        let props = "export interface Props {}";
        if (entry.types) {
          try {
            props = (await fetchText(`${url}/${entry.types}`)).trim();
          } catch (e) {
            console.warn(`[xp] tipe ${spec} gagal diambil: ${e.message}`);
          }
        }
        decls.push(
          `declare module ${JSON.stringify(spec)} {\n` +
            props.replace(/^/gm, "  ") +
            `\n  const Component: (props: Props) => Promise<import("react").JSX.Element>;\n  export default Component;\n}`,
        );
      }
    }

    await writeFile(
      path.join(root, "xp-env.d.ts"),
      `// Dibuat otomatis oleh @xp/next dari manifest remote. Jangan diedit.\n\n${decls.join("\n\n")}\n`,
    );

    // turbopack butuh path relatif terhadap root project.
    const relAlias = Object.fromEntries(Object.entries(alias).map(([k, v]) => [k, "./" + path.relative(root, v)]));

    return {
      ...base,
      webpack(config, options) {
        // "xp:" dianggap skema URI oleh webpack (bukan nama modul), jadi alias biasa tidak cukup:
        // tulis ulang request-nya sebelum resolve.
        config.plugins.push(
          new options.webpack.NormalModuleReplacementPlugin(/^xp:/, (resource) => {
            const target = alias[resource.request];
            if (!target) {
              throw new Error(
                `[xp] "${resource.request}" tidak ada di manifest remote. Tersedia: ${Object.keys(alias).join(", ")}`,
              );
            }
            resource.request = target;
          }),
        );
        return typeof base.webpack === "function" ? base.webpack(config, options) : config;
      },
      turbopack: {
        ...base.turbopack,
        resolveAlias: { ...base.turbopack?.resolveAlias, ...relAlias },
      },
    };
  };
}
