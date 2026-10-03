# @xp/runtime

Komponen yang ditulis dengan `@xp/runtime` bisa dipakai di web, Android, dan iOS dari satu file. Cara menulisnya mirip React, tapi elemennya terbatas pada beberapa primitive yang punya padanan di semua platform.

```tsx
import { Pressable, Text, View, useState } from "@xp/runtime";

export default function Counter({ start = 0 }: { start?: number }) {
  const [n, setN] = useState(start);
  return (
    <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
      <Pressable onPress={() => setN(n - 1)}><Text>-</Text></Pressable>
      <Text style={{ fontSize: 18 }}>{n}</Text>
      <Pressable onPress={() => setN(n + 1)}><Text>+</Text></Pressable>
    </View>
  );
}
```

Simpan di `src/counter.tsx`, lalu `npx github:fadhelmurphy/xp build`. Tidak perlu `import React`.

## Aturan dasar

- Satu file satu komponen, dengan `export default`. Nama file jadi nama komponen (`counter.tsx` dipakai sebagai `xp:ui/counter`).
- Tipe parameter pertama komponen dipakai sebagai tipe props di app konsumen. Tulis tipenya dengan jelas.
- Props harus bisa di-JSON-kan: string, angka, boolean, `null`, array, object. Function tidak bisa dioper dari luar.
- Hanya primitive di bawah yang bisa dipakai. `<div>`, `<span>`, dan tag HTML lain ditolak TypeScript.
- Teks harus ada di dalam `<Text>`.
- Komponen kecil boleh dibuat di file yang sama, atau di file lain yang di-import. Simpan file bantu di subfolder (misalnya `src/lib/`), karena setiap file langsung di `src/` dianggap komponen sendiri.

## Primitive

| Primitive | Props | Web | Android | iOS |
|---|---|---|---|---|
| `View` | `style`, `children` | `div` | `Column` / `Row` | `VStack` / `HStack` |
| `Text` | `style`, `numberOfLines`, `children` | `span` | `Text` | `Text` |
| `Image` | `src`, `alt`, `style` | `img` | `AsyncImage` | `AsyncImage` |
| `Pressable` | `onPress`, `disabled`, `style`, `children` | `div` + click | `clickable` | `Button` |
| `ScrollView` | `horizontal`, `style`, `children` | `div` + overflow | `verticalScroll` / `horizontalScroll` | `ScrollView` |
| `TextInput` | `value`, `placeholder`, `onChangeText`, `secure`, `style` | `input` | `BasicTextField` | `TextField` / `SecureField` |
| `Modal` | `visible`, `onRequestClose`, `style`, `children` | overlay | `Dialog` | `.sheet` |

