// Timer di device, swipe, dan hydration yang memakai ulang elemen SSR.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getQuickJS } from "quickjs-emscripten";
import { swipeDirection } from "../runtime/hosts/gesture";
import type { Batch } from "../runtime/protocol";
import { NativeTree } from "../sdk-reference/tree";

const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
const slider = manifest.components["promo-slider"];
const modal = manifest.components["promo-modal"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function nativeSession(file: string) {
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
  evaluate(readFileSync(`dist/${file}`, "utf8"));
  return { vm, tree, evaluate, call };
}

test("native: setTimeout jalan lewat XP.nextTimer + XP.tick (autoplay slider)", async () => {
  const { vm, tree, evaluate, call } = await nativeSession(slider.native.file);
  const title = () => tree.text(tree.byTestID("slide-title")!);

  call(`XP.mount("{}")`);
  assert.equal(evaluate("XP.nextTimer()"), -1, "tanpa autoplay tidak ada timer");

  call(`XP.update(${JSON.stringify(JSON.stringify({ autoplay: 40 }))})`);
  const wait = evaluate("XP.nextTimer()") as number;
  assert.ok(wait > 0 && wait <= 40, `timer berikutnya ${wait} ms`);

  call("XP.tick()"); // belum jatuh tempo: tidak ada perubahan
  assert.equal(title(), "IELTS Intensif");

  await sleep(wait + 10);
  call("XP.tick()");
  assert.equal(title(), "TOEFL Prep");
  assert.ok((evaluate("XP.nextTimer()") as number) > 0, "timer berikutnya dijadwalkan lagi");

  // Navigasi manual mereset timer; unmount membersihkannya.
  call(`XP.dispatch(${JSON.stringify(tree.handler(tree.byTestID("next")!, "onPress"))}, "[]")`);
  assert.equal(title(), "Speaking Club");
  call("XP.unmount()");
  assert.equal(evaluate("XP.nextTimer()"), -1);
  vm.dispose();
});

test("native: onSwipe dikirim sebagai handler dengan arah", async () => {
  const { vm, tree, call } = await nativeSession(slider.native.file);
  const title = () => tree.text(tree.byTestID("slide-title")!);
  call(`XP.mount("{}")`);
  const key = tree.handler(tree.byTestID("slide")!, "onSwipe")!;
  assert.ok(key, "slide punya handler onSwipe");
  call(`XP.dispatch(${JSON.stringify(key)}, ${JSON.stringify(JSON.stringify(["left"]))})`);
  assert.equal(title(), "TOEFL Prep");
  call(`XP.dispatch(${JSON.stringify(key)}, ${JSON.stringify(JSON.stringify(["right"]))})`);
  call(`XP.dispatch(${JSON.stringify(key)}, ${JSON.stringify(JSON.stringify(["right"]))})`);
  assert.equal(title(), "Speaking Club", "geser ke kanan dari slide pertama berputar ke slide terakhir");
  vm.dispose();
});

test("arah swipe: sumbu dominan, minimal 40", () => {
  assert.equal(swipeDirection(-60, 10), "left");
  assert.equal(swipeDirection(60, -20), "right");
  assert.equal(swipeDirection(5, -80), "up");
  assert.equal(swipeDirection(0, 45), "down");
  assert.equal(swipeDirection(30, 30), null);
});

function loadWeb(entry: { web: { file: string }; ssr: { file: string } }, dom: JSDOM) {
  const g = globalThis as any;
  Object.assign(g, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
  const evaluate = (file: string) => {
    const module = { exports: {} as any };
    new Function("module", "exports", readFileSync(`dist/${file}`, "utf8"))(module, module.exports);
    return module.exports;
  };
  return { ...evaluate(entry.web.file), renderHTML: evaluate(entry.ssr.file).renderHTML } as {
    renderHTML(p: object): string;
    render(el: HTMLElement, p: object): { update(p: object): void; unmount(): void };
  };
}

test("web: hydration memakai elemen hasil SSR, tidak membuat ulang", async () => {
  const dom = new JSDOM(`<div id="app"></div>`);
  const bundle = loadWeb(modal, dom);
  const props = { title: "Kelas IELTS", price: 150000, seats: 3 };
  const app = dom.window.document.getElementById("app")!;
  app.innerHTML = bundle.renderHTML(props);

  const openBefore = app.querySelector('[data-testid="open"]');
  const totalBefore = app.querySelector('[data-testid="total"]');
  const html = app.innerHTML;
  bundle.render(app, props);

  assert.equal(app.querySelector('[data-testid="open"]'), openBefore, "elemen yang sama dipakai");
  assert.equal(app.querySelector('[data-testid="total"]'), totalBefore);
  assert.equal(app.innerHTML, html, "HTML tidak berubah setelah hydrate");

  (openBefore as HTMLElement).click();
  await sleep(0);
  const plus = app.querySelector('[data-testid="plus"]') as HTMLElement;
  await sleep(0);
  plus.click();
  await sleep(0);
  plus.click();
  await sleep(0);
  assert.equal(app.querySelector('[data-testid="total"]'), totalBefore, "elemen SSR terus dipakai saat state berubah");
  assert.equal(totalBefore!.textContent, "Total: Rp450.000");
});

test("web: HTML SSR yang tidak cocok diganti render client", () => {
  const dom = new JSDOM(`<div id="app"></div>`);
  const bundle = loadWeb(modal, dom);
  const app = dom.window.document.getElementById("app")!;
  app.innerHTML = bundle.renderHTML({ title: "Lama", price: 1, seats: 1 }) + "<p>sisa</p>";
  bundle.render(app, { title: "Baru", price: 150000, seats: 3 });
  assert.equal(app.querySelector('[data-testid="title"]')!.textContent, "Baru");
  assert.equal(app.querySelector("p"), null);
});

test("web: geser slide dengan pointer", async () => {
  const dom = new JSDOM(`<div id="app"></div>`);
  const bundle = loadWeb(slider, dom);
  const app = dom.window.document.getElementById("app")!;
  bundle.render(app, {});
  const slide = app.querySelector('[data-testid="slide"]') as HTMLElement;
  const title = () => app.querySelector('[data-testid="slide-title"]')!.textContent;
  assert.match(slide.getAttribute("style")!, /touch-action:pan-y/);

  const swipe = (dx: number) => {
    slide.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, clientX: 200, clientY: 50 }));
    slide.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 200 + dx, clientY: 55 }));
  };
  swipe(-80);
  await sleep(0);
  assert.equal(title(), "TOEFL Prep");
  swipe(20); // terlalu pendek
  await sleep(0);
  assert.equal(title(), "TOEFL Prep");
  swipe(90);
  await sleep(0);
  assert.equal(title(), "IELTS Intensif");
});

test("native: reload bundle membawa state lewat XP.snapshot", async () => {
  const a = await nativeSession(slider.native.file);
  const title = (t: NativeTree) => t.text(t.byTestID("slide-title")!);
  a.call(`XP.mount("{}")`);
  const press = (id: string) => a.call(`XP.dispatch(${JSON.stringify(a.tree.handler(a.tree.byTestID(id)!, "onPress"))}, "[]")`);
  press("next");
  press("next");
  assert.equal(title(a.tree), "Speaking Club");
  const snapshot = a.evaluate("XP.snapshot()") as string;
  assert.deepEqual(Object.values(JSON.parse(snapshot))[0], { 0: 2, 1: 1 }, "index dan direction tersimpan");

  // "Bundle baru": engine baru, mount dengan snapshot dari engine lama.
  const b = await nativeSession(slider.native.file);
  b.call(`XP.mount("{}", ${JSON.stringify(snapshot)})`);
  assert.equal(title(b.tree), "Speaking Club");
  assert.equal(b.tree.text(b.tree.byTestID("counter")!), "3 / 3");
  a.vm.dispose();
  b.vm.dispose();
});
