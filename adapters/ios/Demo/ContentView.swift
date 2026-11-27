import SwiftUI
import UIKit
import XPKit

/// Kalender iOS (UIDatePicker) yang dipakai komponen `jadwal-kelas` lewat <NativeView name="calendar">.
struct Kalender: UIViewRepresentable {
    let ctx: XPNativeContext

    func makeUIView(context: Context) -> UIDatePicker {
        let picker = UIDatePicker()
        picker.datePickerMode = .date
        picker.preferredDatePickerStyle = .inline
        picker.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .valueChanged)
        return picker
    }

    func updateUIView(_ picker: UIDatePicker, context: Context) {
        context.coordinator.ctx = ctx
        if let ms = (ctx.props["minDate"] as? NSNumber)?.doubleValue {
            picker.minimumDate = Date(timeIntervalSince1970: ms / 1000)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(ctx: ctx) }

    final class Coordinator: NSObject {
        var ctx: XPNativeContext
        init(ctx: XPNativeContext) { self.ctx = ctx }

        @objc func changed(_ picker: UIDatePicker) {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            ctx.emit("select", f.string(from: picker.date))
        }
    }
}

/// View native milik app yang boleh dipakai komponen xp.
private let nativeViews: [String: XPNativeView] = [
    "calendar": { ctx in AnyView(Kalender(ctx: ctx)) },
]

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

                // Komponen yang memakai view native milik app (UIDatePicker).
                XPView(base: base, name: "jadwal-kelas", nativeViews: nativeViews)
                    .id("jadwal-\(reload)")

                // Ubah komponen → `npm run build` → tekan ini. Tanpa build ulang app.
                Button("Muat ulang dari URL") { reload += 1 }
                    .buttonStyle(.bordered)
            }
            .padding()
        }
        .background(Color(red: 0.965, green: 0.973, blue: 0.98))
    }
}
