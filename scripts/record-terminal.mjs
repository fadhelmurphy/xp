// Merekam demo terminal sebagai GIF. Perintah benar-benar dijalankan; output yang tampil
// adalah output aslinya, lalu diputar ulang dengan efek mengetik di jendela terminal.
//
//   OUT=docs/demo-build.gif node scripts/record-terminal.mjs "npm run build" "ls dist"
//
// Butuh: Chromium dan ffmpeg (sama dengan scripts/record-demo.mjs).
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const OUT = process.env.OUT ?? "docs/demo-terminal.gif";
const FPS = Number(process.env.FPS ?? 12);
const commands = process.argv.slice(2);
if (!commands.length) {
  console.error('Pemakaian: node scripts/record-terminal.mjs "perintah 1" "perintah 2" ...');
  process.exit(1);
}

// 1. Jalankan perintah, simpan output aslinya.
const steps = commands.map((cmd) => {
  let output;
  try {
    output = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0" } });
  } catch (e) {
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`; // perintah gagal juga direkam apa adanya
  }
  return { cmd, lines: output.replace(/\s+$/, "").split("\n") };
});

// 2. Halaman terminal yang memutar ulang langkah-langkah tadi.
const html = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;background:#0d1117}
  .win{margin:16px;border-radius:10px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,.5);border:1px solid #30363d}
  .bar{background:#161b22;padding:10px 12px;display:flex;gap:7px;align-items:center}
  .dot{width:11px;height:11px;border-radius:50%}
  .title{color:#8b949e;font:12px system-ui,sans-serif;margin-left:10px}
  pre{margin:0;padding:14px 16px;min-height:300px;color:#c9d1d9;font:13px/1.55 "DejaVu Sans Mono",Menlo,monospace;white-space:pre-wrap;word-break:break-all}
  .ps{color:#3fb950}.cmd{color:#e6edf3}.ok{color:#3fb950}.warn{color:#d29922}.err{color:#f85149}.dim{color:#8b949e}
  .cur{display:inline-block;width:8px;background:#c9d1d9;animation:b 1s steps(1) infinite}@keyframes b{50%{opacity:0}}
</style>
<div class="win"><div class="bar">
  <span class="dot" style="background:#ff5f56"></span><span class="dot" style="background:#ffbd2e"></span>
  <span class="dot" style="background:#27c93f"></span><span class="title">xp</span></div>
<pre id="t"></pre></div>
<script>
  const steps = ${JSON.stringify(steps)};
  const t = document.getElementById("t");
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const color = (l) => /^\\s*(✓|ok )/.test(l) ? "ok" : /⚠|warn/i.test(l) ? "warn" : /✗|error|gagal/i.test(l) ? "err" : /^>/.test(l) ? "dim" : "";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let html = "";
  const show = (extra = "") => { t.innerHTML = html + extra; };
  (async () => {
    for (const s of steps) {
      html += '<span class="ps">$ </span>';
      for (let i = 1; i <= s.cmd.length; i++) { show('<span class="cmd">' + esc(s.cmd.slice(0, i)) + '</span><span class="cur">&nbsp;</span>'); await sleep(55); }
      html += '<span class="cmd">' + esc(s.cmd) + "</span>\\n";
      show(); await sleep(450);
      for (const l of s.lines) { html += '<span class="' + color(l) + '">' + esc(l) + "</span>\\n"; show(); await sleep(140); }
      await sleep(900);
    }
    html += '<span class="ps">$ </span>'; show('<span class="cur">&nbsp;</span>');
    document.title = "done";
  })();
</script>`;

// 3. Rekam halaman tadi, ubah jadi GIF.
const SIZE = { width: Number(process.env.WIDTH ?? 820), height: Number(process.env.HEIGHT ?? 470) };
const videoDir = mkdtempSync(path.join(tmpdir(), "xp-term-"));
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium" });
const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: videoDir, size: SIZE } });
const page = await context.newPage();
await page.setContent(html);
await page.waitForFunction(() => document.title === "done", null, { timeout: 120_000 });
await page.waitForTimeout(1500);
await context.close();
await browser.close();

const video = path.join(videoDir, readdirSync(videoDir).find((f) => f.endsWith(".webm")));
mkdirSync(path.dirname(OUT), { recursive: true });
execFileSync(process.env.FFMPEG ?? "ffmpeg", [
  "-y", "-loglevel", "error", "-i", video,
  "-vf", `fps=${FPS},scale=${SIZE.width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=48:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
  "-loop", "0", OUT,
]);
rmSync(videoDir, { recursive: true, force: true });
console.log(`✓ ${OUT}`);
