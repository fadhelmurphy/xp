// Host browser: operasi → elemen DOM.
import { jsx, type ComponentFn } from "../jsx-runtime";
import { ROOT_ID } from "../protocol";
import { createRoot, TEXT, type Host } from "../reconciler";
import { htmlAttrs } from "./html";
import { styleToCss, TAGS } from "./web-style";

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
  private fresh = new Set<number>();
  private nodes = new Map<number, Node>();
  private props = new Map<number, Record<string, any>>();
  private types = new Map<number, string>();
  private handlers = new Map<string, Function>();

  constructor(container: HTMLElement) {
    this.nodes.set(ROOT_ID, container);
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

    for (const [prop, [evt, args]] of Object.entries(EVENTS)) {
      el.addEventListener(evt, (e) => {
        if (prop === "onRequestClose" && e.target !== el) return; // hanya klik di backdrop
        const fn = this.handlers.get(`${id}:${prop}`);
        if (!fn) return; // elemen tanpa handler: biarkan event naik ke parent (mis. Text di dalam Pressable)
        // Pressable terdalam yang menangani klik; parent tidak ikut terpicu (seperti di native).
        if (prop === "onPress") e.stopPropagation();
        if (!this.props.get(id)!.disabled) fn(...args(e));
      });
    }
  }

  setProps(id: number, changed: Record<string, unknown>) {
    const p = this.props.get(id)!;
    for (const [k, v] of Object.entries(changed)) {
      if (typeof v === "function") this.handlers.set(`${id}:${k}`, v);
      else if (v === undefined) this.handlers.delete(`${id}:${k}`);
      v === undefined ? delete p[k] : (p[k] = v);
    }
    const node = this.nodes.get(id)!;
    const type = this.types.get(id)!;
    if (type === TEXT) {
      node.textContent = String(p.value ?? "");
      return;
    }
    const el = node as HTMLElement;
    el.removeAttribute("style");
    for (const [k, v] of Object.entries(styleToCss(type, p.style, p))) el.style.setProperty(k, v);
    for (const [k, v] of Object.entries(htmlAttrs(type, p))) {
      if (k === "value") (el as HTMLInputElement).value = v; // property, bukan atribut
      else el.setAttribute(k, v);
    }
    if (this.fresh.delete(id) && p.entering) this.enter(el, p.entering as EnteringProp);
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
    const parent = this.nodes.get(id)!;
    const wanted = children.map((c) => this.nodes.get(c)!);
    wanted.forEach((node, i) => {
      if (parent.childNodes[i] !== node) parent.insertBefore(node, parent.childNodes[i] ?? null);
    });
    while (parent.childNodes.length > wanted.length) parent.removeChild(parent.lastChild!);
  }

  remove(id: number) {
    const n = this.nodes.get(id);
    n?.parentNode?.removeChild(n);
    this.nodes.delete(id);
    this.props.delete(id);
    this.types.delete(id);
    for (const k of this.handlers.keys()) if (k.startsWith(`${id}:`)) this.handlers.delete(k);
  }

  commit() {}
}

/**
 * Mount ke elemen. Kalau elemen berisi HTML hasil SSR, isinya diganti oleh render client
 * yang identik (M1: belum ada hydration yang mengklaim node lama).
 */
export function mount(container: HTMLElement, Component: ComponentFn, props: Record<string, unknown> = {}) {
  container.textContent = "";
  const host = new DomHost(container);
  const root = createRoot(host);
  root.render(jsx(Component, props));
  host.ready = true;
  return {
    update: (next: Record<string, unknown>) => root.render(jsx(Component, next)),
    unmount: () => root.unmount(),
  };
}
