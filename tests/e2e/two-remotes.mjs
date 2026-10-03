// Dua remote (dua tim, dua CDN) di satu halaman: runtime xp hanya dimuat sekali.
//   1. kedua remote di-build dengan versi xp yang sama → runtime identik
//   2. remote kedua seolah di-build xp versi lebih baru → runtime-nya dipakai juga oleh komponen remote pertama
//   node tests/e2e/two-remotes.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { discover, plan, runBuild } from "../../cli/build.mjs";
import { serve } from "../../cli/serve.mjs";

const all = await discover("examples");
async function remote(name, port, newerVersion) {
  const out = mkdtempSync(path.join(tmpdir(), `xp-${name}-`));
  await runBuild({ srcDir: "examples", outDir: out, jobs: plan(all.filter((c) => c.name === name), "web").jobs });
  if (newerVersion) {
    // Tiru remote yang di-build xp versi lain: isi runtime berbeda, versi lebih tinggi, api sama.
    const file = path.join(out, "manifest.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    const rt = manifest.components[name].web.runtime;
    const code = readFileSync(path.join(out, rt.file), "utf8").replace(/version:\s*"[^"]+"|version="[^"]+"/, (m) => m.replace(/"[^"]+"/, `"${newerVersion}"`)) + "\n// build xp lain\n";
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(code).digest("hex");
    const newFile = `xp-runtime.${sha256.slice(0, 10)}.js`;
    writeFileSync(path.join(out, newFile), code);
    manifest.components[name].web.runtime = { ...rt, file: newFile, sha256, bytes: code.length, version: newerVersion };
    writeFileSync(file, JSON.stringify(manifest, null, 2));
  }
  return serve(out, port, { quiet: true });
}
const a = await remote("promo-modal", 4501);
const b = await remote("promo-slider", 4502);
const c = await remote("promo-slider", 4503, "9.9.9");

// Halaman app di origin ketiga, memakai kode browser adapter apa adanya.
const page = `<!doctype html><meta charset="utf-8"><div id="a"></div><div id="b"></div>
<script type="module">
import { mountComponent, runtimeInfo, runtimeOf } from "/client.js";
// Seperti adapter: info bundle (dari manifest) sudah ada sebelum komponen di-mount.
const manifests = Object.fromEntries(await Promise.all([4501, 4502, 4503].map(async (port) => [port, await (await fetch("http://localhost:" + port + "/manifest.json")).json()])));
async function mount(base, name, el, props) {
  const entry = manifests[base.split(":").pop()].components[name];
  await mountComponent(document.getElementById(el), { src: base + "/" + entry.web.file, sha256: entry.web.sha256, runtime: runtimeOf(base, entry.web) }, props);
}
const modal = () => mount("http://localhost:4501", "promo-modal", "a", { title: "Kelas IELTS", price: 150000, seats: 3 });
const slider = (port) => () => mount("http://localhost:" + port, "promo-slider", "b", {});
const scenario = new URLSearchParams(location.search).get("s");
if (scenario === "sama") await Promise.all([modal(), slider(4502)()]);
if (scenario === "baru-dulu") { await slider(4503)(); await modal(); }
if (scenario === "bersamaan") await Promise.all([modal(), slider(4503)()]);
if (scenario === "lama-dulu") {
  await modal();
  document.querySelector('[data-testid="open"]').click(); // ada state sebelum pindah runtime
  await new Promise((r) => setTimeout(r, 0));
  window.__before = { dialog: document.querySelector('[role="dialog"]'), total: document.querySelector('[data-testid="total"]') };
  await slider(4503)();
  await new Promise((r) => setTimeout(r, 50));
}
window.__runtimes = runtimeInfo();
document.body.dataset.ready = "true";
</script>`;
const app = createServer((req, res) => {
  if (req.url === "/client.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" }).end(readFileSync("adapters/next/client.js"));
  } else res.writeHead(200, { "Content-Type": "text/html" }).end(page);
}).listen(4500);

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium" });
try {
  const scenarios = {
    sama: "versi xp sama",
    "baru-dulu": "versi xp beda, yang baru dimuat duluan",
    bersamaan: "versi xp beda, dimuat bersamaan",
    "lama-dulu": "versi xp beda, yang lama dimuat duluan",
  };
  for (const [s, label] of Object.entries(scenarios)) {
    const p = await browser.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(`http://localhost:4500/?s=${s}`);
    await p.waitForSelector('body[data-ready="true"]');
    const { loaded, active } = await p.evaluate(() => window.__runtimes);
    const fetched = await p.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.includes("xp-runtime")).length);
    assert.equal(active.length, 1, `${label}: runtime aktif ${active.map((r) => r.version).join(", ")}`);
    if (s !== "sama") assert.equal(active[0].version, "9.9.9");
    if (s !== "lama-dulu") assert.equal(fetched, 1, `${label}: runtime diunduh ${fetched}x`);

    if (s === "lama-dulu") {
      // Modal sudah terbuka sebelum komponen pindah ke runtime baru: state ikut pindah.
      assert.equal(await p.locator('[role="dialog"]').isVisible(), true, "modal tetap terbuka setelah pindah runtime");
      assert.ok(
        await p.evaluate(() => window.__before.dialog === document.querySelector('[role="dialog"]') && window.__before.total === document.querySelector('[data-testid="total"]')),
        "elemen DOM yang sama dipakai setelah pindah runtime",
      );
    } else {
      await p.getByTestId("open").click();
    }
    await p.getByTestId("plus").click();
    assert.equal(await p.getByTestId("total").textContent(), "Total: Rp300.000");
    await p.getByTestId("close").click();
    await p.getByTestId("next").click();
    assert.equal(await p.getByTestId("slide-title").textContent(), "TOEFL Prep");
    assert.deepEqual(errors, []);
    console.log(`✓ ${label}: ${fetched} runtime diunduh, 1 aktif (${active[0].version}), kedua komponen interaktif${s === "lama-dulu" ? ", elemen DOM & state tetap saat pindah runtime" : ""}`);
    await p.close();
  }
} finally {
  await browser.close();
  a.close();
  b.close();
  c.close();
  app.close();
}
