// Bundle web hasil `xp build`: SSR (string HTML) dan client (DOM), tanpa React.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
const entry = manifest.components["promo-modal"];
const code = readFileSync(`dist/${entry.web.file}`, "utf8");
const ssrCode = readFileSync(`dist/${entry.ssr.file}`, "utf8");

// Cara loader memuat bundle dari URL: evaluasi CJS mandiri (tidak butuh modul dari host).
// Bundle `web` untuk browser (render), bundle `ssr` untuk server (renderHTML).
function load() {
  const module = { exports: {} as any };
  new Function("module", "exports", code)(module, module.exports);
  const server = { exports: {} as any };
  new Function("module", "exports", ssrCode)(server, server.exports);
  module.exports = { ...module.exports, renderHTML: server.exports.renderHTML };
  return module.exports as {
    protocol: number;
    renderHTML(p: object): string;
    render(el: HTMLElement, p: object): { update(p: object): void; unmount(): void };
  };
}

const props = { title: "Kelas IELTS <Intensif>", price: 150000, seats: 3 };

test("bundle web & ssr mandiri: tidak me-require modul apa pun", () => {
  assert.doesNotMatch(code, /\brequire\(/);
  assert.doesNotMatch(ssrCode, /\brequire\(/);
  assert.equal(load().protocol, 1);
});

test("bundle browser tanpa kode SSR, bundle server tanpa kode DOM", () => {
  assert.doesNotMatch(code, /renderHTML/);
  assert.doesNotMatch(ssrCode, /addEventListener|createElement\(/);
});

test("SSR: HTML lengkap, teks di-escape, modal tersembunyi", () => {
  const html = load().renderHTML(props);
  assert.match(html, /Kelas IELTS &lt;Intensif&gt;/);
  assert.match(html, /Rp150\.000 \/ orang/);
  assert.match(html, /role="dialog"[^>]*style="[^"]*display:none/);
});

test("client: klik di DOM menjalankan state yang sama", async () => {
  const dom = new JSDOM(`<div id="app"></div>`);
  Object.assign(globalThis, { document: dom.window.document });
  const el = dom.window.document.getElementById("app")!;
  el.innerHTML = load().renderHTML(props); // seperti halaman hasil SSR
  load().render(el, props);

  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  const click = async (id: string) => {
    const target = (q(id).querySelector("span") as HTMLElement | null) ?? q(id); // klik di teks tombol
    target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve(); // flush setState
    await Promise.resolve();
  };
  const dialog = () => el.querySelector('[role="dialog"]') as HTMLElement;

  assert.equal(dialog().style.display, "none");
  await click("open");
  assert.equal(dialog().style.display, "flex");
  await click("plus");
  await click("plus");
  assert.equal(q("qty").textContent, "Peserta: 3");
  assert.equal(q("total").textContent, "Total: Rp450.000");
  assert.equal(q("full").textContent, "Kuota penuh");
  await click("plus"); // disabled: tidak berubah
  assert.equal(q("qty").textContent, "Peserta: 3");
  await click("close");
  assert.equal(dialog().style.display, "none");
});

test("SSR dan client menghasilkan struktur yang sama", () => {
  const dom = new JSDOM(`<div id="a"></div>`);
  Object.assign(globalThis, { document: dom.window.document });
  const el = dom.window.document.getElementById("a")!;
  load().render(el, props);
  const norm = (h: string) => h.replace(/\s/g, "").replace(/;"/g, '"');
  const ssr = new JSDOM(load().renderHTML(props)).window.document.body.innerHTML;
  assert.equal(norm(el.innerHTML).length > 0, true);
  // Bandingkan urutan tag + teks (style bisa beda format antara serializer & CSSOM).
  const skeleton = (h: string) => norm(h).replace(/style="[^"]*"/g, "");
  assert.equal(skeleton(el.innerHTML), skeleton(ssr));
});

test("Text numberOfLines memotong teks di web", async () => {
  const { styleToCss } = await import("../runtime/hosts/web-style");
  const css = styleToCss("Text", { fontSize: 14 }, { numberOfLines: 2 });
  assert.equal(css["-webkit-line-clamp"], "2");
  assert.equal(css.overflow, "hidden");
  assert.equal(styleToCss("Text", {}, {})["-webkit-line-clamp"], undefined);
});
