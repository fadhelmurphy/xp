import assert from "node:assert/strict";
import { test } from "node:test";
import { Text, View, useEffect, useState } from "@xp/runtime";
import { createRoot, type Host } from "../runtime/reconciler";

function recorder() {
  const ops: unknown[][] = [];
  const host: Host = {
    create: (id, t) => ops.push(["create", id, t]),
    setProps: (id, p) => ops.push(["props", id, p]),
    setChildren: (id, c) => ops.push(["children", id, c]),
    remove: (id) => ops.push(["delete", id]),
    commit: () => {},
  };
  return { host, ops };
}

const List = ({ items }: { items: string[] }) => (
  <View>{items.map((i) => <Text key={i}>{i}</Text>)}</View>
);

test("list ber-key: urutan berubah tanpa membuat ulang node", () => {
  const { host, ops } = recorder();
  const root = createRoot(host);
  root.render(<List items={["a", "b", "c"]} />);
  const viewId = ops.find((o) => o[0] === "create" && o[2] === "View")![1];
  const view = ops.find((o) => o[0] === "children" && o[1] === viewId)! as [string, number, number[]];
  const [a, b, c] = view[2];
  ops.length = 0;
  root.render(<List items={["c", "a", "b"]} />);
  assert.deepEqual(ops, [["children", view[1], [c, a, b]]]);
});

test("item dihapus: node & anaknya dihapus", () => {
  const { host, ops } = recorder();
  const root = createRoot(host);
  root.render(<List items={["a", "b"]} />);
  ops.length = 0;
  root.render(<List items={["a"]} />);
  assert.equal(ops.filter((o) => o[0] === "delete").length, 2); // Text + #text
});

test("useEffect jalan setelah commit dan cleanup saat unmount", async () => {
  const log: string[] = [];
  function Timer() {
    const [n, setN] = useState(0);
    useEffect(() => {
      log.push(`start ${n}`);
      return () => log.push(`stop ${n}`);
    }, [n]);
    useEffect(() => {
      if (n < 2) setN(n + 1);
    });
    return <Text>{n}</Text>;
  }
  const { host } = recorder();
  const root = createRoot(host);
  root.render(<Timer />);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  root.unmount();
  assert.deepEqual(log, ["start 0", "stop 0", "start 1", "stop 1", "start 2", "stop 2"]);
});

test("setState ganda dalam satu event = satu render", async () => {
  let renders = 0;
  let inc!: () => void;
  function C() {
    renders++;
    const [n, setN] = useState(0);
    inc = () => { setN((x) => x + 1); setN((x) => x + 1); };
    return <Text>{n}</Text>;
  }
  const { host, ops } = recorder();
  createRoot(host).render(<C />);
  ops.length = 0;
  inc();
  await Promise.resolve();
  assert.equal(renders, 2);
  assert.deepEqual(ops.map((o) => o[0]), ["props"]);
});
