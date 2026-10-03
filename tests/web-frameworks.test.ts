// Target web: komponen React, Vue, dan Svelte dari `xp build`.
// SSR (bundle ssr) → hydrate (bundle web) di DOM → interaksi. Tanpa framework dari luar bundle.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
const load = (file: string) => {
  const m = { exports: {} as any };
  new Function("module", "exports", readFileSync(`dist/${file}`, "utf8"))(m, m.exports);
  return m.exports;
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function browser() {
  const dom = new JSDOM(`<!doctype html><html><head></head><body><div id="app"></div></body></html>`, { pretendToBeVisual: true });
  const globals = ["window", "document", "navigator", "Node", "Text", "Comment", "Element", "HTMLElement", "SVGElement",
    "DocumentFragment", "HTMLTemplateElement", "CharacterData", "Event", "MouseEvent", "CustomEvent",
    "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"] as const;
  for (const k of globals) Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true });
  // jsdom tidak punya Web Animations API (dipakai transisi Svelte); browser sungguhan punya.
  (dom.window.Element.prototype as any).animate = function () {
    const a: any = { cancel() {}, finish() {}, onfinish: null, finished: Promise.resolve() };
    setTimeout(() => a.onfinish?.(), 0);
    return a;
  };
  const el = dom.window.document.getElementById("app")!;
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  const click = async (id: string) => {
    q(id).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(20);
  };
  return { dom, el, q, click };
}

async function ssrThenHydrate(name: string, props: Record<string, unknown> = {}) {
  const entry = manifest.components[name];
  assert.equal(entry.target, "web");
  assert.ok(entry.ssr && entry.web && !entry.native, "framework: bundle web + ssr, tanpa native");
  const b = browser();
  const html = await load(entry.ssr.file).renderHTML(props);
  b.el.innerHTML = html;
  const ssrRoot = [...b.el.children].find((c) => c.tagName !== "STYLE")!;
  const errors: string[] = [];
  const orig = { error: console.error, warn: console.warn };
  console.error = console.warn = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  try {
    const instance = load(entry.web.file).render(b.el, props);
    await tick(20);
    return { ...b, html, instance, hydrated: b.el.contains(ssrRoot), errors };
  } finally {
    Object.assign(console, orig);
  }
}

test("React: SSR, hydrate memakai DOM yang sama, klik, update props", async () => {
  const r = await ssrThenHydrate("like-button", { label: "Suka?", initial: 5 });
  assert.match(r.html, /Suka\?/);
  assert.ok(r.hydrated, "DOM hasil SSR dipakai ulang");
  await r.click("like");
  assert.equal(r.q("likes").textContent, "6");
  r.instance.update({ label: "Masih suka?", initial: 5 });
  await tick(20);
  assert.match(r.el.textContent!, /Masih suka\?/);
  assert.equal(r.q("likes").textContent, "6", "state tetap setelah update props");
  assert.deepEqual(r.errors, []);
});

test("Vue: SSR + scoped CSS, hydrate, klik, update props", async () => {
  const r = await ssrThenHydrate("rating-stars", { title: "Nilai kelas" });
  assert.match(r.html, /^<style data-xp-style=/, "CSS ikut di HTML SSR");
  assert.match(r.html, /data-v-[0-9a-f]{8}/, "atribut scoped");
  assert.ok(r.hydrated, "DOM hasil SSR dipakai ulang");
  assert.ok(r.dom.window.document.head.querySelector("style[data-xp-style]"), "CSS dipindah ke <head>");
  await r.click("star-3");
  assert.equal(r.q("rating-label").textContent, "3 dari 5");
  r.instance.update({ title: "Judul baru" });
  await tick(20);
  assert.match(r.el.textContent!, /Judul baru/);
  assert.equal(r.q("rating-label").textContent, "3 dari 5");
  assert.deepEqual(r.errors, []);
});

test("Svelte: SSR + CSS, hydrate, buka/tutup item, update props", async () => {
  const r = await ssrThenHydrate("faq-list");
  assert.match(r.html, /Berapa lama kelas IELTS\?/);
  assert.ok(r.hydrated, "DOM hasil SSR dipakai ulang");
  assert.ok(r.q("faq-answer-0"));
  await r.click("faq-1");
  await tick(300);
  assert.equal(r.q("faq-answer-0"), null);
  assert.match(r.q("faq-answer-1").textContent!, /Ada, gratis/);
  r.instance.update({ items: [{ q: "Satu?", a: "Ya." }] });
  await tick(20);
  assert.match(r.el.textContent!, /Satu\?/);
  assert.deepEqual(r.errors, []);
});

test("bundle mandiri: tidak me-require modul, SSR tidak meninggalkan timer/handle", async () => {
  for (const name of ["like-button", "rating-stars", "faq-list"]) {
    for (const part of ["web", "ssr"]) {
      const code = readFileSync(`dist/${manifest.components[name][part].file}`, "utf8");
      assert.doesNotMatch(code, /\brequire\(/, `${name}.${part}`);
    }
  }
  // Server tidak boleh tertahan oleh scheduler client (mis. MessageChannel React).
  const { execFileSync } = await import("node:child_process");
  const script = `
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync("dist/manifest.json", "utf8"));
    (async () => {
      for (const n of ["like-button", "rating-stars", "faq-list"]) {
        const mod = { exports: {} };
        new Function("module", "exports", fs.readFileSync("dist/" + m.components[n].ssr.file, "utf8"))(mod, mod.exports);
        await mod.exports.renderHTML({});
      }
    })();`;
  execFileSync(process.execPath, ["-e", script], { timeout: 10_000 }); // lewat timeout = proses tertahan
});
