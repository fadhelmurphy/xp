# xp-android: SDK Android + demo app

Memuat komponen xp dari URL dan merendernya dengan **Jetpack Compose**. Tanpa WebView dan tanpa React Native.

```kotlin
XPView(
    base = "https://cdn.kamu/xp",
    name = "promo-modal",
    props = mapOf("title" to "Kelas IELTS", "price" to 150000),
)
```

## Menjalankan demo di emulator

**1. Jalankan remote di WSL** (dari root repo `xp`):
```bash
npm run build && npm run serve      # http://localhost:4400
```

**2. Salin folder ini ke drive Windows.** Android Studio dan Gradle sering bermasalah dengan path `\\wsl.localhost\...`.
```bash
cp -r ~/projects/learn/xp/adapters/android /mnt/c/Users/<user-windows>/xp-android
```

**3. Buka di Android Studio:** *File → Open* → `C:\Users\<user-windows>\xp-android`. Tunggu Gradle sync selesai. Kalau Android Studio menawarkan upgrade AGP atau Kotlin, terima saja.

**4. Jalankan konfigurasi `demo`** di emulator (▶).

Yang seharusnya terlihat:
- Judul "App native (Jetpack Compose)" dan di bawahnya kartu **Kelas IELTS**. Kartu ini dimuat dari `http://10.0.2.2:4400`, yaitu alamat localhost laptop kalau dilihat dari emulator.
- Tap **Lihat detail** membuka **Dialog Android native**.
- Tombol **+ / −** mengubah jumlah peserta, total dihitung, dan muncul teks "Kuota penuh". Semua logika ini jalan di QuickJS di dalam app.
- Tombol back atau tap di luar dialog akan menutupnya (`onRequestClose`).

**Bukti komponennya dinamis:** ubah teks `"Lihat detail"` di `examples/promo-modal.tsx`, jalankan `npm run build`, lalu tap **Muat ulang dari URL** di app. Teksnya berubah tanpa build ulang app.

**Bukti tidak memakai WebView:** di Android Studio buka *Tools → Layout Inspector*. Yang muncul adalah tree Compose (`Column`, `Text`, `Dialog`), bukan `WebView`.

### Kalau gagal
| Gejala | Penyebab / solusi |
|---|---|
| "tidak bisa diakses" | `npm run serve` belum jalan, atau port 4400 dari WSL tidak diteruskan ke Windows. Coba buka `http://localhost:4400` di browser Windows. |
| HP fisik | Ganti `xpUrl` di `gradle.properties` dengan IP laptop, misalnya `http://192.168.1.10:4400`, dan pastikan satu jaringan Wi-Fi. |
| "protokol … tidak didukung" | Versi bundle di remote lebih baru dari SDK. Build ulang app. |
| "primitive yang belum didukung" | Komponen memakai primitive yang belum ada di SDK versi ini. |

Error lengkap bisa dilihat di **Logcat** dengan filter tag `XP`.

## Tes

```bash
./gradlew :xp-android:test
```
Tes ini memutar ulang sesi `promo-modal.session.json`, yaitu rekaman operasi UI dari bundle asli yang dijalankan di QuickJS (`tests/native-queue.test.ts` di repo xp). Tree Android harus sampai di state yang sama: modal terbuka, total Rp450.000, "Kuota penuh" muncul, dan tidak ada node yang bocor.

## Struktur

| File | Isi |
|---|---|
| `XPView.kt` | Composable publik dan pemetaan primitive ke Compose |
| `XPEngine.kt` | QuickJS (zipline), satu thread, `XP.mount/update/dispatch/unmount` |
| `XPLoader.kt` | `manifest.json` → bundle, verifikasi `sha256`, cek protokol & primitive |
| `XPTree.kt` | Menerapkan operasi `create/props/children/delete` (Kotlin murni) |
| `XPStyle.kt` | Parsing style (flex, padding, warna, ukuran) |
| `XPJson.kt` | JSON tanpa dependency |

| Primitive | Compose |
|---|---|
| `View` | `Column` / `Row` (sesuai `flexDirection`) |
| `Text` | `Text` |
| `Pressable` | container + `clickable` |
| `ScrollView` | `verticalScroll` / `horizontalScroll` |
| `TextInput` | `BasicTextField` |
| `Image` | Coil `AsyncImage` |
| `Modal` | `Dialog` |

Animasi: `transitionDuration` di style → `animateColorAsState`/`animateFloatAsState`; prop `entering` → `graphicsLayer` (alpha + translasi) yang dijalankan hanya untuk node yang muncul setelah mount.

## Batasan versi ini
- Layout memakai Column/Row Compose, belum Yoga. Flex dasar sudah didukung (direction, justify, align, gap, flex, padding, margin, ukuran, %), tapi belum `flexWrap` dan `position: absolute`.
- Satu QuickJS per `XPView`. Untuk banyak komponen di satu layar, nanti perlu berbagi runtime.
- `useEffect` dengan timer (`setTimeout`) belum didukung di device.
