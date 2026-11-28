// Mode typed iOS: komponen yang dikompilasi ke Swift bertipe (cli/native-typed-swift.mjs) harus
// berperilaku sama dengan bundle JS-nya. Skenarionya sama dengan tes lain (tests/native/scenarios.ts).
// Runtime typed (XPKit/Typed) hanya memakai Foundation, jadi tes ini juga jalan di Linux.
// Butuh swiftc (env SWIFTC atau `swiftc` di PATH); kalau tidak ada, tes ini dilewati.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { compileTypedSwift } from "../cli/native-typed-swift.mjs";
import { TypedCompileError } from "../cli/native-typed.mjs";
import { COMPONENTS, runJs, SCRIPTS, type Script } from "./native/scenarios";

const ROOT = path.resolve(import.meta.dirname, "..");
const KIT = path.join(ROOT, "adapters/ios/Sources/XPKit");
const TYPED = ["promo-modal", "promo-slider", "jadwal-kelas", "promo-chip", "promo-card"];

function findSwiftc(): string | null {
  if (process.env.SWIFTC && existsSync(process.env.SWIFTC)) return process.env.SWIFTC;
  const r = spawnSync("sh", ["-c", "command -v swiftc"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

const swiftc = findSwiftc();
const work = mkdtempSync(path.join(tmpdir(), "xp-native-typed-swift-"));
let harness = "";
let dist = "";

function swift(args: string[]) {
  const out = spawnSync(swiftc!, args, { encoding: "utf8", cwd: work });
  if (out.status !== 0) throw new Error(`swiftc gagal:\n${out.stderr}`);
  return out.stderr;
}

before(() => {
  if (!swiftc) return;
  dist = path.join(work, "dist");
  for (const dir of new Set(TYPED.map((n) => COMPONENTS[n]))) {
    const only = TYPED.filter((n) => COMPONENTS[n] === dir).join(",");
    execFileSync(process.execPath, ["cli/xp.mjs", "build", dir, "--only", only, "--out", dist, "--yes"], { cwd: ROOT, stdio: "pipe" });
  }
  // File .swift yang sama dengan yang diambil build phase iOS.
  const manifest = JSON.parse(readFileSync(path.join(dist, "manifest.json"), "utf8"));
  const gen = path.join(work, "gen");
  mkdirSync(gen);
  const entries: string[] = [];
  const files: string[] = [];
  for (const name of TYPED) {
    const sw = manifest.components[name].swift;
    assert.ok(sw?.typed, `${name} tidak dikompilasi ke mode typed`);
    files.push(path.join(gen, sw.file));
    writeFileSync(files.at(-1)!, readFileSync(path.join(dist, sw.file)));
    entries.push(`    ${JSON.stringify(name)}: ${sw.type}(),`);
  }
  writeFileSync(path.join(gen, "Registry.swift"), `import XPKit\n\nlet typedComponents: [String: XPTypedComponent] = [\n${entries.join("\n")}\n]\n`);

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
  const warnings = swift(["-I", lib, "-L", lib, "-lXPKit", ...files, path.join(gen, "Registry.swift"), path.join(ROOT, "tests/native/typed/main.swift"), "-o", harness, "-Xlinker", "-rpath", "-Xlinker", lib]);
  // Kode yang dihasilkan tidak boleh memunculkan peringatan di Xcode, juga di mode Swift 6.
  const fromGenerated = warnings.split("\n").filter((l) => l.includes(gen) && /warning:/.test(l));
  assert.deepEqual(fromGenerated, [], "peringatan di kode Swift yang dihasilkan");
  const strict = swift(["-typecheck", "-swift-version", "6", "-I", lib, ...files]);
  assert.deepEqual(strict.split("\n").filter((l) => /error:|warning:/.test(l)), [], "kode Swift yang dihasilkan bermasalah di mode Swift 6");
});

function runSwift(script: Script) {
  const file = path.join(work, `${script.component}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(script));
  const out = execFileSync(harness, [file], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

test("komponen yang memakai fitur di luar mode typed Swift ditolak dengan lokasi", () => {
  assert.throws(
    () => compileTypedSwift({ file: path.join(ROOT, "tests/fixtures/native/kitchen-sink.tsx"), name: "kitchen-sink", projectDir: ROOT }),
    (e: unknown) => e instanceof TypedCompileError && /kitchen-sink\.tsx:\d+:\d+ /.test((e as Error).message),
  );
});

for (const script of SCRIPTS.filter((s) => TYPED.includes(s.component))) {
  test(`Swift typed = JS: ${script.component}`, { skip: !swiftc && "swiftc tidak ditemukan" }, () => {
    const js = runJs(dist, script);
    const sw = runSwift(script);
    assert.equal(sw.length, js.length);
    js.forEach((tree: unknown, i: number) => assert.deepEqual(sw[i], tree, `langkah ${i}`));
  });
}
