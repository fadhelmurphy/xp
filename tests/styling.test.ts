// Styling: CSS biasa, CSS modules, Tailwind, CSS-in-JS (emotion, styled-components) di komponen
// React; className Tailwind di komponen xp (web, SSR, dan native).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { before, test } from "node:test";
import { JSDOM } from "jsdom";
import { evaluate, loadWeb } from "./load-web";

const out = mkdtempSync(path.join(tmpdir(), "xp-styling-"));
let manifest: any;

before(() => {
  execFileSync(process.execPath, ["cli/xp.mjs", "build", "tests/fixtures/styling", "--out", out, "--yes"], { stdio: "pipe" });
  manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function browser() {
  const dom = new JSDOM(`<!doctype html><html><head></head><body><div id="app"></div></body></html>`, { pretendToBeVisual: true });
  const globals = ["window", "document", "navigator", "Node", "Text", "Comment", "Element", "HTMLElement", "SVGElement",
    "DocumentFragment", "HTMLTemplateElement", "CharacterData", "Event", "MouseEvent", "CustomEvent", "HTMLStyleElement",
    "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"] as const;
  for (const k of globals) Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true });
  return { dom, el: dom.window.document.getElementById("app")! };
}

/** SSR → HTML di halaman → bundle web meng-hydrate. Mengembalikan elemen hasil SSR dan error console. */
async function ssrThenHydrate(name: string, props: Record<string, unknown> = {}) {
  const entry = manifest.components[name];
  // SSR berjalan di server: tanpa DOM dari tes sebelumnya.
  for (const k of ["window", "document"]) delete (globalThis as any)[k];
  const html = await evaluate(readFileSync(path.join(out, entry.ssr.file), "utf8"), () => ({})).renderHTML(props);
  const b = browser();
  b.el.innerHTML = html;
  const ssrRoot = [...b.el.children].find((c) => c.tagName !== "STYLE")!;
  const errors: string[] = [];
  const orig = { error: console.error, warn: console.warn };
  console.error = console.warn = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  try {
    const instance = loadWeb(entry.web, out).render(b.el, props);
    await tick(20);
    return { ...b, html, instance, ssrRoot, hydrated: b.el.contains(ssrRoot), errors };
  } finally {
    Object.assign(console, orig);
  }
}

