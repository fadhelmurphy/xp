import { Fragment, isVNode, type ComponentFn, type Props, type VNode } from "./jsx-runtime";
import { onEnvironmentChange } from "./environment";
import { ROOT_ID } from "./protocol";

/** Yang harus diimplementasikan setiap target (native bridge, DOM, SSR). */
export interface Host {
  create(id: number, type: string): void;
  /** Hanya prop yang berubah. Nilai `undefined` = prop dihapus. */
  setProps(id: number, changed: Record<string, unknown>): void;
  setChildren(id: number, children: number[]): void;
  remove(id: number): void;
  /** Akhir satu batch perubahan. */
  commit(): void;
}

type HostInst = {
  kind: "host";
  type: string;
  id: number;
  key: string | null;
  /** Posisi di tree ("View#0/Counter#1"), dipakai untuk menyimpan state saat reload (HMR). */
  path: string;
  props: Props;
  children: Inst[];
  lastIds: number[];
};

type Hook = Record<string, any>;

type CompInst = {
  kind: "comp";
  type: ComponentFn;
  key: string | null;
  path: string;
  /** State dari snapshot sebelum reload: indeks hook → nilai useState. */
  restore?: Record<string, unknown>;
  /** Hook hidup dari runtime lain (pindah runtime): dipakai apa adanya, termasuk ref dan effect. */
  adopt?: (Hook | undefined)[];
  props: Props;
  children: Inst[];
  hostParent: HostInst;
  hooks: Hook[];
  depth: number;
  unmounted: boolean;
  renderedIn: number;
  root: RootCtx;
};

type Inst = HostInst | CompInst;

type RootCtx = {
  host: Host;
  nextId: number;
  dirty: Set<CompInst>;
  scheduled: boolean;
  flushId: number;
  effects: Hook[];
  runEffects: boolean;
  restore: Snapshot | null;
  adopt: Handover | null;
};

/**
 * Hook semua komponen yang sedang tampil, per posisi, sebagai objek hidup (bukan JSON).
 * Dipakai saat komponen pindah ke runtime lain di halaman yang sama: state, ref, memo, dan effect
 * berjalan terus tanpa diulang. Bentuk objek hook adalah kontrak antar versi runtime: HANDOVER_VERSION.
 */
export type Handover = Record<string, Hook[]>;
export const HANDOVER_VERSION = 1;

/** State useState setiap komponen, per posisi di tree. Harus bisa di-JSON-kan. */
export type Snapshot = Record<string, Record<string, unknown>>;

export const TEXT = "#text";

// --- normalisasi children ---

function normalize(node: unknown, out: VNode[] = []): VNode[] {
  if (node == null || typeof node === "boolean") return out;
  if (Array.isArray(node)) {
    for (const n of node) normalize(n, out);
    return out;
  }
  if (typeof node === "string" || typeof node === "number") {
    out.push({ $$xp: true, type: TEXT, props: { value: String(node) }, key: null });
    return out;
  }
  if (isVNode(node)) {
    out.push(node);
    return out;
  }
  throw new Error(`Child tidak didukung: ${String(node)}`);
}

// --- hooks ---

let current: CompInst | null = null;
let hookIndex = 0;

function nextHook(kind: "state" | "ref" | "memo" | "effect"): Hook {
  if (!current) throw new Error("Hooks hanya boleh dipanggil di dalam komponen");
  const i = hookIndex++;
  let h = current.hooks[i];
  if (!h) {
    // Hook dari runtime sebelumnya dipakai kalau jenisnya sama di urutan yang sama.
    const adopted = current.adopt?.[i];
    if (adopted && adopted.kind === kind) {
      h = adopted;
      current.adopt![i] = undefined;
    } else {
      h = { kind };
    }
    current.hooks[i] = h;
  }
  return h;
}

function depsChanged(a: unknown[] | undefined, b: unknown[] | undefined) {
  return !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
}

