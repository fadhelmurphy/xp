import Foundation

/// Nilai JavaScript di Swift, untuk komponen xp yang dikompilasi ke Swift (`xp build`).
///
/// undefined dan null sama-sama `.null`: parameter default juga dipakai saat nilainya null
/// (sama dengan versi Kotlin, supaya kedua platform berperilaku sama).
public enum JsValue {
    case null
    case bool(Bool)
    case num(Double)
    case str(String)
    case obj(JsObject)
    case arr(JsArray)
    case fn(JsFunction)
    case regex(JsRegExp)
    case set(JsSet)
    case map(JsMap)
    case date(JsDate)
    case elem(XPElement)

    public var isNull: Bool { if case .null = self { return true }; return false }
}

/// Object JS: urutan kunci sesuai urutan sisip. Kunci dengan nilai `.null` tetap ada (seperti undefined di JS).
public final class JsObject {
    public private(set) var keys: [String] = []
    private var dict: [String: JsValue] = [:]

    public init() {}

    public init(_ other: JsObject) {
        keys = other.keys
        dict = other.dict
    }

    public init(_ pairs: [(String, JsValue)]) {
        for (k, v) in pairs { self[k] = v }
    }

    public var count: Int { keys.count }

    public subscript(key: String) -> JsValue? {
        get { dict[key] }
        set {
            guard let v = newValue else { remove(key); return }
            if dict.updateValue(v, forKey: key) == nil { keys.append(key) }
        }
    }

    public func has(_ key: String) -> Bool { dict[key] != nil }

    @discardableResult
    public func remove(_ key: String) -> JsValue? {
        guard let old = dict.removeValue(forKey: key) else { return nil }
        keys.removeAll { $0 == key }
        return old
    }

    public var entries: [(String, JsValue)] { keys.map { ($0, dict[$0]!) } }
}

/// Array JS (referensi, bisa diubah lewat push/pop/...).
public final class JsArray {
    public var items: [JsValue]
    public init(_ items: [JsValue] = []) { self.items = items }
    public var count: Int { items.count }
}

public typealias JsImpl = ([JsValue]) throws -> JsValue

/// Function JS. `statics`: properti function itu sendiri (mis. Array.isArray, Number.isInteger).
public final class JsFunction {
    public let name: String
    public let statics: JsObject?
    public let impl: JsImpl

    public init(_ name: String = "", statics: JsObject? = nil, _ impl: @escaping JsImpl) {
        self.name = name
        self.statics = statics
        self.impl = impl
    }
}

/// Error yang dilempar kode komponen (`throw`).
public struct JsError: Error, CustomStringConvertible {
    public let value: JsValue
    public init(_ value: JsValue) { self.value = value }
    public init(_ message: String) { self.value = .str(message) }
    public var description: String { Js.errorMessage(value) }
}

public final class JsRegExp {
    public let source: String
    public let flags: String
    public let regex: NSRegularExpression
    public var global: Bool { flags.contains("g") }

    init(_ source: String, _ flags: String) throws {
        self.source = source
        self.flags = flags
        var opts: NSRegularExpression.Options = []
        if flags.contains("i") { opts.insert(.caseInsensitive) }
        if flags.contains("m") { opts.insert(.anchorsMatchLines) }
        if flags.contains("s") { opts.insert(.dotMatchesLineSeparators) }
        do {
            regex = try NSRegularExpression(pattern: source, options: opts)
        } catch {
            throw JsError("SyntaxError: regex tidak valid: /\(source)/")
        }
    }
}

/// `new Set()` dan `new Map()` (urutan sisip dipertahankan).
public final class JsSet {
    var order: [JsKey] = []
    var members: Set<JsKey> = []
    func add(_ v: JsValue) {
        let k = JsKey(v)
        if members.insert(k).inserted { order.append(k) }
    }
    func remove(_ v: JsValue) -> Bool {
        let k = JsKey(v)
        guard members.remove(k) != nil else { return false }
        order.removeAll { $0 == k }
        return true
    }
    var values: [JsValue] { order.map(\.value) }
}

