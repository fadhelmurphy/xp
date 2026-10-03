// Menjalankan bundle native hasil `xp build` di QuickJS: engine yang sama dengan SDK iOS/Android.
// Tidak ada DOM, React, maupun WebView di sini: hanya JS engine + tree operasi.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { getQuickJS, type QuickJSContext } from "quickjs-emscripten";
import type { Batch } from "../runtime/protocol";
import { NativeTree } from "../sdk-reference/tree";

const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
const entry = manifest.components["promo-modal"];
const code = readFileSync(`dist/${entry.native.file}`, "utf8");

let vm: QuickJSContext;
let tree: NativeTree;
let batches: Batch[];

/** Seperti SDK: jalankan microtask (setState di-flush lewat Promise) sampai habis. */
function drain() {
  for (;;) {
    const res = vm.runtime.executePendingJobs();
    if (res.error) {
      const err = vm.dump(res.error);
      res.error.dispose();
      throw new Error(`Error di JS: ${JSON.stringify(err)}`);
    }
    if (res.value === 0) return;
  }
}

function call(src: string) {
  const r = vm.evalCode(src);
  if (r.error) {
    const err = vm.dump(r.error);
    r.error.dispose();
    throw new Error(`Error di JS: ${JSON.stringify(err)}`);
  }
  const v = vm.dump(r.value);
  r.value.dispose();
  drain();
  return v;
}

/** Simulasi user menekan tombol di layar native. */
function press(testID: string) {
  const node = tree.byTestID(testID);
  assert.ok(node, `node ${testID} tidak ada`);
  const key = tree.handler(node, "onPress");
  assert.ok(key, `${testID} tidak punya onPress`);
  return call(`XP.dispatch(${JSON.stringify(key)}, "[]")`);
}

const text = (id: string) => tree.text(tree.byTestID(id)!);
const modal = () => [...tree.walk()].find((n) => n.type === "Modal")!;

before(async () => {
  const QuickJS = await getQuickJS();
  vm = QuickJS.newContext();
  tree = new NativeTree();
  batches = [];

  // Bridge yang disediakan SDK native.
  const bridge = vm.newObject();
  const send = vm.newFunction("send", (h) => {
    const batch: Batch = JSON.parse(vm.getString(h));
    batches.push(batch);
    tree.apply(batch);
  });
  vm.setProp(bridge, "send", send);
  vm.setProp(vm.global, "__xp_native", bridge);
  send.dispose();
  bridge.dispose();

  call(code); // eval bundle dari "URL"
  call(`XP.mount(${JSON.stringify(JSON.stringify({ title: "Kelas IELTS", price: 150000, seats: 3 }))})`);
});

after(() => vm?.dispose());

test("bundle hanya memakai primitive yang dicatat manifest", () => {
  const used = new Set([...tree.walk()].map((n) => n.type).filter((t) => !t.startsWith("#")));
  for (const t of used) assert.ok(entry.primitives.includes(t), `${t} tidak ada di manifest`);
});

test("mount: UI awal ter-render native, modal tertutup", () => {
  assert.equal(text("title"), "Kelas IELTS");
  assert.equal(modal().props.visible, false);
  assert.equal(batches.length, 1, "mount = satu batch");
});

test("tekan 'Lihat detail': state berubah di QuickJS, modal tampil", () => {
  const before = batches.length;
  press("open");
  assert.equal(modal().props.visible, true);
  assert.equal(batches.length, before + 1);
  // Update kecil: hanya prop `visible`, tidak membuat ulang tree.
  const ops = batches.at(-1)!.ops;
  assert.deepEqual(ops, [["props", modal().id, { visible: true }]]);
});

test("logika di device: tambah peserta, total dihitung, tombol dinonaktifkan di batas kuota", () => {
  assert.equal(tree.byTestID("minus")!.props.disabled, true);
  press("plus");
  press("plus");
  assert.equal(text("qty"), "Peserta: 3");
  assert.equal(text("total"), "Total: Rp450.000");
  assert.equal(tree.byTestID("plus")!.props.disabled, true);
  assert.equal(tree.byTestID("minus")!.props.disabled, false);
  assert.equal(text("full"), "Kuota penuh"); // node baru muncul secara kondisional
});

test("kurangi lagi: node kondisional dihapus, tidak ada node bocor", () => {
  press("minus");
  assert.equal(tree.byTestID("full"), undefined);
  assert.deepEqual(tree.orphans(), []);
});

test("tutup modal; event ke node yang sudah dihapus diabaikan", () => {
  press("close");
  assert.equal(modal().props.visible, false);
  assert.equal(call(`XP.dispatch("99999:onPress", "[]")`), "[]"); // tidak ada perubahan
});

test("update props dari app host tanpa remount", () => {
  const titleNode = tree.byTestID("title")!;
  call(`XP.update(${JSON.stringify(JSON.stringify({ title: "Kelas TOEFL", price: 100000, seats: 3 }))})`);
  assert.equal(text("title"), "Kelas TOEFL");
  assert.equal(tree.byTestID("title")!.id, titleNode.id, "node yang sama, bukan dibuat ulang");
  assert.ok(!batches.at(-1)!.ops.some((op) => op[0] === "create"));
});

test("unmount membersihkan semua node", () => {
  call(`XP.unmount()`);
  assert.deepEqual(tree.nodes.get(0)!.children, []);
  assert.equal(tree.nodes.size, 1);
});
