// CSS di komponen web (React, Vue, Svelte):
//   import "./card.css"                  → CSS ikut bundle, dipasang saat SSR dan di browser
//   import s from "./card.module.css"    → CSS modules: nama class di-scope, `s.card` berisi nama barunya
//   url(./bg.png), @import, font         → di-inline (aset jadi data URL)
//   @import "tailwindcss"                → diproses Tailwind v4, hanya class yang dipakai komponen
//
// Hasil CSS dimasukkan ke registry `xp:css` yang sama dengan CSS Vue/Svelte: ikut HTML SSR sebagai
// <style>, lalu dipindah ke <head> saat hydrate.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export const ASSETS = Object.fromEntries(
  [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".eot"].map((e) => [e, "dataurl"]),
);

/** `@import "tailwindcss"` (atau `@tailwind`) di file CSS. */
export const TAILWIND = /@import\s+["']tailwindcss(?:\/[^"']*)?["']|@tailwind\s+\w+/;
/** CSS yang perlu diproses Tailwind: import-nya, atau direktif seperti @apply / @reference di <style> komponen. */
export const TAILWIND_USE = /@import\s+["']tailwindcss(?:\/[^"']*)?["']|@tailwind\s+\w+|@reference\s|@apply\s|@theme\b|@utility\s|@variant\s|@custom-variant\s/;

const SOURCE = /\.(m?[jt]sx?|vue|svelte|html|mdx?)$/;