public final class JsMap {
    var order: [JsKey] = []
    var dict: [JsKey: JsValue] = [:]
    func set(_ k: JsValue, _ v: JsValue) {
        let key = JsKey(k)
        if dict.updateValue(v, forKey: key) == nil { order.append(key) }
    }
    func remove(_ k: JsValue) -> Bool {
        let key = JsKey(k)
        guard dict.removeValue(forKey: key) != nil else { return false }
        order.removeAll { $0 == key }
        return true
    }
    var entries: [(JsValue, JsValue)] { order.map { ($0.value, dict[$0]!) } }
}

/// `new Date(ms)`: hanya getTime/valueOf/toISOString.
public final class JsDate {
    let ms: Double
    init(_ ms: Double) { self.ms = ms }
}

/// Kunci Set/Map: angka & string dibandingkan isinya, object dibandingkan identitasnya.
struct JsKey: Hashable {
    let value: JsValue
    init(_ v: JsValue) { value = v }

    static func == (a: JsKey, b: JsKey) -> Bool { Js.same(a.value, b.value) }

    func hash(into h: inout Hasher) {
        switch value {
        case .null: h.combine(0)
        case .bool(let b): h.combine(b)
        case .num(let d): h.combine(d.isNaN ? Double.nan.bitPattern : d.bitPattern)
        case .str(let s): h.combine(s)
        default: h.combine(Js.identity(value))
        }
    }
}

/// Isi object literal: `{ a: 1, ...rest }`.
public enum JsProp {
    case kv(String, JsValue)
    case spread(JsValue)
}

/// Isi array literal / argumen: `[a, ...rest]`.
public enum JsItem {
    case v(JsValue)
    case spread(JsValue)
}

public enum Js {
    // MARK: konversi

    public static func truthy(_ v: JsValue) -> Bool {
        switch v {
        case .null: return false
        case .bool(let b): return b
        case .num(let d): return !(d == 0 || d.isNaN)
        case .str(let s): return !s.isEmpty
        default: return true
        }
    }

    public static func toNum(_ v: JsValue) -> Double {
        switch v {
        case .num(let d): return d
        case .null: return .nan
        case .bool(let b): return b ? 1 : 0
        case .str(let raw):
            let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if s.isEmpty { return 0 }
            if s.hasPrefix("0x") || s.hasPrefix("0X") { return Int64(s.dropFirst(2), radix: 16).map(Double.init) ?? .nan }
            if s == "Infinity" || s == "+Infinity" { return .infinity }
            if s == "-Infinity" { return -.infinity }
            guard let last = s.last, last.isASCII, last.isNumber || last == "." else { return .nan }
            guard s.allSatisfy({ $0.isASCII && ($0.isNumber || "+-.eE".contains($0)) }) else { return .nan }
            return Double(s) ?? .nan
        case .arr(let a):
            if a.items.isEmpty { return 0 }
            return a.items.count == 1 ? toNum(a.items[0]) : .nan
        case .date(let d): return d.ms
        default: return .nan
        }
    }

    static func toInt32(_ v: JsValue) -> Int32 {
        let d = toNum(v)
        if d.isNaN || d.isInfinite { return 0 }
        let t = d.rounded(.towardZero)
        let m = t.truncatingRemainder(dividingBy: 4294967296)
        let u = m < 0 ? m + 4294967296 : m
        return Int32(truncatingIfNeeded: UInt32(u))
    }

