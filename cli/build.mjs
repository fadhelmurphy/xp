// Logika build: cari komponen, tentukan target per komponen, build, tulis manifest.
//
// Jenis komponen (dideteksi otomatis):
//   xp      → .tsx/.jsx yang memakai @xp/runtime  → bisa web + native (iOS/Android)
//   react   → .tsx/.jsx yang import "react"       → web saja
//   vue     → .vue                                → web saja
//   svelte  → .svelte                             → web saja
//
// Target:
//   auto           → xp: web + native, framework: web
//   web            → semua komponen: web saja
//   crossplatform  → hanya komponen xp: web + native
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPropsReader } from "./props.mjs";
import { SIGNATURE_FILE, signManifest } from "./sign.mjs";
import { classNamePlugin, webClassTable } from "./classname.mjs";
import { xpClassTable } from "./tailwind-xp.mjs";
import { buildWeb, detectKind } from "./web.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.resolve(here, "..", "runtime");
export const PROTOCOL_VERSION = 1;
export const TARGETS = ["auto", "web", "crossplatform"];
const PRIMITIVES = ["View", "Text", "Image", "Pressable", "ScrollView", "TextInput", "Modal"];
// API yang tidak ada di QuickJS/JavaScriptCore di device. Pemakaian di bundle native = peringatan.
const NOT_ON_DEVICE = ["document", "window", "localStorage", "Intl", "fetch", "XMLHttpRequest"];
const COMPONENT_FILE = /\.(tsx|jsx|vue|svelte)$/;
const GENERIC_PROPS = "export interface Props {\n  [key: string]: unknown;\n}\n";

const xpCommon = {
  bundle: true,
  write: false,
  minify: true,
  metafile: true,
  target: "es2020",
  jsx: "automatic",
  jsxImportSource: "@xp/runtime",
  alias: { "@xp/runtime": RUNTIME },
  resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".json"],
  logLevel: "silent",
};

// Runtime xp untuk browser, dipakai bersama oleh semua komponen xp di satu remote.
// Bundle web komponen me-require modul-modul ini; loader menyediakannya dari file runtime.
export const RUNTIME_MODULES = ["@xp/runtime", "@xp/runtime/jsx-runtime", "@xp/runtime/hosts/dom"];

// Kompatibilitas runtime: komponen butuh runtime dengan `api` yang sama dan `version` minimal
// versi xp yang mem-build-nya. Runtime yang lebih baru dalam satu `api` bisa menjalankan komponen
// yang lebih lama, jadi satu halaman cukup memuat satu runtime walau remote-nya beda versi xp.
const RUNTIME_API = JSON.parse(readFileSync(path.join(RUNTIME, "api.json"), "utf8")).api;
const XP_VERSION = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")).version;

const runtimeBuild = () => ({
  ...xpCommon,
  format: "cjs",
  platform: "neutral",
  stdin: {
    contents:
      RUNTIME_MODULES.map((m, i) => `import * as m${i} from "${m}";`).join("\n") +
      `\nexport const protocol = ${PROTOCOL_VERSION};` +
      `\nexport const api = ${RUNTIME_API};` +
      `\nexport const version = ${JSON.stringify(XP_VERSION)};` +
      `\nexport const modules = { ${RUNTIME_MODULES.map((m, i) => `"${m}": m${i}`).join(", ")} };`,
    resolveDir: RUNTIME,
    loader: "js",
  },
});

const externalRuntime = {
  name: "xp-external-runtime",
  setup(b) {
    b.onResolve({ filter: /^@xp\/runtime(\/.*)?$/ }, (args) => {
      if (RUNTIME_MODULES.includes(args.path)) return { path: args.path, external: true };
      return { errors: [{ text: `${args.path} tidak bisa dipakai di bundle web` }] };
    });
  },
};

// CSS yang di-import komponen xp (tema Tailwind) sudah dipakai untuk tabel className saat build;
// isinya tidak ikut bundle.
const xpCssImports = {
  name: "xp-css-imports",
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
  },
};

