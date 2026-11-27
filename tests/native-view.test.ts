// NativeView: komponen memakai view native milik app (didaftarkan lewat nativeViews di XPView).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { before, test } from "node:test";
import { evaluate } from "./load-web";

const out = mkdtempSync(path.join(tmpdir(), "xp-native-view-"));
let entry: any;

before(() => {
  execFileSync(process.execPath, ["cli/xp.mjs", "build", "examples", "--only", "jadwal-kelas", "--out", out, "--yes"], { stdio: "pipe" });
  entry = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")).components["jadwal-kelas"];
});

test("manifest mencatat native view yang harus didaftarkan app", () => {
  assert.deepEqual(entry.nativeViews, ["calendar"]);
  assert.ok(entry.primitives.includes("NativeView"));
});

test("SSR: NativeView jadi tempat pengganti berisi children", () => {
  const html = evaluate(readFileSync(path.join(out, entry.ssr.file), "utf8"), () => ({})).renderHTML({});
  assert.match(html, /<div data-testid="calendar" data-xp-native="calendar" style="[^"]*height:320px[^"]*">/);
  assert.match(html, /Kalender tersedia di aplikasi\./);
});

test("native: props dan onEvent sampai ke host, event dari view native mengubah state", () => {
  const ctx: any = {};
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(out, entry.native.file), "utf8"), ctx);
  const types = new Map<number, string>();
  const props = new Map<number, any>();
  const texts = new Map<number, string>();
  const apply = (json: string) => {
    for (const b of JSON.parse(json))
      for (const op of b.ops) {
        if (op[0] === "create") types.set(op[1], op[2]);
        if (op[0] === "props") {
          props.set(op[1], { ...props.get(op[1]), ...op[2] });
          if (types.get(op[1]) === "#text") texts.set(op[1], op[2].value);
        }
      }
  };
  apply(ctx.XP.mount("{}"));
  const [id] = [...types].find(([, t]) => t === "NativeView")!;
  const native = props.get(id);
  assert.equal(native.name, "calendar");
  assert.equal(typeof native.props.minDate, "number");
  assert.equal(native.style.height, 320);
  assert.ok(native.onEvent.$fn, "onEvent dikirim sebagai handler");
  assert.ok([...texts.values()].includes("Belum memilih tanggal"));

  // Seperti `emit("select", "2026-12-01")` di Kotlin/Swift.
  apply(ctx.XP.dispatch(native.onEvent.$fn, JSON.stringify(["select", "2026-12-01"])));
  assert.ok([...texts.values()].includes("Jadwal: 2026-12-01"));
});
