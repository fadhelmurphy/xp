import Foundation

/// Event dari `xp dev` (/__xp/events, Server-Sent Events). Hanya untuk development.
public enum XPDevEvents {
    /// Satu baris SSE → daftar komponen yang baru di-build, atau nil untuk event lain.
    public static func parse(_ line: String) -> [String]? {
        guard line.hasPrefix("data:") else { return nil }
        let body = line.dropFirst("data:".count).trimmingCharacters(in: .whitespaces)
        guard
            let event = try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any],
            event["type"] as? String == "update"
        else { return nil }
        return event["components"] as? [String]
    }

    /// Nama komponen yang baru di-build, setiap kali `xp dev` selesai build. Tersambung ulang otomatis.
    static func updates(base: URL) -> AsyncStream<[String]> {
        AsyncStream { continuation in
            let task = Task {
                let url = base.appendingPathComponent("__xp/events")
                while !Task.isCancelled {
                    do {
                        var request = URLRequest(url: url)
                        request.timeoutInterval = 3600 // server mengirim ping tiap 15 detik
                        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                        let (bytes, _) = try await URLSession.shared.bytes(for: request)
                        for try await line in bytes.lines {
                            if let names = parse(line) { continuation.yield(names) }
                        }
                    } catch {
                        if Task.isCancelled { break }
                    }
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
