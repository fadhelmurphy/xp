// CLI: deteksi jenis komponen, rencana target, build parsial, dan error yang jelas.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
// @ts-expect-error modul .mjs tanpa tipe
import { discover, plan } from "../cli/build.mjs";

const run = (...args: string[]) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, ["cli/xp.mjs", ...args], { encoding: "utf8", stdio: "pipe" }) };
  } catch (e: any) {
    return { code: e.status as number, out: `${e.stdout}${e.stderr}` };
  }
};

test("deteksi jenis komponen", async () => {
  const kinds = Object.fromEntries((await discover(path.resolve("examples"))).map((c: any) => [c.name, c.kind]));
  assert.deepEqual(kinds, { "faq-list": "svelte", "like-button": "react", "promo-modal": "xp", "promo-slider": "xp", "rating-stars": "vue" });
});

test("rencana target", async () => {
  const all = await discover(path.resolve("examples"));
  const outputs = (t: string) => Object.fromEntries(plan(all, t).jobs.map((j: any) => [j.name, j.outputs.join("+")]));
  assert.deepEqual(outputs("auto"), {
    "faq-list": "web+ssr", "like-button": "web+ssr", "promo-modal": "web+native", "promo-slider": "web+native", "rating-stars": "web+ssr",
  });
  assert.equal(outputs("web")["promo-modal"], "web");
  const cp = plan(all, "crossplatform");
  assert.deepEqual(cp.jobs.map((j: any) => j.name), ["promo-modal", "promo-slider"]);
  assert.equal(cp.skipped.length, 3);
  assert.throws(() => plan(all.filter((c: any) => c.kind === "vue"), "crossplatform", { explicit: true }), /hanya bisa target web/);
});

test("build parsial mempertahankan komponen lain dan membersihkan file lama", () => {
  const out = mkdtempSync(path.join(tmpdir(), "xp-cli-"));
  assert.equal(run("build", "examples", "--out", out, "-t", "crossplatform", "-y").code, 0);
  const r = run("build", "examples", "--out", out, "--only", "like-button,promo-modal", "-y");
  assert.equal(r.code, 0, r.out);
  const m = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(m.components), ["like-button", "promo-modal", "promo-slider"]);
  const referenced = new Set(Object.values<any>(m.components).flatMap((c) => [c.types, c.web?.file, c.ssr?.file, c.native?.file]).filter(Boolean));
  const files = readdirSync(out).filter((f) => f !== "manifest.json");
  assert.deepEqual(files.sort(), [...referenced].sort(), "tidak ada file yatim");
});

test("error yang jelas", () => {
  const unknown = run("build", "examples", "--only", "nggak-ada", "-y");
  assert.equal(unknown.code, 1);
  assert.match(unknown.out, /Komponen tidak ditemukan: nggak-ada\. Tersedia: faq-list/);
  const native = run("build", "examples", "--only", "faq-list", "-t", "crossplatform", "-y");
  assert.equal(native.code, 1);
  assert.match(native.out, /svelte hanya bisa target web/);
  assert.match(run("build", "examples", "-t", "mobile", "-y").out, /Target tidak dikenal: mobile/);
  assert.match(run("help").out, /--target <target>/);
});
