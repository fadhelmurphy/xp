// Merekam demo app konsumen web lalu menyimpannya sebagai GIF.
//
//   APP_URL=http://localhost:3300 OUT=docs/demo-next.gif node scripts/record-demo.mjs
//
// Butuh: remote (`npm run serve`) dan app konsumen sudah jalan, Chromium, dan ffmpeg.
// CHROME=/path/ke/chrome kalau Chromium tidak ada di lokasi default Playwright.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const APP = process.env.APP_URL ?? "http://localhost:3300";
const OUT = process.env.OUT ?? "docs/demo.gif";
const SIZE = { width: 480, height: 440 };

// Kursor + efek klik, supaya interaksi terlihat di rekaman.
const CURSOR = `
  addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div");
    dot.style.cssText = "position:fixed;z-index:99999;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;" +
      "background:rgba(31,111,235,.35);border:2px solid #1F6FEB;pointer-events:none;left:-40px;top:-40px;transition:transform .15s";
    document.body.appendChild(dot);
    addEventListener("mousemove", (e) => { dot.style.left = e.clientX + "px"; dot.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => { dot.style.transform = "scale(.6)"; }, true);
    addEventListener("mouseup", () => { dot.style.transform = "scale(1)"; }, true);
  });
`;

const videoDir = mkdtempSync(path.join(tmpdir(), "xp-demo-"));
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium" });
const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, recordVideo: { dir: videoDir, size: SIZE } });
await context.addInitScript(CURSOR);
const page = await context.newPage();
const started = Date.now();

const pause = (ms) => page.waitForTimeout(ms);
let mouse = { x: SIZE.width / 2, y: SIZE.height - 40 };
async function tap(testID) {
  const box = await page.getByTestId(testID).boundingBox();
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(mouse.x, mouse.y);
  await page.mouse.move(to.x, to.y, { steps: 14 });
  mouse = to;
  await pause(150);
  await page.mouse.down();
  await pause(90);
  await page.mouse.up();
  await pause(450);
}

await page.goto(APP);
await page.waitForSelector('[data-xp-ready="true"]', { state: "attached" });
const trimStart = (Date.now() - started) / 1000; // buang frame kosong saat halaman memuat
await page.mouse.move(mouse.x, mouse.y);
await pause(900);

await tap("open");
await pause(500);
await tap("plus");
await tap("plus");
await pause(1400); // total & "Kuota penuh"
await tap("close");
await pause(900);

await context.close(); // video baru ditulis saat context ditutup
await browser.close();

const video = path.join(videoDir, readdirSync(videoDir).find((f) => f.endsWith(".webm")));
mkdirSync(path.dirname(OUT), { recursive: true });
execFileSync(process.env.FFMPEG ?? "ffmpeg", [
  "-y", "-loglevel", "error",
  "-ss", trimStart.toFixed(2), "-i", video,
  "-vf", "fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
  "-loop", "0", OUT,
]);
rmSync(videoDir, { recursive: true, force: true });
console.log(`✓ ${OUT}`);
