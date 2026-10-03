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
await page.goto(APP);
await page.waitForSelector('[data-xp-ready="true"]');
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