    /// Angka → teks persis seperti JavaScript (Number.prototype.toString).
    public static func numStr(_ d: Double) -> String {
        if d.isNaN { return "NaN" }
        if d.isInfinite { return d > 0 ? "Infinity" : "-Infinity" }
        if d == 0 { return "0" }
        let neg = d < 0
        // digit terpendek yang kembali ke nilai yang sama, dari representasi Swift
        var text = "\(abs(d))"
        var exp10 = 0
        if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            exp10 = Int(text[text.index(after: e)...]) ?? 0
            text = String(text[..<e])
        }
        var intPart = text
        var frac = ""
        if let dot = text.firstIndex(of: ".") {
            intPart = String(text[..<dot])
            frac = String(text[text.index(after: dot)...])
        }
        var digits = intPart + frac
        var n = intPart.count + exp10 // posisi titik desimal
        while digits.hasPrefix("0") && digits.count > 1 { digits.removeFirst(); n -= 1 }
        while digits.hasSuffix("0") && digits.count > 1 { digits.removeLast() }
        let k = digits.count
        var out: String
        if k <= n && n <= 21 {
            out = digits + String(repeating: "0", count: n - k)
        } else if 0 < n && n <= 21 {
            let i = digits.index(digits.startIndex, offsetBy: n)
            out = digits[..<i] + "." + digits[i...]
        } else if -6 < n && n <= 0 {
            out = "0." + String(repeating: "0", count: -n) + digits
        } else {
            let e = n - 1
            let mant = k == 1 ? digits : String(digits.first!) + "." + digits.dropFirst()
            out = mant + "e" + (e >= 0 ? "+" : "-") + String(abs(e))
        }
        return neg ? "-" + out : out
    }

    public static func toStr(_ v: JsValue) -> String {
        switch v {
        case .null: return "undefined"
        case .str(let s): return s
        case .num(let d): return numStr(d)
        case .bool(let b): return b ? "true" : "false"
        case .arr(let a): return a.items.map { $0.isNull ? "" : toStr($0) }.joined(separator: ",")
        case .obj: return "[object Object]"
        case .fn(let f): return "function \(f.name)() { [native code] }"
        case .regex(let r): return "/\(r.source)/\(r.flags)"
        case .set: return "[object Set]"
        case .map: return "[object Map]"
        case .date(let d): return JsBuiltins.isoString(d.ms)
        case .elem: return "[object Object]"
        }
    }

    public static func key(_ v: JsValue) -> String {
        if case .str(let s) = v { return s }
        return toStr(v)
    }

    public static func typeOf(_ v: JsValue) -> String {
        switch v {
        case .null: return "undefined"
        case .bool: return "boolean"
        case .num: return "number"
        case .str: return "string"
        case .fn: return "function"
        default: return "object"
        }
    }

    static func identity(_ v: JsValue) -> ObjectIdentifier? {
        switch v {
        case .obj(let o): return ObjectIdentifier(o)
        case .arr(let o): return ObjectIdentifier(o)
        case .fn(let o): return ObjectIdentifier(o)
        case .regex(let o): return ObjectIdentifier(o)
        case .set(let o): return ObjectIdentifier(o)
        case .map(let o): return ObjectIdentifier(o)
        case .date(let o): return ObjectIdentifier(o)
        case .elem(let o): return ObjectIdentifier(o)
        default: return nil
        }
    }

    /// Nilai dari luar (props app, argumen event) → nilai JS.
    public static func fromHost(_ v: Any?) -> JsValue {
        guard let v = v else { return .null }
        if let j = v as? JsValue { return j }
        if v is NSNull { return .null }
        if type(of: v) == Bool.self { return .bool(v as! Bool) }
        if let s = v as? String { return .str(s) }
        if let n = v as? NSNumber {
            #if canImport(ObjectiveC)
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
            #endif
            return .num(n.doubleValue)
        }
        if let n = v as? Int { return .num(Double(n)) }
        if let n = v as? Double { return .num(n) }
        if let m = v as? [String: Any?] {
            let o = JsObject()
            for k in m.keys.sorted() { o[k] = fromHost(m[k] ?? nil) }
            return .obj(o)
        }
        if let m = v as? [String: Any] {
            let o = JsObject()
            for k in m.keys.sorted() { o[k] = fromHost(m[k]) }
            return .obj(o)
        }
        if let a = v as? [Any?] { return .arr(JsArray(a.map { fromHost($0) })) }
        if let a = v as? [Any] { return .arr(JsArray(a.map { fromHost($0) })) }
        return .str("\(v)")
    }

    /// Nilai JS → nilai Foundation untuk XPTree (bentuk sama dengan hasil JSONSerialization).
    /// Function di dalam object dibuang, seperti JSON.stringify.
    public static func toHost(_ v: JsValue) -> Any {
        switch v {
        case .null: return NSNull()
        case .bool(let b): return b
        case .num(let d): return NSNumber(value: d)
        case .str(let s): return s
        case .obj(let o):
            var m: [String: Any] = [:]
            for (k, x) in o.entries {
                if case .fn = x { continue }
                m[k] = toHost(x)
            }
            return m
        case .arr(let a): return a.items.map { x -> Any in if case .fn = x { return NSNull() }; return toHost(x) }
        case .fn: return NSNull()
        default: return toStr(v)
        }
    }

    // MARK: operator

    public static func add(_ a: JsValue, _ b: JsValue) -> JsValue {
        if case .num(let x) = a, case .num(let y) = b { return .num(x + y) }
        let pa = prim(a), pb = prim(b)
        if case .str = pa { return .str(toStr(pa) + toStr(pb)) }
        if case .str = pb { return .str(toStr(pa) + toStr(pb)) }
        return .num(toNum(pa) + toNum(pb))
    }

    private static func prim(_ v: JsValue) -> JsValue {
        switch v {
        case .arr, .obj, .fn, .regex, .set, .map, .elem: return .str(toStr(v))
        default: return v
        }
    }

    public static func sub(_ a: JsValue, _ b: JsValue) -> JsValue { .num(toNum(a) - toNum(b)) }
    public static func mul(_ a: JsValue, _ b: JsValue) -> JsValue { .num(toNum(a) * toNum(b)) }
    public static func div(_ a: JsValue, _ b: JsValue) -> JsValue { .num(toNum(a) / toNum(b)) }
    public static func mod(_ a: JsValue, _ b: JsValue) -> JsValue { .num(toNum(a).truncatingRemainder(dividingBy: toNum(b))) }
    public static func pow(_ a: JsValue, _ b: JsValue) -> JsValue { .num(Foundation.pow(toNum(a), toNum(b))) }
    public static func neg(_ a: JsValue) -> JsValue { .num(-toNum(a)) }
    public static func inc(_ a: JsValue, _ delta: Double) -> JsValue { .num(toNum(a) + delta) }

    public static func bitAnd(_ a: JsValue, _ b: JsValue) -> JsValue { .num(Double(toInt32(a) & toInt32(b))) }
    public static func bitOr(_ a: JsValue, _ b: JsValue) -> JsValue { .num(Double(toInt32(a) | toInt32(b))) }
    public static func bitXor(_ a: JsValue, _ b: JsValue) -> JsValue { .num(Double(toInt32(a) ^ toInt32(b))) }
    public static func bitNot(_ a: JsValue) -> JsValue { .num(Double(~toInt32(a))) }
    public static func shl(_ a: JsValue, _ b: JsValue) -> JsValue { .num(Double(toInt32(a) << (toInt32(b) & 31))) }
    public static func shr(_ a: JsValue, _ b: JsValue) -> JsValue { .num(Double(toInt32(a) >> (toInt32(b) & 31))) }
    public static func ushr(_ a: JsValue, _ b: JsValue) -> JsValue {
        .num(Double(UInt32(bitPattern: toInt32(a)) >> UInt32(toInt32(b) & 31)))
    }

    static func utf16Less(_ a: String, _ b: String) -> Bool { a.utf16.lexicographicallyPrecedes(b.utf16) }

    private static func cmp(_ a: JsValue, _ b: JsValue) -> Int? {
        let pa = prim(a), pb = prim(b)
        if case .str(let x) = pa, case .str(let y) = pb { return x == y ? 0 : (utf16Less(x, y) ? -1 : 1) }
        let x = toNum(pa), y = toNum(pb)
        if x.isNaN || y.isNaN { return nil }
        return x == y ? 0 : (x < y ? -1 : 1)
    }

    public static func lt(_ a: JsValue, _ b: JsValue) -> Bool {
        if case .num(let x) = a, case .num(let y) = b { return x < y }
        return (cmp(a, b) ?? 1) < 0
    }
    public static func gt(_ a: JsValue, _ b: JsValue) -> Bool {
        if case .num(let x) = a, case .num(let y) = b { return x > y }
        return (cmp(a, b) ?? -1) > 0
    }
    public static func le(_ a: JsValue, _ b: JsValue) -> Bool {
        if case .num(let x) = a, case .num(let y) = b { return x <= y }
        return (cmp(a, b) ?? 1) <= 0
    }
    public static func ge(_ a: JsValue, _ b: JsValue) -> Bool {
        if case .num(let x) = a, case .num(let y) = b { return x >= y }
        return (cmp(a, b) ?? -1) >= 0
    }

    /// `===`
    public static func seq(_ a: JsValue, _ b: JsValue) -> Bool {
        switch (a, b) {
        case (.null, .null): return true
        case let (.num(x), .num(y)): return x == y
        case let (.str(x), .str(y)): return x == y
        case let (.bool(x), .bool(y)): return x == y
        default:
            guard let x = identity(a), let y = identity(b) else { return false }
            return x == y
        }
    }

    /// `==`
    public static func eq(_ a: JsValue, _ b: JsValue) -> Bool {
        if a.isNull || b.isNull { return a.isNull && b.isNull }
        switch (a, b) {
        case let (.bool(x), .bool(y)): return x == y
        case (.num, .str), (.str, .num), (.bool, _), (_, .bool): return toNum(a) == toNum(b)
        default: return seq(a, b)
        }
    }

    /// Object.is (dipakai hooks): NaN sama dengan NaN, +0 beda dengan -0.
    public static func same(_ a: JsValue, _ b: JsValue) -> Bool {
        if case .num(let x) = a, case .num(let y) = b {
            if x.isNaN && y.isNaN { return true }
            return x == y && x.sign == y.sign
        }
        return seq(a, b)
    }

    public static func hasKey(_ k: JsValue, _ obj: JsValue) throws -> Bool {
        switch obj {
        case .obj(let o): return o.has(key(k))
        case .arr(let a):
            if case .str("length") = k { return true }
            let n = toNum(k)
            return n >= 0 && n < Double(a.count) && n == n.rounded(.down)
        default: throw JsError("TypeError: operator 'in' butuh object")
        }
    }

    public static func isArray(_ v: JsValue) -> Bool { if case .arr = v { return true }; return false }

    // MARK: logika (sisi kanan hanya dievaluasi kalau perlu)

    public static func and(_ a: JsValue, _ b: @autoclosure () throws -> JsValue) rethrows -> JsValue { truthy(a) ? try b() : a }
    public static func or(_ a: JsValue, _ b: @autoclosure () throws -> JsValue) rethrows -> JsValue { truthy(a) ? a : try b() }
    public static func coalesce(_ a: JsValue, _ b: @autoclosure () throws -> JsValue) rethrows -> JsValue { a.isNull ? try b() : a }

    // MARK: properti

    public static func get(_ obj: JsValue, _ k: String) throws -> JsValue {
        if obj.isNull { throw JsError("TypeError: tidak bisa membaca '\(k)' dari undefined") }
        return getOpt(obj, .str(k))
    }

    public static func get(_ obj: JsValue, _ k: JsValue) throws -> JsValue {
        if obj.isNull { throw JsError("TypeError: tidak bisa membaca '\(toStr(k))' dari undefined") }
        return getOpt(obj, k)
    }

    public static func getOpt(_ obj: JsValue, _ k: String) -> JsValue { getOpt(obj, .str(k)) }

    /// Akses properti yang mengembalikan undefined kalau obj undefined (optional chaining).
    public static func getOpt(_ obj: JsValue, _ k: JsValue) -> JsValue {
        switch obj {
        case .null: return .null
        case .obj(let o):
            let name = key(k)
            if let v = o[name] { return v }
            return name == "hasOwnProperty" ? method(obj, name) : .null
        case .arr(let a):
            switch k {
            case .num(let d):
                let i = Int(exactly: d) ?? -1
                return i >= 0 && i < a.count ? a.items[i] : .null
            case .str("length"): return .num(Double(a.count))
            case .str(let s):
                if !s.isEmpty, s.allSatisfy({ $0.isASCII && $0.isNumber }), let i = Int(s) { return i < a.count ? a.items[i] : .null }
                return method(obj, s)
            default: return .null
            }
        case .str(let s):
            switch k {
            case .num(let d):
                let u = Array(s.utf16)
                let i = Int(exactly: d) ?? -1
                return i >= 0 && i < u.count ? .str(String(decoding: u[i...i], as: UTF16.self)) : .null
            case .str("length"): return .num(Double(s.utf16.count))
            case .str(let name): return method(obj, name)
            default: return .null
            }
        case .fn(let f):
            guard case .str(let name) = k else { return .null }
            if name == "name" { return .str(f.name) }
            if let v = f.statics?[name] { return v }
            return method(obj, name)
        case .regex(let r):
            switch key(k) {
            case "source": return .str(r.source)
            case "flags": return .str(r.flags)
            case "global": return .bool(r.global)
            default: return method(obj, key(k))
            }
        case .set(let s):
            if key(k) == "size" { return .num(Double(s.order.count)) }
            return method(obj, key(k))
        case .map(let m):
            if key(k) == "size" { return .num(Double(m.order.count)) }
            return method(obj, key(k))
        case .num, .date:
            if case .str(let name) = k { return method(obj, name) }
            return .null
        default: return .null
        }
    }

    @discardableResult
    public static func set(_ obj: JsValue, _ k: String, _ v: JsValue) throws -> JsValue { try set(obj, .str(k), v) }

    @discardableResult
    public static func set(_ obj: JsValue, _ k: JsValue, _ v: JsValue) throws -> JsValue {
        switch obj {
        case .obj(let o): o[key(k)] = v
        case .arr(let a):
            if case .str("length") = k {
                let n = max(0, Int(toNum(v)))
                if a.items.count > n { a.items.removeLast(a.items.count - n) }
                while a.items.count < n { a.items.append(.null) }
            } else {
                let i = Int(toNum(k))
                guard i >= 0 else { break }
                while a.items.count <= i { a.items.append(.null) }
                a.items[i] = v
            }
        case .null: throw JsError("TypeError: tidak bisa mengisi '\(toStr(k))' di undefined")
        default: throw JsError("TypeError: tidak bisa mengisi '\(toStr(k))' di \(typeOf(obj))")
        }
        return v
    }

    public static func delete(_ obj: JsValue, _ k: JsValue) -> Bool {
        if case .obj(let o) = obj { o.remove(key(k)) }
        return true
    }

    public static func delete(_ obj: JsValue, _ k: String) -> Bool { delete(obj, .str(k)) }

    /// Method bawaan sebagai nilai (mis. `arr.map` tanpa dipanggil).
    private static func method(_ obj: JsValue, _ name: String) -> JsValue {
        guard JsBuiltins.hasMethod(obj, name) else { return .null }
        return .fn(JsFunction(name) { args in try JsBuiltins.callMethod(obj, name, args) })
    }

    // MARK: pemanggilan

    public static func call(_ f: JsValue, _ args: [JsValue]) throws -> JsValue {
        guard case .fn(let fn) = f else { throw JsError("TypeError: \(typeOf(f)) bukan function") }
        return try fn.impl(args)
    }

    public static func callOpt(_ f: JsValue, _ args: [JsValue]) throws -> JsValue {
        f.isNull ? .null : try call(f, args)
    }

    public static func callMethod(_ obj: JsValue, _ name: String, _ args: [JsValue]) throws -> JsValue {
        switch obj {
        case .null: throw JsError("TypeError: tidak bisa memanggil '\(name)' pada undefined")
        case .fn(let f):
            if let s = f.statics?[name] { return try call(s, args) }
        case .obj(let o):
            if let f = o[name] {
                if case .fn(let fn) = f { return try fn.impl(args) }
                if !f.isNull { throw JsError("TypeError: '\(name)' bukan function") }
            }
        default: break
        }
        return try JsBuiltins.callMethod(obj, name, args)
    }

    public static func callMethodOpt(_ obj: JsValue, _ name: String, _ args: [JsValue]) throws -> JsValue {
        obj.isNull ? .null : try callMethod(obj, name, args)
    }

    public static func arg(_ a: [JsValue], _ i: Int) -> JsValue { i < a.count ? a[i] : .null }
    public static func rest(_ a: [JsValue], _ i: Int) -> JsValue { .arr(JsArray(i < a.count ? Array(a[i...]) : [])) }

    // MARK: literal

    public static func object(_ props: [JsProp]) -> JsValue {
        let o = JsObject()
        for p in props {
            switch p {
            case .kv(let k, let v): o[k] = v
            case .spread(let src): spreadInto(o, src)
            }
        }
        return .obj(o)
    }

    public static func array(_ items: [JsValue]) -> JsValue { .arr(JsArray(items)) }

    public static func list(_ items: [JsItem]) throws -> [JsValue] {
        var out: [JsValue] = []
        for i in items {
            switch i {
            case .v(let v): out.append(v)
            case .spread(let s): out.append(contentsOf: try spreadList(s))
            }
        }
        return out
    }

    public static func arraySpread(_ items: [JsItem]) throws -> JsValue { .arr(JsArray(try list(items))) }

    /// `{...x}`
    public static func spreadInto(_ target: JsObject, _ src: JsValue) {
        switch src {
        case .obj(let o): for (k, v) in o.entries { target[k] = v }
        case .arr(let a): for (i, v) in a.items.enumerated() { target[String(i)] = v }
        case .str(let s): for (i, c) in s.utf16.enumerated() { target[String(i)] = .str(String(decoding: [c], as: UTF16.self)) }
        default: break
        }
    }

    /// `const { a, ...rest } = obj`: salinan obj tanpa kunci yang sudah diambil.
    public static func omit(_ src: JsValue, _ taken: [String]) -> JsValue {
        let out = JsObject()
        if case .obj(let o) = src { for (k, v) in o.entries where !taken.contains(k) { out[k] = v } }
        return .obj(out)
    }

    /// `[...x]` dan `f(...x)`
    public static func spreadList(_ src: JsValue) throws -> [JsValue] {
        switch src {
        case .arr(let a): return a.items
        case .str(let s): return s.utf16.map { .str(String(decoding: [$0], as: UTF16.self)) }
        case .set(let s): return s.values
        case .map(let m): return m.entries.map { .arr(JsArray([$0.0, $0.1])) }
        case .null: throw JsError("TypeError: undefined tidak bisa di-spread")
        default: throw JsError("TypeError: \(typeOf(src)) tidak bisa di-spread")
        }
    }

    public static func iter(_ src: JsValue) throws -> [JsValue] { try spreadList(src) }

    /// `for (k in obj)`
    public static func keys(_ src: JsValue) -> [JsValue] {
        switch src {
        case .obj(let o): return o.keys.map { .str($0) }
        case .arr(let a): return a.items.indices.map { .str(String($0)) }
        case .str(let s): return (0..<s.utf16.count).map { .str(String($0)) }
        default: return []
        }
    }

    private static var regexCache: [String: JsRegExp] = [:]

    public static func regex(_ source: String, _ flags: String) throws -> JsValue {
        if flags.contains("g") || flags.contains("y") { return .regex(try JsRegExp(source, flags)) }
        let k = flags + "/" + source
        if let r = regexCache[k] { return .regex(r) }
        let r = try JsRegExp(source, flags)
        regexCache[k] = r
        return .regex(r)
    }

    public static func concat(_ parts: [JsValue]) -> JsValue {
        var out = ""
        for p in parts { out += toStr(p) }
        return .str(out)
    }

    public static func errorMessage(_ v: JsValue) -> String {
        if case .obj(let o) = v { return toStr(o["message"] ?? v) }
        return toStr(v)
    }

    /// Nilai yang ditangkap `catch (e)`.
    public static func caught(_ e: Error) -> JsValue {
        if let j = e as? JsError { return j.value }
        return .obj(JsObject([("name", .str("Error")), ("message", .str("\(e)"))]))
    }
}

extension Js {
    /// `const [a, ...rest] = x`
    public static func restOf(_ v: JsValue, _ i: Int) throws -> JsValue {
        let items = try iter(v)
        return .arr(JsArray(i < items.count ? Array(items[i...]) : []))
    }
}