const withClasses = (opts, table, native) => ({
  ...opts,
  plugins: [...(table ? [classNamePlugin(table, { runtimeDir: RUNTIME, native })] : []), xpCssImports, ...(opts.plugins ?? [])],
});

// CSS varian className: di HTML SSR sebagai <style> pertama; di browser dipindah ke <head>
// sebelum hydrate (cara yang sama dengan komponen React/Vue/Svelte).
function styleHelpers(entry, css) {
  if (!css) return "const styleTag = () => \"\"; const hoistStyle = () => {};";
  const id = JSON.stringify(`xp-${sha(entry).slice(0, 8)}`);
  return `
    const CSS = ${JSON.stringify(css)};
    const ATTR = "data-xp-style";
    const styleTag = () => "<style " + ATTR + '="' + ${id} + '">' + CSS + "</style>";
    function hoistStyle(el) {
      const inline = el.querySelector("style[" + ATTR + '="' + ${id} + '"]');
      if (inline) inline.remove();
      if (typeof document === "undefined" || document.querySelector("head style[" + ATTR + '="' + ${id} + '"]')) return;
      const s = document.createElement("style");
      s.setAttribute(ATTR, ${id});
      s.textContent = CSS;
      document.head.appendChild(s);
    }`;
}

const xpBuilds = {
  // CJS untuk browser: hanya kode komponen. Runtime xp di-require dari file runtime bersama.
  web: (entry, css = "") => ({
    ...xpCommon,
    alias: {},
    plugins: [externalRuntime],
    format: "cjs",
    platform: "neutral",
    stdin: {
      contents: `
        import C from ${JSON.stringify(entry)};
        import { mount } from "@xp/runtime/hosts/dom";
        export const protocol = ${PROTOCOL_VERSION};
        export const framework = "xp";
        ${styleHelpers(entry, css)}
        export const render = (el, props, opts) => (hoistStyle(el), mount(el, C, props, opts));`,
      resolveDir: RUNTIME,
      loader: "tsx",
    },
  }),
  // CJS mandiri untuk server: renderHTML (SSR), tanpa kode DOM.
  ssr: (entry, css = "") => ({
    ...xpCommon,
    format: "cjs",
    platform: "neutral",
    stdin: {
      contents: `
        import C from ${JSON.stringify(entry)};
        import { renderToString } from "@xp/runtime/hosts/html";
        export const protocol = ${PROTOCOL_VERSION};
        export const framework = "xp";
        ${styleHelpers(entry, css)}
        export const renderHTML = (props) => styleTag() + renderToString(C, props);`,
      resolveDir: RUNTIME,
      loader: "tsx",
    },
  }),
  // IIFE: dieksekusi QuickJS/JavaScriptCore; memasang globalThis.XP untuk SDK native.
  native: (entry) => ({
    ...xpCommon,
    format: "iife",
    platform: "neutral",
    stdin: {
      contents: `
        import "@xp/runtime/hosts/timers";
        import C from ${JSON.stringify(entry)};
        import { installNative } from "@xp/runtime/hosts/native";
        installNative(C);`,
      resolveDir: RUNTIME,
      loader: "tsx",
    },
  }),
};

