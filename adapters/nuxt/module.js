// Modul Nuxt: cukup daftarkan di nuxt.config.
//   modules: ["@xp/nuxt"],
//   xp: { remotes: { ui: "https://cdn.kamu/xp" }, revalidate: 30, publicKey: "MFkw..." }
import { addVitePlugin, defineNuxtModule } from "@nuxt/kit";
import { syncRemotes, xp } from "@xp/vite";

/** Wrapper Vue untuk satu komponen remote. Props diteruskan apa adanya (harus bisa di-JSON-kan). */
const vue = {
  code: ({ base, name, revalidate, publicKey }) => `
import { defineComponent, h, onBeforeUnmount, onMounted, onUpdated, ref } from "vue";
import { useAsyncData } from "#app";
import { loadClient, plainProps, renderRemote } from "@xp/vite/runtime";

const BASE = ${JSON.stringify(base)};
const NAME = ${JSON.stringify(name)};

export default defineComponent({
  name: ${JSON.stringify(`XP(${name})`)},
  inheritAttrs: false,
  async setup(_, { attrs }) {
    const props = () => plainProps(attrs);
    const initial = JSON.stringify(props());
    const el = ref(null);
    let result = null; // { src, html } dari server
    let instance = null;
    let lastProps = initial;

    // PENTING: semua lifecycle hook didaftarkan SEBELUM await. Di setup async Vue,
    // hook yang didaftarkan setelah await tidak terhubung ke komponen (gagal diam-diam).

    // Client: muat bundle yang sama, ambil alih HTML (state & event jalan).
    onMounted(async () => {
      if (!result) return;
      try {
        const mod = await loadClient(result.src);
        if (!el.value) return;
        instance = mod.render(el.value, JSON.parse(lastProps));
        el.value.dataset.xpReady = "true";
      } catch (e) {
        console.error("[xp]", e); // gagal: HTML SSR tetap tampil
      }
    });
    // Parent mengubah props → update tanpa remount (state komponen tetap).
    onUpdated(() => {
      const next = JSON.stringify(props());
      if (next === lastProps) return;
      lastProps = next;
      instance?.update(JSON.parse(next));
    });
    onBeforeUnmount(() => instance?.unmount());

    // SSR: render HTML di server. Hasilnya ikut payload Nuxt, jadi client tidak render ulang.
    const { data, error } = await useAsyncData("xp:" + NAME + ":" + initial, () =>
      renderRemote(BASE, NAME, JSON.parse(initial), ${revalidate}, ${JSON.stringify(publicKey ?? null)}),
    );
    if (error.value) console.error("[xp]", error.value);
    result = data.value;

    // HTML hanya dipasang sekali; setelah mount, DOM di dalamnya milik runtime xp.
    const html = result?.html ?? "";
    return () => h("div", { ref: el, "data-xp": result?.src, style: "display:contents", innerHTML: html });
  },
});
`,
  dts: ({ spec, props }) =>
    `declare module ${JSON.stringify(spec)} {\n` +
    props.replace(/^/gm, "  ") +
    `\n  const Component: import("vue").DefineComponent<Props>;\n  export default Component;\n}`,
};

export default defineNuxtModule({
  meta: { name: "@xp/nuxt", configKey: "xp" },
  defaults: { remotes: {}, revalidate: 30, dir: ".xp", publicKey: null },
  async setup(options, nuxt) {
    const root = nuxt.options.rootDir;
    // Ambil manifest & tipe sekali saat Nuxt start/build (cache di .xp/ kalau remote mati).
    const synced = await syncRemotes({ remotes: options.remotes, root, dir: options.dir, framework: vue });
    nuxt.hook("prepare:types", ({ references }) => {
      references.push({ path: synced.dtsPath });
    });
    addVitePlugin(xp({ ...options, root, framework: vue, synced }));
  },
});
