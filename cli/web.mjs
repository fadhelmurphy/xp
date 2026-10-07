// Target web: komponen React, Vue, atau Svelte → satu file JS mandiri.
// Runtime framework ikut di dalam bundle, jadi konsumen tidak perlu memuat React/Vue/Svelte.
// Kontraknya sama dengan bundle web komponen xp:
//   renderHTML(props) → string HTML (boleh Promise)   — SSR
//   render(el, props) → { update(props), unmount() }  — hydrate/mount di browser
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { ASSETS, candidatesFrom, componentStyle, cssImportPlugin, inlineCss } from "./css.mjs";

export const FRAMEWORKS = ["react", "vue", "svelte"];

/** Deteksi jenis komponen dari ekstensi dan import-nya. */
export async function detectKind(file) {
  if (file.endsWith(".vue")) return "vue";
  if (file.endsWith(".svelte")) return "svelte";
  return (await jsxKind(file, new Set())) ?? "xp";
}

const IMPORTS = /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const REACT_JSX = /@jsxImportSource\s+react\b/;
const LOCAL_EXT = ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];

/** Paket React: "react" sendiri, atau library yang butuh React (MUI, emotion, styled-components, ...). */
function isReactPackage(spec, fromDir) {
  const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  if (name === "react" || name === "react-dom") return true;
  // Cari node_modules/<nama>/package.json ke atas (tidak lewat require.resolve: banyak paket
  // tidak meng-export package.json-nya).
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const pkgFile = path.join(dir, "node_modules", name, "package.json");
    if (existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
        return Boolean(pkg.peerDependencies?.react || pkg.dependencies?.react);
      } catch {
        return false;
      }
    }
    if (path.dirname(dir) === dir) return false;
  }
}

/**
 * "xp" kalau komponen (atau file lokal yang di-import-nya) memakai @xp/runtime, "react" kalau
 * memakai React atau library UI React. null kalau tidak ada petunjuk.
 */
async function jsxKind(file, seen) {
  if (seen.has(file)) return null;
  seen.add(file);
  const src = await readFile(file, "utf8").catch(() => null);
  if (src == null) return null;
  if (REACT_JSX.test(src)) return "react";
  const specs = [...src.matchAll(IMPORTS)].map((m) => m[1] ?? m[2] ?? m[3]);
  if (specs.some((s) => s === "@xp/runtime" || s.startsWith("@xp/runtime/"))) return "xp";
  const dir = path.dirname(file);
  if (specs.some((s) => !s.startsWith(".") && !s.startsWith("/") && isReactPackage(s, dir))) return "react";
  for (const s of specs.filter((x) => x.startsWith("."))) {
    for (const ext of LOCAL_EXT) {
      const f = path.resolve(dir, s + ext);
      if (!/\.[mc]?[jt]sx?$/.test(f) || !existsSync(f) || !statSync(f).isFile()) continue;
      const kind = await jsxKind(f, seen);
      if (kind) return kind;
      break;
    }
  }
  return null;
}

// Compiler diambil dari node_modules proyek pengguna (vue/svelte adalah dependency mereka).
function requireFrom(dir, id) {
  try {
    return createRequire(path.join(dir, "noop.js"))(id);
  } catch {
    throw new Error(`"${id}" tidak ditemukan. Install dulu di proyek komponen: npm i ${id.split("/")[0]}`);
  }
}

const shortHash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);

// CSS komponen dikumpulkan lewat modul virtual, lalu dipasang di <head> oleh entry.
const CSS_REGISTRY = `
const sheets = new Map();
export function addCss(id, css) { if (css) sheets.set(id, css); }
export function cssText() { return [...sheets.values()].join("\\n"); }
`;

const cssRegistryPlugin = {
  name: "xp-css",
  setup(build) {
    build.onResolve({ filter: /^xp:css$/ }, () => ({ path: "css", namespace: "xp-css" }));
    build.onLoad({ filter: /.*/, namespace: "xp-css" }, () => ({ contents: CSS_REGISTRY, loader: "js" }));
  },
};

