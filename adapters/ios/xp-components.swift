// Komponen xp versi Swift, diambil dari CDN saat app di-build lalu ikut dikompilasi ke app.
// Di App Store komponennya sudah native: tidak ada JavaScriptCore dan tidak ada unduhan saat runtime.
//
// Build phase "Run Script" di target app, sebelum "Compile Sources":
//
//     export XP_REMOTE="https://cdn.kamu/xp"                 # folder dist/ hasil `xp build`
//     export XP_COMPONENTS="promo-modal promo-slider"        # kosong = semua yang punya versi Swift
//     xcrun --sdk macosx swift "$SRCROOT/../xp/adapters/ios/xp-components.swift" \
//         "$SRCROOT/App/XPComponents.generated.swift"
//
// File hasilnya cukup ditambahkan sekali ke target; isinya diganti setiap build.
import Foundation

func warn(_ message: String) { print("warning: xp: \(message)") }

func fail(_ message: String) -> Never {
    print("error: xp: \(message)")
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("pemakaian: xp-components.swift <file keluaran .swift>") }
let output = URL(fileURLWithPath: args[1])
let env = ProcessInfo.processInfo.environment
guard var remote = env["XP_REMOTE"], !remote.isEmpty else { fail("isi XP_REMOTE dengan URL folder dist/ hasil `xp build`") }
while remote.hasSuffix("/") { remote.removeLast() }
let wanted = (env["XP_COMPONENTS"] ?? "").split(whereSeparator: { $0 == " " || $0 == "," }).map(String.init)

func fetch(_ path: String) throws -> Data {
    guard let url = URL(string: "\(remote)/\(path)") else { throw NSError(domain: "xp", code: 1, userInfo: [NSLocalizedDescriptionKey: "URL tidak valid"]) }
    return try Data(contentsOf: url)
}

// SHA-256 tanpa CryptoKit, supaya script yang sama jalan di macOS dan Linux (CI).
func sha256(_ data: Data) -> String {
    let k: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]
    var h: [UInt32] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
    var msg = [UInt8](data)
    let bitLength = UInt64(msg.count) * 8
    msg.append(0x80)
    while msg.count % 64 != 56 { msg.append(0) }
    for i in (0..<8).reversed() { msg.append(UInt8((bitLength >> (UInt64(i) * 8)) & 0xff)) }
    func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }
    var w = [UInt32](repeating: 0, count: 64)
    for chunk in stride(from: 0, to: msg.count, by: 64) {
        for i in 0..<16 {
            w[i] = (0..<4).reduce(0) { $0 << 8 | UInt32(msg[chunk + i * 4 + $1]) }
        }
        for i in 16..<64 {
            let s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
            let s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
            w[i] = w[i - 16] &+ s0 &+ w[i - 7] &+ s1
        }
        var (a, b, c, d, e, f, g, hh) = (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7])
        for i in 0..<64 {
            let t1 = hh &+ (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) &+ ((e & f) ^ (~e & g)) &+ k[i] &+ w[i]
            let t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) &+ ((a & b) ^ (a & c) ^ (b & c))
            (hh, g, f, e, d, c, b, a) = (g, f, e, d &+ t1, c, b, a, t1 &+ t2)
        }
        for (i, v) in [a, b, c, d, e, f, g, hh].enumerated() { h[i] = h[i] &+ v }
    }
    return h.map { String(format: "%08x", $0) }.joined()
}

let manifest: [String: Any]
do {
    guard let m = try JSONSerialization.jsonObject(with: try fetch("manifest.json")) as? [String: Any] else { fail("manifest.json bukan object") }
    manifest = m
} catch {
    if FileManager.default.fileExists(atPath: output.path) {
        warn("\(remote)/manifest.json tidak bisa diambil (\(error.localizedDescription)); memakai komponen dari build sebelumnya")
        exit(0)
    }
    fail("gagal mengambil \(remote)/manifest.json: \(error.localizedDescription)")
}

let components = manifest["components"] as? [String: [String: Any]] ?? [:]
let names = wanted.isEmpty ? components.filter { $0.value["native"] != nil }.keys.sorted() : wanted
var sources: [String] = []
var entries: [String] = []
var typedEntries: [String] = []
for name in names {
    guard let c = components[name] else { fail("komponen '\(name)' tidak ada di \(remote)/manifest.json") }
    guard let swift = c["swift"] as? [String: Any], let file = swift["file"] as? String, let hash = swift["sha256"] as? String,
          let type = swift["type"] as? String
    else {
        warn("\(name) belum punya versi Swift (lihat peringatan xp build); di app tetap dimuat dari URL")
        continue
    }
    let data: Data
    do { data = try fetch(file) } catch { fail("gagal mengambil \(file): \(error.localizedDescription)") }
    guard sha256(data) == hash else { fail("isi \(file) tidak cocok dengan sha256 di manifest") }
    sources.append(String(decoding: data, as: UTF8.self))
    // Mode typed (Swift bertipe) dan mode dinamis punya registry sendiri.
    if swift["typed"] as? Bool == true {
        typedEntries.append("        \"\(name)\": \(type)(),")
    } else {
        entries.append("        \"\(name)\": \(type)(),")
    }
}

func dictionary(_ list: [String]) -> String { list.isEmpty ? "[:]" : "[\n\(list.joined(separator: "\n"))\n    ]" }
let text = """
// Dibuat oleh xp-components.swift dari \(remote). Jangan diubah manual.
import Foundation
import XPKit

\(sources.joined(separator: "\n"))
#if canImport(ObjectiveC)
@objc(XPGeneratedComponents)
public final class XPGeneratedComponents: NSObject, XPComponentRegistry, XPTypedRegistry {
    nonisolated(unsafe) public static let components: [String: XPCompiledComponent] = \(dictionary(entries))
    nonisolated(unsafe) public static let typedComponents: [String: XPTypedComponent] = \(dictionary(typedEntries))
}
#endif

"""
// Tulis hanya kalau isinya berubah, supaya Xcode tidak mengompilasi ulang tanpa perlu.
if (try? String(contentsOf: output, encoding: .utf8)) != text {
    try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
    try text.write(to: output, atomically: true, encoding: .utf8)
}
let label = names.compactMap { n -> String? in
    if typedEntries.contains(where: { $0.contains("\"\(n)\"") }) { return "\(n) (typed)" }
    return entries.contains(where: { $0.contains("\"\(n)\"") }) ? n : nil
}
print("xp: \(label.count) komponen native dari \(remote) (manifest \(manifest["builtAt"] ?? "?"))" + (label.isEmpty ? "" : ": " + label.joined(separator: ", ")))
