#!/usr/bin/env node
// xp build <folder-entry> [--out dist]
// Setiap file .tsx di folder entry = satu komponen yang dipublikasikan.
// Output per komponen:
//   <nama>.web.<hash>.js     → browser & SSR (mount + renderToString), runtime ikut di dalamnya
//   <nama>.native.<hash>.js  → QuickJS di SDK iOS/Android, runtime ikut di dalamnya
//   manifest.json            → peta nama → file terbaru + primitive yang dipakai
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPropsReader } from "./props.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.resolve(here, "..", "runtime");
const PROTOCOL_VERSION = 1;
const PRIMITIVES = ["View", "Text", "Image", "Pressable", "ScrollView", "TextInput", "Modal"];
// API yang tidak ada di QuickJS di device. Pemakaian di bundle native = peringatan.
const NOT_ON_DEVICE = ["document", "window", "localStorage", "Intl", "fetch", "XMLHttpRequest"];

const args = process.argv.slice(2);
const cmd = args.shift();
if (cmd === "serve") {
  const { serve } = await import("./serve.mjs");
  const portIdx = args.indexOf("--port");
  serve(path.resolve(args[0] ?? "dist"), portIdx >= 0 ? Number(args[portIdx + 1]) : 4400);
} else if (cmd !== "build") {
  console.error("Pemakaian:\n  xp build <folder-entry> [--out dist]\n  xp serve [dist] [--port 4400]");
  process.exit(1);
}
const srcDir = path.resolve(args[0] ?? "src");
const outIdx = args.indexOf("--out");
const outDir = path.resolve(outIdx >= 0 ? args[outIdx + 1] : "dist");

const common = {
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

const TARGETS = {
  // CJS mandiri: dievaluasi oleh loader (browser atau server Next.js) tanpa React.
  web: (entry) => ({
    ...common,
    format: "cjs",
    platform: "neutral",
    stdin: {
      contents: `
        import C from ${JSON.stringify(entry)};
        import { mount } from "@xp/runtime/hosts/dom";
        import { renderToString } from "@xp/runtime/hosts/html";
        export const protocol = ${PROTOCOL_VERSION};
        export const render = (el, props) => mount(el, C, props);
        export const renderHTML = (props) => renderToString(C, props);`,
      resolveDir: RUNTIME,
      loader: "tsx",
    },
  }),
  // IIFE: dieksekusi QuickJS; memasang globalThis.XP untuk SDK native.
  native: (entry) => ({
    ...common,
    format: "iife",
    platform: "neutral",
    stdin: {
      contents: `
        import C from ${JSON.stringify(entry)};
        import { installNative } from "@xp/runtime/hosts/native";
        installNative(C);`,
      resolveDir: RUNTIME,
      loader: "tsx",
    },
  }),
};

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

function deviceWarnings(code) {
  return NOT_ON_DEVICE.filter((g) => new RegExp(`(^|[^.\\w$])${g}\\b`).test(code));
}

async function main() {
  const entries = (await readdir(srcDir)).filter((f) => /\.(t|j)sx$/.test(f)).sort();
  if (!entries.length) throw new Error(`Tidak ada komponen .tsx/.jsx di ${srcDir}`);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const reader = createPropsReader(entries.map((f) => path.join(srcDir, f)), RUNTIME);
  const manifest = { protocol: PROTOCOL_VERSION, builtAt: new Date().toISOString(), components: {} };
  let failed = false;

  for (const file of entries) {
    const name = file.replace(/\.(t|j)sx$/, "");
    const entry = path.join(srcDir, file);
    const record = {};
    try {
      const errors = reader.diagnostics(entry);
      if (errors.length) throw new Error(errors.join("\n    "));

      // Tipe props untuk adapter (autocomplete di app konsumen, codegen Swift/Kotlin).
      const dts = `export interface Props ${reader.propsOf(entry)}\n`;
      const dtsHash = createHash("sha256").update(dts).digest("hex").slice(0, 10);
      record.types = `${name}.${dtsHash}.d.ts`;
      await writeFile(path.join(outDir, record.types), dts);

      for (const [target, opts] of Object.entries(TARGETS)) {
        const result = await build(opts(entry));
        const code = result.outputFiles[0].text;
        const hash = createHash("sha256").update(code).digest("hex").slice(0, 10);
        const out = `${name}.${target}.${hash}.js`;
        await writeFile(path.join(outDir, out), code);
        record[target] = { file: out, bytes: code.length, sha256: createHash("sha256").update(code).digest("hex") };
        if (target === "native") {
          record.primitives = await primitivesUsed(result.metafile);
          const warn = deviceWarnings(code);
          if (warn.length) console.warn(`  ⚠ ${name}: memakai ${warn.join(", ")} yang tidak ada di device`);
        }
      }
      manifest.components[name] = record;
      const kb = (t) => (record[t].bytes / 1024).toFixed(1);
      console.log(`✓ ${name}  web ${kb("web")} kB · native ${kb("native")} kB · [${record.primitives.join(", ")}]`);
    } catch (e) {
      failed = true;
      const msg = e.errors?.map((x) => `${x.location?.file ?? ""}:${x.location?.line ?? ""} ${x.text}`).join("\n    ") ?? e.message;
      console.error(`✗ ${name}\n    ${msg}`);
    }
  }

  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (failed) process.exit(1);
}

if (cmd === "build") main().catch((e) => {
  console.error(e);
  process.exit(1);
});
