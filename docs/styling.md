# Styling

Cara styling tergantung jenis komponennya.

| Komponen | Cara styling | Jalan di |
|---|---|---|
| React, Vue, Svelte | CSS biasa, CSS modules, Tailwind, emotion, styled-components, MUI, dan library UI React lain | web |
| `@xp/runtime` | prop `style`, atau `className` berisi class Tailwind | web, Android, iOS |

## Komponen React, Vue, Svelte

Semua CSS ikut bundle komponen. Saat SSR, CSS ditulis sebagai `<style>` di HTML komponen, lalu dipindah ke `<head>` sebelum hydrate. App pemakai tidak perlu mengatur apa pun.

### CSS biasa dan CSS modules

```tsx
import "./card.css";
import s from "./card.module.css";

export default function Card() {
  return <div className="card"><h2 className={s.title}>Halo</h2></div>;
}
```

- `@import` di dalam file CSS ikut di-bundle.
- `url(./bg.png)`, font, dan SVG dijadikan data URL, jadi tidak ada file lain yang perlu disajikan.
- Nama class CSS modules diberi akhiran unik per file (`title_a1b2c3`), supaya tidak bentrok dengan komponen lain di halaman yang sama, termasuk dari remote lain.
- Di Vue dan Svelte, `<style>` dan `<style scoped>` tetap bekerja seperti biasa.

### Tailwind

Pakai Tailwind v4. Install di proyek komponen:

```bash
npm i -D tailwindcss @tailwindcss/node
```

Buat file CSS dan import dari komponen:

```css
/* src/styles/tw.css */
@import "tailwindcss";

@theme {
  --color-brand: #ff6600;
}
```

```tsx
import "./styles/tw.css";

export default function Promo() {
  return <div className="p-4 bg-brand rounded-lg hover:opacity-90">…</div>;
}
```

CSS yang dihasilkan hanya berisi class yang dipakai komponen itu dan file yang di-import-nya. Preflight (reset CSS bawaan Tailwind) sengaja tidak ikut, supaya komponen tidak mengubah tampilan halaman app pemakai. Kalau memang perlu, import sendiri: `@import "tailwindcss/preflight.css";`.

Di Vue dan Svelte, `@apply` di `<style>` juga bisa. Tambahkan `@reference` supaya Tailwind tahu temanya:

```vue
<style scoped>
@reference "tailwindcss";
.btn { @apply rounded-md bg-blue-500 text-white; }
</style>
```

### CSS-in-JS dan library UI

emotion, styled-components, dan library yang dibangun di atasnya (misalnya MUI) jalan tanpa konfigurasi tambahan:

- emotion dan MUI menulis `<style>` sendiri saat SSR.
- styled-components dikumpulkan dengan `ServerStyleSheet` saat SSR. xp menambahkannya otomatis kalau komponen memakai styled-components.
- Prop `css` dari emotion juga bisa dipakai (`/** @jsxImportSource @emotion/react */` atau cukup import dari `@emotion/react`).

Komponen yang memakai library React tanpa `import React` langsung tetap terdeteksi sebagai komponen React, karena xp melihat dependency library tersebut.

## Komponen @xp/runtime

