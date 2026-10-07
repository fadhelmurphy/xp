// className (Tailwind) di komponen xp, bagian yang ikut bundle: tabel class → style dari
// tailwind-xp.mjs dipakai saat render oleh modul jsx kecil per komponen.
//
// Style dari Tailwind boleh berisi kunci sementara (awalan "__") yang baru bisa dihitung setelah
// semua class digabung: tinggi baris & jarak huruf relatif ukuran font, shadow + warnanya, ring,
// dan gradien from/via/to. finishStyle mengubahnya menjadi style xp biasa.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import path from "node:path";

/** Gabung style `s` ke `into` (in place). Dipakai juga di runtime (lewat toString). */
export function mergeStyle(into, s) {
  const pairs = [
    ["lineHeight", ["__lineHeightRatio"]],
    ["letterSpacing", ["__letterSpacingEm"]],
    ["boxShadow", ["__shadow", "__shadowColor", "__ringWidth", "__ringColor"]],
    ["backgroundImage", ["__gradDir", "__gradFrom", "__gradVia", "__gradTo"]],
  ];
  for (const [final, parts] of pairs) {
    if (final in s) for (const p of parts) delete into[p];
    else if (parts.some((p) => p in s)) delete into[final];
  }
  return Object.assign(into, s);
}

/**
 * Kunci sementara → style akhir. `ctx.env` (hanya di device): { width, height } untuk satuan vh/vw.
 * Dipakai juga di runtime (lewat toString), jadi fungsi ini harus mandiri.
 */
export function finishStyle(s, ctx) {
  const round = (n) => Math.round(n * 100) / 100;
  const out = {};
  for (const k in s) if (k.slice(0, 2) !== "__") out[k] = s[k];
  const fontSize = typeof out.fontSize === "number" ? out.fontSize : (ctx && ctx.fontSize) || 16;
  if (s.__lineHeightRatio != null && out.lineHeight == null) out.lineHeight = round(fontSize * s.__lineHeightRatio);
  if (s.__letterSpacingEm != null && out.letterSpacing == null) out.letterSpacing = round(fontSize * s.__letterSpacingEm);
  if (out.boxShadow == null && ("__shadow" in s || "__ringWidth" in s)) {
    const layers = [];
    if (s.__ringWidth) layers.push("0px 0px 0px " + s.__ringWidth + "px " + (s.__ringColor || out.color || "#000000"));
    for (const l of s.__shadow || []) {
      layers.push(l.x + "px " + l.y + "px " + l.blur + "px " + l.spread + "px " + (s.__shadowColor || l.color));
    }
    out.boxShadow = layers.length ? layers.join(", ") : "none";
  }
  if (out.backgroundImage == null && s.__gradDir) {
    const none = "#00000000";
    const stops = [s.__gradFrom || none];
    if (s.__gradVia) stops.push(s.__gradVia);
    stops.push(s.__gradTo || none);
    out.backgroundImage = "linear-gradient(" + s.__gradDir + ", " + stops.join(", ") + ")";
  }
  if (ctx && ctx.env) {
    for (const k in out) {
      const m = typeof out[k] === "string" && out[k].match(/^(-?[\d.]+)(vh|vw)$/);
      if (m) out[k] = round((parseFloat(m[1]) / 100) * (m[2] === "vh" ? ctx.env.height : ctx.env.width));
    }
  }
  return out;
}

/**
 * Modul jsx per komponen. TABLE: class → [urutan, style, kondisi?, classCss?].
 *   kondisi.minWidth / maxWidth / dark  → dicocokkan dengan environment() (lebar layar, mode gelap)
 *   kondisi.state                       → pressedStyle / hoverStyle / focusStyle, atau digabung saat disabled
 *   classCss (hanya bundle web/SSR)     → [namaClass, kunci]: dipasang sebagai class CSS (varian dengan
 *                                         @media/pseudo asli, divide-*), jadi HTML SSR sudah benar
 *                                         sebelum JavaScript jalan.
 */
