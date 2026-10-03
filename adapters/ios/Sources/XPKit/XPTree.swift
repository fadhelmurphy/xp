import Foundation

/// Node di tree view native, hasil menerapkan operasi UI dari runtime.
public final class XPNode {
    public let id: Int
    public let type: String
    /// Revisi tempat node ini muncul (dipakai untuk animasi `entering`).
    public let createdAt: Int
    public internal(set) var props: [String: Any] = [:]
    public internal(set) var children: [Int] = []

    init(id: Int, type: String, createdAt: Int = 0) {
        self.id = id
        self.type = type
        self.createdAt = createdAt
    }

    /// Key handler event, mis. props["onPress"] = {"$fn": "5:onPress"} → "5:onPress".
    public func handler(_ prop: String) -> String? {
        (props[prop] as? [String: Any])?["$fn"] as? String
    }

    public func string(_ prop: String) -> String? { props[prop] as? String }

    public func bool(_ prop: String) -> Bool { (props[prop] as? Bool) ?? false }

    public var style: [String: Any] { props["style"] as? [String: Any] ?? [:] }

    public var testID: String? { string("testID") }

    public var entering: XPEntering? {
        (props["entering"] as? [String: Any]).map(XPEntering.init)
    }
}

/// Animasi saat node muncul: dari nilai ini ke keadaan normal.
public struct XPEntering: Equatable {
    public var opacity = 1.0
    public var translateX = 0.0
    public var translateY = 0.0
    public var duration = 0.25 // detik

    init(_ m: [String: Any]) {
        opacity = (m["opacity"] as? NSNumber)?.doubleValue ?? 1
        translateX = (m["translateX"] as? NSNumber)?.doubleValue ?? 0
        translateY = (m["translateY"] as? NSNumber)?.doubleValue ?? 0
        duration = ((m["duration"] as? NSNumber)?.doubleValue ?? 250) / 1000
    }
}

/// Menerapkan batch `create / props / children / delete`. Hanya Foundation, jadi bisa diuji di macOS.
/// Implementasi acuan: sdk-reference/tree.ts.
public final class XPTree {
    public static let protocolVersion = 1
    public static let rootID = 0
    public static let primitives: Set<String> = ["View", "Text", "Image", "Pressable", "ScrollView", "TextInput", "Modal", "#text"]

    private var nodes: [Int: XPNode] = [XPTree.rootID: XPNode(id: XPTree.rootID, type: "#root")]

    /// Bertambah setiap kali tree berubah.
    public private(set) var revision = 0

    public init() {}

    public var root: XPNode { nodes[XPTree.rootID]! }

    public var count: Int { nodes.count }

    public func node(_ id: Int) -> XPNode? { nodes[id] }

    /// Terapkan hasil XP.mount/update/dispatch/unmount: string JSON berisi daftar batch.
    public func applyBatches(_ json: String) throws {
        guard let batches = try XPJSON.parse(json) as? [Any] else {
            throw XPError.invalid("hasil runtime bukan array batch")
        }
        if batches.isEmpty { return }
        for batch in batches {
            guard let b = batch as? [String: Any] else { throw XPError.invalid("batch bukan object") }
            try apply(b)
        }
        revision += 1
    }

    private func apply(_ batch: [String: Any]) throws {
        let version = (batch["v"] as? NSNumber)?.intValue
        guard version == XPTree.protocolVersion else { throw XPError.protocolMismatch(version) }

        for raw in batch["ops"] as? [Any] ?? [] {
            guard let op = raw as? [Any], op.count >= 2,
                  let kind = op[0] as? String,
                  let id = (op[1] as? NSNumber)?.intValue
            else { throw XPError.invalid("op tidak valid: \(raw)") }

            switch kind {
            case "create":
                guard op.count >= 3, let type = op[2] as? String else { throw XPError.invalid("create tanpa type") }
                guard XPTree.primitives.contains(type) else { throw XPError.unknownPrimitive(type) }
                nodes[id] = XPNode(id: id, type: type, createdAt: revision + 1)
            case "props":
                guard op.count >= 3, let changes = op[2] as? [String: Any] else { throw XPError.invalid("props tanpa object") }
                let n = try existing(id)
                for (key, value) in changes {
                    if value is NSNull { n.props.removeValue(forKey: key) } else { n.props[key] = value }
                }
            case "children":
                guard op.count >= 3, let list = op[2] as? [Any] else { throw XPError.invalid("children tanpa array") }
                let n = try existing(id)
                n.children = list.compactMap { ($0 as? NSNumber)?.intValue }
            case "delete":
                nodes.removeValue(forKey: id)
            default:
                throw XPError.invalid("operasi tidak dikenal: \(kind)")
            }
        }
    }

    private func existing(_ id: Int) throws -> XPNode {
        guard let n = nodes[id] else { throw XPError.invalid("node \(id) tidak ada (operasi tidak konsisten)") }
        return n
    }

    /// Teks sebuah node = gabungan semua #text di bawahnya.
    public func text(_ n: XPNode) -> String {
        if n.type == "#text" {
            switch n.props["value"] {
            case let s as String:
                return s
            case let num as NSNumber:
                let d = num.doubleValue
                if d == d.rounded(), abs(d) < 1e15 { return String(Int64(d)) }
                return num.stringValue
            default:
                return ""
            }
        }
        return n.children.compactMap { nodes[$0] }.map(text).joined()
    }

    public func walk(from start: XPNode? = nil) -> [XPNode] {
        let first = start ?? root
        var out = [first]
        for c in first.children {
            if let child = nodes[c] { out += walk(from: child) }
        }
        return out
    }

    public func byTestID(_ id: String) -> XPNode? {
        walk().first { $0.testID == id }
    }

    /// Node yang tidak terjangkau dari root = kebocoran. Harus selalu kosong.
    public func orphans() -> [Int] {
        let reachable = Set(walk().map(\.id))
        return nodes.keys.filter { !reachable.contains($0) }.sorted()
    }
}
