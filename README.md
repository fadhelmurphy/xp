# xp

Tulis komponen sekali, build, lalu muat lewat URL dari web, Android, atau iOS. Di mobile komponennya dirender native (Compose / SwiftUI), bukan WebView.

Ada dua jenis komponen:

- Komponen `@xp/runtime` (JSX + hooks). Hasil build-nya bisa dipakai di web dan di iOS/Android.
- Komponen React, Vue, atau Svelte biasa. Hanya untuk web. Runtime framework-nya ikut di bundle, jadi app pemakai tidak perlu memasang framework tersebut. Komponen Vue bisa dipakai di Next.js, komponen React bisa dipakai di Nuxt.

```bash
npx github:fadhelmurphy/xp build              # interaktif: pilih komponen dan target
npx github:fadhelmurphy/xp build src -t web    # langsung, tanpa pertanyaan
```

![xp build](docs/demo-build.gif)

## Daftar isi

- [CLI](#cli)
- [Komponen @xp/runtime](#komponen-xpruntime)
- [Komponen React, Vue, Svelte](#komponen-react-vue-svelte)
- [Contoh](#contoh)
- [Next.js](#nextjs)
- [Nuxt](#nuxt)
- [Android](#android)
- [iOS](#ios)
- [Cara kerja dan protokol](#cara-kerja-dan-protokol)
- [Status](#status)

## CLI

```
xp build [folder] [opsi]      build komponen (default: src)
xp list [folder]              tampilkan komponen dan jenisnya
xp serve [dist] [--port n]    sajikan hasil build, dengan CORS dan cache header
```

Opsi `build`:

```
-t, --target <t>   auto | web | crossplatform   (default: auto)
-o, --only a,b     hanya komponen tertentu (nama file tanpa ekstensi)
    --out <dir>    folder hasil (default: dist)
    --clean        hapus isi folder hasil dulu
-y, --yes          jangan tanya apa-apa
```

Kalau dijalankan di terminal tanpa `--target` atau `--only`, xp akan bertanya dulu: build semua komponen atau pilih sendiri (bisa satu atau beberapa), lalu targetnya.

Arti target:

- `auto`: komponen `@xp/runtime` dibuat untuk web + mobile, komponen React/Vue/Svelte untuk web.
- `web`: semua komponen, web saja.
- `crossplatform`: hanya komponen `@xp/runtime`. Komponen framework dilewati, atau error kalau dipilih secara eksplisit.

Tanpa `--clean`, hanya komponen yang di-build yang diganti. Komponen lain di manifest tetap ada.

Jenis komponen ditebak dari file:

| File | Jenis | Bisa untuk |
|---|---|---|
| `.tsx` / `.jsx` yang import `@xp/runtime` | xp | web, Android, iOS |
| `.tsx` / `.jsx` yang import `react` | React | web |
| `.vue` | Vue | web |
| `.svelte` | Svelte | web |

React, Vue, dan Svelte diambil dari `node_modules` proyekmu, jadi pasang dulu yang dibutuhkan (`npm i react react-dom`, `npm i vue`, `npm i svelte`).

Isi `dist/` setelah build:

```
manifest.json              daftar komponen, file terbaru, dan hash-nya
<nama>.<hash>.d.ts         tipe props, dipakai adapter untuk autocomplete
<nama>.web.<hash>.js       bundle browser
<nama>.ssr.<hash>.js       bundle server (React/Vue/Svelte saja)
<nama>.native.<hash>.js    bundle untuk QuickJS / JavaScriptCore (komponen xp saja)
```

Ukuran contoh yang ada di repo:

| Komponen | web | ssr | native |
|---|---|---|---|
| `promo-modal` (xp) | 11 kB | sama dengan web | 7 kB |
| `like-button` (React) | 220 kB | 219 kB | - |
| `rating-stars` (Vue) | 70 kB | 82 kB | - |
| `faq-list` (Svelte) | 64 kB | 30 kB | - |

Setiap bundle React/Vue/Svelte membawa runtime framework sendiri. Untuk satu dua komponen tidak masalah, tapi kalau satu halaman memuat banyak komponen React, ukurannya ikut berlipat.

### Development repo ini

```bash
npm install
npx github:fadhelmurphy/xp build examples -y   # build contoh ke dist/
npx github:fadhelmurphy/xp serve               # remote di :4400
npm test                                        # 27 test
npm run e2e                                     # tes app Next.js/Nuxt di Chromium (APP_URL=http://localhost:3300)
```

## Komponen @xp/runtime

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

Tidak perlu `import React`. Hooks yang tersedia: `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`.

Elemen yang bisa dipakai hanya `View`, `Text`, `Image`, `Pressable`, `ScrollView`, `TextInput`, dan `Modal`. Tag HTML akan ditolak TypeScript. Styling lewat prop `style`.

Di device tidak ada `document`, `window`, `fetch`, atau `Intl`. Kalau bundle native memakainya, build akan memberi peringatan.

### Animasi

Komponen cukup menentukan nilai akhirnya, animasinya dijalankan oleh platform masing-masing (CSS transition di web, `animate*AsState` di Android, `.animation` di iOS).

Transisi saat style berubah. Yang bisa dianimasikan: `backgroundColor`, `opacity`, `width`, `height`, `borderColor`, `color`.

```tsx
<View style={{
  backgroundColor: active ? "#1F6FEB" : "#D0D7DE",
  width: active ? 18 : 8,
  transitionDuration: 250,
  transitionTimingFunction: "ease-in-out",
}} />
```

Animasi masuk untuk elemen yang muncul setelah mount. Biasanya dipakai bersama `key` yang berganti:

```tsx
<View key={slideIndex} entering={{ opacity: 0, translateX: 28, duration: 320 }}>…</View>
```

`entering` sengaja tidak jalan di render pertama supaya HTML hasil SSR tidak berkedip saat hydrate. Animasi yang mengikuti gesture belum ada.

## Komponen React, Vue, Svelte

Tulis seperti biasa. Satu file satu komponen: default export untuk React, SFC untuk Vue dan Svelte. Hooks, `<script setup>`, runes, scoped CSS, dan transisi Svelte semuanya jalan.

```tsx
// src/like-button.tsx
import { useState } from "react";

export default function LikeButton({ initial = 12 }: { initial?: number }) {
  const [liked, setLiked] = useState(false);
  return <button onClick={() => setLiked(!liked)}>{liked ? "♥" : "♡"} {initial + (liked ? 1 : 0)}</button>;
}
```

```vue
<!-- src/rating-stars.vue -->
<script setup lang="ts">
import { ref } from "vue";
const value = ref(0);
</script>

<template>
  <button v-for="i in 5" :key="i" :class="{ on: i <= value }" @click="value = i">★</button>
</template>

<style scoped>.on { color: #bf8700; }</style>
```

```svelte
<!-- src/faq-list.svelte -->
<script>
  import { slide } from "svelte/transition";
  let open = $state(false);
</script>

<button onclick={() => (open = !open)}>Pertanyaan</button>
{#if open}<p transition:slide>Jawaban</p>{/if}
```

![React, Vue, dan Svelte di satu app Next.js](docs/demo-frameworks.gif)

Di app konsumen cara pakainya sama dengan komponen lain: `import LikeButton from "xp:ui/like-button"`. Server merender HTML pakai bundle `ssr`, lalu browser meng-hydrate pakai bundle `web`. CSS ikut di HTML dan dipindah ke `<head>` saat hydrate. Props harus bisa di-serialize ke JSON.

## Contoh

Semua ada di [`examples/`](examples).

| Komponen | Jenis | Keterangan |
|---|---|---|
| [`promo-modal`](examples/promo-modal.tsx) | xp | kartu promo dengan modal pendaftaran |
| [`promo-slider`](examples/promo-slider.tsx) | xp | slider dengan tombol, titik indikator, dan animasi |
| [`like-button`](examples/like-button.tsx) | React | tombol suka |
| [`rating-stars`](examples/rating-stars.vue) | Vue | rating bintang dengan scoped CSS |
| [`faq-list`](examples/faq-list.svelte) | Svelte | FAQ dengan `transition:slide` |

![promo-slider](docs/demo-slider.gif)

```tsx
import { Pressable, Text, View, useState } from "@xp/runtime";

export default function PromoSlider({ slides = DEFAULT_SLIDES }: Props) {
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const active = Math.min(index, slides.length - 1);
  const current = slides[active];

  return (
    <View style={{ gap: 12 }}>
      <View style={{ height: 160, padding: 20, borderRadius: 16, justifyContent: "flex-end",
                     backgroundColor: current.color, transitionDuration: 350 }}>
        <View key={active} entering={{ opacity: 0, translateX: 28 * direction, duration: 320 }}>
          <Text style={{ color: "#FFFFFF", fontSize: 22, fontWeight: "700" }}>{current.title}</Text>
        </View>
      </View>
      {/* tombol dan titik indikator: lihat examples/promo-slider.tsx */}
    </View>
  );
}
```

```tsx
<PromoSlider />
<PromoSlider slides={[{ title: "Promo Oktober", subtitle: "Diskon 20%", color: "#CF222E" }]} />
```

Swipe belum bisa karena `ScrollView` belum punya mode paging.

## Next.js

![Next.js](docs/demo-next.gif)

```bash
npm i @xp/next
```

```js
// next.config.mjs
import { withXP } from "@xp/next";

export default withXP({}, { remotes: { ui: "https://cdn.kamu/xp" }, revalidate: 30 });
```

```tsx
// app/page.tsx
import PromoModal from "xp:ui/promo-modal";

export default function Page() {
  return <PromoModal title="Kelas IELTS" price={150000} />;
}
```

Komponen dirender di server lalu di-hydrate di browser. Pakai di Server Component, dan props tidak bisa berisi function.

Beberapa hal yang perlu diketahui:

- `withXP` mengunduh file `.d.ts` ke `xp-env.d.ts`, jadi props yang salah langsung ketahuan oleh TypeScript.
- Manifest dicek ulang setiap `revalidate` detik. Deploy komponen baru langsung terpakai tanpa rebuild app.
- Bundle dicocokkan dengan `sha256` di manifest sebelum dijalankan.
- Kalau remote mati saat build, dipakai manifest terakhir yang tersimpan di `.xp/`.
- Remote cukup static hosting atau CDN dengan CORS. `manifest.json` di-cache sebentar, file ber-hash di-cache `immutable` (contohnya di `cli/serve.mjs`).

Menjalankan contoh di `examples-consumer/next-app`:

```bash
npx github:fadhelmurphy/xp build examples -y && npx github:fadhelmurphy/xp serve   # terminal 1
cd adapters/next && npm pack
cd ../../examples-consumer/next-app && npm install
npx next build && npx next start -p 3300           # terminal 2
APP_URL=http://localhost:3300 npm run e2e          # terminal 3, dari root repo
```

## Nuxt

![Nuxt](docs/demo-nuxt.gif)

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

Sama seperti di Next.js: SSR, hydrate, tipe props (cek dengan `nuxi typecheck`), dan update tanpa rebuild. SSR-nya lewat `useAsyncData`, jadi HTML ikut di payload dan tidak dirender ulang di client.

```bash
cd examples-consumer/nuxt-app && npm install && npx nuxt build
PORT=3400 node .output/server/index.mjs
APP_URL=http://localhost:3400 npm run e2e          # dari root repo
```

Untuk framework lain yang berbasis Vite (SvelteKit, Astro, dll.) bisa langsung pakai `@xp/vite`: `xp({ remotes, framework })`, di mana `framework.code()` membuat wrapper komponen dan `framework.dts()` membuat deklarasi tipenya. `@xp/vite/runtime` (`renderRemote`, `loadClient`) tidak terikat ke framework tertentu.

## Android

Bundle native dijalankan di QuickJS (zipline), lalu hasilnya dirender dengan Jetpack Compose. `Modal` jadi `Dialog`, `Pressable` jadi `clickable`, `TextInput` jadi `BasicTextField`.

```kotlin
// settings.gradle.kts
include(":xp-android")

// app/build.gradle.kts
dependencies {
    implementation(project(":xp-android"))
}
```

```xml
<!-- AndroidManifest.xml -->
<uses-permission android:name="android.permission.INTERNET" />
```

```kotlin
import dev.xp.android.XPView

@Composable
fun PromoScreen() {
    XPView(
        base = "https://cdn.kamu/xp",
        name = "promo-modal",
        props = mapOf("title" to "Kelas IELTS", "price" to 150000, "seats" to 3),
    )
}
```

`XPView` juga menerima `modifier`, `loading` (default `CircularProgressIndicator`), dan `error` untuk tampilan saat gagal memuat.

Props berupa `String`, angka, `Boolean`, `null`, `List`, atau `Map`. Kalau props berubah, komponen di-update tanpa remount, jadi state di dalamnya tidak hilang.

Dari emulator, server lokal diakses lewat `http://10.0.2.2:4400`. Demo app dan cara menjalankannya ada di [`adapters/android/README.md`](adapters/android/README.md).

## iOS

Bundle native dijalankan di JavaScriptCore bawaan iOS dan dirender dengan SwiftUI, tanpa dependency tambahan. `Modal` jadi `.sheet`, `Pressable` jadi `Button`, `TextInput` jadi `TextField`.

Tambahkan lewat Xcode: File > Add Package Dependencies > Add Local, pilih `adapters/ios`, lalu tambahkan library `XPKit` (iOS 16+).

```swift
import SwiftUI
import XPKit

struct PromoScreen: View {
    var body: some View {
        XPView(
            base: URL(string: "https://cdn.kamu/xp")!,
            name: "promo-modal",
            props: ["title": "Kelas IELTS", "price": 150000, "seats": 3]
        )
    }
}
```

Props berupa `String`, angka, `Bool`, `Array`, atau `Dictionary`. Sama seperti Android, perubahan props tidak me-remount komponen.

Untuk server `http://` saat development, tambahkan `NSAllowsLocalNetworking` di Info.plist. Simulator bisa langsung akses `http://localhost:4400`. Detail lain dan `swift test` ada di [`adapters/ios/README.md`](adapters/ios/README.md).

## Cara kerja dan protokol

```
komponen.tsx --xp build--> web.js     DOM (browser) / HTML (SSR)
                           native.js  QuickJS / JavaScriptCore -> operasi UI -> Compose / SwiftUI
```

Runtime (reconciler dan hooks) sama di semua platform. Runtime tidak menggambar apa pun, hanya menghasilkan daftar operasi UI. Yang menggambar adalah host di tiap platform.

Kalau mau membuat SDK sendiri, ini kontraknya (`runtime/protocol.ts`, referensi di `sdk-reference/tree.ts`):

1. Unduh `manifest.json`, ambil `components[nama].native.file`, cek `sha256`-nya.
2. Jalankan bundle tersebut di engine JS, lalu panggil `XP.mount(propsJson)`.
3. Kalau ada event, panggil `XP.dispatch(handlerKey, argsJson)`. Untuk props baru, `XP.update(propsJson)`. Untuk membongkar, `XP.unmount()`.
4. Setiap pemanggilan `XP.*` langsung mengembalikan string JSON berisi daftar batch. SDK cukup bisa `evaluate()`.

Opsional, SDK bisa memasang `globalThis.__xp_native = { send(batchJson) }`. Dengan itu batch dikirim lewat `send` dan `XP.*` mengembalikan `"[]"`.

Contoh batch:

```json
{ "v": 1, "ops": [
  ["create", 5, "Pressable"],
  ["props", 5, { "style": {}, "onPress": { "$fn": "5:onPress" } }],
  ["children", 0, [1]],
  ["delete", 7]
]}
```

| Op | Arti |
|---|---|
| `create id type` | buat node |
| `props id {...}` | hanya prop yang berubah. `null` artinya dihapus, `{"$fn": key}` artinya handler event |
| `children id [ids]` | urutan lengkap anak. Node `0` adalah root |
| `delete id` | hapus node |

Node `#text` berisi teks mentah. Gabungkan semua `#text` di dalam satu `Text` menjadi satu string.

## Status

Yang sudah dites:

- Runtime, protokol, host DOM/SSR/native, CLI, dan manifest. Bundle native dijalankan di QuickJS dan hasil tree-nya dicek di unit test.
- Target web untuk React, Vue, dan Svelte (SSR, hydrate, scoped CSS) di jsdom dan Chromium.
- Adapter Next.js dan Nuxt, end-to-end di Chromium.
- CLI dari proyek terpisah lewat `npm pack`, termasuk mode interaktif.

Yang belum:

- SDK Android: bagian tree, style, dan JSON sudah dites dengan kotlinc, tapi bagian Compose belum pernah dikompilasi atau dijalankan di emulator.
- SDK iOS: bundle native sudah jalan di JavaScriptCore (lewat Bun), tapi kode Swift belum dikompilasi. Jalankan `swift test` di Mac.
- Belum ada GIF demo untuk Android dan iOS.
- Layout di mobile belum memakai Yoga, jadi hasilnya bisa sedikit berbeda dari web.
- Belum ada swipe/gesture, `setTimeout` di device, dev server dengan HMR ke device, dan signing bundle.
- Hydration belum mengklaim node hasil SSR. Client merender ulang isi yang sama.
