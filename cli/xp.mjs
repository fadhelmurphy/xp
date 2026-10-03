#!/usr/bin/env node
// CLI xp.
//   npx github:fadhelmurphy/xp build              → pilih komponen & target secara interaktif
//   npx github:fadhelmurphy/xp build src -t web   → tanpa pertanyaan
import path from "node:path";
import { discover, plan, runBuild, TARGETS } from "./build.mjs";

const HELP = `xp: tulis komponen sekali, muat lewat URL di web, iOS, dan Android

Pemakaian:
  xp build [folder] [opsi]      build komponen (default folder: src)
  xp list [folder]              daftar komponen beserta jenis dan target yang bisa dipakai
  xp serve [dist] [--port n]    sajikan hasil build (CORS + cache header)

Opsi build:
  -t, --target <target>   auto | web | crossplatform (default: auto)
                          auto           xp → web + iOS/Android, React/Vue/Svelte → web
                          web            semua komponen, web saja
                          crossplatform  komponen @xp/runtime saja, web + iOS/Android
  -o, --only <a,b,...>    hanya komponen tertentu (nama file tanpa ekstensi)
      --out <folder>      folder hasil (default: dist)
      --clean             kosongkan folder hasil dulu (default: hanya komponen yang di-build yang diganti)
  -y, --yes               jangan bertanya; pakai opsi yang diberikan

Tanpa --target dan --only di terminal interaktif, xp menanyakan komponen dan target.`;

const KIND = {
  xp: "@xp/runtime · web + iOS/Android",
  react: "React · web",
  vue: "Vue · web",
  svelte: "Svelte · web",
};

function parseArgs(argv) {
  const opts = { positional: [], target: null, only: null, out: "dist", clean: false, yes: false, port: 4400, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) throw new Error(`${a} butuh nilai`);
      return v;
    };
    if (a === "-t" || a === "--target") opts.target = value();
    else if (a.startsWith("--target=")) opts.target = a.slice(9);
    else if (a === "-o" || a === "--only") opts.only = value();
    else if (a.startsWith("--only=")) opts.only = a.slice(7);
    else if (a === "--out") opts.out = value();
    else if (a.startsWith("--out=")) opts.out = a.slice(6);
    else if (a === "--port") opts.port = Number(value());
    else if (a === "--clean") opts.clean = true;
    else if (a === "-y" || a === "--yes") opts.yes = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("-")) throw new Error(`Opsi tidak dikenal: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

function summary(r) {
  const rec = r.record;
  const parts = [`web ${kb(rec.web.bytes)}`];
  if (rec.ssr) parts.push(`ssr ${kb(rec.ssr.bytes)}`);
  if (rec.native) parts.push(`native ${kb(rec.native.bytes)}`);
  if (rec.primitives) parts.push(`[${rec.primitives.join(", ")}]`);
  return parts.join(" · ");
}

async function interactive(components, opts) {
  const p = await import("@clack/prompts");
  p.intro("xp build");
  const picked = await p.multiselect({
    message: "Komponen mana yang mau di-build? (spasi: pilih, enter: lanjut)",
    options: components.map((c) => ({ value: c.name, label: c.name, hint: KIND[c.kind] })),
    initialValues: components.map((c) => c.name),
    required: true,
  });
  if (p.isCancel(picked)) {
    p.cancel("Dibatalkan.");
    process.exit(0);
  }
  const target = await p.select({
    message: "Target build?",
    initialValue: "auto",
    options: [
      { value: "auto", label: "auto", hint: "@xp/runtime → web + iOS/Android, React/Vue/Svelte → web" },
      { value: "web", label: "web", hint: "semua komponen, untuk Next.js/Nuxt/..." },
      { value: "crossplatform", label: "crossplatform", hint: "web + iOS/Android, hanya komponen @xp/runtime" },
    ],
  });
  if (p.isCancel(target)) {
    p.cancel("Dibatalkan.");
    process.exit(0);
  }
  return { selected: components.filter((c) => picked.includes(c.name)), target, explicit: false, prompts: p };
}

async function cmdBuild(opts) {
  const srcDir = path.resolve(opts.positional[0] ?? "src");
  const outDir = path.resolve(opts.out);
  const components = await discover(srcDir);
  if (!components.length) throw new Error(`Tidak ada komponen (.tsx, .jsx, .vue, .svelte) di ${srcDir}`);

  const canAsk = !opts.yes && !opts.only && !opts.target && process.stdin.isTTY && process.stdout.isTTY && !process.env.CI;
  let selected = components;
  let target = opts.target ?? "auto";
  let explicit = false;
  let prompts = null;

  if (canAsk) {
    ({ selected, target, explicit, prompts } = await interactive(components, opts));
  } else if (opts.only) {
    const names = opts.only.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = names.filter((n) => !components.some((c) => c.name === n));
    if (unknown.length) {
      throw new Error(`Komponen tidak ditemukan: ${unknown.join(", ")}. Tersedia: ${components.map((c) => c.name).join(", ")}`);
    }
    selected = components.filter((c) => names.includes(c.name));
    explicit = true;
  }

  const { jobs, skipped } = plan(selected, target, { explicit });
  const rel = path.relative(process.cwd(), outDir) || ".";
  console.log(`\nxp build · target ${target} · ${jobs.length} komponen → ${rel}/\n`);
  for (const s of skipped) console.log(`- ${s.name.padEnd(16)} ${s.kind.padEnd(7)} dilewati: ${s.reason}`);

  const { results } = await runBuild({ srcDir, outDir, jobs, clean: opts.clean });
  for (const r of results) {
    if (r.ok) {
      console.log(`✓ ${r.name.padEnd(16)} ${r.kind.padEnd(7)} ${summary(r)}`);
      for (const w of r.warnings) console.log(`  ⚠ ${w}`);
    } else {
      console.log(`✗ ${r.name.padEnd(16)} ${r.kind.padEnd(7)}\n    ${r.error}`);
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  const done = `${results.length - failed}/${results.length} berhasil · manifest: ${rel}/manifest.json`;
  if (prompts) (failed ? prompts.outro(`Selesai dengan error. ${done}`) : prompts.outro(done));
  else console.log(`\n${done}`);
  if (failed) process.exitCode = 1;
}

async function cmdList(opts) {
  const srcDir = path.resolve(opts.positional[0] ?? "src");
  const components = await discover(srcDir);
  for (const c of components) console.log(`${c.name.padEnd(18)} ${KIND[c.kind]}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help" || opts.help) {
    console.log(HELP);
    return;
  }
  if (cmd === "build") return cmdBuild(opts);
  if (cmd === "list") return cmdList(opts);
  if (cmd === "serve") {
    const { serve } = await import("./serve.mjs");
    serve(path.resolve(opts.positional[0] ?? "dist"), opts.port);
    return;
  }
  throw new Error(`Perintah tidak dikenal: ${cmd}\n\n${HELP}`);
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});

export { TARGETS };