export function useState<T>(init: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void] {
  const comp = current!;
  const h = nextHook("state");
  if (!("value" in h)) {
    const saved = comp.restore;
    const i = String(hookIndex - 1);
    const initial = typeof init === "function" ? (init as () => T)() : init;
    // Nilai lama dipakai hanya kalau jenisnya sama (komponen di posisi itu bisa saja sudah berubah).
    const keep = saved && i in saved && (initial == null || typeof saved[i] === typeof initial);
    h.value = keep ? (saved[i] as T) : initial;
    h.state = true;
    // Setter tetap sama selamanya dan meneruskan ke `dispatch` milik runtime yang sedang memegang
    // hook ini. Setter yang sudah tertangkap closure (mis. di timer) tetap jalan setelah pindah runtime.
    h.set = (v: unknown) => h.dispatch(v);
  }
  if (h.owner !== comp) {
    h.owner = comp;
    h.dispatch = (v: T | ((p: T) => T)) => {
      const next = typeof v === "function" ? (v as (p: T) => T)(h.value) : v;
      if (Object.is(next, h.value)) return;
      h.value = next;
      schedule(h.owner);
    };
  }
  return [h.value, h.set];
}

export function useRef<T>(init: T): { current: T } {
  const h = nextHook("ref");
  if (!("ref" in h)) h.ref = { current: init };
  return h.ref;
}

export function useMemo<T>(fn: () => T, deps: unknown[]): T {
  const h = nextHook("memo");
  if (!("value" in h) || depsChanged(h.deps, deps)) {
    h.value = fn();
    h.deps = deps;
  }
  return h.value;
}

export function useCallback<T extends (...a: any[]) => any>(fn: T, deps: unknown[]): T {
  return useMemo(() => fn, deps);
}

export function useEffect(fn: () => void | (() => void), deps?: unknown[]) {
  const comp = current!;
  const h = nextHook("effect");
  if (deps === undefined || depsChanged(h.deps, deps)) {
    h.pending = fn;
    h.deps = deps;
    comp.root.effects.push(h);
  }
}

// --- rekonsiliasi ---

function hostIds(inst: Inst): number[] {
  return inst.kind === "host" ? [inst.id] : inst.children.flatMap(hostIds);
}

function syncChildren(root: RootCtx, h: HostInst) {
  const ids = h.children.flatMap(hostIds);
  if (ids.length !== h.lastIds.length || ids.some((id, i) => id !== h.lastIds[i])) {
    root.host.setChildren(h.id, ids);
    h.lastIds = ids;
  }
}

function propsDiff(prev: Props, next: Props) {
  const changed: Record<string, unknown> = {};
  let any = false;
  for (const k in next) {
    if (k === "children") continue;
    if (!Object.is(prev[k], next[k]) && !(isPlainEqual(prev[k], next[k]))) {
      changed[k] = next[k];
      any = true;
    }
  }
  for (const k in prev) {
    if (k !== "children" && !(k in next)) {
      changed[k] = undefined;
      any = true;
    }
  }
  return any ? changed : null;
}

// Objek style literal dibuat ulang tiap render; bandingkan isinya supaya tidak kirim op sia-sia.
function isPlainEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) || Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.is((a as any)[k], (b as any)[k]));
}

// Nama fungsi komponen tidak dipakai: bundle di-minify, jadi namanya bisa berubah antar build.
const segment = (v: VNode, index: number) => `${typeof v.type === "string" ? v.type : "C"}#${v.key ?? index}`;

