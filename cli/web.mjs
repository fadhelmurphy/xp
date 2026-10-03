// Target web: komponen React, Vue, atau Svelte → satu file JS mandiri.
// Runtime framework ikut di dalam bundle, jadi konsumen tidak perlu memuat React/Vue/Svelte.
// Kontraknya sama dengan bundle web komponen xp:
//   renderHTML(props) → string HTML (boleh Promise)   — SSR
//   render(el, props) → { update(props), unmount() }  — hydrate/mount di browser
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export const FRAMEWORKS = ["react", "vue", "svelte"];

/** Deteksi jenis komponen dari ekstensi dan import-nya. */
export async function detectKind(file) {
  if (file.endsWith(".vue")) return "vue";
  if (file.endsWith(".svelte")) return "svelte";
  const src = await readFile(file, "utf8");
  if (/from\s+["']react["']|from\s+["']react\/|@jsxImportSource\s+react\b/.test(src)) return "react";
  return "xp";
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

function vuePlugin(projectDir) {
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

        const css = descriptor.styles
          .map((s) => sfc.compileStyle({ source: s.content, filename: args.path, id: scopeId, scoped: s.scoped }).code)
          .join("\n");
        code += `\nimport { addCss as __addCss } from "xp:css";\n__addCss(${JSON.stringify(id)}, ${JSON.stringify(css)});`;
        code += "\nexport default __sfc__;";
        return { contents: code, loader: lang === "ts" ? "ts" : "js", resolveDir: path.dirname(args.path) };
      });
    },
  };
}

// Svelte dikompilasi dua kali: versi server (SSR) dan versi client (hydrate).
// Mode diteruskan ke komponen anak lewat pluginData.
function sveltePlugin(projectDir) {
  return {
    name: "xp-svelte",
    setup(build) {
      const { compile } = requireFrom(projectDir, "svelte/compiler");
      build.onResolve({ filter: /\.svelte(\?.*)?$/ }, (args) => {
        const [file, query] = args.path.split("?");
        const mode = query === "server" || query === "client" ? query : args.pluginData?.mode ?? "client";
        return { path: path.resolve(args.resolveDir, file), namespace: `svelte-${mode}`, pluginData: { mode } };
      });
      build.onLoad({ filter: /.*/, namespace: "svelte-server" }, (args) => load(args, "server"));
      build.onLoad({ filter: /.*/, namespace: "svelte-client" }, (args) => load(args, "client"));

      async function load(args, mode) {
        const source = await readFile(args.path, "utf8");
        let result;
        try {
          result = compile(source, { filename: args.path, generate: mode, css: "external", dev: false });
        } catch (e) {
          return { errors: [{ text: e.message, location: e.start ? { file: args.path, line: e.start.line, column: e.start.column } : null }] };
        }
        const id = shortHash(args.path);
        const css = result.css?.code ?? "";
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
function entry(kind, file, styleId, side) {
  const imp = JSON.stringify(file);
  const id = JSON.stringify(styleId);
  const header = `${STYLE_HELPERS}\nexport const protocol = 1;\nexport const framework = ${JSON.stringify(kind)};\n`;
  const code = {
    react: {
      ssr: `
import C from ${imp};
import { createElement } from "react";
import { renderToString } from "react-dom/server.edge";
export function renderHTML(props) { return styleTag(${id}) + renderToString(createElement(C, props)); }`,
      client: `
import C from ${imp};
import { createElement } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
export function render(el, props) {
  hoistStyle(el, ${id});
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
export function webBuildOptions({ kind, file, name, projectDir, side }) {
  const plugins = [cssRegistryPlugin];
  if (kind === "vue") plugins.push(vuePlugin(projectDir));
  if (kind === "svelte") plugins.push(sveltePlugin(projectDir));
  return {
    stdin: { contents: entry(kind, file, `${name}-${shortHash(file)}`, side), resolveDir: path.dirname(file), loader: "js" },
    bundle: true,
    write: false,
    minify: true,
    metafile: true,
    format: "cjs", // dievaluasi loader adapter (new Function), tidak me-require apa pun
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    jsxImportSource: "react",
    nodePaths: [path.join(projectDir, "node_modules")],
    define: {
      "process.env.NODE_ENV": '"production"',
      __VUE_OPTIONS_API__: "true",
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    },
    logLevel: "silent",
    plugins,
  };
}