// Build server styled-components meng-import "stream" (hanya untuk renderToNodeStream). SSR xp
// memakai renderToString, jadi cukup diganti modul kosong supaya bundle tetap mandiri.
const nodeStreamStub = {
  name: "xp-stream-stub",
  setup(build) {
    build.onResolve({ filter: /^(node:)?stream$/ }, () => ({ path: "stream", namespace: "xp-stub" }));
    build.onLoad({ filter: /.*/, namespace: "xp-stub" }, () => ({
      contents: "export class Readable {}\nexport class Writable {}\nexport class Transform {}\nexport default { Readable, Writable, Transform };",
      loader: "js",
    }));
  },
};

function vuePlugin(projectDir, cssCtx) {
  return {
    name: "xp-vue",
    setup(build) {
      const sfc = requireFrom(projectDir, "vue/compiler-sfc");
      build.onLoad({ filter: /\.vue$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        const { descriptor, errors } = sfc.parse(source, { filename: args.path });
        if (errors.length) return { errors: errors.map((e) => ({ text: String(e.message ?? e) })) };

        const id = shortHash(args.path);
        const scopeId = `data-v-${id}`;
        const scoped = descriptor.styles.some((s) => s.scoped);
        let code;
        let lang = "js";

        if (descriptor.script || descriptor.scriptSetup) {
          const script = sfc.compileScript(descriptor, {
            id,
            isProd: true,
            inlineTemplate: true,
            genDefaultAs: "__sfc__",
            templateOptions: { compilerOptions: { scopeId: scoped ? scopeId : undefined } },
          });
          code = script.content;
          lang = (descriptor.scriptSetup ?? descriptor.script).lang ?? "js";
          // <script> biasa + <template>: template belum ter-inline.
          if (!descriptor.scriptSetup && descriptor.template) {
            const tpl = sfc.compileTemplate({ source: descriptor.template.content, filename: args.path, id, scoped, isProd: true });
            code += "\n" + tpl.code.replace(/export function render/, "function render") + "\n__sfc__.render = render;";
          }
        } else {
          const tpl = sfc.compileTemplate({ source: descriptor.template?.content ?? "", filename: args.path, id, scoped, isProd: true });
          code = tpl.code.replace(/export function render/, "function render") + "\nconst __sfc__ = { render };";
        }
        if (scoped) code += `\n__sfc__.__scopeId = ${JSON.stringify(scopeId)};`;

        const parts = [];
        for (const st of descriptor.styles) {
          const source = await componentStyle(st.content, args.path, cssCtx);
          parts.push(sfc.compileStyle({ source, filename: args.path, id: scopeId, scoped: st.scoped }).code);
        }
        const css = await inlineCss(parts.join("\n"), args.path, projectDir);
        code += `\nimport { addCss as __addCss } from "xp:css";\n__addCss(${JSON.stringify(id)}, ${JSON.stringify(css)});`;
        code += "\nexport default __sfc__;";
        return { contents: code, loader: lang === "ts" ? "ts" : "js", resolveDir: path.dirname(args.path) };
      });
    },
  };
}

// Svelte dikompilasi dua kali: versi server (SSR) dan versi client (hydrate).
// Mode diteruskan ke komponen anak lewat pluginData.
function sveltePlugin(projectDir, cssCtx) {
  return {
    name: "xp-svelte",
    setup(build) {
      const { compile, preprocess } = requireFrom(projectDir, "svelte/compiler");
      build.onResolve({ filter: /\.svelte(\?.*)?$/ }, (args) => {
        const [file, query] = args.path.split("?");
        const mode = query === "server" || query === "client" ? query : args.pluginData?.mode ?? "client";
        return { path: path.resolve(args.resolveDir, file), namespace: `svelte-${mode}`, pluginData: { mode } };
      });
      build.onLoad({ filter: /.*/, namespace: "svelte-server" }, (args) => load(args, "server"));
      build.onLoad({ filter: /.*/, namespace: "svelte-client" }, (args) => load(args, "client"));

      async function load(args, mode) {
        let source = await readFile(args.path, "utf8");
        let result;
        try {
          // Tailwind di <style> (@apply, @reference "tailwindcss") diproses sebelum compile.
          source = (await preprocess(source, { style: async ({ content }) => ({ code: await componentStyle(content, args.path, cssCtx) }) }, { filename: args.path })).code;
          result = compile(source, { filename: args.path, generate: mode, css: "external", dev: false });
        } catch (e) {
          return { errors: [{ text: e.message, location: e.start ? { file: args.path, line: e.start.line, column: e.start.column } : null }] };
        }
        const id = shortHash(args.path);
        const css = await inlineCss(result.css?.code ?? "", args.path, projectDir);
        const contents =
          result.js.code + `\nimport { addCss as __addCss } from "xp:css";\n__addCss(${JSON.stringify(id)}, ${JSON.stringify(css)});`;
        return {
          contents,
          loader: "js",
          resolveDir: path.dirname(args.path),
          pluginData: { mode },
          warnings: result.warnings.map((w) => ({ text: w.message })),
        };
      }
    },
  };
}

