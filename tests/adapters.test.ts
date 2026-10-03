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
