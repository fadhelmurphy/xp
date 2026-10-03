// Kode browser adapter: bundle web dicek sha256-nya sebelum dijalankan.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
// @ts-expect-error modul .js tanpa tipe
import { loadBundle, sha256, sha256Js } from "../adapters/next/client.js";
// @ts-expect-error modul .js tanpa tipe
import * as viteClient from "../adapters/vite/client.js";

const hex = (s: string) => createHash("sha256").update(s).digest("hex");

test("sha256 JS (dipakai di http non-localhost) sama dengan node:crypto", async () => {
  for (const s of ["", "abc", "a".repeat(55), "a".repeat(64), "ünïcode ✓ 漢字"]) {
    assert.equal(sha256Js(s), hex(s));
    assert.equal(await sha256(s), hex(s));
  }
});

test("bundle web dengan hash yang tidak cocok ditolak, yang cocok dijalankan", async () => {
  const code = "module.exports.ok = 42;";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(code)) as typeof fetch;
  try {
    await assert.rejects(loadBundle("https://cdn/a.web.js", hex("kode lain")), /hash tidak cocok/);
    assert.equal((await loadBundle("https://cdn/b.web.js", hex(code))).ok, 42);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("adapter Next dan Vite memakai kode browser yang sama", async () => {
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync("adapters/next/client.js", "utf8"), readFileSync("adapters/vite/client.js", "utf8"));
  assert.equal(readFileSync("adapters/next/verify.js", "utf8"), readFileSync("adapters/vite/verify.js", "utf8"));
  assert.equal(typeof viteClient.loadBundle, "function");
});

test("runtime xp dari dua remote dengan isi sama hanya diunduh dan dijalankan sekali", async () => {
  const runtimeCode = "globalThis.__xpRuntimeRuns = (globalThis.__xpRuntimeRuns ?? 0) + 1; module.exports.modules = { '@xp/runtime': { v: 1 } };";
  const component = "module.exports.runtime = require('@xp/runtime');";
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    fetched.push(url);
    return new Response(url.includes("xp-runtime") ? runtimeCode : component);
  }) as typeof fetch;
  try {
    const rt = (base: string) => ({ src: `${base}/xp-runtime.abc.js`, sha256: hex(runtimeCode) });
    const a = await loadBundle("https://tim-a.cdn/promo.web.1.js", hex(component), rt("https://tim-a.cdn"));
    const b = await loadBundle("https://tim-b.cdn/banner.web.2.js", hex(component), rt("https://tim-b.cdn"));
    assert.equal(a.runtime, b.runtime, "modul runtime yang sama dipakai kedua komponen");
    assert.equal(fetched.filter((u) => u.includes("xp-runtime")).length, 1, "runtime hanya diunduh sekali");
    assert.equal((globalThis as any).__xpRuntimeRuns, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("build xp yang sama di proyek berbeda menghasilkan runtime yang identik", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  // @ts-expect-error modul .mjs tanpa tipe
  const { discover, plan, runBuild } = await import("../cli/build.mjs");
  const all = await discover("examples");
  const runtimeOf = async (name: string) => {
    const out = mkdtempSync(path.join(tmpdir(), "xp-rt-"));
    const { jobs } = plan(all.filter((c: any) => c.name === name), "web");
    const { manifest } = await runBuild({ srcDir: "examples", outDir: out, jobs });
    const rt = manifest.components[name].web.runtime;
    return { ...rt, code: readFileSync(path.join(out, rt.file), "utf8") };
  };
  const a = await runtimeOf("promo-modal");
  const b = await runtimeOf("promo-slider");
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.code, b.code);
});

test("runtime versi xp berbeda: runtime yang lebih baru dipakai juga oleh komponen lama", async () => {
  // @ts-expect-error modul .js tanpa tipe
  const { loadBundle: load, compareVersions } = await import("../adapters/vite/client.js");
  assert.ok(compareVersions("0.10.0", "0.9.3") > 0);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);

  const runtimeCode = (v: string) => `module.exports = { api: 1, version: "${v}", modules: { "@xp/runtime": { v: "${v}" } } };`;
  const component = (n: number) => `module.exports.n = ${n}; module.exports.runtime = require("@xp/runtime");`;
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    fetched.push(url);
    const v = url.match(/runtime-(\d+\.\d+\.\d+)/)?.[1];
    return new Response(v ? runtimeCode(v) : component(Number(url.match(/c(\d+)/)![1])));
  }) as typeof fetch;
  const rt = (team: string, version: string) => ({ src: `https://${team}.cdn/runtime-${version}.js`, sha256: hex(runtimeCode(version)), api: 1, version });
  const comp = (team: string, n: number, version: string) => load(`https://${team}.cdn/c${n}.js`, hex(component(n)), rt(team, version));
  try {
    // Tim A (xp 0.3.0) dimuat duluan, lalu tim B (xp 0.2.0): runtime 0.3.0 dipakai keduanya.
    const a = await comp("tim-a", 1, "0.3.0");
    const b = await comp("tim-b", 2, "0.2.0");
    assert.equal(a.runtime.v, "0.3.0");
    assert.equal(b.runtime, a.runtime, "komponen lama memakai runtime yang lebih baru");
    assert.ok(!fetched.some((u) => u.includes("runtime-0.2.0")), "runtime 0.2.0 tidak diunduh");

    // Komponen yang butuh versi lebih baru dari yang sudah ada → runtime barunya dimuat,
    // dan komponen berikutnya memakai yang terbaru.
    const c = await comp("tim-c", 3, "0.4.0");
    const d = await comp("tim-d", 4, "0.2.5");
    assert.equal(c.runtime.v, "0.4.0");
    assert.equal(d.runtime.v, "0.4.0");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("runtime xp memenuhi kontrak api.json (export hanya boleh bertambah)", async () => {
  const { readFileSync } = await import("node:fs");
  const contract = JSON.parse(readFileSync("runtime/api.json", "utf8"));
  const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
  const rt = manifest.components["promo-modal"].web.runtime;
  assert.equal(rt.api, contract.api);
  assert.match(rt.version, /^\d+\.\d+\.\d+/);
  const mod = { exports: {} as any };
  new Function("module", "exports", "require", readFileSync(`dist/${rt.file}`, "utf8"))(mod, mod.exports, () => {});
  assert.equal(mod.exports.api, contract.api);
  for (const [id, names] of Object.entries<string[]>(contract.exports)) {
    for (const n of names) assert.ok(n in mod.exports.modules[id], `${id} harus mengekspor ${n}`);
  }
});

test("runtime lama dimuat duluan: permintaan bersamaan memilih yang terbaru, yang datang belakangan memindahkan komponen", async () => {
  // @ts-expect-error modul .js tanpa tipe
  const client = await import("../adapters/vite/client.js?urutan");
  const runtimeCode = (v: string) => `module.exports = { api: 7, version: "${v}", modules: { "@xp/runtime": { v: "${v}" } } };`;
  // Komponen palsu: render mencatat runtime yang dipakai dan snapshot yang dibawa.
  const component = `module.exports.render = (el, props, opts) => {
    const rt = require("@xp/runtime");
    el.runtime = rt.v; el.restored = opts && opts.restore; el.renders = (el.renders || 0) + 1;
    return { update() {}, unmount() { el.runtime = null; }, snapshot() { return { count: 7 }; } };
  };`;
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    fetched.push(url);
    const v = url.match(/runtime-(\d+\.\d+\.\d+)/)?.[1];
    return new Response(v ? runtimeCode(v) : component);
  }) as typeof fetch;
  const bundle = (team: string, version: string) => ({
    src: `https://${team}.cdn/${team}.web.js`,
    sha256: hex(component),
    runtime: { src: `https://${team}.cdn/runtime-${version}.js`, sha256: hex(runtimeCode(version)), api: 7, version },
  });
  const el = () => ({ textContent: "" }) as any;
  try {
    // 1. Dimuat bersamaan (seperti island yang hydrate di tick yang sama): hanya 0.5.0 yang diunduh.
    const [a, b] = [el(), el()];
    await Promise.all([client.mountComponent(a, bundle("lama", "0.4.0"), {}), client.mountComponent(b, bundle("baru", "0.5.0"), {})]);
    assert.equal(a.runtime, "0.5.0");
    assert.equal(b.runtime, "0.5.0");
    assert.ok(!fetched.some((u) => u.includes("runtime-0.4.0")), "runtime 0.4.0 tidak diunduh");

    // 2. Komponen yang butuh runtime lebih baru datang belakangan: semua dipindah ke runtime itu.
    const c = el();
    await client.mountComponent(c, bundle("terbaru", "0.6.0"), {});
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual([a.runtime, b.runtime, c.runtime], ["0.6.0", "0.6.0", "0.6.0"]);
    assert.deepEqual(a.restored, { count: 7 }, "state dibawa saat pindah runtime");
    const info = client.runtimeInfo();
    assert.deepEqual(info.active.filter((r: any) => r.api === 7).map((r: any) => r.version), ["0.6.0"], "hanya satu runtime yang aktif");
  } finally {
    globalThis.fetch = realFetch;
  }
});
