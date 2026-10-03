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

  const contentBefore = tree.byTestID("slide")!.children[0];
  press("next");
  assert.equal(title(), "TOEFL Prep");
  assert.equal(bg(), "#8250DF");
  assert.equal(counter(), "2 / 3");

  // Animasi: style membawa transisi, konten slide adalah node BARU dengan `entering` dari kanan.
  const slide = tree.byTestID("slide")!;
  assert.equal((slide.props.style as Record<string, unknown>).transitionDuration, 350);
  const content = tree.nodes.get(slide.children[0])!;
  assert.notEqual(slide.children[0], contentBefore, "konten slide dibuat ulang (key berganti)");
  assert.deepEqual(content.props.entering, { opacity: 0, translateX: 28, duration: 320 });
  press("prev");
  assert.deepEqual(tree.nodes.get(tree.byTestID("slide")!.children[0])!.props.entering, { opacity: 0, translateX: -28, duration: 320 }, "mundur: masuk dari kiri");
  press("next");

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

  const server = { exports: {} as any };
  new Function("module", "exports", readFileSync(`dist/${entry.ssr.file}`, "utf8"))(server, server.exports);
  const html = server.exports.renderHTML({});
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

  // Mount awal: tidak ada animasi masuk (konten SSR tidak boleh berkedip).
  const firstContent = q("slide").firstElementChild as HTMLElement;
  assert.equal(firstContent.style.opacity, "");
  assert.match(q("slide").style.transition, /background-color 350ms ease-in-out/);

  await click("next");
  assert.equal(q("slide-title").textContent, "TOEFL Prep");
  const content = q("slide").firstElementChild as HTMLElement;
  assert.notEqual(content, firstContent, "konten slide elemen baru");
  assert.equal(content.style.opacity, "0", "mulai dari opacity 0");
  assert.match(content.style.transform, /translate\(28px, 0px\)/);
  await new Promise((r) => setTimeout(r, 60)); // frame berikutnya
  assert.equal(content.style.opacity, "");
  assert.match(content.style.transition, /opacity 320ms ease-out, transform 320ms ease-out/);
  assert.match(q("dot-1").style.transition, /width 250ms/);

  await click("dot-2");
  assert.equal(q("counter").textContent, "3 / 3");
  assert.equal(q("dot-2").style.width, "18px", "titik aktif melebar");
  await click("next");
  assert.equal(q("slide-title").textContent, "IELTS Intensif");
});
