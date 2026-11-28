// Skenario bersama untuk tes diferensial komponen terkompilasi (Kotlin dan Swift) melawan bundle JS.
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

export const COMPONENTS: Record<string, string> = {
  "promo-modal": "examples",
  "promo-slider": "examples",
  "jadwal-kelas": "examples",
  "kitchen-sink": "tests/fixtures/native",
  "promo-chip": "tests/fixtures/styling",
  "promo-card": "tests/fixtures/styling",
};

export type Step = { event?: [string, string, unknown[]]; advance?: number; props?: Record<string, unknown>; env?: Record<string, unknown>; unmount?: true };
export type Script = { component: string; props: Record<string, unknown>; env?: Record<string, unknown>; steps: Step[] };

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
export function runJs(dist: string, script: Script) {
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

export const SCRIPTS: Script[] = [
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

