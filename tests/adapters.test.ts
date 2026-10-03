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
