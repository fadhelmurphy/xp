// Styling di Chromium: SSR → hydrate untuk komponen React (CSS, Tailwind, emotion,
// styled-components) dan komponen xp dengan className (breakpoint, mode gelap, hover, active).
//
//   node tests/e2e/styling.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const out = mkdtempSync(path.join(tmpdir(), "xp-styling-e2e-"));
execFileSync(process.execPath, ["cli/xp.mjs", "build", "tests/fixtures/styling", "--out", out, "--yes"], { stdio: "pipe" });
const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
const read = (f) => readFileSync(path.join(out, f), "utf8");

function evaluate(code) {
  const module = { exports: {} };
  new Function("module", "exports", "require", code)(module, module.exports, () => ({}));
  return module.exports;
}

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium" });

/** Halaman berisi HTML SSR komponen, lalu bundle web meng-hydrate elemen yang sama. */
async function open(name, { width = 500, dark = false } = {}) {
  const entry = manifest.components[name];
  const html = await evaluate(read(entry.ssr.file)).renderHTML({});
  const page = await browser.newPage({ viewport: { width, height: 700 }, colorScheme: dark ? "dark" : "light" });
  const problems = [];
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));
  await page.setContent(`<!doctype html><html><head></head><body><div id="app">${html}</div></body></html>`);
  // Tampilan sebelum JavaScript jalan (hanya HTML + CSS dari SSR).
  const before = await page.evaluate(() => document.querySelector("#app > :not(style)").outerHTML.length);
  const result = await page.evaluate(
    ({ web, runtime }) => {
      const ev = (code, req) => {
        const module = { exports: {} };
        new Function("module", "exports", "require", code)(module, module.exports, req);
        return module.exports;
      };
      const modules = runtime ? ev(runtime).modules : {};
      const app = document.getElementById("app");
      const first = app.querySelector(":scope > :not(style)");
      ev(web, (id) => modules[id]).render(app, {});
      return new Promise((r) => setTimeout(() => r({ same: app.querySelector(":scope > :not(style)") === first, inlineStyle: !!app.querySelector("style") }), 100));
    },
    { web: read(entry.web.file), runtime: entry.web.runtime ? read(entry.web.runtime.file) : null },
  );
  assert.ok(before > 0);
  assert.ok(result.same, `${name}: hydrate memakai elemen hasil SSR`);
  assert.ok(!result.inlineStyle, `${name}: <style> dipindah ke <head>`);
  return { page, problems };
}

const css = (page, selector, prop) => page.$eval(selector, (el, p) => getComputedStyle(el)[p], prop);

try {
  // React + CSS biasa + CSS modules + Tailwind
  {
    const { page, problems } = await open("card");
    // .card (CSS biasa, tanpa layer) menang atas utilities Tailwind, sama seperti di browser biasa
    assert.equal(await css(page, "[data-testid=card]", "backgroundColor"), "rgb(238, 238, 255)");
    assert.equal(await css(page, "[data-testid=card]", "borderTopLeftRadius"), "8px", "rounded-lg");
    assert.equal(await css(page, "[data-testid=card] h2", "color"), "rgb(204, 0, 0)", "CSS modules");
    await page.click("[data-testid=card]");
    assert.equal(await page.textContent("[data-testid=count]"), "1");
    assert.deepEqual(problems, []);
    await page.close();
  }
  for (const [name, bg] of [["emotion-box", "rgb(255, 105, 180)"], ["styled-box", "rgb(0, 128, 128)"]]) {
    const { page, problems } = await open(name);
    assert.equal(await css(page, "[data-testid=box]", "backgroundColor"), bg, `${name}: CSS-in-JS`);
    assert.deepEqual(problems, [], `${name}: tanpa hydration mismatch`);
    await page.close();
  }

  // xp + className: layar sempit & terang
  {
    const { page, problems } = await open("promo-chip", { width: 500 });
    assert.equal(await css(page, "[data-testid=root]", "paddingTop"), "16px");
    assert.equal(await css(page, "[data-testid=root]", "backgroundColor"), "rgb(255, 255, 255)");
    assert.equal(await css(page, "[data-testid=chip]", "backgroundColor"), "rgb(229, 231, 235)");
    await page.hover("[data-testid=chip]");
    await page.waitForTimeout(250); // transition-colors 150ms
    assert.equal(await css(page, "[data-testid=chip]", "backgroundColor"), "rgb(209, 213, 220)", "hover:");
    await page.mouse.down();
    await page.waitForTimeout(250);
    assert.equal(await css(page, "[data-testid=chip]", "backgroundColor"), "rgb(153, 161, 175)", "active:");
    await page.mouse.up();
    await page.focus("[data-testid=input]");
    assert.equal(await css(page, "[data-testid=input]", "borderTopColor"), "rgb(255, 102, 0)", "focus:");
    assert.deepEqual(problems, []);
    await page.close();
  }
  // xp + className: layar lebar & gelap, langsung dari HTML SSR
  {
    const { page, problems } = await open("promo-chip", { width: 1100, dark: true });
    assert.equal(await css(page, "[data-testid=root]", "paddingTop"), "32px", "md:p-8");
    assert.equal(await css(page, "[data-testid=root]", "flexDirection"), "row", "lg:flex-row");
    assert.equal(await css(page, "[data-testid=root]", "backgroundColor"), "rgb(0, 0, 0)", "dark:");
    assert.equal(await css(page, "[data-testid=root]", "columnGap"), "12px", "tab: (breakpoint dari @theme)");
    assert.deepEqual(problems, []);
    await page.close();
  }
  // xp + class lengkap
  {
    const { page, problems } = await open("promo-card", { width: 900 });
    assert.match(await css(page, "[data-testid=card]", "backgroundImage"), /^linear-gradient\(to right, rgb\(43, 127, 255\), rgb\(246, 51, 154\)\)$/);
    assert.match(await css(page, "[data-testid=card]", "boxShadow"), /rgba\(43, 127, 255, 0\.4\)/);
    assert.equal(await css(page, "[data-testid=title]", "borderBottomWidth"), "1px", "divide-y");
    assert.equal(await css(page, "[data-testid=badge]", "position"), "absolute");
    assert.equal(await css(page, "[data-testid=tall]", "display"), "flex", "md:flex menimpa hidden");
    assert.deepEqual(problems, []);
    await page.close();
  }
  console.log("styling e2e: ok");
} finally {
  await browser.close();
}
