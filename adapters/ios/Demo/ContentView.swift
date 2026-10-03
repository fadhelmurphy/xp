import SwiftUI
import XPKit

/// Demo: komponen promo-modal yang sama dengan yang dipakai app Next.js, Nuxt, dan Android.
struct ContentView: View {
    // Simulator iOS bisa langsung mengakses localhost di Mac.
    // HP fisik: ganti dengan IP Mac di jaringan yang sama, mis. http://192.168.1.10:4400
    private let base = URL(string: "http://localhost:4400")!
    @State private var reload = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("App native (SwiftUI)").font(.title2.bold())
                Text("Komponen di bawah dimuat dari \(base.absoluteString)")
                    .font(.caption)
                    .foregroundColor(.secondary)

                XPView(base: base, name: "promo-slider")
                    .id("slider-\(reload)")

                XPView(base: base, name: "promo-modal", props: [
                    "title": "Kelas IELTS",
                    "price": 150000,
                    "seats": 3,
                ])
                .id(reload)

                // Ubah komponen → `npm run build` → tekan ini. Tanpa build ulang app.
                Button("Muat ulang dari URL") { reload += 1 }
                    .buttonStyle(.bordered)
            }
            .padding()
        }
        .background(Color(red: 0.965, green: 0.973, blue: 0.98))
    }
}
