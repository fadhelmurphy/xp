// Dua remote (dua tim, dua CDN) di satu halaman: runtime xp yang identik hanya dimuat sekali.
//   node tests/e2e/two-remotes.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { discover, plan, runBuild } from "../../cli/build.mjs";
import { serve } from "../../cli/serve.mjs";

const all = await discover("examples");
async function remote(name, port) {
  const out = mkdtempSync(path.join(tmpdir(), `xp-${name}-`));
  await runBuild({ srcDir: "examples", outDir: out, jobs: plan(all.filter((c) => c.name === name), "web").jobs });
  return serve(out, port, { quiet: true });
}
const a = await remote("promo-modal", 4501);
const b = await remote("promo-slider", 4502);

// Halaman app di origin ketiga, memakai kode browser adapter apa adanya.
const page = `<!doctype html><meta charset="utf-8"><div id="a"></div><div id="b"></div>
<script type="module">
import { loadBundle, runtimeOf } from "/client.js";
async function mount(base, name, el, props) {
  const entry = (await (await fetch(base + "/manifest.json")).json()).components[name];
  const mod = await loadBundle(base + "/" + entry.web.file, entry.web.sha256, runtimeOf(base, entry.web));
  mod.render(document.getElementById(el), props);
}
await Promise.all([
  mount("http://localhost:4501", "promo-modal", "a", { title: "Kelas IELTS", price: 150000, seats: 3 }),
  mount("http://localhost:4502", "promo-slider", "b", {}),
]);
document.body.dataset.ready = "true";
</script>`;
const app = createServer((req, res) => {
  if (req.url === "/client.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" }).end(readFileSync("adapters/next/client.js"));
  } else res.writeHead(200, { "Content-Type": "text/html" }).end(page);
}).listen(4500);

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium" });
try {
  const p = await browser.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto("http://localhost:4500");
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
  console.log(`✓ dua remote, satu runtime (${runtimes[0].replace(/^https?:\/\/[^/]+\//, "")}), kedua komponen interaktif`);
} finally {
  await browser.close();
  a.close();
  b.close();
  app.close();
}