function runtimeSource(native) {
  return `
export { Fragment } from "@xp/runtime/jsx-runtime";
import { jsx as base } from "@xp/runtime/jsx-runtime";
import * as R from "@xp/runtime";
const NATIVE = ${native};
${mergeStyle.toString()}
${finishStyle.toString()}
const entries = Object.values(TABLE);
const BREAKPOINTS = [...new Set(entries.flatMap((e) => (e[2] && !e[3] ? [e[2].minWidth, e[2].maxWidth] : [])).filter((w) => w != null))];
const VIEWPORT = NATIVE && entries.some((e) => Object.values(e[1]).some((v) => typeof v === "string" && /v[hw]$/.test(v)));
if (R.registerBreakpoints) R.registerBreakpoints(BREAKPOINTS, VIEWPORT);
const env = () => (R.environment ? R.environment() : { width: 0, height: 0, dark: false });
const cache = new Map();
function matches(c, e) {
  if (c.minWidth != null && !(e.width >= c.minWidth)) return false;
  if (c.maxWidth != null && !(e.width < c.maxWidth)) return false;
  if (c.dark != null && c.dark !== e.dark) return false;
  return true;
}
function resolve(className) {
  const e = env();
  const key = className + "|" + BREAKPOINTS.map((w) => (e.width >= w ? 1 : 0)).join("") + (e.dark ? "d" : "") + (VIEWPORT ? e.width + "x" + e.height : "");
  let out = cache.get(key);
  if (out) return out;
  const list = String(className).split(/\\s+/).filter((c) => TABLE[c]).map((c) => TABLE[c]).sort((a, b) => a[0] - b[0]);
  out = { style: {}, classes: [], states: {} };
  for (const [, s, c, css] of list) {
    if (css) out.classes.push(css);
    else if (!c) mergeStyle(out.style, s);
    else if (matches(c, e)) {
      if (c.state) mergeStyle((out.states[c.state] ??= {}), s);
      else mergeStyle(out.style, s);
    }
  }
  cache.set(key, out);
  return out;
}
// Properti yang diatur style langsung menang atas class (seperti inline style di web).
const family = (k) => { const m = k.match(/^(padding|margin|border.*Width|border.*Radius|inset|top|right|bottom|left)/); return m ? m[1] : k; };
const same = (a, b) => a === b || (typeof a === "object" && JSON.stringify(a) === JSON.stringify(b));
export function jsx(type, props, key) {
  if (typeof type === "string" && props && props.className != null) {
    const { className, ...rest } = props;
    const r = resolve(className);
    const user = rest.style;
    const ctx = { env: NATIVE ? env() : null };
    const raw = mergeStyle({}, r.style);
    if (rest.disabled && r.states.disabled) mergeStyle(raw, r.states.disabled);
    if (user) mergeStyle(raw, user);
    const style = finishStyle(raw, ctx);
    if (Object.keys(style).length) rest.style = style;
    const userKeys = user ? Object.keys(user).map(family) : [];
    for (const st of ["pressed", "hover", "focus"]) {
      if (!r.states[st]) continue;
      // Hasil akhir saat keadaan aktif, dikurangi yang sama dengan style biasa.
      const whole = finishStyle(mergeStyle(mergeStyle({}, raw), r.states[st]), { ...ctx, fontSize: style.fontSize });
      const own = {};
      for (const k in whole) if (!same(whole[k], style[k]) && !userKeys.includes(family(k))) own[k] = whole[k];
      const prop = st + "Style";
      if (Object.keys(own).length) rest[prop] = rest[prop] ? { ...own, ...rest[prop] } : own;
    }
    if (r.classes.length) {
      const keep = r.classes.filter(([, keys]) => !keys.some((k) => userKeys.includes(family(k))));
      if (keep.length) rest.__xpClass = keep.map(([n]) => n).join(" ");
    }
    props = rest;
  }
  return base(type, props, key);
}
export const jsxs = jsx;
export const jsxDEV = jsx;
`;
}

/**
 * Setiap import "@xp/runtime/jsx-runtime" dari kode komponen diarahkan ke modul className.
 * Tabelnya milik komponen ini saja, jadi tidak bercampur dengan komponen lain di halaman.
 */
