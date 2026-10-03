// Host untuk iOS/Android: dijalankan di QuickJS di dalam SDK native.
//
// Dua mode pengiriman perintah UI:
//  1. Bridge: SDK memasang globalThis.__xp_native.send(json); setiap batch dikirim langsung.
//  2. Antrean (default kalau __xp_native tidak ada): setiap panggilan XP.* mengembalikan
//     string JSON berisi daftar batch, secara sinkron. SDK cukup bisa `evaluate(script)`.
//     Ini yang dipakai SDK Android (zipline QuickJs) dan iOS.
//
// SDK → JS: XP.mount(propsJson), XP.update(propsJson), XP.dispatch(handlerKey, argsJson), XP.unmount()
import { jsx, type ComponentFn } from "../jsx-runtime";
import { PROTOCOL_VERSION, type Batch, type Op } from "../protocol";
import { createRoot, type Host } from "../reconciler";

type Bridge = { send(batchJson: string): void };

class NativeHost implements Host {
  private ops: Op[] = [];
  readonly queue: Batch[] = [];
  // Key handler stabil per (node, prop): closure baru tiap render tidak memicu op baru.
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>();

  constructor(private bridge: Bridge | null) {}

  create(id: number, type: string) {
    this.ops.push(["create", id, type as never]);
  }

  setProps(id: number, changed: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    let any = false;
    for (const [k, v] of Object.entries(changed)) {
      const key = `${id}:${k}`;
      if (typeof v === "function") {
        const known = this.handlers.has(key);
        this.handlers.set(key, v as never);
        if (known) continue; // hanya fungsinya yang berganti; native tidak perlu tahu
        out[k] = { $fn: key };
      } else {
        if (this.handlers.delete(key) && v === undefined) {
          out[k] = null;
          any = true;
          continue;
        }
        out[k] = v === undefined ? null : v;
      }
      any = true;
    }
    if (any) this.ops.push(["props", id, out]);
  }

  setChildren(id: number, children: number[]) {
    this.ops.push(["children", id, children]);
  }

  remove(id: number) {
    for (const k of this.handlers.keys()) if (k.startsWith(`${id}:`)) this.handlers.delete(k);
    this.ops.push(["delete", id]);
  }

  commit() {
    if (!this.ops.length) return;
    const batch: Batch = { v: PROTOCOL_VERSION, ops: this.ops };
    this.ops = [];
    if (this.bridge) this.bridge.send(JSON.stringify(batch));
    else this.queue.push(batch);
  }

  /** Ambil semua batch yang menunggu (mode antrean) sebagai JSON. */
  drain(): string {
    const out = JSON.stringify(this.queue);
    this.queue.length = 0;
    return out;
  }
}

/** Dipanggil oleh entry bundle native. Memasang globalThis.XP untuk SDK. */
export function installNative(Component: ComponentFn) {
  const g = globalThis as any;
  const bridge: Bridge | null = g.__xp_native?.send ? g.__xp_native : null;

  const host = new NativeHost(bridge);
  const root = createRoot(host);
  // Setiap panggilan dari SDK menyelesaikan semua update sebelum kembali,
  // jadi SDK tidak perlu menjalankan microtask QuickJS.
  const done = () => {
    root.flushSync();
    return host.drain();
  };

  g.XP = {
    protocol: PROTOCOL_VERSION,
    mount(propsJson = "{}") {
      root.render(jsx(Component, JSON.parse(propsJson)));
      return done();
    },
    update(propsJson = "{}") {
      root.render(jsx(Component, JSON.parse(propsJson)));
      return done();
    },
    unmount() {
      root.unmount();
      return done();
    },
    dispatch(handlerKey: string, argsJson = "[]") {
      const fn = host.handlers.get(handlerKey);
      if (fn) fn(...JSON.parse(argsJson)); // node sudah dihapus: abaikan event basi
      return done();
    },
  };
}