Di device tidak ada CSS, jadi komponen xp memakai object `style` (lihat [runtime.md](runtime.md#style)). Kalau lebih nyaman dengan Tailwind, tulis `className`. Saat build, setiap class dikompilasi oleh Tailwind (termasuk tema, nilai arbitrer seperti `p-[18px]`, dan `@theme` milik proyek) lalu diubah menjadi `style`.

```tsx
import "./styles/tw.css"; // opsional: @theme proyek
import { Pressable, Text, View } from "@xp/runtime";

export default function Chip({ label }: { label: string }) {
  return (
    <View className="flex-row items-center gap-2 p-4 md:p-6 bg-white dark:bg-gray-900 rounded-xl shadow-md">
      <Pressable className="px-4 py-2 rounded-full bg-brand active:scale-95 transition-transform">
        <Text className="text-white font-semibold uppercase tracking-wide">{label}</Text>
      </Pressable>
    </View>
  );
}
```

`style` dan `className` boleh dipakai bersamaan. Kalau keduanya mengatur hal yang sama, `style` menang, sama seperti inline style di web.

File CSS yang di-import komponen xp hanya boleh berisi konfigurasi Tailwind (`@import "tailwindcss"`, `@theme`, dan sejenisnya). Tanpa file CSS, tema bawaan Tailwind dipakai.

### Varian

| Varian | Web | Android / iOS |
|---|---|---|
| `sm:` `md:` `lg:` `xl:` `2xl:` `max-*:` `min-[…]:`, breakpoint dari `@theme` | CSS `@media` | lebar layar dari SDK |
| `dark:` | `prefers-color-scheme` | mode gelap sistem |
| `hover:` | `:hover` | pointer (iPad, mouse) |
| `active:` | `:active` | sedang ditekan, di `Pressable` |
| `focus:` | `:focus` | sedang diketik, di `TextInput` |
| `disabled:` | `aria-disabled` | `Pressable` dengan `disabled` |

Di web, varian ditulis sebagai CSS asli, jadi HTML hasil SSR sudah benar sebelum JavaScript jalan (tidak ada lompatan tampilan saat hydrate). Di device, komponen dirender ulang saat layar melewati breakpoint atau mode gelap berubah. `active:`, `hover:`, dan `focus:` menjadi prop `pressedStyle`, `hoverStyle`, dan `focusStyle`, yang juga bisa ditulis langsung tanpa Tailwind.

### Class yang didukung

| Kelompok | Class |
|---|---|
| Layout | `flex` `block` `hidden` `grid` `grid-cols-*` `col-span-*` `flex-row` `flex-col` `*-reverse` `flex-wrap` `flex-1` `flex-auto` `flex-none` `grow` `shrink` `items-*` `self-*` `justify-*` `gap-*` `gap-x-*` `gap-y-*` `space-x-*` `space-y-*` |
| Posisi | `relative` `absolute` `inset-*` `top-*` `right-*` `bottom-*` `left-*` `z-*` `overflow-hidden` |
| Ukuran | `w-*` `h-*` `size-*` `min-w-*` `max-w-*` `min-h-*` `max-h-*` `aspect-*`, termasuk persen (`w-1/2`) dan layar (`h-screen`, `min-h-dvh`, `w-screen`) |
| Jarak | `p-*` `px-*` `py-*` `pt-*` … `m-*` … `mx-auto` `ml-auto` dan margin auto lainnya |
| Latar | `bg-*` (termasuk opacity `bg-blue-500/50`), gradien `bg-linear-to-*` / `bg-linear-45` + `from-*` `via-*` `to-*`, `bg-[linear-gradient(...)]` |
| Border | `border` `border-*` (per sisi juga: `border-t-2`), `border-dashed` `border-dotted`, warna border, `rounded-*` (per sisi dan pojok: `rounded-t-lg`, `rounded-bl-md`), `divide-x` `divide-y` + warnanya |
| Efek | `shadow-*` + warna shadow (`shadow-blue-500/40`), `ring-*` + warna ring, `opacity-*` |
| Transform | `scale-*` `scale-x-*` `scale-y-*` `translate-x-*` `translate-y-*` (termasuk persen) `rotate-*` |
| Animasi | `transition-*` `duration-*` `ease-*`, `animate-spin` `animate-pulse` `animate-bounce` `animate-ping` |
| Teks | `text-*` (ukuran dan warna), `font-*` (tebal dan keluarga), `leading-*` `tracking-*` `italic` `underline` `line-through` `no-underline` `uppercase` `lowercase` `capitalize` `text-left/center/right` `truncate` `line-clamp-*` `whitespace-nowrap` `text-ellipsis` |
| Gambar | `object-cover` `object-contain` `object-fill` |
| Khusus web | `cursor-*` `select-*` `outline-none` `pointer-events-none` (juga di iOS), `break-words`. Di device tidak berpengaruh. |

Class yang tidak bisa dijalankan di device membuat build gagal dengan pesan yang menyebut file, baris, dan alasannya, misalnya:

```
src/promo.tsx:12:24 className "blur-sm": filter: blur(8px) belum didukung di komponen xp
```

Yang termasuk di sini: filter dan `backdrop-*`, `shadow-inner` dan `ring-offset-*`, `overflow-auto` (pakai `<ScrollView>`), `group-*` dan `peer-*`, `before:` dan `after:`, animasi dengan keyframes sendiri, `grid-rows-*`, dan ukuran yang mencampur persen dengan px (`w-[calc(100%-16px)]`).

### Catatan perilaku di device

- `absolute` diposisikan terhadap parent langsung (seperti React Native), bukan elemen `relative` terdekat. Dalam praktik sama, karena biasanya `relative` dipasang di parent.
- `shadow-*`: Android memakai elevation dengan warna shadow; iOS memakai lapisan shadow dengan blur terbesar.
- `ring-*` digambar sebagai garis di luar kotak.
- Breakpoint memakai lebar layar (jendela), bukan lebar komponen, sama seperti di web.
