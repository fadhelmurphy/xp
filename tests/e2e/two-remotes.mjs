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
import { loadBundle, loadedRuntimes, runtimeOf } from "/client.js";
async function mount(base, name, el, props) {
  const entry = (await (await fetch(base + "/manifest.json")).json()).components[name];
  const mod = await loadBundle(base + "/" + entry.web.file, entry.web.sha256, runtimeOf(base, entry.web));
  mod.render(document.getElementById(el), props);
}
const second = new URLSearchParams(location.search).get("second") ?? "4502";
if (second === "4503") {
  // Remote dengan xp lebih baru dimuat duluan, lalu komponen dari xp yang lebih lama.
  await mount("http://localhost:4503", "promo-slider", "b", {});
  await mount("http://localhost:4501", "promo-modal", "a", { title: "Kelas IELTS", price: 150000, seats: 3 });
} else {
  await Promise.all([
    mount("http://localhost:4501", "promo-modal", "a", { title: "Kelas IELTS", price: 150000, seats: 3 }),
    mount("http://localhost:" + second, "promo-slider", "b", {}),
  ]);
}
window.__runtimes = loadedRuntimes();
document.body.dataset.ready = "true";
</script>`;
const app = createServer((req, res) => {
  if (req.url === "/client.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" }).end(readFileSync("adapters/next/client.js"));
  } else res.writeHead(200, { "Content-Type": "text/html" }).end(page);
}).listen(4500);

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium" });
try {
  for (const second of ["4502", "4503"]) {
  const p = await browser.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`http://localhost:4500/?second=${second}`);
  await p.waitForSelector('body[data-ready="true"]');
  const runtimes = await p.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes("xp-runtime")));
  assert.equal(runtimes.length, 1, `runtime dimuat ${runtimes.length}x: ${runtimes.join(", ")}`);

  await p.getByTestId("open").click();
  await p.getByTestId("plus").click();
  assert.equal(await p.getByTestId("total").textContent(), "Total: Rp300.000");
  await p.getByTestId("close").click();
  await p.getByTestId("next").click();
  assert.equal(await p.getByTestId("slide-title").textContent(), "TOEFL Prep");
  assert.deepEqual(errors, []);
  const used = await p.evaluate(() => window.__runtimes);
  console.log(
    second === "4502"
      ? `✓ dua remote, versi xp sama: satu runtime (${runtimes[0].replace(/^https?:\/\/[^/]+\//, "")}), kedua komponen interaktif`
      : `✓ dua remote, versi xp beda: runtime ${used.map((r) => r.version).join(", ")} dipakai kedua komponen, keduanya interaktif`,
  );
  if (second === "4503") assert.deepEqual(used.map((r) => r.version), ["9.9.9"]);
  await p.close();
  }
} finally {
  await browser.close();
  a.close();
  b.close();
  c.close();
  app.close();
}
