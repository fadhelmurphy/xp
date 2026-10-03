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
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPropsReader } from "./props.mjs";
import { SIGNATURE_FILE, signManifest } from "./sign.mjs";
import { detectKind, webBuildOptions } from "./web.mjs";

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

const xpBuilds = {
  // CJS mandiri: render (browser) + renderHTML (SSR), runtime xp ikut di dalamnya.
  web: (entry) => ({
    ...xpCommon,
    format: "cjs",
    platform: "neutral",
    stdin: {
      contents: `
        import C from ${JSON.stringify(entry)};
        import { mount } from "@xp/runtime/hosts/dom";
        import { renderToString } from "@xp/runtime/hosts/html";
        export const protocol = ${PROTOCOL_VERSION};
        export const framework = "xp";
        export const render = (el, props, opts) => mount(el, C, props, opts);
        export const renderHTML = (props) => renderToString(C, props);`,
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
      jobs.push({ ...c, outputs: target === "web" ? ["web"] : ["web", "native"] });
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
export async function runBuild({ srcDir, outDir, jobs, clean = false, projectDir = process.cwd(), signingKey = null }) {
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
      for (const out of outputs) {
        const opts =
          kind === "xp"
            ? xpBuilds[out](file)
            : webBuildOptions({ kind, file, name, projectDir, side: out === "ssr" ? "ssr" : "client" });
        const result = await build(opts);
        const code = result.outputFiles[0].text;
        const hash = sha(code);
        const fileName = `${name}.${out}.${hash.slice(0, 10)}.js`;
        written.push([fileName, code]);
        record[out] = { file: fileName, bytes: code.length, sha256: hash };
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

  manifest.builtAt = new Date().toISOString();
  manifest.components = Object.fromEntries(Object.entries(manifest.components).sort(([a], [b]) => a.localeCompare(b)));
  const text = JSON.stringify(manifest, null, 2);
  await writeFile(manifestPath, text);
  // Tanda tangan lama tidak boleh tertinggal: manifest baru tanpa --sign = tanpa manifest.sig.
  if (signingKey) await writeFile(path.join(outDir, SIGNATURE_FILE), `${signManifest(text, signingKey)}\n`);
  else await rm(path.join(outDir, SIGNATURE_FILE), { force: true });
  return { results, manifest, signed: Boolean(signingKey) };
}
