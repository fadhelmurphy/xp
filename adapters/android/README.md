# xp-android: SDK Android + demo app

Memuat komponen xp dari URL dan merendernya dengan **Jetpack Compose**. Tanpa WebView dan tanpa React Native.

```kotlin
XPView(
    base = "https://cdn.kamu/xp",
    name = "promo-modal",
    props = mapOf("title" to "Kelas IELTS", "price" to 150000),
)
```

Parameter lain:

- `publicKey`: hanya terima manifest yang ditandatangani kunci ini (`xp keygen`, `xp build --sign`).
- `live`: untuk development. Sambung ke `xp dev` dan muat ulang setiap build baru, state `useState` dibawa.
- `nativeViews`: view native milik app yang bisa dipakai komponen lewat `<NativeView name="...">` (peta, video, kalender, custom view). Lihat [NativeView](../../docs/runtime.md#nativeview).

```kotlin
XPView(base = "http://10.0.2.2:4400", name = "promo-slider", live = BuildConfig.DEBUG)
```

## Memakai di project yang sudah ada

Syarat: minSdk 24 ke atas, compileSdk 36, Kotlin 2.x, dan Compose aktif di modul app. SDK ini belum terbit di Maven, jadi modulnya disambungkan langsung dari folder repo `xp`.

Untuk tim, jadikan repo `xp` git submodule di dalam project app (`git submodule add https://github.com/fadhelmurphy/xp xp`), supaya path di bawah bisa relatif (`file("xp/adapters/android/xp-android")`) dan sama di semua laptop.

**1. `settings.gradle.kts`**
```kotlin
include(":xp-android")
project(":xp-android").projectDir = file("C:/path/ke/xp/adapters/android/xp-android")
```

**2. `build.gradle.kts` (root).** Tambahkan plugin yang dipakai modul SDK, dengan versi yang sama dengan yang sudah ada di project kamu (lewati yang sudah ada):
```kotlin
plugins {
    id("com.android.library") version "<versi AGP project>" apply false
    id("org.jetbrains.kotlin.android") version "<versi Kotlin project>" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "<versi Kotlin project>" apply false
}
```

**3. `app/build.gradle.kts`**
```kotlin
dependencies {
    implementation(project(":xp-android"))
}
```

**4. Pasang di layar Compose**
```kotlin
import dev.xp.android.XPView

XPView(
    base = "https://cdn.kamu/xp", // folder dist/ hasil `xp build`
    name = "promo-modal",
    props = mapOf("title" to "Kelas IELTS", "price" to 150000),
    live = BuildConfig.DEBUG,     // debug: dari URL + xp dev; release: versi native di APK
)
```

App yang masih memakai XML/View bisa membungkusnya dengan `ComposeView`. Aktifkan Compose di modul app (`buildFeatures { compose = true }` dan plugin `org.jetbrains.kotlin.plugin.compose`), lalu:
```xml
<androidx.compose.ui.platform.ComposeView
    android:id="@+id/promo"
    android:layout_width="match_parent"
    android:layout_height="wrap_content" />
```
```kotlin
findViewById<ComposeView>(R.id.promo).setContent {
    XPView(base = "https://cdn.kamu/xp", name = "promo-modal")
}
```

**5. Komponen native di APK.** Di `app/build.gradle.kts`, di bawah blok `plugins { }`, lihat [Komponen native di build release](#komponen-native-di-build-release). Untuk mencoba dengan `xp serve` lokal, pakai `http://127.0.0.1:4400` (bukan `localhost`, yang di Windows bisa nyasar ke server lain lewat IPv6).

**6. Production**
- Sajikan `dist/` lewat https (CDN atau bucket). `android:usesCleartextTraffic="true"` hanya perlu saat mencoba remote lokal lewat `http://`.
- Tanda tangani bundle supaya app hanya menerima komponen dari kamu: `npx github:fadhelmurphy/xp keygen`, lalu `npx github:fadhelmurphy/xp build src --sign`, dan isi `publicKey` di `XPView`.
- Saat development, `live = BuildConfig.DEBUG` bersama `xp dev` membuat app memuat ulang setiap ada build baru.

## Komponen native di build release

`xp build` juga membuat versi Kotlin dari setiap komponen `@xp/runtime` (`<nama>.kotlin.<hash>.kt`, tercatat di `manifest.json` sebagai `kotlin`). Task Gradle `xpComponents` mengunduh file itu dari CDN saat app di-build, jadi yang masuk ke Play Store sudah kode native: tidak ada QuickJS dan tidak ada unduhan saat komponen tampil. Tim mobile tidak perlu menyalin file apa pun.

```kotlin
// app/build.gradle.kts, di bawah blok plugins { }
extra["xpRemote"] = "https://cdn.kamu/xp"                 // folder dist/ hasil `xp build`
extra["xpComponents"] = listOf("promo-modal", "promo-slider") // kosongkan = semua yang punya versi Kotlin
apply(from = "C:/path/ke/xp/adapters/android/xp-components.gradle")
```

Kalau bisa, versi Kotlin-nya **mode typed**: Kotlin bertipe (`Double`, `String`, class) yang dirender langsung tanpa QuickJS dan tanpa operasi UI. Kalau komponen memakai fitur di luar mode typed, versi Kotlin dinamis yang dipakai. Lihat [Mode typed](../../docs/runtime.md#mode-typed).

`XPView` tidak perlu diubah. Kalau komponen ada di build, versi Kotlin yang dipakai. Kalau tidak ada, komponen dimuat dari `base` seperti biasa. `live = true` selalu memakai bundle dari URL supaya `xp dev` tetap bisa dipakai.

- Task ini jalan sebelum setiap build (`preBuild`) dan selalu mengecek `manifest.json` terbaru. Isi setiap file dicek dengan `sha256` di manifest. Kalau CDN tidak bisa dihubungi, hasil unduhan sebelumnya yang dipakai.
- Cek berhasil: Build Output berisi `xp: N komponen native dari ... (manifest <waktu build>)` (komponen mode typed diberi tanda `(typed)`), dan Logcat `tag:XPView` menulis `Kotlin bertipe (mode typed)` atau `komponen terkompilasi (Kotlin, tanpa QuickJS)`. Paling meyakinkan: force stop app, nyalakan airplane mode, buka lagi; komponen native tetap tampil.
- Komponen baru di CDN baru masuk ke app di build berikutnya. Ini memang aturan Play Store dan App Store: kode native tidak boleh diunduh saat runtime.
- Komponen yang memakai fitur JS di luar jangkauan compiler (lihat [Kompilasi ke native](../../docs/runtime.md#kompilasi-ke-native)) tidak punya versi Kotlin. `xp build` memberi peringatan dan menyebut lokasinya, task Gradle juga, dan di app komponen itu tetap dimuat dari URL.
- R8/ProGuard: aturan keep sudah ikut dari `consumer-rules.pro` SDK.

Demo: `./gradlew :demo:installDebug -PxpNative` (dengan `npx github:fadhelmurphy/xp serve` jalan di komputer yang sama).

## Menjalankan demo di emulator

**1. Jalankan remote di WSL** (dari root repo `xp`):
```bash
npx github:fadhelmurphy/xp build examples -y
npx github:fadhelmurphy/xp serve      # http://localhost:4400
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
- Kartu **Pilih jadwal kelas** berisi kalender bawaan Android (`CalendarView`) yang didaftarkan app lewat `nativeViews`. Pilih tanggal, maka komponen menampilkan "Jadwal: …". Contoh `NativeView`: view native milik app di dalam komponen xp.

**Bukti komponennya dinamis:** ubah teks `"Lihat detail"` di `examples/promo-modal.tsx`, jalankan `npx github:fadhelmurphy/xp build examples -y`, lalu tap **Muat ulang dari URL** di app. Teksnya berubah tanpa build ulang app.

**Bukti tidak memakai WebView:** di Android Studio buka *Tools → Layout Inspector*. Yang muncul adalah tree Compose (`Column`, `Text`, `Dialog`), bukan `WebView`.

### Kalau gagal
| Gejala | Penyebab / solusi |
|---|---|
| "tidak bisa diakses" | `npx github:fadhelmurphy/xp serve` belum jalan, atau port 4400 dari WSL tidak diteruskan ke Windows. Coba buka `http://localhost:4400` di browser Windows. |
| HP fisik | Ganti `xpUrl` di `gradle.properties` dengan IP laptop, misalnya `http://192.168.1.10:4400`, dan pastikan satu jaringan Wi-Fi. |
| "protokol … tidak didukung" | Versi bundle di remote lebih baru dari SDK. Build ulang app. |
| "primitive yang belum didukung" | Komponen memakai primitive yang belum ada di SDK versi ini. |

Error lengkap bisa dilihat di **Logcat** dengan filter tag `XP`.

## Tes

```bash
./gradlew :xp-android:test
```
Tes ini memutar ulang sesi `promo-modal.session.json`, yaitu rekaman operasi UI dari bundle asli yang dijalankan di QuickJS (`tests/native-queue.test.ts` di repo xp). Tree Android harus sampai di state yang sama: modal terbuka, total Rp450.000, "Kuota penuh" muncul, dan tidak ada node yang bocor.

Tes lain: arah swipe (`XPGestureTest`), event `xp dev` (`XPDevEventsTest`), dan verifikasi tanda tangan manifest dari Node (`XPSignatureTest`, fixture `signed-manifest.json`).

## Struktur

| File | Isi |
|---|---|
| `XPView.kt` | Composable publik dan pemetaan primitive ke Compose |
| `XPEngine.kt` | QuickJS (zipline), satu thread, `XP.mount/update/dispatch/unmount/tick/snapshot` |
| `XPRuntime.kt` | Pilihan antara komponen terkompilasi dan QuickJS, dan pencarian registry `dev.xp.generated.XPComponents` |
| `compiled/` | Runtime untuk komponen terkompilasi: reconciler dan hooks (port dari `runtime/reconciler.ts`), nilai JS, dan builtin (String, Array, Math, JSON, Map, Set, ...) |
| `../xp-components.gradle` | Task `xpComponents`: unduh versi Kotlin komponen dari CDN saat build |
| `XPLoader.kt` | `manifest.json` → bundle, verifikasi `sha256` dan tanda tangan, cek protokol & primitive |
| `XPSignature.kt` | Verifikasi `manifest.sig` (ECDSA P-256) |
| `XPGesture.kt` | Arah swipe |
| `XPLive.kt`, `XPDevEvents.kt` | Sambungan ke `xp dev` untuk `live = true` |
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
| `NativeView` | view yang didaftarkan app di `nativeViews` (mis. `AndroidView`) |

Animasi: `transitionDuration` di style → `animateColorAsState`/`animateFloatAsState`; prop `entering` → `graphicsLayer` (alpha + translasi) yang dijalankan hanya untuk node yang muncul setelah mount.

## Batasan versi ini
- Layout memakai Column/Row Compose, belum Yoga. Flex dasar sudah didukung (direction, justify, align, gap, flex, padding, margin, ukuran, %), tapi belum `flexWrap` dan `position: absolute`.
- Satu QuickJS per `XPView`. Untuk banyak komponen di satu layar, nanti perlu berbagi runtime.
- Timer: `XPView` membaca `XP.nextTimer()` setelah setiap perubahan, menunggu dengan `delay`, lalu memanggil `XP.tick()`. Timer berhenti saat `XPView` keluar dari komposisi.
- Swipe dideteksi dengan `detectDragGestures`. Kode Compose ini, termasuk timer dan `live`, belum dikompilasi di sini.
- Komponen terkompilasi: runtime `compiled/` dan hasil compiler sudah dites dengan kotlinc di JVM, dibandingkan langkah demi langkah dengan bundle JS (`tests/native-kotlin.test.ts`). Penyambungannya ke `XPView` dan task Gradle di dalam build Android belum pernah dijalankan; task-nya sendiri sudah dicoba dengan Gradle di luar Android.