// Pasang CSS: di HTML SSR sebagai <style> pertama; di browser dipindah ke <head> sebelum hydrate,
// supaya struktur DOM sama persis dengan yang dihasilkan framework.
const STYLE_HELPERS = `
import { cssText } from "xp:css";
const STYLE_ATTR = "data-xp-style";
function styleTag(id) {
  const css = cssText();
  return css ? '<style ' + STYLE_ATTR + '="' + id + '">' + css + "</style>" : "";
}
function hoistStyle(el, id) {
  const inline = el.querySelector("style[" + STYLE_ATTR + '="' + id + '"]');
  if (inline) inline.remove();
  if (typeof document === "undefined" || document.querySelector("head style[" + STYLE_ATTR + '="' + id + '"]')) return;
  const css = cssText();
  if (!css) return;
  const s = document.createElement("style");
  s.setAttribute(STYLE_ATTR, id);
  s.textContent = css;
  document.head.appendChild(s);
}
`;

// Dua entry per komponen: "client" (dimuat browser, untuk hydrate) dan "ssr" (dimuat server).
// Dipisah supaya browser tidak mengunduh renderer server, dan server tidak memuat scheduler client.
function entry(kind, file, styleId, side, opts = {}) {
  const imp = JSON.stringify(file);
  const id = JSON.stringify(styleId);
  const header = `${STYLE_HELPERS}\nexport const protocol = 1;\nexport const framework = ${JSON.stringify(kind)};\n`;
  const code = {
    react: {
      ssr: `
import C from ${imp};
import { createElement } from "react";
import { renderToString } from "react-dom/server.edge";
${
  opts.styled
    ? `import { ServerStyleSheet } from "styled-components";
export function renderHTML(props) {
  // styled-components: CSS yang dipakai selama render dikumpulkan lalu ikut HTML SSR.
  const sheet = new ServerStyleSheet();
  try {
    const html = renderToString(sheet.collectStyles(createElement(C, props)));
    return styleTag(${id}) + sheet.getStyleTags() + html;
  } finally {
    sheet.seal();
  }
}`
    : `export function renderHTML(props) { return styleTag(${id}) + renderToString(createElement(C, props)); }`
}`,
      client: `
import C from ${imp};
import { createElement } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
export function render(el, props) {
  hoistStyle(el, ${id});
  // <style> hasil SSR library CSS-in-JS (emotion, MUI, styled-components) ikut di dalam HTML
  // komponen. Pindahkan ke <head> sebelum hydrate supaya struktur DOM sama dengan render React.
  for (const s of el.querySelectorAll("style[data-emotion], style[data-styled]")) document.head.appendChild(s);
  let root;
  if (el.hasChildNodes()) root = hydrateRoot(el, createElement(C, props));
  else { root = createRoot(el); root.render(createElement(C, props)); }
  return { update: (p) => root.render(createElement(C, p)), unmount: () => root.unmount() };
}`,
    },
    vue: {
      ssr: `
import C from ${imp};
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
export async function renderHTML(props) {
  const app = createSSRApp({ render: () => h(C, props) });
  return styleTag(${id}) + (await renderToString(app));
}`,
      client: `
import C from ${imp};
import { createApp, createSSRApp, h, reactive } from "vue";
export function render(el, props) {
  hoistStyle(el, ${id});
  const state = reactive({ ...props });
  const app = (el.hasChildNodes() ? createSSRApp : createApp)({ render: () => h(C, state) });
  app.mount(el);
  return {
    update(p) {
      for (const k of Object.keys(state)) if (!(k in p)) delete state[k];
      Object.assign(state, p);
    },
    unmount: () => app.unmount(),
  };
}`,
    },
    svelte: {
      ssr: `
import Server from ${JSON.stringify(file + "?server")};
import { render as ssr } from "svelte/server";
export function renderHTML(props) { return styleTag(${id}) + ssr(Server, { props }).body; }`,
      client: `
import Client from ${JSON.stringify(file + "?client")};
import { createClassComponent } from "svelte/legacy";
export function render(el, props) {
  hoistStyle(el, ${id});
  const c = createClassComponent({ component: Client, target: el, props, hydrate: el.hasChildNodes() });
  return { update: (p) => c.$set(p), unmount: () => c.$destroy() };
}`,
    },
  }[kind];
  if (!code) throw new Error(`framework tidak dikenal: ${kind}`);
  return header + code[side];
}

