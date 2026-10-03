// Host browser: operasi → elemen DOM.
import { jsx, type ComponentFn } from "../jsx-runtime";
import { ROOT_ID } from "../protocol";
import { createRoot, HANDOVER_VERSION, TEXT, type Handover, type Host, type Snapshot } from "../reconciler";

export { HANDOVER_VERSION };
import { swipeDirection } from "./gesture";
import { htmlAttrs } from "./html";
import { cssText, styleToCss, TAGS } from "./web-style";

// Prop event → event DOM + cara mengambil argumennya.
const EVENTS: Record<string, [string, (e: Event) => unknown[]]> = {
  onPress: ["click", () => []],
  onChangeText: ["input", (e) => [(e.target as HTMLInputElement).value]],
  onRequestClose: ["click", () => []], // klik backdrop Modal
};

type EnteringProp = { opacity?: number; translateX?: number; translateY?: number; duration?: number };

const nextFrame = (fn: () => void) =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => requestAnimationFrame(fn)) : setTimeout(fn, 32);

class DomHost implements Host {
  /** false selama render pertama: animasi `entering` dilewati supaya konten SSR tidak berkedip. */
  ready = false;
  /** true setelah release(): tree dilepas tanpa menyentuh DOM, listener lama berhenti bekerja. */
  detached = false;
  private fresh = new Set<number>();
  private nodes = new Map<number, Node>();
  private props = new Map<number, Record<string, any>>();
  private types = new Map<number, string>();
  private children = new Map<number, number[]>();
  private attrs = new Map<number, string[]>();
  private handlers = new Map<string, Function>();

  constructor(root: HTMLElement) {
    this.nodes.set(ROOT_ID, root);
  }

  create(id: number, type: string) {
    this.types.set(id, type);
    this.props.set(id, {});
    if (type === TEXT) {
      this.nodes.set(id, document.createTextNode(""));
      return;
    }
    const tag = TAGS[type];
    if (!tag) throw new Error(`Primitive tidak dikenal: ${type}`);
    const el = document.createElement(tag);
    this.nodes.set(id, el);
    if (this.ready) this.fresh.add(id);
    this.wire(id, el);
  }

  /** Pasang listener event ke elemen node `id` (elemen baru atau elemen hasil SSR). */
  private wire(id: number, el: HTMLElement) {
    let swiped = false;
    for (const [prop, [evt, args]] of Object.entries(EVENTS)) {
      el.addEventListener(evt, (e) => {
        if (this.detached) return;
        if (prop === "onRequestClose" && e.target !== el) return; // hanya klik di backdrop
        const fn = this.handlers.get(`${id}:${prop}`);
        if (!fn) return; // elemen tanpa handler: biarkan event naik ke parent (mis. Text di dalam Pressable)
        // Pressable terdalam yang menangani klik; parent tidak ikut terpicu (seperti di native).
        if (prop === "onPress") {
          e.stopPropagation();
          if (swiped) return (swiped = false); // akhir geseran bukan tap
        }
        if (!this.props.get(id)?.disabled) fn(...args(e));
      });
    }

    // onSwipe: geseran pointer (jari atau mouse) minimal SWIPE_THRESHOLD px.
    // dragAxis: selama digeser, elemen ikut pointer di sumbu itu, lalu kembali saat dilepas.
    // Gerakan dipantau di window supaya pointer yang keluar dari elemen tetap terhitung.
    el.addEventListener("pointerdown", (down) => {
      if (this.detached) return;
      const axis = this.props.get(id)?.dragAxis as "x" | "y" | undefined;
      if (!this.handlers.has(`${id}:onSwipe`) && !axis) return;
      if ((down as any).__xpDrag) return; // elemen yang lebih dalam sudah menangani
      (down as any).__xpDrag = true;
      const win = el.ownerDocument.defaultView!;
      const from = { x: down.clientX, y: down.clientY };
      const base = { transform: el.style.transform, transition: el.style.transition };
      let dragging = false;

      const move = (e: PointerEvent) => {
        if (e.pointerId !== down.pointerId || !axis) return;
        const dx = axis === "x" ? e.clientX - from.x : 0;
        const dy = axis === "y" ? e.clientY - from.y : 0;
        if (!dragging && Math.abs(dx) + Math.abs(dy) < 4) return;
        if (!dragging) {
          dragging = true;
          el.style.transition = "none";
        }
        el.style.transform = `${base.transform} translate(${dx}px, ${dy}px)`.trim();
      };
      const end = (e: PointerEvent, cancelled: boolean) => {
        if (e.pointerId !== down.pointerId) return;
        win.removeEventListener("pointermove", move as EventListener);
        win.removeEventListener("pointerup", up as EventListener);
        win.removeEventListener("pointercancel", cancel as EventListener);
        if (dragging) {
          // Kembali ke posisi semula, lalu style dikembalikan sesuai props.
          el.style.transition = "transform 200ms ease-out";
          el.style.transform = base.transform;
          setTimeout(() => this.nodes.get(id) === el && this.paint(id), 220);
        }
        if (cancelled) return;
        const dir = swipeDirection(e.clientX - from.x, e.clientY - from.y);
        const fn = this.handlers.get(`${id}:onSwipe`);
        if (!dir) return;
        swiped = true; // click yang menyusul geseran bukan tap
        setTimeout(() => (swiped = false), 0);
        fn?.(dir);
      };
      const up = (e: PointerEvent) => end(e, false);
      const cancel = (e: PointerEvent) => end(e, true);
      win.addEventListener("pointermove", move as EventListener);
      win.addEventListener("pointerup", up as EventListener);
      win.addEventListener("pointercancel", cancel as EventListener);
    });
  }

