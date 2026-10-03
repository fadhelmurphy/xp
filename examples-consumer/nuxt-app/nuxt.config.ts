export default defineNuxtConfig({
  compatibilityDate: "2026-10-01",
  modules: ["@xp/nuxt"],
  xp: {
    // Komponen dari tim lain, di-host di URL. Ganti dengan domain/CDN kalian.
    remotes: { ui: process.env.XP_UI_URL ?? "http://localhost:4400" },
    revalidate: 5, // detik; manifest dicek ulang → deploy remote terpakai tanpa rebuild app ini
  },
  devtools: { enabled: false },
  telemetry: false,
});
