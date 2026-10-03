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
- Ubah teks di `examples/promo-modal.tsx`, jalankan `npx github:fadhelmurphy/xp build examples -y`, lalu tap **Muat ulang dari URL**. Teksnya berubah tanpa build ulang app.

**Bukti tidak memakai WebView:** di Xcode buka *Debug View Hierarchy*. Yang muncul adalah view SwiftUI (`Text`, `Button`, sheet), bukan `WKWebView`.

## Tes

```bash
cd adapters/ios
swift test
```
- `XPTreeTests` memutar ulang sesi rekaman dari QuickJS (`promo-modal.session.json`) dan memeriksa bahwa tree iOS sampai di state yang sama.
- `XPEngineTests` menjalankan **bundle `promo-modal` asli** di JavaScriptCore lewat `XPEngine`: mount, buka modal, hitung total, update props tanpa remount, lalu unmount.

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

Animasi: `transitionDuration` di style → `.animation(_:value:)` pada nilai yang berubah; prop `entering` → `opacity` + `offset` yang dianimasikan saat view muncul, hanya untuk node yang muncul setelah mount.

## Batasan versi ini
- Layout memakai stack SwiftUI, belum Yoga. Flex dasar sudah didukung (direction, justify, align, gap, flex, padding, margin, ukuran, %), tapi belum `flexWrap` dan `position: absolute`. Lebar persen selain 100% diperlakukan sebagai lebar penuh.
- `Modal` tampil sebagai sheet iOS, bukan dialog di tengah layar seperti di web/Android. Ini disengaja, karena sheet adalah pola modal standar iOS.
- Satu JSContext per `XPView`.
- `useEffect` dengan timer (`setTimeout`) belum didukung di device.
