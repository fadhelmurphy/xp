import Foundation
import JavaScriptCore

/// Satu JSContext (JavaScriptCore, bawaan iOS) yang menjalankan satu bundle komponen.
/// Semua akses lewat satu antrean serial.
///
/// Kontrak dengan runtime xp (mode antrean): setiap XP.* mengembalikan string JSON
/// berisi daftar batch operasi UI, secara sinkron.
public final class XPEngine {
    private let queue = DispatchQueue(label: "dev.xp.engine")
    private var context: JSContext?
    private var exception: String?

    private init() {}

    public static func create(bundle: String, fileName: String) async throws -> XPEngine {
        let engine = XPEngine()
        try await engine.run {
            guard let ctx = JSContext() else { throw XPError.script("JSContext tidak bisa dibuat") }
            ctx.name = "xp:\(fileName)"
            ctx.exceptionHandler = { [weak engine] _, value in
                engine?.exception = value?.toString() ?? "error tidak dikenal"
            }
            engine.context = ctx
            _ = ctx.evaluateScript(bundle, withSourceURL: URL(string: "xp://\(fileName)"))
            try engine.throwIfException()

            let proto = ctx.evaluateScript("typeof XP === 'object' ? XP.protocol : -1")?.toInt32()
            guard let proto, Int(proto) == XPTree.protocolVersion else {
                throw XPError.protocolMismatch(proto.map { Int($0) })
            }
        }
        return engine
    }

    /// `snapshot`: hasil snapshot() dari engine sebelumnya (reload saat development).
    public func mount(_ propsJSON: String, snapshot: String = "null") async throws -> String {
        try await call("XP.mount(\(XPJSON.quote(propsJSON)), \(XPJSON.quote(snapshot)))")
    }

    /// State useState komponen saat ini, untuk dipakai bundle versi baru.
    public func snapshot() async throws -> String {
        try await call("typeof XP.snapshot === 'function' ? XP.snapshot() : 'null'")
    }

    public func update(_ propsJSON: String) async throws -> String {
        try await call("XP.update(\(XPJSON.quote(propsJSON)))")
    }

    public func dispatch(_ handlerKey: String, args: [Any] = []) async throws -> String {
        let argsJSON = try XPJSON.stringify(args)
        return try await call("XP.dispatch(\(XPJSON.quote(handlerKey)), \(XPJSON.quote(argsJSON)))")
    }

    public func unmount() async throws -> String {
        try await call("XP.unmount()")
    }

    /// Jalankan timer (setTimeout/setInterval) yang sudah jatuh tempo.
    public func tick() async throws -> String {
        try await call("typeof XP.tick === 'function' ? XP.tick() : '[]'")
    }

    /// ms sampai timer berikutnya, atau -1 kalau tidak ada.
    public func nextTimer() async throws -> Int {
        try await run {
            guard let ctx = self.context else { throw XPError.script("engine sudah ditutup") }
            let value = ctx.evaluateScript("typeof XP.nextTimer === 'function' ? XP.nextTimer() : -1")
            try self.throwIfException()
            return Int(value?.toDouble() ?? -1)
        }
    }

    public func close() {
        queue.async { self.context = nil }
    }

    private func call(_ script: String) async throws -> String {
        try await run {
            guard let ctx = self.context else { throw XPError.script("engine sudah ditutup") }
            let value = ctx.evaluateScript(script)
            try self.throwIfException()
            guard let value, value.isString, let text = value.toString() else { return "[]" }
            return text
        }
    }

    private func throwIfException() throws {
        if let message = exception {
            exception = nil
            throw XPError.script(message)
        }
    }

    private func run<T>(_ work: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                continuation.resume(with: Result { try work() })
            }
        }
    }
}