function mount(root: RootCtx, v: VNode, hostParent: HostInst, depth: number, path: string): Inst {
  if (typeof v.type === "string") {
    const inst: HostInst = { kind: "host", type: v.type, id: root.nextId++, key: v.key, path, props: v.props, children: [], lastIds: [] };
    root.host.create(inst.id, v.type);
    const init = propsDiff({}, v.props);
    if (init) root.host.setProps(inst.id, init);
    inst.children = reconcile(root, [], normalize(v.props.children), inst, depth + 1, path);
    syncChildren(root, inst);
    return inst;
  }
  const inst: CompInst = {
    kind: "comp", type: v.type, key: v.key, path, props: v.props, children: [], hostParent,
    hooks: [], depth, unmounted: false, renderedIn: -1, root, restore: root.restore?.[path],
    adopt: root.adopt?.[path] ? [...root.adopt[path]] : undefined,
  };
  renderComp(root, inst);
  if (inst.adopt) {
    // Hook lama yang tidak terpakai (struktur komponen berbeda): bersihkan effect-nya.
    for (const h of inst.adopt) if (typeof h?.cleanup === "function") h.cleanup();
    inst.adopt = undefined;
  }
  return inst;
}

function update(root: RootCtx, inst: Inst, v: VNode, depth: number) {
  if (inst.kind === "host") {
    const changed = propsDiff(inst.props, v.props);
    if (changed) root.host.setProps(inst.id, changed);
    inst.props = v.props;
    inst.children = reconcile(root, inst.children, normalize(v.props.children), inst, depth + 1, inst.path);
    syncChildren(root, inst);
  } else {
    inst.props = v.props;
    renderComp(root, inst);
  }
}

function renderComp(root: RootCtx, inst: CompInst) {
  const prev = current, prevIndex = hookIndex;
  current = inst;
  hookIndex = 0;
  try {
    const out = inst.type === Fragment ? inst.props.children : inst.type(inst.props);
    if (out instanceof Promise) throw new Error("Komponen async tidak didukung");
    inst.renderedIn = root.flushId;
    inst.children = reconcile(root, inst.children, normalize(out), inst.hostParent, inst.depth + 1, inst.path);
  } finally {
    current = prev;
    hookIndex = prevIndex;
  }
}

function unmount(root: RootCtx, inst: Inst) {
  if (inst.kind === "comp") {
    inst.unmounted = true;
    for (const h of inst.hooks) if (typeof h.cleanup === "function") h.cleanup();
    for (const c of inst.children) unmount(root, c);
  } else {
    for (const c of inst.children) unmount(root, c);
    root.host.remove(inst.id);
  }
}

function reconcile(root: RootCtx, old: Inst[], next: VNode[], hostParent: HostInst, depth: number, path: string): Inst[] {
  const byKey = new Map<string, Inst>();
  const unkeyed: Inst[] = [];
  for (const o of old) (o.key != null ? byKey.set(o.key, o) : unkeyed.push(o));

  const used = new Set<Inst>();
  let u = 0;
  const result = next.map((v, i) => {
    const match = v.key != null ? byKey.get(v.key) : unkeyed[u++];
    if (match && !used.has(match) && match.type === v.type) {
      used.add(match);
      update(root, match, v, depth);
      return match;
    }
    return mount(root, v, hostParent, depth, `${path}/${segment(v, i)}`);
  });
  for (const o of old) if (!used.has(o)) unmount(root, o);
  return result;
}

// --- penjadwalan update dari setState ---

function schedule(comp: CompInst) {
  const root = comp.root;
  root.dirty.add(comp);
  if (root.scheduled) return;
  root.scheduled = true;
  // Microtask: dipakai di browser & bridge mode. Host native bisa memanggil flushSync() lebih dulu;
  // kalau begitu microtask ini tidak melakukan apa-apa.
  Promise.resolve().then(() => root.scheduled && flush(root));
}

function flush(root: RootCtx) {
  root.scheduled = false;
  root.flushId++;
  const dirty = [...root.dirty].sort((a, b) => a.depth - b.depth);
  root.dirty.clear();
  const parents = new Set<HostInst>();
  for (const c of dirty) {
    if (c.unmounted || c.renderedIn === root.flushId) continue; // sudah ikut dirender parent-nya
    renderComp(root, c);
    parents.add(c.hostParent);
  }
  for (const p of parents) syncChildren(root, p);
  commit(root);
}

