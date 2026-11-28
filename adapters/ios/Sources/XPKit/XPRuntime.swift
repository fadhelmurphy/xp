import CoreGraphics
import Foundation

/// Yang dijalankan XPView: bundle JS di JavaScriptCore (development / dimuat dari URL),
/// atau komponen yang sudah dikompilasi ke Swift (release).
/// Setiap pemanggilan mengembalikan daftar batch operasi UI untuk XPTree.
protocol XPRuntime: AnyObject {
    func mount(_ propsJSON: String) async throws -> [Any]
    func update(_ propsJSON: String) async throws -> [Any]
    func dispatch(_ handlerKey: String, args: [Any]) async throws -> [Any]
    func environment(screen: CGSize, dark: Bool) async throws -> [Any]
    func tick() async throws -> [Any]
    func nextTimer() async throws -> Int
    func close()
}

private func batches(_ json: String) throws -> [Any] {
    guard let list = try XPJSON.parse(json) as? [Any] else { throw XPError.invalid("hasil runtime bukan array batch") }
    return list
}

final class XPEngineRuntime: XPRuntime {
    let engine: XPEngine
    init(_ engine: XPEngine) { self.engine = engine }

    func mount(_ propsJSON: String) async throws -> [Any] { try batches(try await engine.mount(propsJSON)) }
    func update(_ propsJSON: String) async throws -> [Any] { try batches(try await engine.update(propsJSON)) }
    func dispatch(_ handlerKey: String, args: [Any]) async throws -> [Any] { try batches(try await engine.dispatch(handlerKey, args: args)) }
    func environment(screen: CGSize, dark: Bool) async throws -> [Any] { try batches(try await engine.environment(screen: screen, dark: dark)) }
    func tick() async throws -> [Any] { try batches(try await engine.tick()) }
    func nextTimer() async throws -> Int { try await engine.nextTimer() }
    func close() { engine.close() }
}

/// Komponen terkompilasi. Tetap di antrean serial sendiri supaya render tidak membebani main thread.
final class XPCompiledRuntime: XPRuntime {
    private let queue: DispatchQueue
    private var rt: XPComponentRuntime?

    init(_ component: XPCompiledComponent) {
        queue = DispatchQueue(label: "dev.xp.\(component.name)")
        rt = XPComponentRuntime(component)
    }

    private func run<T>(_ work: @escaping (XPComponentRuntime) throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                continuation.resume(with: Result {
                    guard let rt = self.rt else { throw XPError.script("komponen sudah ditutup") }
                    do {
                        return try work(rt)
                    } catch let e as JsError {
                        throw XPError.script(e.description)
                    }
                })
            }
        }
    }

    func mount(_ propsJSON: String) async throws -> [Any] { try await run { try $0.mount(json: propsJSON) } }
    func update(_ propsJSON: String) async throws -> [Any] { try await run { try $0.update(json: propsJSON) } }
    func dispatch(_ handlerKey: String, args: [Any]) async throws -> [Any] { try await run { try $0.dispatch(handlerKey, args: args) } }
    func environment(screen: CGSize, dark: Bool) async throws -> [Any] {
        try await run { try $0.environment(width: Double(screen.width).rounded(), height: Double(screen.height).rounded(), dark: dark) }
    }
    func tick() async throws -> [Any] { try await run { try $0.tick() } }
    func nextTimer() async throws -> Int { try await run { Int($0.nextTimer()) } }
    func close() { queue.async { self.rt = nil } }
}

/// Komponen yang ikut dikompilasi ke dalam app (dihasilkan `xp build`, diambil oleh script
/// `xp-components.sh` di build phase). Dicari lewat nama class Objective-C `XPGeneratedComponents`,
/// jadi app yang tidak memakainya tidak perlu konfigurasi apa pun.
public enum XPCompiled {
    public static let components: [String: XPCompiledComponent] = {
        #if canImport(ObjectiveC)
        let registry = NSClassFromString("XPGeneratedComponents") as? XPComponentRegistry.Type
        return registry?.components ?? [:]
        #else
        return [:]
        #endif
    }()

    public static func component(_ name: String) -> XPCompiledComponent? { components[name] }

    /// Komponen mode typed (Swift bertipe). Dipilih lebih dulu daripada versi dinamis.
    public static let typedComponents: [String: XPTypedComponent] = {
        #if canImport(ObjectiveC)
        let registry = NSClassFromString("XPGeneratedComponents") as? XPTypedRegistry.Type
        return registry?.typedComponents ?? [:]
        #else
        return [:]
        #endif
    }()

    public static func typed(_ name: String) -> XPTypedComponent? { typedComponents[name] }
}
