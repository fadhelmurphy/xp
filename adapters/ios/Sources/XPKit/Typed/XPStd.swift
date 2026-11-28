import Foundation

/// Perilaku JS yang dipakai kode bertipe: angka → teks, perbandingan Object.is, truthy, Math, dst.
/// Bagian yang rumit (format angka, method string, regex) memakai implementasi yang sama dengan
/// mode dinamis (Compiled/JsValue.swift, JsBuiltins.swift), supaya hasilnya persis sama.
public enum XPStd {
    // MARK: nilai

    /// Optional bertumpuk (`Any??`) → satu tingkat. Nil di dalam Any dianggap nil.
    public static func flat(_ v: Any?) -> Any? {
        guard let v = v else { return nil }
        let m = Mirror(reflecting: v)
        if m.displayStyle == .optional {
            guard let inner = m.children.first else { return nil }
            return flat(inner.value)
        }
        return v
    }

    /// Nilai untuk renderer: tanpa nil, class → dictionary, angka tetap Double.
    public static func host(_ v: Any?) -> Any? {
        guard let v = flat(v) else { return nil }
        switch v {
        case let o as XPHostValue: return hostProps(o.toHost())
        case let m as [String: Any?]: return hostProps(m)
        case let l as [Any?]: return l.map { host($0) ?? NSNull() }
        default: return v
        }
    }

    public static func hostProps(_ m: [String: Any?]) -> [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in m { if let h = host(v) { out[k] = h } }
        return out
    }

    /// Nilai JS (dari helper dinamis) → nilai Swift: Double, String, Bool, [Any?], [String: Any?].
    static func native(_ v: JsValue) -> Any? {
        switch v {
        case .null: return nil
        case .bool(let b): return b
        case .num(let d): return d
        case .str(let s): return s
        case .arr(let a): return a.items.map { native($0) }
        case .obj(let o):
            var m: [String: Any?] = [:]
            for (k, x) in o.entries { m[k] = native(x) }
            return m
        default: return v
        }
    }

    static func js(_ v: Any?) -> JsValue {
        guard let v = flat(v) else { return .null }
        if let j = v as? JsValue { return j }
        if let o = v as? XPHostValue { return js(o.toHost()) }
        if let m = v as? [String: Any?] {
            let o = JsObject()
            for k in m.keys.sorted() { o[k] = js(m[k] ?? nil) }
            return .obj(o)
        }
        if let l = v as? [Any?] { return .arr(JsArray(l.map { js($0) })) }
        return Js.fromHost(v)
    }

    public static func str(_ d: Double) -> String { Js.numStr(d) }

    public static func str(_ v: Any?) -> String {
        guard let v = flat(v) else { return "undefined" }
        switch v {
        case let s as String: return s
        case let d as Double: return Js.numStr(d)
        case let b as Bool: return b ? "true" : "false"
        case is XPHostValue: return "[object Object]"
        default: return Js.toStr(js(v))
        }
    }

    public static func num(_ v: Any?) -> Double {
        guard let v = flat(v) else { return .nan }
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        return Js.toNum(js(v))
    }

    public static func numOrNull(_ v: Any?) -> Double? { flat(v) == nil ? nil : num(v) }

    public static func map(_ v: Any?) -> [String: Any?] { flat(v) as? [String: Any?] ?? [:] }

    /// `m[k]` untuk dictionary yang nilainya optional.
    public static func get<T>(_ m: [String: T?]?, _ k: String) -> T? {
        guard let m = m, let v = m[k] else { return nil }
        return v
    }

    /// Object.is: angka dengan aturan NaN/±0, string dan boolean per nilai, object per identitas.
    /// Array tidak punya identitas di Swift, jadi dibandingkan isinya.
    public static func same(_ a: Any?, _ b: Any?) -> Bool {
        let a = flat(a), b = flat(b)
        if a == nil || b == nil { return a == nil && b == nil }
        if let x = a as? Double, let y = b as? Double {
            if x.isNaN && y.isNaN { return true }
            return x == y && (x != 0 || (1 / x) == (1 / y))
        }
        if let x = a as? String { return (b as? String) == x }
        if let x = a as? Bool { return (b as? Bool) == x }
        if let x = a as? [Any?], let y = b as? [Any?] { return x.count == y.count && zip(x, y).allSatisfy { same($0, $1) } }
        if let x = a as? XPEnv, let y = b as? XPEnv { return x == y }
        if let x = a as AnyObject?, let y = b as AnyObject?, !(a is Double), !(a is String) { return x === y }
        return false
    }