/** Opsi esbuild untuk satu komponen framework (target web). side: "client" | "ssr". */
export function webBuildOptions({ kind, file, name, projectDir, side, css = { state: {}, candidates: null }, styled = false, emotion = false }) {
  const plugins = [cssRegistryPlugin, cssImportPlugin({ projectDir, ...css })];
  if (side === "ssr" && kind === "react") plugins.push(nodeStreamStub);
  const cssCtx = { projectDir, state: css.state, candidates: css.candidates };
  if (kind === "vue") plugins.push(vuePlugin(projectDir, cssCtx));
  if (kind === "svelte") plugins.push(sveltePlugin(projectDir, cssCtx));
  return {
    stdin: { contents: entry(kind, file, `${name}-${shortHash(file)}`, side, { styled }), resolveDir: path.dirname(file), loader: "js" },
    bundle: true,
    write: false,
    minify: true,
    metafile: true,
    format: "cjs", // dievaluasi loader adapter (new Function), tidak me-require apa pun
    // SSR React memakai build server library (bukan "browser"): emotion/MUI lalu menulis <style>
    // ke HTML SSR sendiri, tanpa konfigurasi.
    ...(side === "ssr" && kind === "react" ? { platform: "neutral", mainFields: ["module", "main"] } : { platform: "browser" }),
    target: "es2020",
    jsx: "automatic",
    // Komponen yang memakai emotion: prop `css` butuh JSX runtime milik emotion.
    jsxImportSource: emotion ? "@emotion/react" : "react",
    nodePaths: [path.join(projectDir, "node_modules")],
    define: {
      "process.env.NODE_ENV": '"production"',
      __VUE_OPTIONS_API__: "true",
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    },
    loader: ASSETS, // import gambar/font dari JS → data URL
    logLevel: "silent",
    plugins,
  };
}

/**
 * Build satu komponen framework. Kalau komponen memakai Tailwind, build diulang sekali: build
 * pertama mencari file sumber yang dipakai komponen, build kedua membuat CSS Tailwind hanya untuk
 * class yang ada di file-file itu.
 */
export async function buildWeb(params) {
  const state = { tailwind: false };
  const first = await build(webBuildOptions({ ...params, css: { state, candidates: null } }));
  const inputs = Object.keys(first.metafile.inputs);
  // styled-components butuh ServerStyleSheet di SSR supaya CSS-nya ikut HTML.
  const styled = params.side === "ssr" && params.kind === "react" && inputs.some((f) => /node_modules[\\/]styled-components[\\/]/.test(f));
  const emotion = params.kind === "react" && inputs.some((f) => /node_modules[\\/]@emotion[\\/]react[\\/]/.test(f));
  if (!state.tailwind && !styled && !emotion) return first;
  // Input dari namespace plugin (mis. "svelte-client:/a/b.svelte") tetap file sumber.
  const files = inputs
    .map((f) => f.replace(/^[\w-]+:(?=\/|[A-Za-z]:[\\/])/, "").replace(/\?.*$/, ""))
    .filter((f) => !/^[\w-]+:/.test(f) || /^[A-Za-z]:[\\/]/.test(f))
    .map((f) => path.resolve(f));
  const candidates = state.tailwind ? await candidatesFrom(files) : null;
  return build(webBuildOptions({ ...params, css: { state, candidates }, styled, emotion }));
}