function commit(root: RootCtx) {
  root.host.commit();
  const effects = root.effects;
  root.effects = [];
  if (!root.runEffects) return;
  for (const h of effects) {
    if (typeof h.cleanup === "function") h.cleanup();
    const c = h.pending();
    h.cleanup = typeof c === "function" ? c : undefined;
  }
}

// --- API publik ---

export function createRoot(host: Host, opts: { effects?: boolean } = {}) {
  const container: HostInst = { kind: "host", type: "#root", id: ROOT_ID, key: null, path: "", props: {}, children: [], lastIds: [] };
  const root: RootCtx = {
    host, nextId: 1, dirty: new Set(), scheduled: false, flushId: 0, effects: [],
    runEffects: opts.effects ?? true, restore: null, adopt: null,
  };
  // Lebar layar / mode gelap berubah melewati breakpoint: render ulang supaya className ikut.
  let lastElement: unknown = null;
  const stopEnv = onEnvironmentChange(() => {
    if (lastElement === null) return;
    root.flushId++;
    container.children = reconcile(root, container.children, normalize(lastElement), container, 0, "");
    syncChildren(root, container);
    commit(root);
  });
  return {
    /** `restore`: snapshot dari versi sebelumnya; state komponen di posisi yang sama dipakai lagi. */
    render(element: unknown, restore?: Snapshot | null, adopt?: Handover | null) {
      lastElement = element;
      root.flushId++;
      root.restore = restore ?? null;
      root.adopt = adopt ?? null;
      container.children = reconcile(root, container.children, normalize(element), container, 0, "");
      root.restore = null;
      root.adopt = null;
      syncChildren(root, container);
      commit(root);
    },
    /** Jalankan update yang tertunda sekarang juga (dipakai SDK native setelah event). */
    flushSync() {
      // Effect bisa memanggil setState lagi; batasi supaya tidak loop tanpa akhir.
      for (let i = 0; root.scheduled; i++) {
        if (i > 50) throw new Error("Terlalu banyak update berantai (setState di dalam effect?)");
        flush(root);
      }
    },
    /** State useState semua komponen yang sedang tampil (yang bisa di-JSON-kan saja). */
    snapshot(): Snapshot {
      const out: Snapshot = {};
      const walk = (inst: Inst) => {
        if (inst.kind === "comp") {
          const states: Record<string, unknown> = {};
          inst.hooks.forEach((h, i) => {
            if (!h.state || h.value === undefined) return;
            try {
              states[i] = JSON.parse(JSON.stringify(h.value ?? null));
            } catch {
              // nilai yang tidak bisa di-JSON-kan dilewati; komponen memakai nilai awal
            }
          });
          if (Object.keys(states).length) out[inst.path] = states;
        }
        inst.children.forEach(walk);
      };
      container.children.forEach(walk);
      return out;
    },
    /**
     * Serahkan semua hook hidup ke runtime lain, lalu berhenti tanpa menjalankan cleanup effect
     * (effect-nya diteruskan, bukan dihentikan). Host tidak diberi tahu; DOM dibiarkan.
     */
    handover(): Handover {
      const out: Handover = {};
      const walk = (inst: Inst) => {
        if (inst.kind === "comp") {
          if (inst.hooks.length) out[inst.path] = inst.hooks;
          inst.unmounted = true;
        }
        inst.children.forEach(walk);
      };
      container.children.forEach(walk);
      container.children = [];
      lastElement = null;
      stopEnv();
      root.dirty.clear();
      root.effects = [];
      return out;
    },
    unmount() {
      lastElement = null;
      stopEnv();
      for (const c of container.children) unmount(root, c);
      container.children = [];
      syncChildren(root, container);
      root.host.commit();
    },
  };
}
