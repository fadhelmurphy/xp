// JSX runtime otomatis. Komponen tidak perlu `import React`.
export type Props = Record<string, any> & { children?: unknown };
export type ComponentFn = (props: any) => unknown;
export type VNode = { $$xp: true; type: string | ComponentFn; props: Props; key: string | null };

export function jsx(type: VNode["type"], props: Props | null, key?: unknown): VNode {
  return { $$xp: true, type, props: props ?? {}, key: key == null ? null : String(key) };
}
export const jsxs = jsx;
export const jsxDEV = jsx;

export function Fragment(props: Props) {
  return props.children;
}

export function createElement(type: VNode["type"], props: Props | null, ...children: unknown[]): VNode {
  const { key, ...rest } = props ?? {};
  if (children.length) rest.children = children.length === 1 ? children[0] : children;
  return jsx(type, rest, key);
}

export function isVNode(v: unknown): v is VNode {
  return typeof v === "object" && v !== null && (v as VNode).$$xp === true;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace JSX {
  export type Element = VNode;
  export interface IntrinsicElements {
    [name: string]: never; // tag HTML dilarang: pakai primitive (View, Text, ...)
  }
  export interface ElementChildrenAttribute {
    children: {};
  }
  export interface IntrinsicAttributes {
    key?: string | number;
  }
}