test("React: import CSS, CSS modules, url() aset, dan Tailwind ikut SSR lalu pindah ke <head>", async () => {
  const r = await ssrThenHydrate("card");
  assert.match(r.html, /^<style data-xp-style="card-[0-9a-f]+">/);
  assert.match(r.html, /\.card\{padding:16px;background:#eef\}/, "CSS biasa");
  assert.match(r.html, /\.base\{margin:0\}/, "@import di CSS ikut");
  assert.match(r.html, /\.card_title_[0-9a-f]{6}\{color:#c00;background:url\(['"]?data:image\/svg\+xml/, "CSS modules di-scope, aset jadi data URL");
  assert.match(r.html, /class="card_title_[0-9a-f]{6}"/);
  assert.match(r.html, /--color-brand: ?#ff6600/i, "tema @theme dipakai");
  assert.match(r.html, /\.bg-brand\{/);
  assert.match(r.html, /\.hover\\:bg-blue-500:hover/);
  assert.doesNotMatch(r.html, /\*,:after,:before|::backdrop,:after,:before/, "preflight Tailwind tidak ikut");
  assert.ok(r.hydrated, "DOM hasil SSR dipakai ulang");
  assert.equal(r.el.querySelector("style"), null, "<style> dipindah dari komponen");
  assert.ok(r.dom.window.document.head.querySelector("style[data-xp-style]"));
  r.el.querySelector<HTMLElement>("[data-testid=card]")!.click();
  await tick(20);
  assert.equal(r.el.querySelector("[data-testid=count]")!.textContent, "1");
  assert.deepEqual(r.errors, []);
});

test("React + emotion: CSS dari SSR, hydrate tanpa mismatch", async () => {
  const r = await ssrThenHydrate("emotion-box", { label: "halo" });
  assert.match(r.html, /<style data-emotion="css [\w-]+">\.css-[\w-]+\{padding:12px;background:hotpink;\}/);
  assert.match(r.html, /font-weight:bold/, "prop css (jsx emotion)");
  assert.doesNotMatch(r.html, /css="\[object Object\]"/);
  assert.ok(r.hydrated);
  assert.equal(r.el.querySelector("style"), null);
  assert.ok(r.dom.window.document.head.querySelector("style[data-emotion]"));
  assert.deepEqual(r.errors, []);
});

test("React + styled-components: ServerStyleSheet di SSR, hydrate tanpa mismatch", async () => {
  const r = await ssrThenHydrate("styled-box", { label: "halo" });
  assert.match(r.html, /<style data-styled="true"[^>]*>\.[\w-]+\{padding:12px;background:teal;\}/);
  assert.ok(r.hydrated);
  assert.equal(r.el.querySelector("style"), null);
  assert.equal(r.el.textContent, "halo");
  assert.deepEqual(r.errors, []);
});

test("xp className: SSR berisi CSS varian (@media, :hover, :active) dan class-nya", async () => {
  const r = await ssrThenHydrate("promo-chip");
  const css = r.html.match(/^<style data-xp-style="[^"]+">([^<]*)<\/style>/)![1];
  assert.match(css, /@media \(min-width:768px\)\{\.xp[0-9a-f]{6}-\d+\{padding:32px!important\}\}/, "md:p-8");
  assert.match(css, /@media \(min-width:600px\)\{\.xp[0-9a-f]{6}-\d+\{gap:12px!important\}\}/, "breakpoint dari @theme (tab:)");
  assert.match(css, /@media \(prefers-color-scheme:dark\)\{\.xp[0-9a-f]{6}-\d+\{background-color:#000000!important\}\}/);
  assert.match(css, /@media \(hover:hover\)\{\.xp[0-9a-f]{6}-\d+:hover\{background-color:#d1d5dc!important\}\}/);
  assert.match(css, /\.xp[0-9a-f]{6}-\d+:active\{background-color:#99a1af!important\}/);
  assert.match(css, /\[aria-disabled="true"\]\{opacity:0\.5!important\}/);
  assert.match(css, /\.xp[0-9a-f]{6}-\d+:focus\{border-color:#ff6600!important\}/);
  const root = r.el.querySelector<HTMLElement>("[data-testid=root]")!;
  assert.match(root.getAttribute("class")!, /^xp[0-9a-f]{6}-\d+( xp[0-9a-f]{6}-\d+)*$/);
  assert.match(root.getAttribute("style")!, /padding:16px/);
  assert.match(root.getAttribute("style")!, /background-color:#ffffff/);
  assert.ok(r.hydrated, "DOM hasil SSR dipakai ulang");
  assert.equal(r.el.querySelector("style"), null);
  assert.ok(r.dom.window.document.head.querySelector("style[data-xp-style]"));
  assert.deepEqual(r.errors, []);
});

test("xp pressedStyle manual di web: berlaku selama ditekan", async () => {
  const r = await ssrThenHydrate("promo-chip");
  const manual = r.el.querySelector<HTMLElement>("[data-testid=manual]")!;
  const pointer = (type: string, target: EventTarget) => {
    const e = new r.dom.window.Event(type, { bubbles: true });
    Object.assign(e, { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0 });
    target.dispatchEvent(e);
  };
  assert.doesNotMatch(manual.getAttribute("style")!, /opacity/);
  pointer("pointerdown", manual);
  assert.match(manual.getAttribute("style")!, /opacity:0\.5/);
  pointer("pointerup", r.dom.window);
  assert.doesNotMatch(manual.getAttribute("style")!, /opacity/);
});

/** Bundle native di VM (seperti QuickJS di device): XP.environment lalu XP.mount. */
function native(name: string) {
  const ctx: any = {};
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(out, manifest.components[name].native.file), "utf8"), ctx);
  const props = new Map<number, any>();
  const apply = (json: string) => {
    for (const b of JSON.parse(json)) for (const op of b.ops) if (op[0] === "props") props.set(op[1], { ...props.get(op[1]), ...op[2] });
  };
  const byTest = (id: string) => [...props.values()].find((p) => p.testID === id);
  return { XP: ctx.XP, apply, byTest };
}

test("xp className di native: breakpoint & dark dari XP.environment, keadaan jadi pressedStyle/hoverStyle/focusStyle", () => {
  const n = native("promo-chip");
  n.apply(n.XP.environment('{"width":390,"height":800,"dark":false}'));
  n.apply(n.XP.mount("{}"));
  assert.deepEqual(n.byTest("root").style, { padding: 16, backgroundColor: "#ffffff" }, "lebar 390: tab:gap-3 (600) belum");
  const chip = n.byTest("chip");
  assert.equal(chip.style.backgroundColor, "#e5e7eb");
  assert.deepEqual(chip.pressedStyle, { backgroundColor: "#99a1af" });
  assert.deepEqual(chip.hoverStyle, { backgroundColor: "#d1d5dc" });
  assert.deepEqual(n.byTest("input").focusStyle, { borderColor: "#ff6600" });
  assert.deepEqual(n.byTest("manual").pressedStyle, { opacity: 0.5 }, "pressedStyle manual tetap terkirim");

  // Melewati breakpoint dan ganti mode gelap → render ulang tanpa XP.update.
  n.apply(n.XP.environment('{"width":800,"height":800,"dark":true}'));
  assert.deepEqual(n.byTest("root").style, { padding: 32, backgroundColor: "#000000", gap: 12 });
  // Dalam breakpoint yang sama: tidak ada operasi UI.
  assert.equal(n.XP.environment('{"width":820,"height":800,"dark":true}'), "[]");
});

test("xp className: tekan chip → class berganti (bg-brand) di native", () => {
  const n = native("promo-chip");
  n.apply(n.XP.mount("{}"));
  const key = n.byTest("chip").onPress.$fn;
  n.apply(n.XP.dispatch(key));
  assert.equal(n.byTest("chip").style.backgroundColor, "#ff6600");
});

test("xp className yang tidak bisa jalan di device: build gagal dengan lokasi dan alasan", () => {
  let message = "";
  try {
    execFileSync(process.execPath, ["cli/xp.mjs", "build", "tests/fixtures/styling-bad", "--out", mkdtempSync(path.join(tmpdir(), "xp-bad-")), "--yes"], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (e: any) {
    message = `${e.stdout}${e.stderr}`;
  }
  assert.match(message, /blurred\.tsx:4:\d+ className "blur-sm": filter: blur\(8px\) belum didukung di komponen xp/);
});

for (const [name, color] of [["tw-vue", "--color-blue-500"], ["tw-svelte", "--color-emerald-500"]]) {
  test(`${name}: Tailwind lewat import dan @apply di <style>, lalu hydrate`, async () => {
    const r = await ssrThenHydrate(name);
    assert.match(r.html, /\.p-2\{padding:calc\(var\(--spacing\) \* 2\)\}/, "class di template");
    assert.match(r.html, /\.hover\\:bg-brand:hover\{background-color:var\(--color-brand\)\}/, "tema @theme");
    assert.match(r.html, new RegExp(`\\.btn[^{]*\\{[^}]*background-color: ?var\\(${color}`), "@apply di <style>");
    assert.ok(r.hydrated, "DOM hasil SSR dipakai ulang");
    assert.equal(r.el.querySelector("style"), null);
    assert.deepEqual(r.errors, []);
  });
}

test("xp className: posisi, grid, shadow, gradien, transform, teks, dan satuan layar di native", () => {
  const n = native("promo-card");
  n.apply(n.XP.environment('{"width":800,"height":700,"dark":false}'));
  n.apply(n.XP.mount("{}"));
  assert.deepEqual(n.byTest("card").style, {
    position: "relative", overflow: "hidden", borderRadius: 16, padding: 16, dividerWidth: 1, dividerColor: "#ffffff66",
    boxShadow: "0px 10px 15px -3px #2b7fff66, 0px 4px 6px -4px #2b7fff66",
    backgroundImage: "linear-gradient(to right, #2b7fff, #f6339a)",
  });
  assert.deepEqual(n.byTest("title").style, {
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "monospace", color: "#ffffff",
    textTransform: "uppercase", fontStyle: "italic", textDecorationLine: "underline", letterSpacing: 0.8,
  });
  assert.deepEqual(n.byTest("grid").style, { display: "grid", gridColumns: 2, columnGap: 8, rowGap: 4 });
  assert.deepEqual(n.byTest("wide").style, { gridColumnSpan: 2, fontSize: 12, lineHeight: 16 });
  assert.deepEqual(n.byTest("img").style, { aspectRatio: 1.778, width: "100%", objectFit: "contain" });
  const buy = n.byTest("buy");
  assert.equal(buy.style.marginLeft, "auto");
  assert.equal(buy.style.borderTopWidth, 2);
  assert.equal(buy.style.borderStyle, "dashed");
  assert.equal(buy.style.boxShadow, "0px 0px 0px 2px #ffffff99", "ring-2 + warna ring");
  assert.deepEqual(buy.pressedStyle, { scaleX: 0.95, scaleY: 0.95 });
  assert.deepEqual(n.byTest("badge").style, { position: "absolute", top: 8, right: 8, zIndex: 10, rotate: -12, translateY: "-50%" });
  assert.deepEqual(n.byTest("tall").style, { display: "flex", minHeight: 700 }, "md:flex menimpa hidden; 100vh = tinggi layar");
  // Tinggi layar berubah → min-h-screen ikut.
  n.apply(n.XP.environment('{"width":800,"height":900,"dark":false}'));
  assert.equal(n.byTest("tall").style.minHeight, 900);
});

test("xp className: CSS web untuk divide-*, transform, dan animate-*", async () => {
  const r = await ssrThenHydrate("promo-card");
  assert.match(r.html, /@keyframes xp-pulse/);
  assert.match(r.html, /\.xp[0-9a-f]{6}-\d+>:not\(:last-child\)\{border-bottom-width:1px!important;border-bottom-style:solid!important\}/);
  assert.match(r.html, /:active\{scale:0\.95 0\.95!important\}/);
  assert.match(r.html, /@media \(min-width:768px\)\{\.xp[0-9a-f]{6}-\d+\{display:flex!important\}\}/);
  const badge = r.el.querySelector("[data-testid=badge]")!.getAttribute("style")!;
  assert.match(badge, /translate:0px -50%;rotate:-12deg;position:absolute;top:8px;right:8px;z-index:10/);
  assert.match(r.el.querySelector("[data-testid=tall]")!.getAttribute("style")!, /display:none;.*min-height:100vh/);
  assert.match(r.el.querySelector("[data-testid=grid]")!.getAttribute("style")!, /display:grid;.*grid-template-columns:repeat\(2, minmax\(0, 1fr\)\);column-gap:8px;row-gap:4px/);
  assert.ok(r.hydrated);
  assert.deepEqual(r.errors, []);
});
