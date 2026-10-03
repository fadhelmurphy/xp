// E2E: app konsumen (Next.js / Nuxt / ...) meng-import "xp:ui/promo-modal" dari remote (xp serve).
// Jalankan: APP_URL=http://localhost:3300 node tests/e2e/consumer.mjs  (remote di :4400)
import assert from "node:assert/strict";
import { cp, readFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { chromium } from "playwright-core";

const APP = process.env.APP_URL ?? "http://localhost:3300";
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium" });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => r.status() >= 400 && !r.url().endsWith("/favicon.ico") && errors.push(`${r.status()} ${r.url()}`));

const step = (msg) => console.log("✓", msg);

// 1. SSR: HTML dari server sudah berisi komponen, sebelum JS apa pun jalan.
const html = await (await fetch(APP)).text();
assert.match(html, /Kelas IELTS/);
assert.match(html, /Rp150\.000 \/ orang/);
assert.match(html, /role="dialog"/);
step("SSR: komponen remote ada di HTML server");

// 2. Hydrate + interaksi di browser.
// Simpan elemen hasil SSR sebelum JS jalan, untuk memastikan hydrate memakai elemen yang sama.
await page.addInitScript(() => {
  document.addEventListener("DOMContentLoaded", () => {
    window.__ssr = { open: document.querySelector('[data-testid="open"]'), slide: document.querySelector('[data-testid="slide"]') };
  });
});
await page.goto(APP);
await page.waitForSelector('[data-xp-ready="true"]');
await page.waitForFunction(() => document.querySelectorAll('[data-xp-ready="true"]').length >= 2);
assert.ok(
  await page.evaluate(
    () => window.__ssr.open === document.querySelector('[data-testid="open"]') && window.__ssr.slide === document.querySelector('[data-testid="slide"]'),
  ),
  "hydrate harus memakai elemen hasil SSR, bukan membuat ulang",
);
step("hydrate memakai elemen DOM hasil SSR (tidak dirender ulang)");
const dialog = page.locator('[role="dialog"]');
assert.equal(await dialog.isVisible(), false);
await page.getByTestId("open").click();
await dialog.waitFor({ state: "visible" });
step("klik 'Lihat detail' → modal tampil");

await page.getByTestId("plus").click();
await page.getByTestId("plus").click();
assert.equal(await page.getByTestId("qty").textContent(), "Peserta: 3");
assert.equal(await page.getByTestId("total").textContent(), "Total: Rp450.000");
assert.equal(await page.getByTestId("full").textContent(), "Kuota penuh");
step("state & logika jalan: peserta 3, total Rp450.000, kuota penuh");

await page.getByTestId("close").click();
await dialog.waitFor({ state: "hidden" });
step("tutup modal");

// Slider: komponen kedua di halaman yang sama.
assert.equal(await page.getByTestId("slide-title").textContent(), "IELTS Intensif");
await page.getByTestId("next").click();
await page.getByTestId("next").click();
assert.equal(await page.getByTestId("slide-title").textContent(), "Speaking Club");
await page.getByTestId("next").click(); // berputar ke awal
assert.equal(await page.getByTestId("counter").textContent(), "1 / 3");
await page.getByTestId("dot-1").click();
assert.equal(await page.getByTestId("slide-title").textContent(), "TOEFL Prep");
step("slider: tombol ‹ ›, titik indikator, dan putaran jalan");

// Geser dengan mouse (pointer event sungguhan): ke kiri → slide berikutnya.
const box = await page.getByTestId("slide").boundingBox();
await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 8 });
await page.mouse.up();
await page.waitForFunction(() => document.querySelector('[data-testid="slide-title"]').textContent === "Speaking Club");
step("slider: geser ke kiri → slide berikutnya (onSwipe)");

// Komponen web dari framework lain (React, Vue, Svelte), di halaman yang sama.
assert.match(html, /Suka kelas ini\?/, "React di-SSR");
assert.match(html, /Belum dinilai/, "Vue di-SSR");
assert.match(html, /Berapa lama kelas IELTS\?/, "Svelte di-SSR");
await page.waitForFunction(() => document.querySelectorAll('[data-xp-ready="true"]').length >= 5);

await page.getByTestId("like").click();
assert.equal(await page.getByTestId("likes").textContent(), "13");
step("React (like-button): SSR + hydrate, klik ♥ → 13");

await page.getByTestId("star-4").click();
assert.equal(await page.getByTestId("rating-label").textContent(), "4 dari 5");
// .star.on berwarna emas (scoped CSS); tunggu transisi warna 0,15 dtk selesai.
await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="star-1"]')).color === "rgb(191, 135, 0)", null, { timeout: 2000 });
step("Vue (rating-stars): SSR + hydrate, klik bintang 4 → \"4 dari 5\", scoped CSS aktif");

assert.equal(await page.getByTestId("faq-answer-0").isVisible(), true);
await page.getByTestId("faq-1").click();
await page.getByTestId("faq-answer-1").waitFor({ state: "visible" });
await page.getByTestId("faq-answer-0").waitFor({ state: "detached" }); // transisi slide selesai
step("Svelte (faq-list): SSR + hydrate, buka item 2 → item 1 menutup dengan transisi");

const loaded = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes(":4400/")));
assert.ok(!loaded.some((n) => n.includes(".ssr.")), "browser tidak boleh mengunduh bundle SSR");
assert.ok(!loaded.some((n) => /react|vue|svelte/i.test(n) && !n.includes(".web.")), "tidak ada runtime framework terpisah");
step(`browser hanya mengunduh bundle web (${loaded.filter((n) => n.endsWith(".js")).length} file), tanpa bundle SSR`);

// 3. Tim komponen deploy perubahan → app konsumen ikut berubah TANPA rebuild.
const src = "examples/promo-modal.tsx";
const original = await readFile(src, "utf8");
try {
  await writeFile(src, original.replace("Lihat detail", "Daftar sekarang"));
  execSync("node cli/xp.mjs build examples --out dist", { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 6500)); // > revalidate (5 dtk)
  await fetch(APP); // request pertama memicu revalidate di background
  await new Promise((r) => setTimeout(r, 1000));
  await page.goto(APP);
  await page.waitForSelector('[data-xp-ready="true"]');
  assert.equal((await page.getByTestId("open").textContent()).trim(), "Daftar sekarang");
  step("remote di-deploy ulang → konsumen menampilkan versi baru tanpa rebuild");
} finally {
  await writeFile(src, original);
  execSync("node cli/xp.mjs build examples --out dist", { stdio: "ignore" });
}

assert.deepEqual(errors, [], `error di browser: ${errors.join(" | ")}`);
step("tidak ada error / hydration mismatch di console browser");
await browser.close();
