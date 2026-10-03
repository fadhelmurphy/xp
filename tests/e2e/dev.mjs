// xp dev: ubah file komponen → pratinjau di browser memuat bundle baru dan state tetap.
//   node tests/e2e/dev.mjs
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { dev } from "../../cli/dev.mjs";

const work = mkdtempSync(path.join(tmpdir(), "xp-dev-"));
const src = path.join(work, "src");
cpSync("examples/promo-slider.tsx", path.join(src, "promo-slider.tsx"));
const logs = [];
const port = 4455;
const session = await dev({ srcDir: src, outDir: path.join(work, "dist"), port, log: (l) => logs.push(l) });

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium" });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/preview/promo-slider`);
  const title = page.getByTestId("slide-title");
  await title.waitFor();
  assert.equal(await title.textContent(), "IELTS Intensif");
  await page.getByTestId("next").click();
  await page.getByTestId("next").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="slide-title"]').textContent === "Speaking Club");
  const fileBefore = await page.evaluate(() => document.body.dataset.file);

  // Edit file: ganti teks slide ketiga.
  const file = path.join(src, "promo-slider.tsx");
  writeFileSync(file, readFileSync(file, "utf8").replace("Latihan bicara bareng mentor", "Latihan bicara tiap Sabtu"));
  await page.waitForFunction((f) => document.body.dataset.file !== f, fileBefore, { timeout: 15_000 });

  assert.equal(await title.textContent(), "Speaking Club", "state (slide aktif) tetap setelah reload");
  assert.match(await page.locator("body").textContent(), /Latihan bicara tiap Sabtu/);
  assert.match(await page.locator("#status").textContent(), /state dipertahankan/);
  assert.deepEqual(errors, []);
  console.log("✓ xp dev: rebuild otomatis, pratinjau dimuat ulang, state dipertahankan");
} finally {
  await browser.close();
  session.close();
}
