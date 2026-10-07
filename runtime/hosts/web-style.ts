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
const ANIMATED = ["background-color", "opacity", "width", "height", "border-color", "color", "translate", "scale", "rotate"];

const UNITLESS = new Set(["flex", "flexGrow", "flexShrink", "opacity", "fontWeight", "zIndex", "aspectRatio"]);

// Kunci style yang diterjemahkan khusus (bukan sekadar kebab-case).
const SPECIAL = new Set([
  "gridColumns", "gridColumnSpan", "translateX", "translateY", "scaleX", "scaleY", "rotate", "lineClamp",
  "fontFamily", "animation", "dividerWidth", "dividerColor", "userSelect",
]);

/** Animasi bawaan Tailwind (animate-*), sama dengan yang dijalankan host native. */
export const ANIMATIONS: Record<string, string> = {
  spin: "xp-spin 1s linear infinite",
  ping: "xp-ping 1s cubic-bezier(0,0,0.2,1) infinite",
  pulse: "xp-pulse 2s cubic-bezier(0.4,0,0.6,1) infinite",
  bounce: "xp-bounce 1s infinite",
};

export const KEYFRAMES =
  "@keyframes xp-spin{to{transform:rotate(360deg)}}" +
  "@keyframes xp-ping{75%,100%{transform:scale(2);opacity:0}}" +
  "@keyframes xp-pulse{50%{opacity:.5}}" +
  "@keyframes xp-bounce{0%,100%{transform:translateY(-25%);animation-timing-function:cubic-bezier(0.8,0,1,1)}" +
  "50%{transform:none;animation-timing-function:cubic-bezier(0,0,0.2,1)}}";

const FONTS: Record<string, string> = {
  "sans-serif": 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  monospace: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
};

const px = (v: unknown) => (typeof v === "number" ? `${v}px` : String(v));

/** Garis pemisah untuk anak ke-`index` dari parent dengan dividerWidth/dividerColor (divide-x/y). */
export function dividerCss(parent: Style | undefined, index: number, count: number): Record<string, string> {
  if (!parent || index >= count - 1 || (parent.dividerWidth == null && parent.dividerColor == null)) return {};
  const side = parent.flexDirection === "row" || parent.flexDirection === "row-reverse" ? "right" : "bottom";
  return {
    [`border-${side}-width`]: `${parent.dividerWidth ?? 1}px`,
    [`border-${side}-style`]: "solid",
    [`border-${side}-color`]: parent.dividerColor ?? "currentColor",
  };
}

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
  const anyBorder = ["borderWidth", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"].some((k) => s[k] !== undefined);
  if (anyBorder && s.borderStyle === undefined) css["border-style"] = "solid";
  if (s.display === "grid" || s.gridColumns !== undefined) {
    css.display = "grid";
    css["grid-template-columns"] = `repeat(${s.gridColumns ?? 1}, minmax(0, 1fr))`;
  }
  if (typeof s.gridColumnSpan === "number") {
    css["grid-column"] = s.gridColumnSpan < 0 ? "1 / -1" : `span ${s.gridColumnSpan} / span ${s.gridColumnSpan}`;
  }
  if (s.translateX !== undefined || s.translateY !== undefined) css.translate = `${px(s.translateX ?? 0)} ${px(s.translateY ?? 0)}`;
  if (s.scaleX !== undefined || s.scaleY !== undefined) css.scale = `${s.scaleX ?? 1} ${s.scaleY ?? 1}`;
  if (typeof s.rotate === "number") css.rotate = `${s.rotate}deg`;
  if (typeof s.fontFamily === "string") css["font-family"] = FONTS[s.fontFamily] ?? (/[\s,]/.test(s.fontFamily) ? `"${s.fontFamily}"` : s.fontFamily);
  if (typeof s.animation === "string") css.animation = ANIMATIONS[s.animation] ?? "none";
  if (typeof s.userSelect === "string") css["user-select"] = css["-webkit-user-select"] = s.userSelect;
  const clamp = typeof s.lineClamp === "number" ? s.lineClamp : undefined;
  if (clamp && clamp > 0 && extra.numberOfLines === undefined) extra = { ...extra, numberOfLines: clamp };
  if (type === "ScrollView" && extra.horizontal) css["flex-direction"] = "row";
  if (type === "Modal" && !extra.visible) css.display = "none";
  if (typeof extra.onSwipe === "function" || extra.dragAxis) {
    // Geseran di sumbu itu ditangani xp; scroll di sumbu lain tetap jalan.
    css["touch-action"] = extra.dragAxis === "y" ? "pan-x" : "pan-y";
    css["user-select"] = "none";
  }
  if ((type === "Text" || clamp) && typeof extra.numberOfLines === "number" && extra.numberOfLines > 0) {
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
    if (v === undefined || v === null || SPECIAL.has(k)) continue;
    if (k === "display") {
      // grid sudah di atas; flex = bawaan elemen, kecuali di CSS varian (mis. md:flex setelah hidden)
      if (v === "none" || (v === "flex" && !type)) css.display = String(v);
      else if (v === "flex" && css.display === "none") delete css.display;
      continue;
    }
    css[kebab(k)] = typeof v === "number" && !UNITLESS.has(k) ? `${v}px` : String(v);
  }
  return css;
}

export const cssText = (css: Record<string, string>) =>
  Object.entries(css).map(([k, v]) => `${k}:${v}`).join(";");