    /// Kesamaan isi (seperti `==` Kotlin): dictionary dan array dibandingkan per elemen.
    public static func equal(_ a: Any?, _ b: Any?) -> Bool {
        if let x = flat(a) as? [String: Any?], let y = flat(b) as? [String: Any?] {
            return x.count == y.count && x.allSatisfy { k, v in y.keys.contains(k) && equal(v, y[k] ?? nil) }
        }
        if let x = flat(a) as? [Any?], let y = flat(b) as? [Any?] { return x.count == y.count && zip(x, y).allSatisfy { equal($0, $1) } }
        if let x = flat(a) as? Double, let y = flat(b) as? Double { return x == y }
        return same(a, b)
    }

    /// `===` untuk nilai yang tipenya tidak pasti.
    public static func strictEquals(_ a: Any?, _ b: Any?) -> Bool {
        if let x = flat(a) as? Double, let y = flat(b) as? Double { return x == y }
        return same(a, b)
    }

    public static func truthy(_ d: Double) -> Bool { d != 0 && !d.isNaN }
    public static func truthy(_ s: String?) -> Bool { !(s ?? "").isEmpty }
    public static func truthy(_ d: Double?) -> Bool { d.map { truthy($0) } ?? false }
    public static func truthy(_ v: Any?) -> Bool {
        guard let v = flat(v) else { return false }
        switch v {
        case let b as Bool: return b
        case let d as Double: return truthy(d)
        case let s as String: return !s.isEmpty
        default: return true
        }
    }

    // MARK: Math dengan aturan JS

    public static func round(_ d: Double) -> Double { d.isNaN || d.isInfinite ? d : Foundation.floor(d + 0.5) }
    public static func trunc(_ d: Double) -> Double { d < 0 ? Foundation.ceil(d) : Foundation.floor(d) }
    public static func sign(_ d: Double) -> Double { d.isNaN ? d : d > 0 ? 1 : d < 0 ? -1 : d }
    public static func min(_ xs: Double...) -> Double { xs.reduce(Double.infinity) { a, b in a.isNaN || b.isNaN ? .nan : Swift.min(a, b) } }
    public static func max(_ xs: Double...) -> Double { xs.reduce(-Double.infinity) { a, b in a.isNaN || b.isNaN ? .nan : Swift.max(a, b) } }
    public static func hypot(_ xs: Double...) -> Double { Foundation.sqrt(xs.reduce(0) { $0 + $1 * $1 }) }
    public static func mod(_ a: Double, _ b: Double) -> Double { a.truncatingRemainder(dividingBy: b) }
    public static func pow(_ a: Double, _ b: Double) -> Double { Js.toNum(Js.pow(.num(a), .num(b))) }
    public static func random() -> Double { Double.random(in: 0..<1) }
    public static func now() -> Double { JsBuiltins.clock() }

    public static func isInteger(_ v: Any?) -> Bool { (flat(v) as? Double).map { $0.isFinite && $0 == Foundation.floor($0) } ?? false }
    public static func isFiniteNum(_ v: Any?) -> Bool { (flat(v) as? Double)?.isFinite ?? false }
    public static func isNaNNum(_ v: Any?) -> Bool { (flat(v) as? Double)?.isNaN ?? false }

    public static func parseFloat(_ s: String?) -> Double { global("parseFloat", [s]) as? Double ?? .nan }
    public static func parseInt(_ s: String?, _ radix: Double? = nil) -> Double {
        global("parseInt", radix.map { [s, $0] } ?? [s]) as? Double ?? .nan
    }

    private static func i32(_ d: Double) -> Int32 { Js.toInt32(.num(d)) }
    public static func bitAnd(_ a: Double, _ b: Double) -> Double { Double(i32(a) & i32(b)) }
    public static func bitOr(_ a: Double, _ b: Double) -> Double { Double(i32(a) | i32(b)) }
    public static func bitXor(_ a: Double, _ b: Double) -> Double { Double(i32(a) ^ i32(b)) }
    public static func bitNot(_ a: Double) -> Double { Double(~i32(a)) }
    public static func shl(_ a: Double, _ b: Double) -> Double { Double(i32(a) << (i32(b) & 31)) }
    public static func shr(_ a: Double, _ b: Double) -> Double { Double(i32(a) >> (i32(b) & 31)) }
    public static func ushr(_ a: Double, _ b: Double) -> Double { Double(UInt32(bitPattern: i32(a)) >> UInt32(i32(b) & 31)) }

