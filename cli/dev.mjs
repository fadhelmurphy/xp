// xp dev: build, sajikan, dan build ulang setiap file komponen berubah.
// Setiap build dikabarkan lewat /__xp/events, jadi pratinjau browser dan app iOS/Android
// (XPView dengan live = true) memuat versi baru tanpa restart. State useState dipertahankan.
import { watch } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { discover, plan, runBuild } from "./build.mjs";
import { serve } from "./serve.mjs";

const COMPONENT_FILE = /\.(tsx|jsx|vue|svelte)$/;

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
}

export async function dev({ srcDir, outDir, port, target = "auto", signingKey = null, log = console.log }) {
  const all = async () => plan(await discover(srcDir), target);

  async function build(names) {
    const { jobs, skipped } = await all();
    const selected = names ? jobs.filter((j) => names.includes(j.name)) : jobs;
    if (!selected.length) return null;
    const started = Date.now();
    const { results } = await runBuild({ srcDir, outDir, jobs: selected, signingKey });
    for (const r of results) {
      log(r.ok ? `✓ ${r.name}` : `✗ ${r.name}\n    ${r.error}`);
      if (r.ok) for (const w of r.warnings) log(`  ⚠ ${w}`);
    }
    if (!names) for (const s of skipped) log(`- ${s.name} dilewati: ${s.reason}`);
    log(`  ${Date.now() - started} ms`);
    return results;
  }

  await build(null);
  const server = serve(outDir, port, { dev: true, quiet: true });
  log(`\nxp dev → http://localhost:${port}`);
  for (const ip of lanAddresses()) log(`         http://${ip}:${port}  (HP di jaringan yang sama)`);
  log(`         http://10.0.2.2:${port}  (emulator Android)\n`);

  // Kumpulkan perubahan beruntun (editor sering menulis file 2-3 kali) lalu build sekali.
  let pending = new Set();
  let timer = null;
  let running = Promise.resolve();
  const flush = () => {
    const changed = [...pending];
    pending = new Set();
    running = running.then(async () => {
      // File komponen di src/ → komponen itu saja. File lain (helper di subfolder) → semua.
      const direct = changed.every((f) => !f.includes(path.sep) && COMPONENT_FILE.test(f));
      const names = direct ? changed.map((f) => f.replace(COMPONENT_FILE, "")) : null;
      log(`\n↻ ${changed.join(", ")}`);
      try {
        const results = await build(names);
        if (!results) return;
        const ok = results.filter((r) => r.ok).map((r) => r.name);
        const failed = results.filter((r) => !r.ok);
        if (ok.length) server.broadcast({ type: "update", components: ok, builtAt: new Date().toISOString() });
        for (const f of failed) server.broadcast({ type: "error", component: f.name, message: f.error });
      } catch (e) {
        log(`✗ ${e.message}`);
        server.broadcast({ type: "error", message: e.message });
      }
    });
  };
  const watcher = watch(srcDir, { recursive: true }, (_event, file) => {
    if (!file || file.split(path.sep).some((p) => p.startsWith(".") || p === "node_modules")) return;
    pending.add(file);
    clearTimeout(timer);
    timer = setTimeout(flush, 120);
  });

  return {
    server,
    /** Untuk tes: tunggu build yang sedang berjalan selesai. */
    idle: () => new Promise((r) => setTimeout(() => running.then(r), 200)),
    close() {
      watcher.close();
      clearTimeout(timer);
      server.close();
    },
  };
}
