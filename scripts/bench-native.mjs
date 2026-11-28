// Bandingkan kecepatan mode dinamis dan mode typed (Kotlin, di JVM).
//
//     KOTLINC=/path/ke/kotlinc node scripts/bench-native.mjs [komponen]
//
// Angkanya dari JVM desktop, bukan dari HP; yang penting perbandingannya.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SDK = path.join(ROOT, "adapters/android/xp-android/src/main/kotlin/dev/xp/android");
const name = process.argv[2] ?? "promo-slider";
const kotlinc = process.env.KOTLINC ?? "kotlinc";
const work = mkdtempSync(path.join(tmpdir(), "xp-bench-"));

function build(mode) {
  const out = path.join(work, mode);
  execFileSync(process.execPath, ["cli/xp.mjs", "build", "examples", "--only", name, "--out", out, "--yes"], {
    cwd: ROOT,
    stdio: "pipe",
    env: { ...process.env, XP_NATIVE_MODE: mode },
  });
  const kt = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")).components[name].kotlin;
  return { file: path.join(out, kt.file), object: kt.object, typed: !!kt.typed };
}

const dyn = build("dynamic");
const typed = build("typed");
if (!typed.typed) throw new Error(`${name} tidak bisa dikompilasi ke mode typed`);
const gen = path.join(work, "gen");
mkdirSync(gen);
writeFileSync(
  path.join(gen, "Registry.kt"),
  `package dev.xp.generated

import dev.xp.android.compiled.XPCompiledComponent
import dev.xp.android.compiled.XPComponentRegistry
import dev.xp.android.typed.XPTypedComponent
import dev.xp.android.typed.XPTypedRegistry

object XPComponents : XPComponentRegistry {
    override val components: Map<String, XPCompiledComponent> = mapOf(${JSON.stringify(name)} to ${dyn.object})
}

object XPTypedComponents : XPTypedRegistry {
    override val components: Map<String, XPTypedComponent> = mapOf(${JSON.stringify(name)} to ${typed.object})
}
`,
);
const jar = path.join(work, "bench.jar");
const sources = [
  ...["compiled/XPJs.kt", "compiled/JsBuiltins.kt", "compiled/XPComponentRuntime.kt", "typed/XPTyped.kt", "typed/XPClassName.kt", "XPJson.kt", "XPTree.kt"].map((f) => path.join(SDK, f)),
  dyn.file,
  typed.file,
  path.join(gen, "Registry.kt"),
  path.join(ROOT, "scripts/bench/Bench.kt"),
];
console.log(`kompilasi ${name} (dinamis + typed)...`);
const c = spawnSync(kotlinc, [...sources, "-nowarn", "-d", jar], { encoding: "utf8" });
if (c.status !== 0) throw new Error(`kotlinc gagal:\n${c.stderr}`);
const stdlib = path.join(path.dirname(path.dirname(spawnSync("sh", ["-c", `command -v ${kotlinc}`], { encoding: "utf8" }).stdout.trim() || kotlinc)), "lib", "kotlin-stdlib.jar");
execFileSync("java", ["-cp", `${jar}${path.delimiter}${stdlib}`, "BenchKt", name], { stdio: "inherit" });
