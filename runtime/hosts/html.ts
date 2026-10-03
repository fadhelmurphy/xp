// SSR: render komponen menjadi string HTML (tanpa DOM, tanpa effect).
import { jsx, type ComponentFn } from "../jsx-runtime";
import { ROOT_ID } from "../protocol";
import { createRoot, TEXT, type Host } from "../reconciler";
import { cssText, styleToCss, TAGS } from "./web-style";

type MemNode = { type: string; props: Record<string, any>; children: number[] };

class MemoryHost implements Host {
  nodes = new Map<number, MemNode>([[ROOT_ID, { type: "#root", props: {}, children: [] }]]);
  create(id: number, type: string) {
    this.nodes.set(id, { type, props: {}, children: [] });
  }
  setProps(id: number, changed: Record<string, unknown>) {
    const n = this.nodes.get(id)!;
    for (const [k, v] of Object.entries(changed)) (v === undefined ? delete n.props[k] : (n.props[k] = v));
  }
  setChildren(id: number, children: number[]) {
    this.nodes.get(id)!.children = children;
  }
  remove(id: number) {
    this.nodes.delete(id);
  }
  commit() {}
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Atribut HTML (non-style, non-event) per primitive. Dipakai juga oleh DOM host. */
export function htmlAttrs(type: string, p: Record<string, any>): Record<string, string> {
  const a: Record<string, string> = {};
  if (p.testID) a["data-testid"] = p.testID;
  if (type === "Image") {
    a.src = p.src ?? "";
    a.alt = p.alt ?? "";
  }
  if (type === "Pressable") {
    a.role = "button";
    a.tabindex = p.disabled ? "-1" : "0";
    if (p.disabled) a["aria-disabled"] = "true";
  }
  if (type === "TextInput") {
    a.type = p.secure ? "password" : "text";
    if (p.value != null) a.value = String(p.value);
    if (p.placeholder) a.placeholder = p.placeholder;
  }
  if (type === "Modal") {
    a.role = "dialog";
    a["aria-modal"] = "true";
  }
  return a;
}

function serialize(host: MemoryHost, id: number): string {
  const n = host.nodes.get(id)!;
  if (n.type === TEXT) return esc(String(n.props.value ?? ""));
  const inner = n.children.map((c) => serialize(host, c)).join("");
  if (n.type === "#root") return inner;

  const tag = TAGS[n.type];
  if (!tag) throw new Error(`Primitive tidak dikenal: ${n.type}`);
  const attrs = { ...htmlAttrs(n.type, n.props), style: cssText(styleToCss(n.type, n.props.style, n.props)) };
  const attrText = Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
  return tag === "img" || tag === "input" ? `<${tag}${attrText}>` : `<${tag}${attrText}>${inner}</${tag}>`;
}

export function renderToString(Component: ComponentFn, props: Record<string, unknown> = {}): string {
  const host = new MemoryHost();
  createRoot(host, { effects: false }).render(jsx(Component, props));
  return serialize(host, ROOT_ID);
}
