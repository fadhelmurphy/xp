// promo-slider: navigasi ‹ ›, titik indikator, dan putaran (wrap-around),
// diuji di QuickJS (jalur native, mode antrean) dan di DOM (web).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getQuickJS } from "quickjs-emscripten";
import type { Batch } from "../runtime/protocol";
import { NativeTree } from "../sdk-reference/tree";

const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
const entry = manifest.components["promo-slider"];

test("native (QuickJS): pindah slide lewat tombol dan titik, berputar di ujung", async () => {
  const vm = (await getQuickJS()).newContext();
  const tree = new NativeTree();
  const evaluate = (script: string) => {
    const r = vm.evalCode(script);
    if (r.error) {
      const e = vm.dump(r.error);
      r.error.dispose();
      throw new Error(JSON.stringify(e));
    }
    const v = vm.dump(r.value);
    r.value.dispose();
    return v;
  };
  const call = (script: string) => (JSON.parse(evaluate(script)) as Batch[]).forEach((b) => tree.apply(b));
  const press = (id: string) => call(`XP.dispatch(${JSON.stringify(tree.handler(tree.byTestID(id)!, "onPress"))}, "[]")`);
  const title = () => tree.text(tree.byTestID("slide-title")!);
  const counter = () => tree.text(tree.byTestID("counter")!);
  const bg = () => (tree.byTestID("slide")!.props.style as Record<string, string>).backgroundColor;

  evaluate(readFileSync(`dist/${entry.native.file}`, "utf8"));
  call(`XP.mount("{}")`); // pakai slide bawaan
  assert.equal(title(), "IELTS Intensif");
  assert.equal(counter(), "1 / 3");

  press("next");
  assert.equal(title(), "TOEFL Prep");
  assert.equal(bg(), "#8250DF");
  assert.equal(counter(), "2 / 3");

  press("dot-2");
  assert.equal(title(), "Speaking Club");
  press("next"); // berputar ke awal
  assert.equal(title(), "IELTS Intensif");
  press("prev"); // berputar ke akhir
  assert.equal(counter(), "3 / 3");

  // Slide dari app host
  call(`XP.update(${JSON.stringify(JSON.stringify({ slides: [{ title: "A", subtitle: "a", color: "#000000" }] }))})`);
  assert.equal(title(), "A");
  assert.equal(counter(), "1 / 1", "index menyesuaikan saat jumlah slide berkurang");
  assert.deepEqual(tree.orphans(), []);
  vm.dispose();
});

test("web (DOM): klik tombol dan titik mengganti slide", async () => {
  const code = readFileSync(`dist/${entry.web.file}`, "utf8");
  const mod = { exports: {} as any };
  new Function("module", "exports", code)(mod, mod.exports);

  const html = mod.exports.renderHTML({});
  assert.match(html, /IELTS Intensif/);
  assert.match(html, /1 \/ 3/);

  const dom = new JSDOM(`<div id="app"></div>`);
  Object.assign(globalThis, { document: dom.window.document });
  const el = dom.window.document.getElementById("app")!;
  mod.exports.render(el, {});
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  const click = async (id: string) => {
    const target = (q(id).querySelector("span") as HTMLElement | null) ?? q(id);
    target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  };

  await click("next");
  assert.equal(q("slide-title").textContent, "TOEFL Prep");
  await click("dot-2");
  assert.equal(q("counter").textContent, "3 / 3");
  assert.equal(q("dot-2").style.width, "18px", "titik aktif melebar");
  await click("next");
  assert.equal(q("slide-title").textContent, "IELTS Intensif");
});
