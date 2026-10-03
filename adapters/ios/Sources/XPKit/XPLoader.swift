import CryptoKit
import Foundation

/// Bundle native yang sudah diunduh dan diverifikasi.
public struct XPBundle {
    public let name: String
    public let file: String
    public let code: String
    public let primitives: [String]
}

/// Mengambil komponen dari remote hasil `xp build`:
///   <base>/manifest.json → components[name].native.file → <base>/<file>
/// File ber-hash di-cache di memori; manifest selalu diambil ulang.
public actor XPLoader {
    public static let shared = XPLoader()

    private let session: URLSession
    private var cache: [URL: String] = [:]

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func load(base: URL, name: String) async throws -> XPBundle {
        let manifestURL = base.appendingPathComponent("manifest.json")
        let manifestData = try await get(manifestURL)
        guard let manifest = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any] else {
            throw XPError.load("manifest.json tidak valid")
        }

        let proto = (manifest["protocol"] as? NSNumber)?.intValue
        guard proto == XPTree.protocolVersion else { throw XPError.protocolMismatch(proto) }

        guard let entry = (manifest["components"] as? [String: Any])?[name] as? [String: Any] else {
            throw XPError.load("komponen '\(name)' tidak ada di \(manifestURL.absoluteString)")
        }
        guard let native = entry["native"] as? [String: Any], let file = native["file"] as? String else {
            throw XPError.load("'\(name)' tidak punya bundle native")
        }

        // Cek kapabilitas: primitive yang dipakai komponen harus dikenal SDK ini.
        let primitives = entry["primitives"] as? [String] ?? []
        let unknown = primitives.filter { !XPTree.primitives.contains($0) }
        guard unknown.isEmpty else {
            throw XPError.load("'\(name)' memakai primitive yang belum didukung app ini: \(unknown.joined(separator: ", "))")
        }

        let url = base.appendingPathComponent(file)
        if let code = cache[url] {
            return XPBundle(name: name, file: file, code: code, primitives: primitives)
        }
        let data = try await get(url)
        if let expected = native["sha256"] as? String {
            let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            guard actual == expected else { throw XPError.load("hash \(file) tidak cocok dengan manifest, bundle ditolak") }
        }
        guard let code = String(data: data, encoding: .utf8) else { throw XPError.load("\(file) bukan UTF-8") }
        cache[url] = code
        return XPBundle(name: name, file: file, code: code, primitives: primitives)
    }

    private func get(_ url: URL) async throws -> Data {
        do {
            let (data, response) = try await session.data(from: url)
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                throw XPError.load("\(url.absoluteString) → HTTP \(http.statusCode)")
            }
            return data
        } catch let error as XPError {
            throw error
        } catch {
            throw XPError.load("\(url.absoluteString) tidak bisa diakses: \(error.localizedDescription)")
        }
    }
}
