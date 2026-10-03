// Mode antrean: persis seperti SDK Android/iOS memakai QuickJS.
// SDK hanya memanggil evaluate(script) → string. Tidak ada bridge, tidak ada microtask.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { getQuickJS } from "quickjs-emscripten";
import type { Batch } from "../runtime/protocol";
import { NativeTree } from "../sdk-reference/tree";

const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
const code = readFileSync(`dist/${manifest.components["promo-modal"].native.file}`, "utf8");

test("SDK cukup evaluate(): semua interaksi sinkron, tanpa executePendingJobs", async () => {
  const vm = (await getQuickJS()).newContext();
  const tree = new NativeTree();
  const session: { call: string; batches: Batch[] }[] = [];

  // Sama dengan XPEngine.kt: evaluate → string JSON → terapkan ke tree.
  const evaluate = (script: string) => {
    const r = vm.evalCode(script);
    if (r.error) {
      const e = vm.dump(r.error);
      r.error.dispose();
      throw new Error(JSON.stringify(e));
    }
    const out = vm.dump(r.value);
    r.value.dispose();
    return out;
  };
  const call = (script: string) => {
    const batches: Batch[] = JSON.parse(evaluate(script));
    batches.forEach((b) => tree.apply(b));
    session.push({ call: script, batches });
  };
  const press = (testID: string) => {
    const key = tree.handler(tree.byTestID(testID)!, "onPress")!;
    call(`XP.dispatch(${JSON.stringify(key)}, "[]")`);
  };
  const text = (id: string) => tree.text(tree.byTestID(id)!);
  const modal = () => [...tree.walk()].find((n) => n.type === "Modal")!;

  evaluate(code);
  call(`XP.mount(${JSON.stringify(JSON.stringify({ title: "Kelas IELTS", price: 150000, seats: 3 }))})`);
  assert.equal(text("title"), "Kelas IELTS");
  assert.equal(modal().props.visible, false);

  press("open");
  assert.equal(modal().props.visible, true, "update langsung tersedia di hasil dispatch");
  press("plus");
  press("plus");
  assert.equal(text("total"), "Total: Rp450.000");
  assert.equal(text("full"), "Kuota penuh");
  press("close");
  assert.equal(modal().props.visible, false);
  assert.deepEqual(tree.orphans(), []);

  // Tidak boleh ada pekerjaan tertunda yang tertinggal (semua sudah di-flush).
  call(`XP.dispatch("0:none", "[]")`);
  assert.deepEqual(session.at(-1)!.batches, []);
  vm.dispose();

  // Rekaman sesi ini = fixture untuk unit test SDK Android/iOS (menerapkan ops yang sama).
  mkdirSync("fixtures", { recursive: true });
  writeFileSync("fixtures/promo-modal.session.json", JSON.stringify(session, null, 2) + "\n");
});
