// Komponen yang dikompilasi ke Kotlin (file .kt dari xp build, dipakai app Android) harus
// berperilaku sama dengan bundle JS-nya: skenario event yang sama (tests/native/scenarios.ts)
// dijalankan di keduanya, tree UI-nya dibandingkan setelah setiap langkah. Butuh kotlinc
// (env KOTLINC atau `kotlinc` di PATH); kalau tidak ada, tes ini dilewati.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { compileKotlin, registryKotlin } from "../cli/native-kotlin.mjs";
import { COMPONENTS, runJs, SCRIPTS, type Script } from "./native/scenarios";

const ROOT = path.resolve(import.meta.dirname, "..");
const SDK = path.join(ROOT, "adapters/android/xp-android/src/main/kotlin/dev/xp/android");

function findKotlinc(): string | null {
  if (process.env.KOTLINC && existsSync(process.env.KOTLINC)) return process.env.KOTLINC;
  const r = spawnSync("sh", ["-c", "command -v kotlinc"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

const kotlinc = findKotlinc();
const work = mkdtempSync(path.join(tmpdir(), "xp-native-kt-"));
let jar = "";
let stdlib = "";
let dist = "";

before(async () => {
  if (!kotlinc) return;
  dist = path.join(work, "dist");
  for (const dir of new Set(Object.values(COMPONENTS))) {
    const only = Object.keys(COMPONENTS).filter((n) => COMPONENTS[n] === dir).join(",");
    execFileSync(process.execPath, ["cli/xp.mjs", "build", dir, "--only", only, "--out", dist, "--yes"], {
      cwd: ROOT,
      stdio: "pipe",
      env: { ...process.env, XP_NATIVE_MODE: "dynamic" },
    });
  }
  // File .kt yang sama dengan yang diunduh task Gradle xpComponents.
  const manifest = JSON.parse(readFileSync(path.join(dist, "manifest.json"), "utf8"));
  const gen = path.join(work, "gen");
  mkdirSync(gen);
  const entries = [];
  for (const name of Object.keys(COMPONENTS)) {
    const kt = manifest.components[name].kotlin;
    assert.ok(kt, `${name} tidak punya versi Kotlin`);
    writeFileSync(path.join(gen, kt.file), readFileSync(path.join(dist, kt.file)));
    entries.push({ name, objectName: kt.object, file: kt.file });
  }
  writeFileSync(path.join(gen, "XPComponents.kt"), registryKotlin(entries));
  jar = path.join(work, "native.jar");
  const sources = [
    ...["compiled/XPJs.kt", "compiled/JsBuiltins.kt", "compiled/XPComponentRuntime.kt", "XPJson.kt", "XPTree.kt"].map((f) => path.join(SDK, f)),
    ...entries.map((e) => path.join(gen, e.file)),
    path.join(gen, "XPComponents.kt"),
    path.join(ROOT, "tests/native/Harness.kt"),
  ];
  const out = spawnSync(kotlinc, [...sources, "-nowarn", "-d", jar], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`kotlinc gagal:\n${out.stderr}`);
  stdlib = path.join(path.dirname(path.dirname(kotlinc)), "lib", "kotlin-stdlib.jar");
});

function runKotlin(script: Script) {
  const file = path.join(work, `${script.component}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(script));
  const out = execFileSync("java", ["-cp", `${jar}${path.delimiter}${stdlib}`, "HarnessKt", file], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

test("fitur yang tidak bisa jalan di native: build gagal dengan lokasi", async () => {
  await assert.rejects(
    compileKotlin({ file: path.join(ROOT, "tests/fixtures/native/uses-class.tsx"), name: "uses-class", projectDir: ROOT }),
    /tests\/fixtures\/native\/uses-class\.tsx:3:1 class belum didukung di target native/,
  );
});

for (const script of SCRIPTS) {
  test(`Kotlin = JS: ${script.component}`, { skip: !kotlinc && "kotlinc tidak ditemukan" }, () => {
    const js = runJs(dist, script);
    const kt = runKotlin(script);
    assert.equal(kt.length, js.length);
    js.forEach((tree: unknown, i: number) => assert.deepEqual(kt[i], tree, `langkah ${i}`));
  });
}