  setProps(id: number, changed: Record<string, unknown>) {
    const p = this.props.get(id)!;
    for (const [k, v] of Object.entries(changed)) {
      if (typeof v === "function") this.handlers.set(`${id}:${k}`, v);
      else if (v === undefined) this.handlers.delete(`${id}:${k}`);
      v === undefined ? delete p[k] : (p[k] = v);
    }
    this.paint(id);
    const el = this.nodes.get(id) as HTMLElement;
    if (this.fresh.delete(id) && p.entering) this.enter(el, p.entering as EnteringProp);
  }

  /** Tulis style dan atribut dari props ke node DOM. */
  private paint(id: number) {
    const p = this.props.get(id)!;
    const node = this.nodes.get(id)!;
    const type = this.types.get(id)!;
    if (type === TEXT) {
      const text = String(p.value ?? "");
      if (node.textContent !== text) node.textContent = text;
      return;
    }
    const el = node as HTMLElement;
    // Sama persis dengan atribut hasil SSR, jadi hydrate tidak menulis ulang apa pun.
    const style = cssText(styleToCss(type, p.style, p));
    if (el.getAttribute("style") !== style) el.setAttribute("style", style);
    const next = htmlAttrs(type, p);
    for (const k of this.attrs.get(id) ?? []) if (!(k in next)) el.removeAttribute(k);
    for (const [k, v] of Object.entries(next)) {
      if (k === "value") (el as HTMLInputElement).value = v; // property, bukan atribut
      else if (el.getAttribute(k) !== v) el.setAttribute(k, v);
    }
    this.attrs.set(id, Object.keys(next));
  }

  /**
   * Hydration: pakai elemen hasil SSR di `container` untuk tree yang baru dirender.
   * Mengembalikan false (tanpa mengubah apa pun) kalau strukturnya tidak cocok.
   */
  hydrate(container: HTMLElement): boolean {
    const pairs: [number, Node][] = [];
    // Teks yang tidak bisa dipasangkan satu-satu: node teks lama diganti node teks baru.
    const textSwaps: { parent: Node; before: Node | null; remove: Node[]; insert: number[] }[] = [];
    const empties: Node[] = [];
    const match = (id: number, dom: Node): boolean => {
      const kids = this.children.get(id) ?? [];
      const domKids = [...dom.childNodes].filter((n) => {
        if (n.nodeType === 3 && !n.textContent) return empties.push(n), false; // teks kosong diabaikan
        return n.nodeType === 1 || n.nodeType === 3;
      });
      let d = 0;
      for (let i = 0; i < kids.length; ) {
        if (this.types.get(kids[i]) === TEXT) {
          // Teks berurutan ("Total: " + angka): di HTML SSR menjadi satu node teks, di DOM hasil
          // render client tetap terpisah. Cocokkan isinya, bukan jumlah node-nya.
          const run: number[] = [];
          while (i < kids.length && this.types.get(kids[i]) === TEXT) run.push(kids[i++]);
          const text = run.map((k) => String(this.props.get(k)!.value ?? "")).join("");
          const nodes: Node[] = [];
          let seen = "";
          while (seen.length < text.length && domKids[d]?.nodeType === 3) {
            seen += domKids[d].textContent;
            nodes.push(domKids[d++]);
          }
          if (seen !== text) return false;
          if (nodes.length === run.length) run.forEach((k, j) => pairs.push([k, nodes[j]]));
          else textSwaps.push({ parent: dom, before: nodes[0] ?? domKids[d] ?? null, remove: nodes, insert: run });
          continue;
        }
        const node = domKids[d++];
        const own = this.nodes.get(kids[i]) as HTMLElement;
        if (!node || node.nodeType !== 1 || (node as Element).tagName !== own.tagName) return false;
        if (!match(kids[i], node)) return false;
        pairs.push([kids[i], node]);
        i++;
      }
      return d === domKids.length;
    };
    if (!match(ROOT_ID, container)) return false;

    this.nodes.set(ROOT_ID, container);
    for (const [id, node] of pairs) {
      this.nodes.set(id, node);
      if (node.nodeType === 1) this.wire(id, node as HTMLElement);
      this.paint(id); // menyamakan style/atribut/value
    }
    for (const swap of textSwaps) {
      for (const id of swap.insert) swap.parent.insertBefore(this.nodes.get(id)!, swap.before);
      for (const n of swap.remove) swap.parent.removeChild(n);
    }
    for (const n of empties) n.parentNode?.removeChild(n);
    for (const n of [...container.childNodes]) if (n.nodeType === 8) container.removeChild(n);
    return true;
  }

