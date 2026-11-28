// Komponen yang dikompilasi ke Kotlin (file .kt dari xp build, dipakai app Android) harus
// berperilaku sama dengan bundle JS-nya: skenario event yang sama dijalankan di keduanya, tree UI-nya dibandingkan
// setelah setiap langkah. Butuh kotlinc (env KOTLINC atau `kotlinc` di PATH); kalau tidak ada,
// tes ini dilewati.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { before, test } from "node:test";
import { compileKotlin, registryKotlin } from "../cli/native-kotlin.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SDK = path.join(ROOT, "adapters/android/xp-android/src/main/kotlin/dev/xp/android");
const COMPONENTS: Record<string, string> = {
  "promo-modal": "examples",
  "promo-slider": "examples",
  "jadwal-kelas": "examples",
  "kitchen-sink": "tests/fixtures/native",
  "promo-chip": "tests/fixtures/styling",
  "promo-card": "tests/fixtures/styling",
};

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
    execFileSync(process.execPath, ["cli/xp.mjs", "build", dir, "--only", only, "--out", dist, "--yes"], { cwd: ROOT, stdio: "pipe" });
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

type Step = { event?: [string, string, unknown[]]; advance?: number; props?: Record<string, unknown>; env?: Record<string, unknown>; unmount?: true };
type Script = { component: string; props: Record<string, unknown>; env?: Record<string, unknown>; steps: Step[] };

function snapshot(nodes: Map<number, any>, id: number): unknown {
  const n = nodes.get(id);
  if (n.type === "#text") return n.props.value;
  const props: Record<string, unknown> = {};
  for (const k of Object.keys(n.props).sort()) {
    const v = n.props[k];
    props[k] = v && typeof v === "object" && "$fn" in v ? "fn" : v;
  }
  return { type: n.type, props, children: n.children.map((c: number) => snapshot(nodes, c)) };
}

/** Skenario di bundle JS (QuickJS di device; di sini node:vm). */
function runJs(script: Script) {
  const manifest = JSON.parse(readFileSync(path.join(dist, "manifest.json"), "utf8"));
  let now = 1_000_000;
  const ctx: any = { Date: { now: () => now } };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(dist, manifest.components[script.component].native.file), "utf8"), ctx);
  const nodes = new Map<number, any>([[0, { type: "#root", props: {}, children: [] }]]);
  const apply = (json: string) => {
    for (const b of JSON.parse(json))
      for (const op of b.ops) {
        if (op[0] === "create") nodes.set(op[1], { type: op[2], props: {}, children: [] });
        if (op[0] === "props") for (const [k, v] of Object.entries(op[2])) v === null ? delete nodes.get(op[1]).props[k] : (nodes.get(op[1]).props[k] = v);
        if (op[0] === "children") nodes.get(op[1]).children = op[2];
        if (op[0] === "delete") nodes.delete(op[1]);
      }
  };
  const tree = () => nodes.get(0).children.map((c: number) => snapshot(nodes, c));
  const byTestID = (id: string) => [...nodes.values()].find((n) => n.props.testID === id);
  if (script.env) apply(ctx.XP.environment(JSON.stringify(script.env)));
  apply(ctx.XP.mount(JSON.stringify(script.props)));
  const out = [tree()];
  for (const s of script.steps) {
    if (s.event) {
      const [testID, prop, args] = s.event;
      apply(ctx.XP.dispatch(byTestID(testID).props[prop].$fn, JSON.stringify(args)));
    } else if (s.advance) {
      now += s.advance;
      apply(ctx.XP.tick());
    } else if (s.props) apply(ctx.XP.update(JSON.stringify(s.props)));
    else if (s.env) apply(ctx.XP.environment(JSON.stringify(s.env)));
    else if (s.unmount) apply(ctx.XP.unmount());
    out.push(tree());
  }
  return JSON.parse(JSON.stringify(out));
}

function runKotlin(script: Script) {
  const file = path.join(work, `${script.component}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(script));
  const out = execFileSync("java", ["-cp", `${jar}${path.delimiter}${stdlib}`, "HarnessKt", file], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

const SCRIPTS: Script[] = [
  {
    component: "promo-modal",
    props: { title: "Kelas IELTS", price: 150000, seats: 3 },
    steps: [
      { event: ["open", "onPress", []] },
      { event: ["plus", "onPress", []] },
      { event: ["plus", "onPress", []] },
      { event: ["plus", "onPress", []] },
      { event: ["minus", "onPress", []] },
      { props: { title: "Kelas TOEFL", price: 99500.5, seats: 2 } },
      { event: ["close", "onPress", []] },
      { unmount: true },
    ],
  },
  {
    component: "promo-slider",
    props: { autoplay: 3000 },
    steps: [
      { event: ["next", "onPress", []] },
      { event: ["next", "onPress", []] },
      { event: ["next", "onPress", []] },
      { event: ["prev", "onPress", []] },
      { event: ["dot-0", "onPress", []] },
      { event: ["slide", "onSwipe", ["left"]] },
      { event: ["slide", "onSwipe", ["right"]] },
      { advance: 1000 },
      { advance: 2000 },
      { advance: 3000 },
      { props: { autoplay: 0, slides: [{ title: "A", subtitle: "a", color: "#000000" }, { title: "B", subtitle: "b", color: "#FFFFFF" }] } },
      { event: ["next", "onPress", []] },
      { advance: 5000 },
    ],
  },
  {
    component: "jadwal-kelas",
    props: { title: "Jadwal" },
    steps: [
      { event: ["calendar", "onEvent", ["select", "2026-12-01"]] },
      { event: ["reset", "onPress", []] },
      { event: ["calendar", "onEvent", ["other", null]] },
    ],
  },
  {
    component: "kitchen-sink",
    props: {},
    steps: [
      { event: ["inc", "onPress", []] },
      { event: ["inc", "onPress", []] },
      { event: ["dec", "onPress", []] },
      { advance: 1000 },
      { advance: 500 },
      { advance: 500 },
      { props: { start: 9, label: "Label" } },
      { event: ["dec", "onPress", []] },
      { unmount: true },
      { advance: 5000 },
    ],
  },
  {
    component: "promo-chip",
    props: { label: "Diskon" },
    env: { width: 400, height: 800, dark: false },
    steps: [
      { event: ["chip", "onPress", []] },
      { env: { width: 800, height: 800, dark: false } },
      { env: { width: 1200, height: 800, dark: true } },
      { event: ["chip", "onPress", []] },
      { props: { label: "Gratis" } },
      { env: { width: 320, height: 640, dark: false } },
    ],
  },
  {
    component: "promo-card",
    props: {},
    env: { width: 400, height: 800, dark: false },
    steps: [{ env: { width: 900, height: 700, dark: false } }, { env: { width: 900, height: 500, dark: true } }],
  },
];

test("fitur yang tidak bisa jalan di native: build gagal dengan lokasi", async () => {
  await assert.rejects(
    compileKotlin({ file: path.join(ROOT, "tests/fixtures/native/uses-class.tsx"), name: "uses-class", projectDir: ROOT }),
    /tests\/fixtures\/native\/uses-class\.tsx:3:1 class belum didukung di target native/,
  );
});

for (const script of SCRIPTS) {
  test(`Kotlin = JS: ${script.component}`, { skip: !kotlinc && "kotlinc tidak ditemukan" }, () => {
    const js = runJs(script);
    const kt = runKotlin(script);
    assert.equal(kt.length, js.length);
    js.forEach((tree: unknown, i: number) => assert.deepEqual(kt[i], tree, `langkah ${i}`));
  });
}
