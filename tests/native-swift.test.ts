// Komponen yang dikompilasi ke Swift (file .swift dari xp build, dipakai app iOS) harus
// berperilaku sama dengan bundle JS-nya: skenario yang sama dengan tes Kotlin dijalankan di
// keduanya, tree UI-nya dibandingkan setelah setiap langkah. Runtime Swift (XPKit/Compiled) dan
// XPTree dikompilasi apa adanya, jadi tes ini juga jalan di Linux. Butuh swiftc (env SWIFTC atau
// `swiftc` di PATH); kalau tidak ada, tes ini dilewati.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { compileSwift } from "../cli/native-swift.mjs";
import { COMPONENTS, runJs, SCRIPTS, type Script } from "./native/scenarios";

const ROOT = path.resolve(import.meta.dirname, "..");
const KIT = path.join(ROOT, "adapters/ios/Sources/XPKit");

function findSwiftc(): string | null {
  if (process.env.SWIFTC && existsSync(process.env.SWIFTC)) return process.env.SWIFTC;
  const r = spawnSync("sh", ["-c", "command -v swiftc"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

const swiftc = findSwiftc();
const work = mkdtempSync(path.join(tmpdir(), "xp-native-swift-"));
let harness = "";
let dist = "";

function swift(args: string[]) {
  const out = spawnSync(swiftc!, args, { encoding: "utf8", cwd: work });
  if (out.status !== 0) throw new Error(`swiftc gagal:\n${out.stderr}`);
  return out.stderr;
}

before(async () => {
  if (!swiftc) return;
  dist = path.join(work, "dist");
  for (const dir of new Set(Object.values(COMPONENTS))) {
    const only = Object.keys(COMPONENTS).filter((n) => COMPONENTS[n] === dir).join(",");
    // Tes ini untuk jalur dinamis; mode typed punya tesnya sendiri (native-typed-swift.test.ts).
    execFileSync(process.execPath, ["cli/xp.mjs", "build", dir, "--only", only, "--out", dist, "--yes"], {
      cwd: ROOT,
      stdio: "pipe",
      env: { ...process.env, XP_NATIVE_MODE: "dynamic" },
    });
  }
  // File .swift yang sama dengan yang diambil build phase iOS.
  const manifest = JSON.parse(readFileSync(path.join(dist, "manifest.json"), "utf8"));
  const gen = path.join(work, "gen");
  mkdirSync(gen);
  const entries: string[] = [];
  for (const name of Object.keys(COMPONENTS)) {
    const sw = manifest.components[name].swift;
    assert.ok(sw, `${name} tidak punya versi Swift`);
    writeFileSync(path.join(gen, sw.file), readFileSync(path.join(dist, sw.file)));
    entries.push(`    ${JSON.stringify(name)}: ${sw.type}(),`);
  }
  writeFileSync(path.join(gen, "Registry.swift"), `import XPKit\n\nlet generatedComponents: [String: XPCompiledComponent] = [\n${entries.join("\n")}\n]\n`);

  const lib = path.join(work, "lib");
  mkdirSync(lib);
  const kit = [
    ...["JsValue", "JsBuiltins", "XPComponentRuntime"].map((f) => path.join(KIT, "Compiled", `${f}.swift`)),
    ...["XPTyped", "XPStd", "XPClassName"].map((f) => path.join(KIT, "Typed", `${f}.swift`)),
    path.join(KIT, "XPTree.swift"),
    path.join(KIT, "XPJSON.swift"),
  ];
  swift(["-parse-as-library", "-emit-library", "-emit-module", "-module-name", "XPKit", ...kit, "-o", path.join(lib, "libXPKit.so"), "-emit-module-path", path.join(lib, "XPKit.swiftmodule")]);
  harness = path.join(work, "harness");
  const generated = Object.keys(COMPONENTS).map((n) => path.join(gen, manifest.components[n].swift.file));
  const warnings = swift(["-I", lib, "-L", lib, "-lXPKit", ...generated, path.join(gen, "Registry.swift"), path.join(ROOT, "tests/native/main.swift"), "-o", harness, `-Xlinker`, `-rpath`, `-Xlinker`, lib]);
  // Kode yang dihasilkan tidak boleh memunculkan peringatan di Xcode.
  const fromGenerated = warnings.split("\n").filter((l) => l.includes(gen) && /warning:/.test(l));
  assert.deepEqual(fromGenerated, [], "peringatan di kode Swift yang dihasilkan");
});

function runSwift(script: Script) {
  const file = path.join(work, `${script.component}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(script));
  const out = execFileSync(harness, [file], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

test("fitur yang tidak bisa jalan di native: build Swift gagal dengan lokasi", async () => {
  await assert.rejects(
    compileSwift({ file: path.join(ROOT, "tests/fixtures/native/uses-class.tsx"), name: "uses-class", projectDir: ROOT }),
    /tests\/fixtures\/native\/uses-class\.tsx:3:1 class belum didukung di target native/,
  );
});

for (const script of SCRIPTS) {
  test(`Swift = JS: ${script.component}`, { skip: !swiftc && "swiftc tidak ditemukan" }, () => {
    const js = runJs(dist, script);
    const sw = runSwift(script);
    assert.equal(sw.length, js.length);
    js.forEach((tree: unknown, i: number) => assert.deepEqual(sw[i], tree, `langkah ${i}`));
  });
}