  /** Render client dipindah ke container (tanpa hydration). */
  adopt(container: HTMLElement) {
    this.nodes.set(ROOT_ID, container);
  }

  /** Mulai dari nilai `entering`, lalu transisi ke style normal. */
  private enter(el: HTMLElement, e: EnteringProp) {
    const duration = e.duration ?? 250;
    const finalOpacity = el.style.opacity;
    const finalTransform = el.style.transform;
    const finalTransition = el.style.transition;
    el.style.transition = "none";
    if (e.opacity !== undefined) el.style.opacity = String(e.opacity);
    el.style.transform = `translate(${e.translateX ?? 0}px, ${e.translateY ?? 0}px)`;
    nextFrame(() => {
      const enterTransition = `opacity ${duration}ms ease-out, transform ${duration}ms ease-out`;
      el.style.transition = finalTransition ? `${finalTransition}, ${enterTransition}` : enterTransition;
      el.style.opacity = finalOpacity;
      el.style.transform = finalTransform;
    });
  }

  setChildren(id: number, children: number[]) {
    this.children.set(id, children);
    if (this.detached) return;
    const parent = this.nodes.get(id)!;
    const wanted = children.map((c) => this.nodes.get(c)!);
    wanted.forEach((node, i) => {
      if (parent.childNodes[i] !== node) parent.insertBefore(node, parent.childNodes[i] ?? null);
    });
    while (parent.childNodes.length > wanted.length) parent.removeChild(parent.lastChild!);
  }

  remove(id: number) {
    const n = this.nodes.get(id);
    if (!this.detached) n?.parentNode?.removeChild(n);
    this.nodes.delete(id);
    this.props.delete(id);
    this.types.delete(id);
    this.children.delete(id);
    this.attrs.delete(id);
    for (const k of this.handlers.keys()) if (k.startsWith(`${id}:`)) this.handlers.delete(k);
  }

  commit() {}
}

/**
 * Mount ke elemen. Kalau elemen sudah berisi HTML hasil SSR dari komponen yang sama dengan
 * props yang sama, elemen itu dipakai apa adanya (hydration): tidak ada node yang dibuat ulang.
 * Kalau isinya tidak cocok, isinya diganti hasil render client.
 */
export function mount(
  container: HTMLElement,
  Component: ComponentFn,
  props: Record<string, unknown> = {},
  opts: { restore?: Snapshot | null; adopt?: Handover | null } = {},
) {
  const staging = document.createElement(container.tagName);
  const host = new DomHost(staging);
  const root = createRoot(host);
  root.render(jsx(Component, props), opts.restore, opts.adopt);
  const hasSSR = [...container.childNodes].some((n) => n.nodeType === 1 || (n.nodeType === 3 && n.textContent!.trim()));
  if (!hasSSR || !host.hydrate(container)) {
    container.textContent = "";
    while (staging.firstChild) container.appendChild(staging.firstChild);
    host.adopt(container);
  }
  host.ready = true;
  return {
    update: (next: Record<string, unknown>) => root.render(jsx(Component, next)),
    unmount: () => root.unmount(),
    /** State saat ini, untuk dipakai lagi oleh bundle baru (reload saat development). */
    snapshot: () => root.snapshot(),
    /**
     * Lepas komponen (effect & timer dibersihkan) tapi biarkan elemen DOM-nya. Dipakai saat pindah ke
     * runtime lain: runtime baru me-mount dengan snapshot dan meng-hydrate elemen yang sama.
     */
    release: () => {
      host.detached = true;
      root.unmount();
    },
    /**
     * Seperti release, tapi hook hidup (state, ref, memo, effect yang sedang jalan) diserahkan ke
     * runtime baru lewat mount(el, C, props, { adopt }), tanpa menjalankan cleanup.
     */
    handover: () => {
      host.detached = true;
      return root.handover();
    },
    handoverVersion: HANDOVER_VERSION,
  };
}
