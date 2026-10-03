# xp: komponen JSX → web + iOS + Android, di-load lewat URL

Tulis komponen sekali dengan JSX + hooks, lalu satu perintah build menghasilkan bundle untuk web dan native. Tanpa React, tanpa React Native, dan **tanpa WebView**.

```bash
npm install
npm run build   # xp build examples --out dist
npm test        # 17 test: QuickJS (native), SSR, DOM, reconciler
npm run serve   # xp serve dist --port 4400 (CORS + cache header)
npm run e2e     # app konsumen (Next.js/Nuxt) di Chromium, APP_URL=http://localhost:3300
```

```
dist/
  manifest.json                      → nama → file terbaru, hash, primitive yang dipakai
  promo-modal.<hash>.d.ts            → tipe props (untuk autocomplete di app konsumen)
  promo-modal.web.<hash>.js          → browser + SSR     (~10 kB, runtime ikut)
  promo-modal.native.<hash>.js       → QuickJS di iOS/Android (~6 kB, runtime ikut)
```

## Menulis komponen

```tsx
import { Modal, Pressable, Text, View, useState } from "@xp/runtime";

export default function PromoModal({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable onPress={() => setOpen(true)}><Text>{title}</Text></Pressable>
      <Modal visible={open} onRequestClose={() => setOpen(false)}>…</Modal>
    </View>
  );
}
```

- Tidak perlu `import React`: JSX runtime-nya milik xp.
- Hooks tersedia: `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`.
- Hanya boleh memakai primitive: `View`, `Text`, `Image`, `Pressable`, `ScrollView`, `TextInput`, `Modal`. Tag HTML ditolak oleh TypeScript.
- Di device tidak ada `document`, `window`, `fetch`, maupun `Intl`. Build memberi peringatan kalau bundle native memakainya.

## Konsumen web: Next.js (`@xp/next`)

```bash
npm i @xp/next
```
```js
// next.config.mjs
import { withXP } from "@xp/next";
export default withXP({}, { remotes: { ui: "https://cdn.kamu/xp" }, revalidate: 30 });
```
```tsx
// app/page.tsx: import seperti modul biasa
import PromoModal from "xp:ui/promo-modal";

export default function Page() {
  return <PromoModal title="Kelas IELTS" price={150000} />;
}
```

- **SSR:** HTML dirender di server, lalu bundle yang sama di-hydrate di browser (state dan event jalan).
- **Bertipe:** `withXP` mengunduh `.d.ts` ke `xp-env.d.ts`, jadi props yang salah langsung jadi error TypeScript.
- **Tanpa rebuild:** manifest dicek ulang tiap `revalidate` detik, sehingga deploy remote langsung terpakai.
- **Aman:** bundle diverifikasi dengan `sha256` dari manifest sebelum dijalankan.
- Pakai di **Server Component**. Props harus serializable (tidak bisa mengoper function).
- Remote mati saat build: dipakai manifest terakhir dari `.xp/`.
- Host remote cukup static hosting/CDN dengan CORS: `manifest.json` di-cache singkat, file ber-hash `immutable` (lihat `cli/serve.mjs`).

Contoh lengkap ada di `examples-consumer/next-app`. Untuk menjalankannya secara lokal:
```bash
npm run build && npm run serve                        # terminal 1: remote di :4400
cd adapters/next && npm pack                          # paket adapter (.tgz)
cd ../../examples-consumer/next-app && npm install
npx next build && npx next start -p 3300              # terminal 2
APP_URL=http://localhost:3300 npm run e2e             # terminal 3, dari root repo
```

## Konsumen web: Nuxt (`@xp/nuxt`)

```bash
npm i @xp/vite @xp/nuxt
```
```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@xp/nuxt"],
  xp: { remotes: { ui: "https://cdn.kamu/xp" }, revalidate: 30 },
});
```
```vue
<script setup lang="ts">
import PromoModal from "xp:ui/promo-modal";
</script>

<template>
  <PromoModal title="Kelas IELTS" :price="150000" />
</template>
```

