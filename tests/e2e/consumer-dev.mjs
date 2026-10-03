// xp dev + app konsumen di mode dev (next dev / nuxt dev): ubah file komponen →
// komponen di halaman diganti versi baru tanpa refresh, state komponen xp tetap.
//
//   node tests/e2e/consumer-dev.mjs     (menjalankan xp dev di :4400 dari salinan examples/)
//   lalu jalankan app konsumen dengan `next dev -p 3300` atau `nuxt dev --port 3400`,
//   dan set APP_URL ke alamatnya.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { dev } from "../../cli/dev.mjs";

const APP = process.env.APP_URL ?? "http://localhost:3300";
const work = mkdtempSync(path.join(tmpdir(), "xp-consumer-dev-"));
const src = path.join(work, "src");
cpSync("examples", src, { recursive: true });
const session = await dev({ srcDir: src, outDir: path.join(work, "dist"), port: 4400, log: () => {} });
console.log("xp dev jalan di :4400. Menunggu", APP);

// App konsumen dijalankan terpisah; tunggu sampai siap.
for (let i = 0; ; i++) {
  try {
    if ((await fetch(APP)).ok) break;
  } catch {}
  if (i > 240) throw new Error(`${APP} tidak bisa diakses`);
  await new Promise((r) => setTimeout(r, 1000));
}

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium" });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(APP);
  await page.waitForFunction(() => document.querySelectorAll('[data-xp-ready="true"]').length >= 5, null, { timeout: 60_000 });

  await page.getByTestId("next").click();
  await page.getByTestId("next").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="slide-title"]').textContent === "Speaking Club");

  const file = path.join(src, "promo-slider.tsx");
  writeFileSync(file, readFileSync(file, "utf8").replace("Latihan bicara bareng mentor", "Latihan bicara tiap Sabtu"));
  await page.waitForFunction(() => document.body.textContent.includes("Latihan bicara tiap Sabtu"), null, { timeout: 20_000 });
  assert.equal(await page.getByTestId("slide-title").textContent(), "Speaking Club", "slide aktif tetap setelah reload");
  console.log("✓ komponen xp diganti versi baru tanpa refresh, state tetap");

  // Interaksi tetap jalan di versi baru.
  await page.getByTestId("next").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="slide-title"]').textContent === "IELTS Intensif");
  console.log("✓ versi baru tetap interaktif");

  const vue = path.join(src, "rating-stars.vue");
  writeFileSync(vue, readFileSync(vue, "utf8").replace("Belum dinilai", "Belum ada rating"));
  await page.waitForFunction(() => document.body.textContent.includes("Belum ada rating"), null, { timeout: 20_000 });
  console.log("✓ komponen Vue juga dimuat ulang");

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  session.close();
}
