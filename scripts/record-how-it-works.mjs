// Merender scripts/how-it-works.html frame per frame lalu menyimpannya sebagai GIF.
//
//   node scripts/record-how-it-works.mjs            → docs/xp-flow.gif
//
// Butuh: Chromium dan ffmpeg (sama dengan scripts/record-demo.mjs).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const OUT = process.env.OUT ?? "docs/xp-flow.gif";
const FPS = Number(process.env.FPS ?? 15);
const dir = mkdtempSync(path.join(tmpdir(), "xp-how-"));
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 900, height: 680 } });
await page.goto(pathToFileURL(path.resolve("scripts/how-it-works.html")).href);
const duration = await page.evaluate(() => window.DURATION);
const frames = Math.round(duration * FPS);
for (let i = 0; i < frames; i++) {
  await page.evaluate((t) => window.render(t), i / FPS);
  await page.screenshot({ path: path.join(dir, `f${String(i).padStart(4, "0")}.png`) });
}
await browser.close();
execFileSync(process.env.FFMPEG ?? "ffmpeg", [
  "-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(dir, "f%04d.png"),
  "-vf", "scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
  "-loop", "0", OUT,
]);
rmSync(dir, { recursive: true, force: true });
console.log(`✓ ${OUT}`);