Fiturnya sama dengan Next.js: SSR (lewat `useAsyncData`, sehingga HTML ikut payload dan client tidak merender ulang), hydrate, tipe props otomatis (`nuxi typecheck`), dan update tanpa rebuild. Contohnya ada di `examples-consumer/nuxt-app`:
```bash
cd examples-consumer/nuxt-app && npm install && npx nuxt build
PORT=3400 node .output/server/index.mjs
APP_URL=http://localhost:3400 npm run e2e    # dari root repo
```

Adapter framework lain yang berbasis Vite (SvelteKit, Astro, ...) cukup memakai `@xp/vite`: `xp({ remotes, framework })`, dengan `framework.code()` membuat wrapper komponen dan `framework.dts()` membuat deklarasi tipe. Runtime-nya (`@xp/vite/runtime`: `renderRemote`, `loadClient`) tidak bergantung pada framework.

## Cara kerja

```
komponen.tsx ──xp build──┬─ web.js    → DOM host (client) / HTML host (SSR)
                         └─ native.js → QuickJS di SDK → operasi UI → SwiftUI / Compose
```

Runtime (reconciler + hooks) sama untuk semua target. Ia tidak menggambar apa pun; ia hanya menghasilkan **operasi UI**. Yang menggambar adalah host di masing-masing platform.

## Protokol untuk SDK iOS/Android

Ini satu-satunya kontrak yang perlu diimplementasikan tim mobile (`runtime/protocol.ts`, acuannya `sdk-reference/tree.ts`).

**SDK → JS** (mode antrean, paling sederhana: SDK cukup bisa `evaluate(script)`)
1. Buat context QuickJS. Opsional: pasang `globalThis.__xp_native = { send(batchJson) }` untuk mode bridge.
2. Unduh `manifest.json` → `components[nama].native.file`, lalu verifikasi `sha256`-nya.
3. `eval(bundle)`, lalu panggil `XP.mount(propsJson)`.
4. Saat ada event: `XP.dispatch(handlerKey, argsJson)`.
5. Setiap `XP.*` mengembalikan string JSON berisi daftar batch, sinkron. Tidak perlu menjalankan microtask. (Mode bridge: batch dikirim lewat `send`, dan hasilnya `"[]"`.)

**JS → SDK**, lewat `send`:
```json
{ "v": 1, "ops": [
  ["create", 5, "Pressable"],
  ["props", 5, { "style": {…}, "onPress": { "$fn": "5:onPress" } }],
  ["children", 0, [1]],
  ["delete", 7]
]}
```

| Op | Arti |
|---|---|
| `create id type` | buat node primitive |
| `props id {…}` | prop yang berubah saja; `null` = hapus; `{"$fn": key}` = handler event |
| `children id [ids]` | urutan anak lengkap; node `0` = root |
| `delete id` | hapus node |

`#text` adalah teks mentah: gabungkan semua `#text` di dalam `Text` menjadi satu string. Layout dari `style` dihitung dengan Yoga (flexbox), lalu view SwiftUI/Compose ditempatkan sesuai hasilnya.

## Status

- **M1 (selesai, teruji):** runtime, protokol, host native/DOM/SSR, CLI build + manifest. Bundle native dijalankan di QuickJS, dan hasilnya (modal, state, total, kondisional, event, update props, unmount) diverifikasi lewat tree operasi.
- **Adapter Next.js & Nuxt (selesai, teruji di Chromium):** import `xp:ui/nama`, SSR + hydrate, tipe otomatis, update tanpa rebuild. Nuxt dibangun di atas `@xp/vite`, yang juga bisa dipakai untuk SvelteKit.
- **SDK Android (`adapters/android`):** `XPView(base, name, props)`, yang memakai QuickJS (zipline) + Jetpack Compose, plus demo app. Inti-nya (tree, style, JSON) teruji dengan kotlinc terhadap sesi rekaman QuickJS. Bagian Compose belum dikompilasi di sini; lihat `adapters/android/README.md`.
- **M2 sisa:** SDK iOS (QuickJS + SwiftUI), Yoga untuk layout identik.
- **M3:** dev server + HMR ke device, API plugin, signing bundle, pengecekan kapabilitas host, hydration yang mengklaim node SSR (saat ini client merender ulang isi yang identik).