/** Semua komponen di folder sumber: [{ name, file, kind }]. */
export async function discover(srcDir) {
  const info = await stat(srcDir).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Folder komponen tidak ditemukan: ${srcDir}`);
  const files = (await readdir(srcDir)).filter((f) => COMPONENT_FILE.test(f)).sort();
  const out = [];
  const seen = new Map();
  for (const f of files) {
    const name = f.replace(COMPONENT_FILE, "");
    if (seen.has(name)) throw new Error(`Nama komponen ganda: ${seen.get(name)} dan ${f}`);
    seen.set(name, f);
    const file = path.join(srcDir, f);
    out.push({ name, file, kind: await detectKind(file) });
  }
  return out;
}

/**
 * Rencana build: komponen mana dibuat untuk output apa.
 * `explicit` = pengguna memilih komponen secara spesifik (lewat --only atau prompt).
 */
export function plan(components, target, { explicit = false } = {}) {
  if (!TARGETS.includes(target)) throw new Error(`Target tidak dikenal: ${target} (pilih: ${TARGETS.join(", ")})`);
  const jobs = [];
  const skipped = [];
  for (const c of components) {
    if (c.kind === "xp") {
      jobs.push({ ...c, outputs: target === "web" ? ["web", "ssr"] : ["web", "ssr", "native"] });
    } else if (target === "crossplatform") {
      const reason = `komponen ${c.kind} hanya bisa target web (iOS/Android butuh komponen @xp/runtime)`;
      if (explicit) throw new Error(`${c.name}: ${reason}`);
      skipped.push({ ...c, reason });
    } else {
      jobs.push({ ...c, outputs: ["web", "ssr"] });
    }
  }
  return { jobs, skipped };
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

async function primitivesUsed(metafile) {
  const used = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const abs = path.resolve(input);
    if (abs.startsWith(RUNTIME) || input.startsWith("<stdin>")) continue;
    const src = await readFile(abs, "utf8").catch(() => "");
    for (const p of PRIMITIVES) if (new RegExp(`<${p}[\\s/>]`).test(src)) used.add(p);
  }
  return [...used].sort();
}

function formatError(e) {
  return e.errors?.length
    ? e.errors.map((x) => `${x.location ? `${path.relative(process.cwd(), x.location.file)}:${x.location.line} ` : ""}${x.text}`).join("\n    ")
    : e.message;
}

/**
 * Jalankan build.
 * Build parsial (sebagian komponen) mempertahankan komponen lain di manifest, kecuali `clean`.
 */
export async function runBuild({ srcDir, outDir, jobs, clean = false, projectDir = process.cwd(), signingKey = null, dev = false }) {
  const manifestPath = path.join(outDir, "manifest.json");
  let manifest = { protocol: PROTOCOL_VERSION, builtAt: "", components: {} };
  if (clean) await rm(outDir, { recursive: true, force: true });
  else {
    const prev = await readFile(manifestPath, "utf8").then(JSON.parse).catch(() => null);
    if (prev?.protocol === PROTOCOL_VERSION) manifest = prev;
  }
  await mkdir(outDir, { recursive: true });

  const xpFiles = jobs.filter((j) => j.kind === "xp").map((j) => j.file);
  const reactFiles = jobs.filter((j) => j.kind === "react").map((j) => j.file);
  const xpReader = xpFiles.length ? createPropsReader(xpFiles, RUNTIME) : null;
  const reactReader = reactFiles.length ? createPropsReader(reactFiles, RUNTIME, { jsxImportSource: "react" }) : null;

  // Runtime bersama dibuat sekali per build kalau ada komponen xp untuk web.
  let runtime = null;
  if (jobs.some((j) => j.kind === "xp" && j.outputs.includes("web"))) {
    const code = (await build(runtimeBuild())).outputFiles[0].text;
    const hash = sha(code);
    runtime = { file: `xp-runtime.${hash.slice(0, 10)}.js`, sha256: hash, bytes: code.length, api: RUNTIME_API, version: XP_VERSION, code };
  }

  const results = [];
  for (const job of jobs) {
    const { name, file, kind, outputs } = job;
    const record = { kind, target: outputs.includes("native") ? "crossplatform" : "web" };
    const written = [];
    try {
      // Tipe props untuk adapter (autocomplete di app konsumen).
      let props = GENERIC_PROPS;
      if (kind === "xp") {
        const errors = xpReader.diagnostics(file);
        if (errors.length) throw new Error(errors.join("\n    "));
        props = `export interface Props ${xpReader.propsOf(file)}\n`;
      } else if (kind === "react") {
        try {
          props = `export interface Props ${reactReader.propsOf(file)}\n`;
        } catch {
          // Props tidak terbaca (mis. tanpa TypeScript): tetap build, tipe generik.
        }
      }
      record.types = `${name}.${sha(props).slice(0, 10)}.d.ts`;
      written.push([record.types, props]);

      const warnings = [];
      // className (Tailwind) → style, dihitung sekali untuk semua output komponen ini.
      const classes = kind === "xp" ? await xpClassTable(file, { projectDir, runtimeDir: RUNTIME }) : null;
      const web = kind === "xp" ? await webClassTable(classes, file, RUNTIME) : null;
      for (const out of outputs) {
        const result =
          kind === "xp"
            ? await build(out === "native" ? withClasses(xpBuilds.native(file), classes, true) : withClasses(xpBuilds[out](file, web.css), web.table, false))
            : await buildWeb({ kind, file, name, projectDir, side: out === "ssr" ? "ssr" : "client" });
        const code = result.outputFiles[0].text;
        const hash = sha(code);
        const fileName = `${name}.${out}.${hash.slice(0, 10)}.js`;
        written.push([fileName, code]);
        record[out] = { file: fileName, bytes: code.length, sha256: hash };
        if (kind === "xp" && out === "web") {
          const { file, sha256, bytes, api, version } = runtime;
          record.web.runtime = { file, sha256, bytes, api, version };
        }
        for (const w of result.warnings ?? []) warnings.push(w.text);
        if (out === "native") {
          record.primitives = await primitivesUsed(result.metafile);
          const bad = NOT_ON_DEVICE.filter((g) => new RegExp(`(^|[^.\\w$])${g}\\b`).test(code));
          if (bad.length) warnings.push(`memakai ${bad.join(", ")} yang tidak ada di device`);
        }
      }

      // Hapus file versi lama komponen ini, lalu tulis yang baru.
      const old = manifest.components[name];
      if (old) {
        const oldFiles = [old.types, old.web?.file, old.ssr?.file, old.native?.file].filter(Boolean);
        const keep = new Set(written.map(([f]) => f));
        await Promise.all(oldFiles.filter((f) => !keep.has(f)).map((f) => rm(path.join(outDir, f), { force: true })));
      }
      for (const [f, content] of written) await writeFile(path.join(outDir, f), content);
      manifest.components[name] = record;
      results.push({ name, kind, ok: true, record, warnings });
    } catch (e) {
      results.push({ name, kind, ok: false, error: formatError(e) });
    }
  }

  // File runtime: tulis yang dipakai, hapus yang tidak dipakai komponen mana pun lagi.
  // Komponen dari build lama tetap memakai runtime versinya sendiri sampai di-build ulang.
  const usedRuntimes = new Set(Object.values(manifest.components).map((c) => c.web?.runtime?.file).filter(Boolean));
  if (runtime && usedRuntimes.has(runtime.file)) await writeFile(path.join(outDir, runtime.file), runtime.code);
  for (const f of await readdir(outDir)) {
    if (/^xp-runtime\.[0-9a-f]+\.js$/.test(f) && !usedRuntimes.has(f)) await rm(path.join(outDir, f), { force: true });
  }

  manifest.builtAt = new Date().toISOString();
  // Ditandai oleh xp dev: adapter web di mode dev hanya berlangganan /__xp/events kalau ada tanda ini.
  if (dev) manifest.dev = true;
  else delete manifest.dev;
  manifest.components = Object.fromEntries(Object.entries(manifest.components).sort(([a], [b]) => a.localeCompare(b)));
  const text = JSON.stringify(manifest, null, 2);
  await writeFile(manifestPath, text);
  // Tanda tangan lama tidak boleh tertinggal: manifest baru tanpa --sign = tanpa manifest.sig.
  if (signingKey) await writeFile(path.join(outDir, SIGNATURE_FILE), `${signManifest(text, signingKey)}\n`);
  else await rm(path.join(outDir, SIGNATURE_FILE), { force: true });
  return { results, manifest, signed: Boolean(signingKey) };
}
