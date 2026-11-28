# XPKit: SDK iOS

Memuat komponen xp dari URL dan merendernya dengan **SwiftUI**. Tanpa WebView dan tanpa React Native. Logika komponen dijalankan di **JavaScriptCore** bawaan iOS, jadi tidak ada dependency pihak ketiga.

```swift
import XPKit

XPView(
    base: URL(string: "https://cdn.kamu/xp")!,
    name: "promo-modal",
    props: ["title": "Kelas IELTS", "price": 150000]
)
```

Parameter lain:

- `publicKey`: hanya terima manifest yang ditandatangani kunci ini (`xp keygen`, `xp build --sign`).
- `live`: untuk development. Sambung ke `xp dev` dan muat ulang setiap build baru, state `useState` dibawa.
- `nativeViews`: view native milik app yang bisa dipakai komponen lewat `<NativeView name="...">` (peta, video, kalender, custom view). Lihat [NativeView](../../docs/runtime.md#nativeview).

```swift
#if DEBUG
XPView(base: URL(string: "http://localhost:4400")!, name: "promo-slider", live: true)
#endif
```

## Memasang

Di Xcode: *File → Add Package Dependencies… → Add Local…*, lalu pilih folder ini (`adapters/ios`) dan tambahkan library **XPKit** ke target app. Butuh iOS 16+.

Kalau remote masih memakai `http://` (development), tambahkan ini di `Info.plist`:
```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
</dict>
```

## Komponen native di build release

`xp build` juga membuat versi Swift dari setiap komponen `@xp/runtime` (`<nama>.swift.<hash>.swift`, tercatat di `manifest.json` sebagai `swift`). Script `xp-components.swift` mengambil file itu dari CDN saat app di-build dan menggabungkannya jadi satu file di project, jadi yang masuk ke App Store sudah kode native: tanpa JavaScriptCore dan tanpa unduhan saat komponen tampil. Tim iOS tidak perlu menyalin file apa pun.

1. Di target app: *Build Phases → + → New Run Script Phase*, geser ke atas *Compile Sources*, isi:
   ```bash
   export XP_REMOTE="https://cdn.kamu/xp"            # folder dist/ hasil `xp build`
   export XP_COMPONENTS="promo-modal promo-slider"   # kosongkan = semua yang punya versi Swift
   xcrun --sdk macosx swift "$SRCROOT/../xp/adapters/ios/xp-components.swift" "$SRCROOT/XPComponents.generated.swift"
   ```
   Matikan *User Script Sandboxing* di Build Settings target, atau daftarkan script dan file keluaran di *Input Files* / *Output Files* phase ini.
2. Build sekali, lalu tambahkan `XPComponents.generated.swift` ke target app. Isinya diganti setiap build; file-nya tetap.

`XPView` tidak perlu diubah. Kalau komponen ada di file itu, versi Swift yang dipakai. Kalau tidak ada, komponen dimuat dari `base` seperti biasa. `live: true` selalu memakai bundle dari URL supaya `xp dev` tetap bisa dipakai.

- Setiap build mengecek `manifest.json` terbaru, dan isi setiap file dicek dengan `sha256` di manifest. Kalau CDN tidak bisa dihubungi, hasil build sebelumnya yang dipakai (dengan peringatan di Xcode).
- Komponen baru di CDN baru masuk ke app di build berikutnya. Ini aturan App Store (Guideline 2.5.2): kode native tidak boleh diunduh saat runtime.
- Komponen yang memakai fitur JS di luar jangkauan compiler (lihat [Kompilasi ke native](../../docs/runtime.md#kompilasi-ke-native)) tidak punya versi Swift dan tetap dimuat dari URL.

## Menjalankan demo di Simulator (butuh Mac + Xcode)

1. Di root repo `xp`, jalankan `npx github:fadhelmurphy/xp build examples -y` lalu `npx github:fadhelmurphy/xp serve`. Remote akan jalan di `http://localhost:4400`.
2. Di Xcode: *File → New → Project → iOS App*, beri nama `XPDemo`, pilih interface **SwiftUI**.
3. Tambahkan package lokal `adapters/ios` seperti langkah di atas.
4. Ganti isi `ContentView.swift` dengan [`Demo/ContentView.swift`](Demo/ContentView.swift), lalu tambahkan `NSAllowsLocalNetworking` ke Info.plist.
5. Jalankan di Simulator.

Yang seharusnya terlihat:
- Kartu **Kelas IELTS**.
- Tap **Lihat detail** membuka **sheet iOS native**, yang bisa ditutup dengan swipe ke bawah (`onRequestClose`).
- Tombol **+ / −** mengubah jumlah peserta, total dihitung, dan muncul teks "Kuota penuh". Semua logika ini jalan di JavaScriptCore.
- Kartu **Pilih jadwal kelas** berisi `UIDatePicker` yang didaftarkan app lewat `nativeViews`. Pilih tanggal, maka komponen menampilkan "Jadwal: …". Contoh `NativeView`: view native milik app di dalam komponen xp.
- Ubah teks di `examples/promo-modal.tsx`, jalankan `npx github:fadhelmurphy/xp build examples -y`, lalu tap **Muat ulang dari URL**. Teksnya berubah tanpa build ulang app.

**Bukti tidak memakai WebView:** di Xcode buka *Debug View Hierarchy*. Yang muncul adalah view SwiftUI (`Text`, `Button`, sheet), bukan `WKWebView`.

## Tes

```bash
cd adapters/ios
swift test
```
- `XPTreeTests` memutar ulang sesi rekaman dari QuickJS (`promo-modal.session.json`) dan memeriksa bahwa tree iOS sampai di state yang sama.
- `XPEngineTests` menjalankan **bundle `promo-modal` asli** di JavaScriptCore lewat `XPEngine`: mount, buka modal, hitung total, update props tanpa remount, lalu unmount.
- Tes lain: arah swipe, event `xp dev`, dan verifikasi tanda tangan manifest dari Node (fixture `signed-manifest.json`).

Fixture diperbarui dari root repo dengan `npm test && npm run sync-fixtures`.

## Pemetaan primitive

| Primitive | SwiftUI |
|---|---|
| `View` | `VStack` / `HStack` (sesuai `flexDirection`) |
| `Text` | `Text` |
| `Pressable` | `Button` (`.plain`) |
| `ScrollView` | `ScrollView` |
| `TextInput` | `TextField` / `SecureField` |
| `Image` | `AsyncImage` |
| `Modal` | `.sheet` (detent medium/large) |
| `NativeView` | view yang didaftarkan app di `nativeViews` (mis. `UIViewRepresentable`) |

Animasi: `transitionDuration` di style → `.animation(_:value:)` pada nilai yang berubah; prop `entering` → `opacity` + `offset` yang dianimasikan saat view muncul, hanya untuk node yang muncul setelah mount.

## Batasan versi ini
- Layout memakai stack SwiftUI, belum Yoga. Flex dasar sudah didukung (direction, justify, align, gap, flex, padding, margin, ukuran, %), tapi belum `flexWrap` dan `position: absolute`. Lebar persen selain 100% diperlakukan sebagai lebar penuh.
- `Modal` tampil sebagai sheet iOS, bukan dialog di tengah layar seperti di web/Android. Ini disengaja, karena sheet adalah pola modal standar iOS.
- Satu JSContext per `XPView`.
- Timer: `XPModel` membaca `XP.nextTimer()` setelah setiap perubahan, menunggu dengan `Task.sleep`, lalu memanggil `XP.tick()`.
- Swipe memakai `DragGesture` yang dipasang simultan, jadi `Button` tetap menerima tap.
- Kode SwiftUI, JavaScriptCore, timer, swipe, signing, dan `live` belum dikompilasi di sini. Jalankan `swift test` di Mac.
- Komponen terkompilasi: runtime `Sources/XPKit/Compiled` (Foundation saja), `XPTree`, hasil compiler, dan script `xp-components.swift` sudah dikompilasi dan dijalankan dengan swiftc di Linux; hasilnya dibandingkan langkah demi langkah dengan bundle JS (`tests/native-swift.test.ts`). Penyambungannya ke `XPView` dan build phase di Xcode belum pernah dijalankan.