/** Kandidat class Tailwind dari file sumber: setiap token, seperti cara Tailwind memindai proyek. */
export async function candidatesFrom(files) {
  const out = new Set();
  for (const f of files) {
    if (!SOURCE.test(f) || f.includes("node_modules")) continue;
    const text = await readFile(f, "utf8").catch(() => "");
    for (const t of text.match(/[^\s"'`<>{};,]+/g) ?? []) out.add(t);
  }
  return [...out];
}

/** @tailwindcss/node dari proyek pengguna (langsung, atau lewat @tailwindcss/postcss / @tailwindcss/vite). */
export function loadTailwind(projectDir) {
  const req = createRequire(path.join(projectDir, "noop.js"));
  for (const via of [null, "@tailwindcss/postcss", "@tailwindcss/vite"]) {
    try {
      if (!via) return req("@tailwindcss/node");
      const viaReq = createRequire(req.resolve(`${via}/package.json`));
      return viaReq("@tailwindcss/node");
    } catch {
      // coba sumber berikutnya
    }
  }
  throw new Error("Tailwind tidak ditemukan. Install di proyek komponen: npm i -D tailwindcss @tailwindcss/node");
}

/**
 * Jalankan Tailwind untuk satu file CSS. `@import "tailwindcss"` diganti theme + utilities saja:
 * preflight (reset global) tidak ikut, supaya tidak mengubah tampilan halaman app yang memakai
 * komponen. Kalau memang perlu, import sendiri: @import "tailwindcss/preflight.css".
 */
export async function tailwindCss(css, file, candidates, projectDir) {
  const tw = loadTailwind(projectDir);
  const source = css.replace(
    /@import\s+["']tailwindcss["'](\s+[^;]*)?;/g,
    '@import "tailwindcss/theme.css" layer(theme);\n@import "tailwindcss/utilities.css" layer(utilities);',
  );
  const compiler = await tw.compile(source, { base: path.dirname(file), onDependency() {} });
  return compiler.build(candidates);
}

const shortHash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 10);

/** Bundle satu file CSS (beserta @import dan aset) → { js, css }. js berisi peta class untuk CSS modules. */
async function bundleCss(file, contents, projectDir) {
  const isModule = /\.module\.css$/.test(file);
  const imp = JSON.stringify(file);
  const virtual = !file.endsWith(".css"); // <style> dari file .vue / .svelte
  const result = await build({
    stdin: { contents: isModule ? `import s from ${imp}; export default s;` : `import ${imp};`, resolveDir: path.dirname(file), loader: "js" },
    bundle: true,
    write: false,
    outdir: path.join(projectDir, ".xp-css"),
    format: "esm",
    minifyWhitespace: true,
    minifySyntax: true, // nama class CSS modules tidak dipendekkan; dibuat unik di bawah
    loader: ASSETS,
    nodePaths: [path.join(projectDir, "node_modules")],
    logLevel: "silent",
    plugins: [
      {
        name: "xp-css-source",
        setup(b) {
          if (virtual) b.onResolve({ filter: /.*/ }, (args) => (args.path === file ? { path: file, namespace: "xp-style" } : undefined));
          // Isi file utama sudah diproses (mis. oleh Tailwind); file lain dimuat esbuild seperti biasa.
          const own = (args) => (args.path === file ? { contents, loader: isModule ? "local-css" : "css", resolveDir: path.dirname(file) } : undefined);
          b.onLoad({ filter: /\.css$/ }, own);
          b.onLoad({ filter: /.*/, namespace: "xp-style" }, own);
        },
      },
    ],
  });
  const pick = (ext) => result.outputFiles.find((o) => o.path.endsWith(ext))?.text ?? "";
  let js = pick(".js");
  let css = pick(".css");
  if (isModule) {
    // Nama dari esbuild ("card_title") bisa sama dengan komponen lain di halaman yang sama,
    // apalagi dari remote lain. Tambahkan hash path file supaya unik.
    const suffix = shortHash(file).slice(0, 6);
    const names = [...new Set([...js.matchAll(/"([A-Za-z_][\w-]*)"/g)].map((m) => m[1]))].filter((n) =>
      new RegExp(`\\.${n}(?![\\w-])`).test(css),
    );
    for (const n of names) {
      css = css.replace(new RegExp(`\\.${n}(?![\\w-])`, "g"), `.${n}_${suffix}`);
      js = js.replace(new RegExp(`"${n}"`, "g"), `"${n}_${suffix}"`);
    }
  }
  return { js, css };
}

/**
 * Plugin esbuild untuk import CSS di komponen web.
 * `state.tailwind` jadi true kalau ada CSS yang memakai Tailwind; build perlu diulang dengan
 * `candidates` (class yang dipakai komponen) supaya CSS Tailwind-nya bisa dibuat.
 */
export function cssImportPlugin({ projectDir, state, candidates }) {
  return {
    name: "xp-css-import",
    setup(b) {
      b.onLoad({ filter: /\.css$/ }, async (args) => {
        if (args.namespace !== "file") return undefined;
        let css = await readFile(args.path, "utf8");
        if (TAILWIND.test(css)) {
          state.tailwind = true;
          css = candidates ? await tailwindCss(css, args.path, candidates, projectDir) : "";
        }
        const out = await bundleCss(args.path, css, projectDir);
        const id = JSON.stringify(`css-${shortHash(args.path)}`);
        return {
          contents: `import { addCss as __addCss } from "xp:css";\n__addCss(${id}, ${JSON.stringify(out.css)});\n${out.js}`,
          loader: "js",
          resolveDir: path.dirname(args.path),
        };
      });
    },
  };
}

/**
 * CSS dari <style> komponen Vue/Svelte: Tailwind (@apply, @reference, ...) diproses dulu, lalu
 * @import dan url() aset di-inline seperti file CSS biasa.
 */
export async function componentStyle(css, file, { projectDir, state, candidates }) {
  let out = css;
  if (TAILWIND_USE.test(out)) {
    state.tailwind = true;
    out = candidates ? await tailwindCss(out, file, candidates, projectDir) : "";
  }
  return out;
}

/** Inline @import dan aset url() di CSS yang sudah jadi (mis. hasil compile Vue/Svelte). */
export async function inlineCss(css, file, projectDir) {
  if (!/@import|url\(/.test(css)) return css;
  return (await bundleCss(file, css, projectDir)).css;
}