Semua primitive juga menerima `testID` (untuk tes) dan `entering` (animasi masuk, lihat [Animasi](#animasi)).

### View

Kontainer flexbox. Default-nya kolom (`flexDirection: "column"`), sama seperti React Native.

```tsx
<View style={{ flexDirection: "row", justifyContent: "space-between", padding: 16 }}>
  <Text>Kiri</Text>
  <Text>Kanan</Text>
</View>
```

### Text

`numberOfLines` memotong teks dengan elipsis.

```tsx
<Text style={{ fontSize: 16, fontWeight: "600", color: "#1F2328" }} numberOfLines={2}>
  {judul}
</Text>
```

### Image

Ukurannya perlu ditentukan lewat `style`, karena gambar dimuat setelah layout.

```tsx
<Image src="https://cdn.kamu/banner.png" alt="Banner promo" style={{ width: "100%", height: 160, borderRadius: 12 }} />
```

### Pressable

Area yang bisa ditekan. Isinya bebas.

```tsx
<Pressable onPress={kirim} disabled={!valid} style={{ padding: 12, backgroundColor: valid ? "#1F6FEB" : "#8C959F" }}>
  <Text style={{ color: "#FFFFFF" }}>Kirim</Text>
</Pressable>
```

### ScrollView

```tsx
<ScrollView horizontal style={{ gap: 8 }}>
  {produk.map((p) => <Kartu key={p.id} produk={p} />)}
</ScrollView>
```

Belum ada mode paging, jadi belum bisa dipakai untuk carousel yang digeser.

### TextInput

Selalu dipakai sebagai controlled input: simpan nilainya di state.

```tsx
const [email, setEmail] = useState("");

<TextInput value={email} onChangeText={setEmail} placeholder="Email" style={{ borderWidth: 1, borderColor: "#D0D7DE", padding: 10 }} />
<TextInput value={pin} onChangeText={setPin} placeholder="PIN" secure />
```

### Modal

Ditampilkan kalau `visible` bernilai `true`. `onRequestClose` dipanggil saat pengguna menutupnya (klik latar di web, tombol back di Android, swipe ke bawah di iOS). Ubah state-nya sendiri di situ.

```tsx
const [open, setOpen] = useState(false);

<Modal visible={open} onRequestClose={() => setOpen(false)}>
  <View style={{ padding: 20, gap: 12 }}>
    <Text>Isi modal</Text>
    <Pressable onPress={() => setOpen(false)}><Text>Tutup</Text></Pressable>
  </View>
</Modal>
```

## Hooks

| Hook | Keterangan |
|---|---|
| `useState(awal)` | state lokal. Setter menerima nilai atau fungsi `(prev) => baru` |
| `useEffect(fn, deps?)` | jalan setelah render. Boleh mengembalikan fungsi cleanup. Tidak jalan saat SSR |
| `useMemo(fn, deps)` | simpan hasil hitungan sampai `deps` berubah |
| `useCallback(fn, deps)` | sama dengan `useMemo(() => fn, deps)` |
| `useRef(awal)` | object `{ current }` yang tetap sama di setiap render |

Aturannya sama dengan React: panggil hooks di level atas komponen, jangan di dalam `if` atau loop. Komponen async dan `setState` berantai tanpa henti di dalam effect akan error.

## List dan key

Beri `key` pada elemen hasil `map`, supaya state tiap item tidak tertukar saat urutan berubah.

```tsx
{items.map((item) => (
  <View key={item.id}><Text>{item.nama}</Text></View>
))}
```

`key` yang diganti juga membuat elemen dibuat ulang. Ini berguna untuk memicu animasi `entering`, misalnya saat slide berganti.

`Fragment` tersedia lewat `<>...</>`.

## Style

Styling hanya lewat prop `style`, berupa object. Angka berarti pixel (dp di Android, pt di iOS).

| Kelompok | Properti |
|---|---|
| Layout | `flex`, `flexDirection` (`row`/`column`), `flexGrow`, `flexShrink`, `flexWrap`, `justifyContent`, `alignItems`, `alignSelf`, `gap` |
| Ukuran | `width`, `height` (angka atau `"50%"`), `minWidth`, `maxWidth`, `minHeight` |
| Jarak | `padding`, `paddingHorizontal`, `paddingVertical`, `margin`, `marginHorizontal`, `marginVertical` |
| Tampilan | `backgroundColor`, `borderRadius`, `borderWidth`, `borderColor`, `opacity` |
| Teks | `color`, `fontSize`, `fontWeight` (`"400"` sampai `"700"`), `lineHeight`, `textAlign` |
| Transisi | `transitionDuration` (ms), `transitionTimingFunction` |

Tulis warna sebagai hex (`"#1F6FEB"`, `"#1F6FEB80"` untuk transparan) supaya hasilnya sama di semua platform. Properti di luar daftar ini ditolak TypeScript.

Untuk style yang dipakai berulang, simpan di variabel biasa:

```tsx
const tombol = { padding: 12, borderRadius: 8, alignItems: "center" } as const;

<Pressable style={{ ...tombol, backgroundColor: "#1F6FEB" }}>…</Pressable>
```

## Animasi

Komponen cukup menentukan nilai akhirnya. Animasinya dijalankan oleh platform (CSS transition di web, `animate*AsState` di Android, `.animation` di iOS).

Transisi saat style berubah. Yang bisa dianimasikan: `backgroundColor`, `opacity`, `width`, `height`, `borderColor`, `color`.

```tsx
<View style={{ width: aktif ? 18 : 8, backgroundColor: aktif ? "#1F6FEB" : "#D0D7DE", transitionDuration: 250 }} />
```

Animasi masuk untuk elemen yang muncul setelah komponen tampil. Elemen bergerak dari nilai di `entering` ke posisi normalnya:

```tsx
<View key={index} entering={{ opacity: 0, translateX: 28, duration: 320 }}>…</View>
```

`entering` tidak jalan di render pertama, supaya HTML hasil SSR tidak berkedip.

## Yang tidak tersedia di device

Bundle native dijalankan di QuickJS (Android) dan JavaScriptCore (iOS), bukan di browser. Yang tidak ada:

- `document`, `window`, `localStorage`
- `fetch`, `XMLHttpRequest`. Data dikirim lewat props dari app.
- `Intl`. Format angka dan tanggal sebaiknya ditulis sendiri, jangan mengandalkan `toLocaleString`.
- `setTimeout` dan `setInterval`

`xp build` memberi peringatan kalau bundle native memakai API di atas.

## Contoh lengkap

- [`examples/promo-modal.tsx`](../examples/promo-modal.tsx): kartu promo, modal, state, tombol nonaktif, hitung total.
- [`examples/promo-slider.tsx`](../examples/promo-slider.tsx): slider dengan tombol, titik indikator, dan animasi.