    public static func toFixed(_ d: Double, _ digits: Double) -> String { method(d, "toFixed", digits) as? String ?? "" }
    public static func toString(_ d: Double, _ radix: Double) -> String { method(d, "toString", radix) as? String ?? "" }

    // MARK: string

    /// Perbandingan string seperti JS: per code unit UTF-16.
    public static func lt(_ a: String, _ b: String) -> Bool { Js.utf16Less(a, b) }
    public static func gt(_ a: String, _ b: String) -> Bool { Js.utf16Less(b, a) }
    public static func le(_ a: String, _ b: String) -> Bool { !Js.utf16Less(b, a) }
    public static func ge(_ a: String, _ b: String) -> Bool { !Js.utf16Less(a, b) }

    public static func length(_ s: String) -> Double { Double(s.utf16.count) }
    public static func trim(_ s: String) -> String { method(s, "trim") as? String ?? s }
    public static func charAt(_ s: String, _ i: Double) -> String { method(s, "charAt", i) as? String ?? "" }
    public static func split(_ s: String, _ sep: String?) -> [String] { strList(method(s, "split", sep)) ?? [] }

    // MARK: array

    public static func at<T>(_ list: [T]?, _ i: Double) -> T? {
        guard let list = list, !i.isNaN, i >= 0, i < Double(list.count) else { return nil }
        return list[Int(i)]
    }

    /// Argumen event ke-i dari renderer, atau nil.
    public static func arg(_ a: [Any?], _ i: Int) -> Any? { i < a.count ? flat(a[i]) : nil }

    public static func join<T>(_ list: [T], _ sep: String) -> String {
        list.map { v -> String in flat(v) == nil ? "" : str(v) }.joined(separator: sep)
    }

    public static func slice<T>(_ list: [T], _ start: Double = 0, _ end: Double? = nil) -> [T] {
        func idx(_ v: Double) -> Int {
            let n = v.isNaN ? 0 : v
            let i = n < 0 ? Swift.max(0, Double(list.count) + trunc(n)) : Swift.min(trunc(n), Double(list.count))
            return Int(i)
        }
        let a = idx(start), b = idx(end ?? Double(list.count))
        return a < b ? Array(list[a..<b]) : []
    }

    /// includes dengan SameValueZero.
    public static func includes<T>(_ list: [T], _ v: Any?) -> Bool { list.contains { sameZero($0, v) } }

    public static func indexOf<T>(_ list: [T], _ v: Any?) -> Double {
        Double(list.firstIndex { strictEquals($0, v) && !(isNaNNum(v)) } ?? -1)
    }

    private static func sameZero(_ a: Any?, _ b: Any?) -> Bool {
        if let x = flat(a) as? Double, let y = flat(b) as? Double { return x == y || (x.isNaN && y.isNaN) }
        return same(a, b)
    }

    public static func isArray(_ v: Any?) -> Bool { flat(v) is [Any?] }

    // MARK: RegExp

    public static func regex(_ source: String, _ flags: String) -> JsValue {
        do { return try Js.regex(source, flags) } catch { report(error); return .null }
    }

    public static func test(_ re: JsValue, _ s: String) -> Bool { (callJs(re, "test", [.str(s)]) as? Bool) ?? false }

    // MARK: lewat implementasi dinamis

    /// Method JS lain lewat implementasi yang sama dengan mode dinamis.
    public static func method(_ recv: Any?, _ name: String, _ args: Any?...) -> Any? {
        callJs(js(recv), name, args.map { js($0) })
    }

    private static func callJs(_ recv: JsValue, _ name: String, _ args: [JsValue]) -> Any? {
        do { return native(try Js.callMethod(recv, name, args)) } catch { report(error); return nil }
    }

    private static func global(_ name: String, _ args: [Any?]) -> Any? {
        do { return native(try Js.call(JsBuiltins.global(name), args.map { js($0) })) } catch { report(error); return nil }
    }

    public static func strList(_ v: Any?) -> [String]? { (flat(v) as? [Any?])?.map { str($0) } }

    public static func json(_ v: Any?) -> String {
        do { return Js.toStr(try Js.callMethod(JsBuiltins.global("JSON"), "stringify", [js(v)])) } catch { report(error); return "" }
    }

    public static func log(_ level: String, _ args: Any?...) {
        JsConsole.sink(level, args.map { str($0) }.joined(separator: " "))
    }

    /// Error dari helper JS (mis. regex tidak valid). Swift bertipe tidak memakai `throws`, jadi
    /// error dicatat ke console dan nilainya menjadi undefined.
    static func report(_ e: Error) { JsConsole.sink("error", "\(e)") }
}