export function classNamePlugin(table, { runtimeDir, native }) {
  return {
    name: "xp-classname",
    setup(b) {
      b.onResolve({ filter: /jsx-runtime(\.ts)?$/ }, (args) => {
        if (args.namespace === "xp-classname") return undefined; // modul ini sendiri: pakai jsx-runtime asli
        if (!/^@xp\/runtime\/jsx-runtime$/.test(args.path) && !args.path.startsWith(path.join(runtimeDir, "jsx-runtime"))) return undefined;
        if (args.importer.startsWith(runtimeDir)) return undefined; // file runtime sendiri
        return { path: "jsx", namespace: "xp-classname" };
      });
      b.onLoad({ filter: /.*/, namespace: "xp-classname" }, () => ({
        contents: `const TABLE = ${JSON.stringify(table)};\n${runtimeSource(native)}`,
        loader: "js",
        resolveDir: runtimeDir,
      }));
    },
  };
}

// styleToCss dari runtime (TypeScript), dimuat sekali untuk membuat CSS class di build.
let webStyle = null;
async function loadWebStyle(runtimeDir) {
  if (webStyle) return webStyle;
  const out = await build({
    entryPoints: [path.join(runtimeDir, "hosts", "web-style.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  webStyle = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
  return webStyle;
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

/**
 * Untuk bundle web dan SSR: class bervarian (sm:, md:, dark:, hover:, active:, focus:, disabled:)
 * dan divide-* jadi class CSS dengan @media / pseudo-class / selector anak asli, supaya HTML SSR
 * langsung tampil sesuai lebar layar dan mode gelap, dan hover/active ditangani browser sendiri.
 * Mengembalikan tabel web (entri itu diberi [namaClass, kunci]) dan teks CSS-nya.
 */
export async function webClassTable(table, file, runtimeDir) {
  if (!table) return { table: null, css: "" };
  const { styleToCss, KEYFRAMES } = await loadWebStyle(runtimeDir);
  const prefix = `xp${sha(file).slice(0, 6)}`;
  const out = {};
  const rules = [];
  let i = 0;
  let animated = false;
  const entries = Object.entries(table).sort((a, b) => a[1][0] - b[1][0]);
  for (const [cls, entry] of entries) {
    const [order, style, cond] = entry;
    if (style.animation) animated = true;
    const divider = "dividerWidth" in style || "dividerColor" in style;
    if (!cond && !divider) {
      out[cls] = entry;
      continue;
    }
    const s = finishStyle(style, {});
    const name = `${prefix}-${i++}`;
    const important = (css) => Object.entries(css).map(([k, v]) => `${k}:${v}!important`).join(";");
    let rule;
    if (divider) {
      // divide-y: garis di bawah setiap anak kecuali terakhir; divide-x: di kanan.
      const side = style.__divideAxis === "x" ? "right" : "bottom";
      const css = {};
      if (s.dividerWidth != null) Object.assign(css, { [`border-${side}-width`]: `${s.dividerWidth}px`, [`border-${side}-style`]: "solid" });
      if (s.dividerColor != null) css["border-color"] = s.dividerColor;
      rule = `.${name}>:not(:last-child){${important(css)}}`;
    } else {
      const css = styleToCss("", s);
      // Tinggi baris dari leading-* ikut ukuran font di CSS juga (tanpa satuan), sama seperti di native.
      if (style.__lineHeightRatio != null && style.lineHeight == null) css["line-height"] = String(style.__lineHeightRatio);
      if (style.__letterSpacingEm != null && style.letterSpacing == null) css["letter-spacing"] = `${style.__letterSpacingEm}em`;
      // Selector keadaan: spesifisitas sama dengan Tailwind (class + pseudo), jadi hover:/active:
      // menang atas varian layar seperti dark:, persis seperti di Tailwind biasa.
      const pseudo = { hover: ":hover", focus: ":focus", pressed: ":active", disabled: '[aria-disabled="true"]' }[cond.state] ?? "";
      rule = `.${name}${pseudo}{${important(css)}}`;
    }
    const media = [];
    if (cond?.minWidth != null) media.push(`(min-width:${cond.minWidth}px)`);
    if (cond?.maxWidth != null) media.push(`(max-width:${cond.maxWidth - 0.02}px)`);
    if (cond?.dark != null) media.push(`(prefers-color-scheme:${cond.dark ? "dark" : "light"})`);
    if (cond?.state === "hover") media.push("(hover:hover)");
    rules.push(media.length ? `@media ${media.join(" and ")}{${rule}}` : rule);
    out[cls] = [order, style, cond, [name, Object.keys(s)]];
  }
  if (animated) rules.unshift(KEYFRAMES);
  return { table: out, css: rules.join("\n") };
}
