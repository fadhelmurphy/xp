// Pemetaan primitive → HTML/CSS, dipakai bersama oleh SSR dan DOM supaya hasilnya identik.
import type { Style } from "../index";

export const TAGS: Record<string, string> = {
  View: "div",
  Text: "span",
  Image: "img",
  Pressable: "div",
  ScrollView: "div",
  TextInput: "input",
  Modal: "div",
};

// Default ala React Native: semua kontainer flex column.
const BASE: Record<string, Record<string, string>> = {
  View: { display: "flex", "flex-direction": "column", "box-sizing": "border-box", "min-width": "0" },
  Pressable: { display: "flex", "flex-direction": "column", "box-sizing": "border-box", cursor: "pointer" },
  ScrollView: { display: "flex", "flex-direction": "column", overflow: "auto", "box-sizing": "border-box" },
  Text: { display: "block" },
  Image: { display: "block", "object-fit": "cover" },
  TextInput: { "box-sizing": "border-box", font: "inherit" },
  Modal: {
    position: "fixed", inset: "0", display: "flex", "align-items": "center", "justify-content": "center",
    background: "rgba(0,0,0,.45)", padding: "16px", "z-index": "1000",
  },
};

// Sama dengan yang dianimasikan host native.
const ANIMATED = ["background-color", "opacity", "width", "height", "border-color", "color"];

const UNITLESS = new Set(["flex", "flexGrow", "flexShrink", "opacity", "fontWeight", "zIndex"]);

const kebab = (k: string) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());

export function styleToCss(type: string, style: Style | undefined, extra: Record<string, unknown> = {}) {
  const css: Record<string, string> = { ...BASE[type] };
  const s: Record<string, unknown> = { ...style };

  // Singkatan ala RN
  for (const [short, a, b] of [
    ["paddingHorizontal", "paddingLeft", "paddingRight"],
    ["paddingVertical", "paddingTop", "paddingBottom"],
    ["marginHorizontal", "marginLeft", "marginRight"],
    ["marginVertical", "marginTop", "marginBottom"],
  ] as const) {
    if (s[short] !== undefined) {
      s[a] ??= s[short];
      s[b] ??= s[short];
      delete s[short];
    }
  }
  if (s.borderWidth !== undefined) css["border-style"] = "solid";
  if (type === "ScrollView" && extra.horizontal) css["flex-direction"] = "row";
  if (type === "Modal" && !extra.visible) css.display = "none";
  if (typeof extra.onSwipe === "function" || extra.dragAxis) {
    // Geseran di sumbu itu ditangani xp; scroll di sumbu lain tetap jalan.
    css["touch-action"] = extra.dragAxis === "y" ? "pan-x" : "pan-y";
    css["user-select"] = "none";
  }
  if (type === "Text" && typeof extra.numberOfLines === "number" && extra.numberOfLines > 0) {
    css.display = "-webkit-box";
    css["-webkit-box-orient"] = "vertical";
    css["-webkit-line-clamp"] = String(extra.numberOfLines);
    css.overflow = "hidden";
  }

  const duration = s.transitionDuration;
  const easing = s.transitionTimingFunction ?? "ease";
  delete s.transitionDuration;
  delete s.transitionTimingFunction;
  if (typeof duration === "number" && duration > 0) {
    css.transition = ANIMATED.map((p) => `${p} ${duration}ms ${easing}`).join(", ");
  }

  for (const [k, v] of Object.entries(s)) {
    if (v === undefined || v === null) continue;
    css[kebab(k)] = typeof v === "number" && !UNITLESS.has(k) ? `${v}px` : String(v);
  }
  return css;
}

export const cssText = (css: Record<string, string>) =>
  Object.entries(css).map(([k, v]) => `${k}:${v}`).join(";");
