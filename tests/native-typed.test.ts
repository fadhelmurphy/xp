// Mode typed: komponen yang dikompilasi ke Kotlin bertipe (cli/native-typed.mjs) harus berperilaku
// sama dengan bundle JS-nya. Skenarionya sama dengan tes mode dinamis (tests/native/scenarios.ts).
// Butuh kotlinc (env KOTLINC atau `kotlinc` di PATH); kalau tidak ada, tes ini dilewati.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { compileTypedKotlin, TypedCompileError } from "../cli/native-typed.mjs";
import { COMPONENTS, runJs, SCRIPTS, type Script } from "./native/scenarios";

const ROOT = path.resolve(import.meta.dirname, "..");
const SDK = path.join(ROOT, "adapters/android/xp-android/src/main/kotlin/dev/xp/android");
// Komponen yang (harus) bisa dikompilasi ke mode typed. kitchen-sink sengaja memakai fitur di luar
// mode typed, jadi tetap mode dinamis.
const TYPED = ["promo-modal", "promo-slider", "jadwal-kelas", "promo-chip", "promo-card"];

function findKotlinc(): string | null {
  if (process.env.KOTLINC && existsSync(process.env.KOTLINC)) return process.env.KOTLINC;
  const r = spawnSync("sh", ["-c", "command -v kotlinc"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

const kotlinc = findKotlinc();
const work = mkdtempSync(path.join(tmpdir(), "xp-native-typed-"));
let jar = "";
let stdlib = "";
let dist = "";

before(() => {
  if (!kotlinc) return;
  dist = path.join(work, "dist");
  for (const dir of new Set(TYPED.map((n) => COMPONENTS[n]))) {
    const only = TYPED.filter((n) => COMPONENTS[n] === dir).join(",");
    execFileSync(process.execPath, ["cli/xp.mjs", "build", dir, "--only", only, "--out", dist, "--yes"], { cwd: ROOT, stdio: "pipe" });
  }
  // File .kt yang sama dengan yang diunduh task Gradle xpComponents.
  const manifest = JSON.parse(readFileSync(path.join(dist, "manifest.json"), "utf8"));
  const gen = path.join(work, "gen");
  mkdirSync(gen);
  const entries: string[] = [];
  const files: string[] = [];
  for (const name of TYPED) {
    const kt = manifest.components[name].kotlin;
    assert.ok(kt?.typed, `${name} tidak dikompilasi ke mode typed`);
    files.push(path.join(gen, kt.file));
    writeFileSync(files.at(-1)!, readFileSync(path.join(dist, kt.file)));
    entries.push(`${JSON.stringify(name)} to ${kt.object}`);
  }
  writeFileSync(
    path.join(gen, "XPTypedComponents.kt"),
    `package dev.xp.generated\n\nimport dev.xp.android.typed.XPTypedComponent\nimport dev.xp.android.typed.XPTypedRegistry\n\nobject XPTypedComponents : XPTypedRegistry {\n    override val components: Map<String, XPTypedComponent> = mapOf(${entries.join(", ")})\n}\n`,
  );
  jar = path.join(work, "typed.jar");
  const sources = [
    path.join(SDK, "typed/XPTyped.kt"),
    path.join(SDK, "typed/XPClassName.kt"),
    ...["XPJs.kt", "JsBuiltins.kt", "XPComponentRuntime.kt"].map((f) => path.join(SDK, "compiled", f)),
    path.join(SDK, "XPJson.kt"),
    ...files,
    path.join(gen, "XPTypedComponents.kt"),
    path.join(ROOT, "tests/native/TypedHarness.kt"),
  ];
  const out = spawnSync(kotlinc, [...sources, "-d", jar], { encoding: "utf8" });
  assert.equal(out.status, 0, `kotlinc gagal:\n${out.stderr}`);
  // Kode hasil compiler tidak boleh memunculkan peringatan di Android Studio.
  const warnings = out.stderr.split("\n").filter((l) => l.includes(gen) && /warning:/.test(l));
  assert.deepEqual(warnings, [], "peringatan di kode Kotlin yang dihasilkan");
  stdlib = path.join(path.dirname(path.dirname(kotlinc)), "lib", "kotlin-stdlib.jar");
});

function runTyped(script: Script) {
  const file = path.join(work, `${script.component}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(script));
  const out = execFileSync("java", ["-cp", `${jar}${path.delimiter}${stdlib}`, "TypedHarnessKt", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

test("komponen yang memakai fitur di luar mode typed ditolak dengan lokasi", () => {
  assert.throws(
    () => compileTypedKotlin({ file: path.join(ROOT, "tests/fixtures/native/kitchen-sink.tsx"), name: "kitchen-sink", projectDir: ROOT }),
    (e: unknown) => e instanceof TypedCompileError && /kitchen-sink\.tsx:\d+:\d+ /.test((e as Error).message),
  );
});

for (const script of SCRIPTS.filter((s) => TYPED.includes(s.component))) {
  test(`Kotlin typed = JS: ${script.component}`, { skip: !kotlinc && "kotlinc tidak ditemukan" }, () => {
    const js = runJs(dist, script);
    const kt = runTyped(script);
    assert.equal(kt.length, js.length);
    js.forEach((tree: unknown, i: number) => assert.deepEqual(kt[i], tree, `langkah ${i}`));
  });
}
