// Tailwind untuk komponen xp (web, Android, iOS):
//   <View className="p-4 flex-row items-center gap-2 bg-blue-500 rounded-lg">
//
// Tidak ada CSS di device, jadi saat build setiap class diterjemahkan menjadi object `style`
// memakai Tailwind itu sendiri: class dikompilasi Tailwind v4 (nilai, tema, dan nilai arbitrer
// persis seperti di web), lalu deklarasi CSS-nya diubah ke properti style xp. Runtime menggabungkan
// class saat render, mengikuti urutan stylesheet Tailwind (seperti cascade di browser).
//
// Varian (md:, dark:, hover:, active:, ...) dicatat sebagai kondisi; lihat classname.mjs.
// Class yang tidak bisa dijalankan di device (mis. `blur-sm`, `group-hover:`) membuat build gagal
// dengan pesan yang menyebut file, baris, dan alasannya.
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { TAILWIND, tailwindCss } from "./css.mjs";

// --- membaca CSS hasil Tailwind ---

/** Pecah CSS menjadi blok { prelude, body } atau { prelude, children } (bersarang). */
function parseBlocks(css) {
  const out = [];
  let i = 0;
  let start = 0;
  const n = css.length;
  while (i < n) {
    const ch = css[i];
    if (ch === "/" && css[i + 1] === "*") {
      i = css.indexOf("*/", i + 2) + 2;
      if (i < 2) break;
      start = i;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = css.indexOf(ch, i + 1) + 1;
      continue;
    }
    if (ch === ";") {
      const stmt = css.slice(start, i).trim();
      if (stmt) out.push({ statement: stmt });
      start = ++i;
      continue;
    }
    if (ch === "{") {
      const prelude = css.slice(start, i).trim();
      let depth = 1;
      let j = i + 1;
      while (j < n && depth) {
        if (css[j] === '"' || css[j] === "'") j = css.indexOf(css[j], j + 1);
        else if (css[j] === "{") depth++;
        else if (css[j] === "}") depth--;
        j++;
      }
      const inner = css.slice(i + 1, j - 1);
      out.push({ prelude, inner });
      i = start = j;
      continue;
    }
    i++;
  }
  return out;
}

/** Deklarasi di dalam satu rule (blok bersarang dikembalikan terpisah). */
function declarations(inner) {
  const decls = [];
  const nested = [];
  for (const b of parseBlocks(inner)) {
    if (b.statement) {
      const k = b.statement.indexOf(":");
      if (k > 0) decls.push([b.statement.slice(0, k).trim(), b.statement.slice(k + 1).trim()]);
    } else nested.push(b);
  }
  return { decls, nested };
}

const unescapeCss = (s) => s.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, "$1");

/**
 * Kondisi varian dari media query dan pseudo-class. Yang didukung:
 *   sm: md: lg: xl: 2xl: max-*: min-[...]:   → lebar layar
 *   dark:                                      → mode gelap
 *   active: hover: focus: disabled:            → keadaan elemen
 * Hasil null = varian tidak didukung (alasannya di `why`).
 */
function variantCondition(media, pseudo) {
  const cond = {};
  for (const m of media) {
    for (const part of m.replace(/^@media\s*/, "").split(/\s+and\s+/)) {
      const q = part.trim().replace(/^\(|\)$/g, "").trim();
      let mm;
      if (q === "hover: hover") continue; // pasangan :hover
      if ((mm = q.match(/^width\s*>=\s*([\d.]+)(px|rem|em)$/)) || (mm = q.match(/^min-width:\s*([\d.]+)(px|rem|em)$/))) {
        cond.minWidth = parseFloat(mm[1]) * (mm[2] === "px" ? 1 : 16);
      } else if ((mm = q.match(/^width\s*<\s*([\d.]+)(px|rem|em)$/)) || (mm = q.match(/^max-width:\s*([\d.]+)(px|rem|em)$/))) {
        cond.maxWidth = parseFloat(mm[1]) * (mm[2] === "px" ? 1 : 16);
      } else if ((mm = q.match(/^prefers-color-scheme:\s*(dark|light)$/))) {
        cond.dark = mm[1] === "dark";
      } else {
        return { why: `media query (${q})` };
      }
    }
  }
  if (pseudo) {
    const state = { ":active": "pressed", ":hover": "hover", ":focus": "focus", ":focus-visible": "focus", ":disabled": "disabled" }[pseudo];
    if (!state) return { why: `selector ${pseudo}` };
    cond.state = state;
  }
  return { cond };
}

/** Pisahkan daftar selector di koma, kecuali koma yang di-escape (`\,`) atau di dalam kurung. */
function splitSelectors(prelude) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < prelude.length; i++) {
    const ch = prelude[i];
    if (ch === "\\") {
      cur += ch + (prelude[++i] ?? "");
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Baca hasil Tailwind: variabel tema dan rule per class. */
export function readTailwindCss(css) {
  const vars = {};
  const rules = new Map(); // class → { order, decls, cond } | { order, unsupported }
  let order = 0;
  const walk = (blocks, ctx) => {
    for (const b of blocks) {
      if (b.statement) continue;
      const p = b.prelude;
      if (p.startsWith("@property")) {
        const name = p.slice(9).trim();
        const init = declarations(b.inner).decls.find(([k]) => k === "initial-value");
        if (init && !(name in vars)) vars[name] = init[1];
        continue;
      }
      if (p.startsWith("@layer")) {
        walk(parseBlocks(b.inner), { ...ctx, layer: p.slice(6).trim() });
        continue;
      }
      if (p.startsWith("@media")) {
        walk(parseBlocks(b.inner), { ...ctx, media: [...(ctx.media ?? []), p] });
        continue;
      }
      if (p.startsWith("@supports")) {
        if (ctx.layer === "utilities") walk(parseBlocks(b.inner), ctx);
        continue;
      }
      if (p.startsWith("@")) {
        if (ctx.layer === "utilities") walk(parseBlocks(b.inner), { ...ctx, unsupported: p });
        continue;
      }
      const { decls, nested } = declarations(b.inner);
      if (ctx.layer === "theme" || /(^|,)\s*:root\b/.test(p)) {
        for (const [k, v] of decls) if (k.startsWith("--")) vars[k] = v;
        continue;
      }
      if (ctx.layer !== "utilities") continue;
      for (const sel of splitSelectors(p)) {
        // space-x/y-*, divide-*: `:where(.class > :not(:last-child))` → properti diberi awalan ">"
        const child = sel.match(/^:where\(\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[^\s.:#[\]>+~\\(),])+)\s*>\s*:not\(:last-child\)\)$/);
        const m = child ? [sel, child[1], ""] : sel.match(/^\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[^\s.:#[\]>+~\\(),])+)(.*)$/);
        if (!m) continue;
        const cls = unescapeCss(m[1]);
        const rest = m[2].trim();
        if (child) decls.forEach((d, i) => (decls[i] = [d[0].startsWith("--") ? d[0] : ">" + d[0], d[1]]));
        const prev = rules.get(cls);
        const at = prev?.order ?? order++;
        const bad = (why) => rules.set(cls, { order: at, unsupported: why });
        if (ctx.unsupported) {
          bad(ctx.unsupported);
          continue;
        }
        if (nested.some((x) => !x.prelude.startsWith("@supports"))) {
          bad("selector bersarang");
          continue;
        }
        if (rest && !/^:[a-z-]+$/.test(rest)) {
          bad(`selector ${rest}`);
          continue;
        }
        const v = variantCondition(ctx.media ?? [], rest || null);
        if (v.why) bad(v.why);
        else rules.set(cls, { order: at, decls: [...(prev?.decls ?? []), ...decls], cond: Object.keys(v.cond).length ? v.cond : undefined });
      }
    }
  };
  walk(parseBlocks(css), {});
  return { vars, rules };
}

// --- nilai CSS → nilai style ---

/** Ganti var(--x, fallback) secara rekursif. */
function resolveVars(value, vars, depth = 0) {
  if (depth > 20) return value;
  let out = "";
  let i = 0;
  while (i < value.length) {
    const k = value.indexOf("var(", i);
    if (k < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, k);
    let depthP = 1;
    let j = k + 4;
    while (j < value.length && depthP) {
      if (value[j] === "(") depthP++;
      else if (value[j] === ")") depthP--;
      j++;
    }
    const inner = value.slice(k + 4, j - 1);
    const comma = topLevelComma(inner);
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? undefined : inner.slice(comma + 1).trim();
    const v = vars[name] !== undefined && vars[name] !== "initial" ? vars[name] : fallback;
    out += v === undefined ? "" : resolveVars(v, vars, depth + 1);
    i = j;
  }
  return out.trim();
}

function topLevelComma(s) {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") d++;
    else if (s[i] === ")") d--;
    else if (s[i] === "," && d === 0) return i;
  }
  return -1;
}

/** Panjang dalam px (number) atau persen ("50%"). null kalau bukan panjang yang didukung. */
export function toLength(value) {
  const v = value.trim();
  if (v === "0") return 0;
  let m = v.match(/^(-?[\d.]+)(px|rem|em|%)?$/);
  if (m) {
    const n = parseFloat(m[1]);
    if (m[2] === "%") return `${round(n)}%`;
    return round(m[2] === "rem" || m[2] === "em" ? n * 16 : n);
  }
  m = v.match(/^calc\((.*)\)$/);
  if (m) {
    const percent = m[1].includes("%");
    // persen bercampur px (calc(100% - 16px)) tidak bisa jadi satu angka
    if (percent && /\d(px|rem|em)\b/.test(m[1])) return null;
    const expr = m[1]
      .replace(/calc\(/g, "(")
      .replace(/infinity/gi, "1e6")
      .replace(/(-?[\d.]+)(px|rem|em|%)/g, (_, n, u) => String(u === "rem" || u === "em" ? n * 16 : n));
    if (!/^[\d.eE+\-*/()\s]+$/.test(expr)) return null;
    const n = Function(`"use strict"; return (${expr});`)();
    if (!Number.isFinite(n)) return null;
    return percent ? `${round(n)}%` : round(Math.min(n, 9999));
  }
  return null;
}

const round = (n) => Math.round(n * 1000) / 1000;

const hex2 = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, "0");

function oklchToRgb(l, c, h) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return lin.map((x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(x, 0) ** (1 / 2.4) - 0.055));
}

/** Warna CSS → "#rrggbb" / "#rrggbbaa". null kalau tidak dikenal. */
const NAMED_COLORS = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00",
  orange: "#ffa500", purple: "#800080", pink: "#ffc0cb", gray: "#808080", grey: "#808080", cyan: "#00ffff",
  magenta: "#ff00ff", lime: "#00ff00", navy: "#000080", teal: "#008080", maroon: "#800000", olive: "#808000",
  silver: "#c0c0c0", gold: "#ffd700", indigo: "#4b0082", violet: "#ee82ee", brown: "#a52a2a", hotpink: "#ff69b4",
};

export function toColor(value) {
  const v = value.trim().toLowerCase();
  if (v === "transparent") return "#00000000";
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  let m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    return h.length === 6 || h.length === 8 ? `#${h}` : null;
  }
  m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return `#${[m[1], m[2], m[3]].map((x) => hex2(x / 255)).join("")}${alpha < 1 ? hex2(alpha) : ""}`;
  }
  m = v.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/);
  if (m) {
    const l = m[2] ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
    const rgb = oklchToRgb(l, parseFloat(m[3]), parseFloat(m[4]));
    const alpha = m[5] === undefined ? 1 : m[6] ? parseFloat(m[5]) / 100 : parseFloat(m[5]);
    return `#${rgb.map(hex2).join("")}${alpha < 1 ? hex2(alpha) : ""}`;
  }
  // Modifier opacity Tailwind: color-mix(in oklab, <warna> 50%, transparent)
  m = v.match(/^color-mix\(in [a-z]+,\s*(.+?)\s+([\d.]+)%,\s*transparent\s*\)$/);
  if (m) {
    const base = toColor(m[1]);
    if (!base) return null;
    const alpha = (base.length === 9 ? parseInt(base.slice(7), 16) / 255 : 1) * (parseFloat(m[2]) / 100);
    return base.slice(0, 7) + (alpha < 1 ? hex2(alpha) : "");
  }
  return null;
}

const KEYWORDS = {
  flexDirection: ["row", "column", "row-reverse", "column-reverse"],
  flexWrap: ["wrap", "nowrap"],
  alignItems: ["flex-start", "center", "flex-end", "stretch"],
  alignSelf: ["auto", "flex-start", "center", "flex-end", "stretch"],
  justifyContent: ["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"],
  textAlign: ["left", "center", "right"],
  position: ["relative", "absolute"],
  fontStyle: ["normal", "italic"],
  textDecorationLine: ["none", "underline", "line-through"],
  textTransform: ["none", "uppercase", "lowercase", "capitalize"],
  whiteSpace: ["normal", "nowrap"],
  textOverflow: ["clip", "ellipsis"],
  objectFit: ["cover", "contain", "fill"],
  pointerEvents: ["auto", "none"],
  userSelect: ["auto", "none", "text"],
};
const ALIAS = { start: "flex-start", end: "flex-end", "flex-start": "flex-start", "flex-end": "flex-end" };

const EASING = {
  "cubic-bezier(0.4,0,0.2,1)": "ease-in-out",
  "cubic-bezier(0.4,0,1,1)": "ease-in",
  "cubic-bezier(0,0,0.2,1)": "ease-out",
  linear: "linear",
  ease: "ease",
  "ease-in": "ease-in",
  "ease-out": "ease-out",
  "ease-in-out": "ease-in-out",
};

// Panjang yang boleh "auto" (margin) atau negatif.
const EDGE = {
  padding: "padding", "padding-inline": "paddingHorizontal", "padding-block": "paddingVertical",
  "padding-top": "paddingTop", "padding-right": "paddingRight", "padding-bottom": "paddingBottom", "padding-left": "paddingLeft",
  "padding-inline-start": "paddingLeft", "padding-inline-end": "paddingRight",
  margin: "margin", "margin-inline": "marginHorizontal", "margin-block": "marginVertical",
  "margin-top": "marginTop", "margin-right": "marginRight", "margin-bottom": "marginBottom", "margin-left": "marginLeft",
  "margin-inline-start": "marginLeft", "margin-inline-end": "marginRight",
  "margin-block-start": "marginTop", "margin-block-end": "marginBottom",
  gap: "gap", "column-gap": "columnGap", "row-gap": "rowGap",
  "border-radius": "borderRadius", "border-width": "borderWidth", "font-size": "fontSize",
  "border-top-left-radius": "borderTopLeftRadius", "border-top-right-radius": "borderTopRightRadius",
  "border-bottom-right-radius": "borderBottomRightRadius", "border-bottom-left-radius": "borderBottomLeftRadius",
  "border-start-start-radius": "borderTopLeftRadius", "border-start-end-radius": "borderTopRightRadius",
  "border-end-end-radius": "borderBottomRightRadius", "border-end-start-radius": "borderBottomLeftRadius",
  "border-top-width": "borderTopWidth", "border-right-width": "borderRightWidth",
  "border-bottom-width": "borderBottomWidth", "border-left-width": "borderLeftWidth",
};
// Properti logis Tailwind → beberapa properti fisik.
const MULTI = {
  "border-inline-width": ["borderLeftWidth", "borderRightWidth"],
  "border-block-width": ["borderTopWidth", "borderBottomWidth"],
  "border-inline-start-width": ["borderLeftWidth"],
  "border-inline-end-width": ["borderRightWidth"],
  inset: ["top", "right", "bottom", "left"],
  "inset-inline": ["left", "right"],
  "inset-block": ["top", "bottom"],
  "inset-inline-start": ["left"],
  "inset-inline-end": ["right"],
};
const SIZE = {
  width: "width", height: "height", "min-width": "minWidth", "max-width": "maxWidth",
  "min-height": "minHeight", "max-height": "maxHeight", top: "top", right: "right", bottom: "bottom", left: "left",
};
const COLOR = { "background-color": "backgroundColor", color: "color", "border-color": "borderColor" };
// Hanya bermakna di web (kursor, seleksi teks, outline fokus browser); di device diabaikan.
const WEB_ONLY = new Set(["cursor", "outline-style", "overflow-wrap", "word-break", "text-wrap", "-webkit-font-smoothing", "-moz-osx-font-smoothing", "-webkit-box-orient", "appearance", "-webkit-appearance", "touch-action", "will-change"]);

/** "45deg", "calc(45deg * -1)", "0.5turn" → derajat. */
function toDegrees(value) {
  const v = value.replace(/calc\((.*)\)/, "$1").trim();
  const m = v.match(/^(-?[\d.]+)(deg|turn|rad)?(?:\s*\*\s*(-?[\d.]+))?$/);
  if (!m) return null;
  const n = parseFloat(m[1]) * (m[3] ? parseFloat(m[3]) : 1);
  return round(m[2] === "turn" ? n * 360 : m[2] === "rad" ? (n * 180) / Math.PI : n);
}

/** "95%" / "0.95" → 0.95 */
const toFraction = (v) => (/^-?[\d.]+%$/.test(v.trim()) ? round(parseFloat(v) / 100) : /^-?[\d.]+$/.test(v.trim()) ? round(parseFloat(v)) : null);

/** Lapisan box-shadow → [{ x, y, blur, spread, color }]. null kalau ada yang tidak dikenal (mis. inset). */
function shadowLayers(value) {
  const out = [];
  for (const layer of splitTop(value)) {
    const l = layer.trim();
    if (!l || l === "none") continue;
    if (/\binset\b/.test(l)) return null;
    const parts = splitSpaces(l);
    const color = parts.find((p) => toLength(p) === null);
    const nums = parts.filter((p) => p !== color).map((p) => toLength(p));
    if (nums.some((n) => typeof n !== "number") || nums.length < 2) return null;
    const c = color ? toColor(color) : "#000000";
    if (!c) return null;
    const [x, y, blur = 0, spread = 0] = nums;
    if (/^#[0-9a-f]{6}00$/.test(c) && !blur && !spread) continue; // 0 0 #0000: lapisan kosong
    out.push({ x, y, blur, spread, color: c });
  }
  return out;
}

function splitTop(value) {
  const out = [];
  let d = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") d++;
    else if (value[i] === ")") d--;
    else if (value[i] === "," && d === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out;
}

function splitSpaces(value) {
  const out = [];
  let d = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") d++;
    if (ch === ")") d--;
    if (/\s/.test(ch) && d === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const SYSTEM_FONTS = /^(ui-sans-serif|ui-serif|ui-monospace|system-ui|-apple-system|BlinkMacSystemFont|SFMono-Regular|Menlo|Monaco|Consolas|Georgia|Cambria|"?Times New Roman"?|Times|sans-serif|serif|monospace)$/i;

/**
 * Font Tailwind → "sans-serif" / "serif" / "monospace" kalau isinya font sistem (font-sans,
 * font-serif, font-mono), atau nama font pertama kalau tema memakai font sendiri (mis. "Inter").
 */
function fontFamily(value) {
  const list = splitTop(value).map((f) => f.trim().replace(/^["']|["']$/g, ""));
  if (!SYSTEM_FONTS.test(list[0])) return list[0];
  return list.find((f) => /^(sans-serif|serif|monospace)$/.test(f)) ?? (/mono/i.test(value) ? "monospace" : "sans-serif");
}

/** "linear-gradient(to right, red, #00f)" → bentuk baku dengan warna hex, atau null. */
function linearGradient(value) {
  const m = value.trim().match(/^linear-gradient\((.*)\)$/);
  if (!m) return null;
  const parts = splitTop(m[1]).map((x) => x.trim());
  let dir = "to bottom";
  if (/^to |deg$|turn$/.test(parts[0])) dir = parts.shift().replace(/\s+in\s+[a-z]+$/, "");
  const colors = parts.map(toColor);
  if (colors.length < 2 || colors.some((c) => !c)) return null;
  return `linear-gradient(${dir}, ${colors.join(", ")})`;
}

/** Deklarasi satu class → { style } atau { error }. */
export function classToStyle(decls, themeVars) {
  const vars = { ...themeVars };
  for (const [k, v] of decls) if (k.startsWith("--")) vars[k] = v;
  const own = new Set(decls.map(([k]) => k));
  const style = {};
  const color = (k, raw) => {
    const c = toColor(resolveVars(raw, vars));
    if (!c) return false;
    style[k] = c;
    return true;
  };
  // Variabel yang menggabungkan beberapa class (shadow + warnanya, ring, gradien).
  if (own.has("--tw-shadow")) {
    const layers = shadowLayers(resolveVars(vars["--tw-shadow"], { ...vars, "--tw-shadow-color": undefined }));
    if (!layers) return { error: `box-shadow: ${resolveVars(vars["--tw-shadow"], vars)} belum didukung di komponen xp` };
    style.__shadow = layers;
  }
  if (own.has("--tw-shadow-color") && !color("__shadowColor", vars["--tw-shadow-color"])) return { error: "warna shadow belum didukung" };
  if (own.has("--tw-ring-shadow")) {
    const m = resolveVars(vars["--tw-ring-shadow"], { ...vars, "--tw-ring-color": "#000", "--tw-ring-inset": "" }).match(/^0 0 0 (.+?) #000$/);
    const w = m ? toLength(m[1]) : null;
    if (typeof w !== "number") return { error: "ring ini belum didukung di komponen xp" };
    style.__ringWidth = w;
  }
  if (own.has("--tw-ring-color") && !color("__ringColor", vars["--tw-ring-color"])) return { error: "warna ring belum didukung" };
  if (own.has("--tw-ring-offset-width") || own.has("--tw-inset-shadow") || own.has("--tw-inset-ring-shadow")) {
    return { error: "ring-offset dan inset shadow belum didukung di komponen xp" };
  }
  if (own.has("--tw-gradient-position")) {
    style.__gradDir = vars["--tw-gradient-position"].replace(/\s+in\s+[a-z]+$/, "").trim();
  }
  for (const [v, key] of [["--tw-gradient-from", "__gradFrom"], ["--tw-gradient-via", "__gradVia"], ["--tw-gradient-to", "__gradTo"]]) {
    if (own.has(v) && !color(key, vars[v])) return { error: "warna gradien belum didukung" };
  }
  if (["--tw-gradient-from-position", "--tw-gradient-via-position", "--tw-gradient-to-position"].some((v) => own.has(v))) {
    return { error: "posisi warna gradien belum didukung di komponen xp" };
  }

  for (const [prop, raw] of decls) {
    if (prop.startsWith("--")) continue;
    const value = resolveVars(raw, vars);
    const fail = (why) => ({ error: why ?? `${prop.replace(/^>/, "")}: ${value} belum didukung di komponen xp` });

    // Anak kecuali yang terakhir: space-x/y (jarak) dan divide (garis pemisah).
    if (prop.startsWith(">")) {
      const p = prop.slice(1);
      if (/^margin-(block|inline)-(start|end)$/.test(p)) {
        const n = toLength(value);
        if (typeof n !== "number") return fail();
        if (n) style.gap = n;
      } else if (/^border-.*-width$/.test(p)) {
        const n = toLength(value);
        if (typeof n !== "number") return fail();
        if (n) {
          style.dividerWidth = n;
          style.__divideAxis = /right|left|inline/.test(p) ? "x" : "y"; // untuk CSS web
        }
      } else if (p === "border-color") {
        if (!color("dividerColor", raw)) return fail();
      } else if (!/-style$/.test(p)) return fail();
      continue;
    }

    if (prop in EDGE || prop in MULTI) {
      const keys = MULTI[prop] ?? [EDGE[prop]];
      if (value === "auto") {
        if (!/^margin/.test(prop) && !(prop in MULTI)) return fail();
        if (/^margin/.test(prop)) for (const k of keys) style[k] = "auto";
        continue; // inset: auto = bawaan
      }
      const n = toLength(value);
      const allowPercent = prop in MULTI;
      if (n === null || (typeof n === "string" && !allowPercent)) return fail();
      for (const k of keys) style[k] = n;
    } else if (prop in SIZE) {
      if (value === "auto" || value === "none" || value === "fit-content" || value === "max-content" || value === "min-content") {
        if (value === "auto" || value === "none") continue;
        return fail();
      }
      const vp = value.match(/^(-?[\d.]+)(d|s|l)?(vh|vw)$/);
      if (vp) {
        style[SIZE[prop]] = `${round(parseFloat(vp[1]))}${vp[3]}`;
        continue;
      }
      const n = toLength(value);
      if (n === null) return fail();
      style[SIZE[prop]] = n;
    } else if (prop in COLOR) {
      if (!color(COLOR[prop], raw)) {
        if (prop === "color" && value === "inherit") continue;
        return fail();
      }
    } else if (prop === "line-height") {
      const unitless = value.match(/^-?[\d.]+$/) ? parseFloat(value) : (() => {
        const m = value.match(/^calc\(([\d.\s/*+-]+)\)$/);
        return m ? Function(`return (${m[1]})`)() : null;
      })();
      if (unitless !== null && unitless !== undefined) style.__lineHeightRatio = round(unitless);
      else {
        const n = toLength(value);
        if (typeof n !== "number") return fail();
        style.lineHeight = n;
      }
    } else if (prop === "letter-spacing") {
      const m = value.match(/^(-?[\d.]+)em$/);
      if (m) style.__letterSpacingEm = round(parseFloat(m[1]));
      else {
        const n = value === "normal" ? 0 : toLength(value);
        if (typeof n !== "number") return fail();
        style.letterSpacing = n;
      }
    } else if (prop === "font-weight") {
      if (!/^\d+$/.test(value)) return fail();
      style.fontWeight = value;
    } else if (prop === "font-family") {
      style.fontFamily = fontFamily(value);
    } else if (prop === "opacity") {
      const n = value.endsWith("%") ? parseFloat(value) / 100 : parseFloat(value);
      if (Number.isNaN(n)) return fail();
      style.opacity = round(n);
    } else if (prop === "z-index") {
      if (value === "auto") continue;
      if (!/^-?\d+$/.test(value)) return fail();
      style.zIndex = Number(value);
    } else if (prop === "flex") {
      if (/^\d+$/.test(value)) style.flex = Number(value);
      else if (value === "none") Object.assign(style, { flexGrow: 0, flexShrink: 0 });
      else if (value === "auto") Object.assign(style, { flexGrow: 1, flexShrink: 1 });
      else if (/^\d+ \d+ (0|0%|auto)$/.test(value)) Object.assign(style, { flexGrow: Number(value.split(" ")[0]), flexShrink: Number(value.split(" ")[1]) });
      else return fail();
    } else if (prop === "flex-grow" || prop === "flex-shrink") {
      if (!/^\d+$/.test(value)) return fail();
      style[prop === "flex-grow" ? "flexGrow" : "flexShrink"] = Number(value);
    } else if (prop === "flex-basis") {
      if (value !== "auto" && value !== "0" && value !== "0%") return fail("basis-* belum didukung; pakai w-* atau flex-1");
    } else if (prop === "display") {
      // Semua elemen xp adalah kotak flex, jadi block/flex/inline-* sama saja.
      if (value === "none") style.display = "none";
      else if (value === "grid") style.display = "grid";
      else if (value === "-webkit-box") {
        // bagian dari line-clamp-*
      } else if (["flex", "block", "inline-flex", "inline-block", "inline"].includes(value)) style.display = "flex";
      else return fail(`display: ${value} belum didukung di komponen xp`);
    } else if (prop === "grid-template-columns") {
      const m = value.match(/^repeat\((\d+),\s*minmax\(0,\s*1fr\)\)$/);
      if (value === "none") continue;
      if (!m) return fail();
      style.gridColumns = Number(m[1]);
    } else if (prop === "grid-column") {
      const m = value.match(/^span (\d+) \/ span \d+$/);
      if (m) style.gridColumnSpan = Number(m[1]);
      else if (value === "1 / -1") style.gridColumnSpan = -1;
      else return fail();
    } else if (prop === "overflow" || prop === "overflow-x" || prop === "overflow-y") {
      if (value === "hidden" || value === "clip") style.overflow = "hidden";
      else if (value === "visible") style.overflow = "visible";
      else return fail(`${prop}: ${value} belum didukung; pakai <ScrollView> untuk konten yang bisa digulir`);
    } else if (prop === "aspect-ratio") {
      if (value === "auto") continue;
      const m = value.match(/^([\d.]+)\s*(?:\/\s*([\d.]+))?$/);
      if (!m) return fail();
      style.aspectRatio = round(parseFloat(m[1]) / (m[2] ? parseFloat(m[2]) : 1));
    } else if (prop === "-webkit-line-clamp") {
      if (value === "none" || value === "unset") continue;
      if (!/^\d+$/.test(value)) return fail();
      style.lineClamp = Number(value);
    } else if (prop === "translate") {
      // translate-x-* dan translate-y-* diatur lewat variabel masing-masing, jadi bisa digabung.
      if (value === "none") continue;
      for (const [v, key] of [["--tw-translate-x", "translateX"], ["--tw-translate-y", "translateY"]]) {
        if (!own.has(v)) continue;
        const n = toLength(resolveVars(vars[v], vars));
        if (n === null) return fail();
        style[key] = n;
      }
      if (!own.has("--tw-translate-x") && !own.has("--tw-translate-y")) {
        const parts = splitSpaces(value).map(toLength);
        if (parts.some((p) => p === null)) return fail();
        [style.translateX, style.translateY = 0] = parts;
      }
    } else if (prop === "scale") {
      if (value === "none") continue;
      for (const [v, key] of [["--tw-scale-x", "scaleX"], ["--tw-scale-y", "scaleY"]]) {
        if (!own.has(v)) continue;
        const n = toFraction(resolveVars(vars[v], vars));
        if (n === null) return fail();
        style[key] = n;
      }
      if (!own.has("--tw-scale-x") && !own.has("--tw-scale-y")) {
        const parts = splitSpaces(value).map(toFraction);
        if (parts.some((p) => p === null)) return fail();
        [style.scaleX, style.scaleY = parts[0]] = parts;
      }
    } else if (prop === "rotate") {
      if (value === "none") continue;
      const d = toDegrees(value);
      if (d === null) return fail();
      style.rotate = d;
    } else if (prop === "box-shadow") {
      // isinya dari variabel --tw-shadow / --tw-ring-shadow di atas
      if (!own.has("--tw-shadow") && !own.has("--tw-ring-shadow") && !own.has("--tw-shadow-color")) {
        const layers = shadowLayers(value);
        if (!layers) return fail();
        style.__shadow = layers;
      }
    } else if (prop === "background-image") {
      if (value === "none") style.backgroundImage = "none";
      else if (own.has("--tw-gradient-position")) {
        // bg-linear-*: arah di --tw-gradient-position, warna dari class from-/via-/to-
      } else {
        // nilai arbitrer: bg-[linear-gradient(...)]
        const g = linearGradient(value);
        if (!g) return fail("background-image selain gradien linear (tanpa posisi warna) belum didukung; pakai <Image>");
        style.backgroundImage = g;
      }
    } else if (prop === "border-style" || /^border-(top|right|bottom|left|inline|block)-style$/.test(prop)) {
      if (!["solid", "dashed", "dotted", "none"].includes(value)) return fail(`border ${value} belum didukung`);
      if (value === "none") style.borderWidth = 0;
      else if (prop === "border-style") style.borderStyle = value;
    } else if (prop === "text-decoration-line") {
      const v = value.trim();
      if (!KEYWORDS.textDecorationLine.includes(v)) return fail();
      style.textDecorationLine = v;
    } else if (prop === "-webkit-user-select" || prop === "user-select") {
      if (!KEYWORDS.userSelect.includes(value)) return fail();
      style.userSelect = value;
    } else if (prop === "cursor") {
      style.cursor = value;
    } else if (prop === "outline-style") {
      if (value !== "none") return fail();
      style.outlineStyle = "none";
    } else if (WEB_ONLY.has(prop)) {
      // tidak berpengaruh di device
    } else if (
      prop === "flex-direction" || prop === "flex-wrap" || prop === "align-items" || prop === "align-self" ||
      prop === "justify-content" || prop === "text-align" || prop === "position" || prop === "font-style" ||
      prop === "text-transform" || prop === "white-space" || prop === "text-overflow" || prop === "object-fit" ||
      prop === "pointer-events"
    ) {
      const key = prop.replace(/-(\w)/g, (_, c) => c.toUpperCase());
      let v = ALIAS[value] ?? (prop === "text-align" ? { start: "left", end: "right" }[value] ?? value : value);
      if (prop === "position" && value === "static") continue;
      if (prop === "white-space" && value === "nowrap") v = "nowrap";
      if (!KEYWORDS[key].includes(v)) return fail();
      style[key] = v;
    } else if (prop === "animation") {
      // Animasi bawaan Tailwind; keyframes sendiri belum bisa dijalankan di device.
      const name = value === "none" ? "none" : value.split(/\s+/)[0];
      if (!["none", "spin", "pulse", "bounce", "ping"].includes(name)) return fail(`animation ${name} belum didukung (yang didukung: animate-spin, animate-pulse, animate-bounce, animate-ping)`);
      style.animation = name;
    } else if (prop === "transition-duration") {
      const m = value.match(/^([\d.]+)(ms|s)$/);
      if (!m) return fail();
      style.transitionDuration = m[2] === "s" ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
    } else if (prop === "transition-timing-function") {
      const e = EASING[value.replace(/\s+/g, "")];
      if (!e) return fail();
      style.transitionTimingFunction = e;
    } else if (prop === "transition-property") {
      // xp menganimasikan properti yang sudah ditentukan (warna, opacity, ukuran, transform)
    } else {
      return fail();
    }
  }
  return { style };
}

// --- mencari class di sumber komponen ---

const SOURCE = /\.(m?[jt]sx?)$/;

/** File sumber komponen (tanpa node_modules) dan file CSS yang di-import (untuk @theme). */
async function componentGraph(file, runtimeDir) {
  const cssFiles = [];
  const result = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    jsx: "automatic",
    jsxImportSource: "@xp/runtime",
    logLevel: "silent",
    plugins: [
      {
        name: "xp-graph",
        setup(b) {
          b.onResolve({ filter: /^@xp\/runtime/ }, (a) => ({ path: a.path, external: true }));
          b.onResolve({ filter: /^[^./]/ }, (a) => ({ path: a.path, external: true }));
          b.onLoad({ filter: /\.css$/ }, (a) => {
            cssFiles.push(a.path);
            return { contents: "", loader: "js" };
          });
        },
      },
    ],
  });
  const files = Object.keys(result.metafile.inputs)
    .filter((f) => SOURCE.test(f) && !f.includes("node_modules"))
    .map((f) => path.resolve(f));
  return { files, cssFiles };
}

/** Semua string di file (kandidat class) dan class yang dipakai di atribut className (dengan lokasinya). */
function scanSource(text, fileName) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const strings = new Set();
  const used = [];
  const tokens = (s) => s.split(/\s+/).filter(Boolean);
  const collect = (node, inClassName, tag) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      for (const t of tokens(node.text)) {
        strings.add(t);
        if (inClassName) used.push({ cls: t, pos: node.getStart(), tag });
      }
    } else if (ts.isTemplateExpression(node)) {
      // Hanya token utuh: "p-4 ${x}" → p-4; "bg-${c}" tidak bisa ditentukan saat build.
      const parts = [node.head, ...node.templateSpans.map((s) => s.literal)];
      parts.forEach((part, i) => {
        const list = part.text.split(/(\s+)/);
        list.forEach((t, j) => {
          if (!t.trim()) return;
          const touchesBefore = j === 0 && i > 0;
          const touchesAfter = j === list.length - 1 && i < parts.length - 1;
          if (touchesBefore || touchesAfter) return;
          strings.add(t);
          if (inClassName) used.push({ cls: t, pos: part.getStart(), tag });
        });
      });
      node.templateSpans.forEach((s) => collect(s.expression, inClassName, tag));
      return;
    }
    if (ts.isJsxAttribute(node) && node.name.getText() === "className") {
      const el = node.parent.parent; // JsxAttributes → elemen pembuka
      const name = ts.isJsxOpeningElement(el) || ts.isJsxSelfClosingElement(el) ? el.tagName.getText() : undefined;
      ts.forEachChild(node, (child) => collect(child, true, name));
      return;
    }
    ts.forEachChild(node, (child) => collect(child, inClassName, tag));
  };
  collect(sf, false, undefined);
  const where = (pos) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(pos);
    return `${line + 1}:${character + 1}`;
  };
  return { strings, used: used.map((u) => ({ ...u, at: where(u.pos) })) };
}

/**
 * Tabel class → style untuk satu komponen xp, atau null kalau komponen tidak memakai className.
 * Format tabel: { [class]: [urutan, style] }.
 */
export async function xpClassTable(file, { projectDir, runtimeDir }) {
  const { files, cssFiles } = await componentGraph(file, runtimeDir);
  const strings = new Set();
  const used = [];
  for (const f of files) {
    const scan = scanSource(await readFile(f, "utf8"), f);
    scan.strings.forEach((s) => strings.add(s));
    used.push(...scan.used.map((u) => ({ ...u, file: f })));
  }
  if (!used.length) return null;

  // Tema: CSS Tailwind yang di-import komponen (boleh berisi @theme), atau tema bawaan.
  let source = "";
  for (const f of cssFiles) {
    const text = await readFile(f, "utf8");
    if (!TAILWIND.test(text) && !/@theme\b/.test(text)) {
      throw new Error(`${path.relative(process.cwd(), f)}: komponen xp tidak memakai file CSS. Pakai className (Tailwind) atau style. File CSS hanya boleh berisi konfigurasi Tailwind (@import "tailwindcss", @theme).`);
    }
    source += text + "\n";
  }
  if (!TAILWIND.test(source)) source = `@import "tailwindcss";\n${source}`;

  const css = await tailwindCss(source, file, [...strings], projectDir);
  const { vars, rules } = readTailwindCss(css);

  const table = {};
  const reasons = new Map();
  for (const [cls, rule] of rules) {
    if (rule.unsupported) {
      const prefix = cls.includes(":") ? `varian ${cls.slice(0, cls.lastIndexOf(":") + 1)} ` : "";
      reasons.set(cls, `${prefix}(${rule.unsupported}) belum didukung di komponen xp`);
      continue;
    }
    const r = classToStyle(rule.decls ?? [], vars);
    if (r.error) reasons.set(cls, r.error);
    else table[cls] = rule.cond ? [rule.order, r.style, rule.cond] : [rule.order, r.style];
  }

  // Keadaan hanya punya arti di elemen tertentu.
  const STATE_TAGS = { pressed: ["Pressable"], disabled: ["Pressable"], focus: ["TextInput"] };
  const errors = [];
  for (const u of used) {
    const where = `${path.relative(process.cwd(), u.file)}:${u.at}`;
    const entry = table[u.cls];
    if (!entry) {
      errors.push(`${where} className "${u.cls}": ${reasons.get(u.cls) ?? "bukan class Tailwind yang dikenal"}`);
      continue;
    }
    const state = entry[2]?.state;
    if (state && STATE_TAGS[state] && u.tag && !STATE_TAGS[state].includes(u.tag)) {
      errors.push(`${where} className "${u.cls}": varian ini hanya berlaku di <${STATE_TAGS[state].join("/")}>, bukan <${u.tag}>`);
    }
  }
  if (errors.length) throw new Error([...new Set(errors)].join("\n    "));

  // Class yang dipakai di className, plus string lain yang memang class valid (mis. disimpan di variabel).
  return table;
}
