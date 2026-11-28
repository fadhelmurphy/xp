import Foundation

/// Method bawaan JS (String, Array, Number, RegExp, Set, Map) dan objek global (Math, Object,
/// Array, JSON, ...) untuk komponen yang dikompilasi ke Swift. Padanan JsBuiltins.kt di Android.
/// Indeks string memakai UTF-16, sama seperti JavaScript.
public enum JsBuiltins {
    private static let stringMethods: Set<String> = [
        "replace", "replaceAll", "split", "toUpperCase", "toLowerCase", "trim", "trimStart", "trimEnd",
        "includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "slice", "substring", "charAt",
        "charCodeAt", "padStart", "padEnd", "repeat", "concat", "at", "match", "toString", "localeCompare",
        "toLocaleUpperCase", "toLocaleLowerCase", "normalize", "search",
    ]
    private static let arrayMethods: Set<String> = [
        "map", "filter", "forEach", "reduce", "reduceRight", "find", "findIndex", "findLast", "findLastIndex",
        "some", "every", "includes", "indexOf", "lastIndexOf", "join", "slice", "concat", "push", "pop", "shift",
        "unshift", "splice", "reverse", "sort", "flat", "flatMap", "at", "fill", "keys", "values", "entries",
        "toString", "toSorted", "toReversed",
    ]

    static func hasMethod(_ obj: JsValue, _ name: String) -> Bool {
        switch obj {
        case .str: return stringMethods.contains(name)
        case .arr: return arrayMethods.contains(name)
        case .num: return ["toFixed", "toString", "toPrecision", "valueOf"].contains(name)
        case .regex: return name == "test" || name == "exec"
        case .set: return ["has", "add", "delete", "clear", "forEach", "values"].contains(name)
        case .map: return ["has", "get", "set", "delete", "clear", "forEach", "keys", "values", "entries"].contains(name)
        case .obj: return name == "hasOwnProperty"
        case .fn: return ["call", "apply", "bind"].contains(name)
        case .date: return ["getTime", "valueOf", "toISOString"].contains(name)
        default: return false
        }
    }

    static func callMethod(_ obj: JsValue, _ name: String, _ a: [JsValue]) throws -> JsValue {
        switch obj {
        case .str(let s): return try string(s, name, a)
        case .arr(let l): return try array(l, name, a)
        case .num(let d): return try number(d, name, a)
        case .regex(let r): return try regexp(r, name, a)
        case .set(let s): return try set(s, name, a)
        case .map(let m): return try map(m, name, a)
        case .obj(let o):
            if name == "hasOwnProperty" { return .bool(o.has(Js.key(arg(a, 0)))) }
        case .date(let d):
            switch name {
            case "getTime", "valueOf": return .num(d.ms)
            case "toISOString": return .str(isoString(d.ms))
            default: break
            }
        case .fn(let f):
            switch name {
            case "call": return try f.impl(Array(a.dropFirst()))
            case "apply":
                if case .arr(let list) = arg(a, 1) { return try f.impl(list.items) }
                return try f.impl([])
            case "bind":
                let bound = Array(a.dropFirst())
                return .fn(JsFunction(f.name) { more in try f.impl(bound + more) })
            default: break
            }
        default: break
        }
        throw unknown(obj, name)
    }

    private static func unknown(_ obj: JsValue, _ name: String) -> JsError {
        JsError("TypeError: \(Js.typeOf(obj)).\(name) bukan function")
    }

    private static func arg(_ a: [JsValue], _ i: Int) -> JsValue { i < a.count ? a[i] : .null }

    private static func fn(_ a: [JsValue], _ i: Int) throws -> JsFunction {
        if case .fn(let f) = arg(a, i) { return f }
        throw JsError("TypeError: argumen \(i + 1) harus function")
    }

    private static func toInt(_ d: Double) -> Int {
        if d.isNaN { return 0 }
        if d >= Double(Int.max) { return Int.max }
        if d <= Double(Int.min) { return Int.min }
        return Int(d.rounded(.towardZero))
    }

    private static func idx(_ v: JsValue, _ len: Int, _ def: Int) -> Int {
        if v.isNull { return def }
        var n = Js.toNum(v)
        if n.isNaN { n = 0 }
        let i = n.isInfinite ? (n > 0 ? len : -len) : toInt(n)
        return i < 0 ? max(0, len + i) : min(i, len)
    }

    // MARK: String (UTF-16)

    private static func u16(_ s: String) -> [UInt16] { Array(s.utf16) }
    private static func str<C: Collection>(_ u: C) -> String where C.Element == UInt16 { String(decoding: u, as: UTF16.self) }

    private static func indexOf(_ h: [UInt16], _ n: [UInt16], from: Int = 0) -> Int {
        if n.isEmpty { return min(max(from, 0), h.count) }
        if n.count > h.count { return -1 }
        var i = max(from, 0)
        while i + n.count <= h.count {
            if h[i] == n[0] && Array(h[i..<(i + n.count)]) == n { return i }
            i += 1
        }
        return -1
    }

    private static func lastIndexOf(_ h: [UInt16], _ n: [UInt16]) -> Int {
        if n.count > h.count { return -1 }
        var i = h.count - n.count
        while i >= 0 {
            if Array(h[i..<(i + n.count)]) == n { return i }
            i -= 1
        }
        return -1
    }

    private static func string(_ s: String, _ name: String, _ a: [JsValue]) throws -> JsValue {
        let u = u16(s)
        switch name {
        case "toUpperCase", "toLocaleUpperCase": return .str(s.uppercased())
        case "toLowerCase", "toLocaleLowerCase": return .str(s.lowercased())
        case "trim": return .str(s.trimmingCharacters(in: .whitespacesAndNewlines))
        case "trimStart": return .str(String(s.drop { $0.isWhitespace }))
        case "trimEnd": return .str(String(s.reversed().drop { $0.isWhitespace }.reversed()))
        case "toString", "normalize": return .str(s)
        case "includes": return .bool(indexOf(u, u16(Js.toStr(arg(a, 0)))) >= 0)
        case "startsWith":
            let n = u16(Js.toStr(arg(a, 0)))
            let from = idx(arg(a, 1), u.count, 0)
            return .bool(from + n.count <= u.count && Array(u[from..<(from + n.count)]) == n)
        case "endsWith":
            let n = u16(Js.toStr(arg(a, 0)))
            let end = idx(arg(a, 1), u.count, u.count)
            return .bool(end - n.count >= 0 && Array(u[(end - n.count)..<end]) == n)
        case "indexOf": return .num(Double(indexOf(u, u16(Js.toStr(arg(a, 0))), from: idx(arg(a, 1), u.count, 0))))
        case "lastIndexOf": return .num(Double(lastIndexOf(u, u16(Js.toStr(arg(a, 0))))))
        case "search":
            guard case .regex(let r) = arg(a, 0) else { return .num(-1) }
            let m = r.regex.firstMatch(in: s, range: NSRange(location: 0, length: u.count))
            return .num(m.map { Double($0.range.location) } ?? -1)
        case "slice":
            let from = idx(arg(a, 0), u.count, 0), to = idx(arg(a, 1), u.count, u.count)
            return .str(from < to ? str(u[from..<to]) : "")
        case "substring":
            func c(_ v: JsValue, _ d: Int) -> Int {
                if v.isNull { return d }
                let n = Js.toNum(v)
                return n.isNaN ? 0 : min(max(toInt(n), 0), u.count)
            }
            let x = c(arg(a, 0), 0), y = c(arg(a, 1), u.count)
            return .str(str(u[min(x, y)..<max(x, y)]))
        case "charAt":
            let i = toInt(Js.toNum(a.isEmpty ? .num(0) : a[0]))
            return .str(i >= 0 && i < u.count ? str(u[i...i]) : "")
        case "charCodeAt":
            let i = toInt(Js.toNum(a.isEmpty ? .num(0) : a[0]))
            return .num(i >= 0 && i < u.count ? Double(u[i]) : .nan)
        case "at":
            var i = toInt(Js.toNum(arg(a, 0)))
            if i < 0 { i += u.count }
            return i >= 0 && i < u.count ? .str(str(u[i...i])) : .null
        case "padStart": return .str(pad(s, a, start: true))
        case "padEnd": return .str(pad(s, a, start: false))
        case "repeat": return .str(String(repeating: s, count: max(0, toInt(Js.toNum(arg(a, 0))))))
        case "concat": return .str(s + a.map(Js.toStr).joined())
        case "localeCompare":
            let t = Js.toStr(arg(a, 0))
            return .num(s == t ? 0 : (Js.utf16Less(s, t) ? -1 : 1))
        case "split": return try split(s, a)
        case "replace": return .str(try replace(s, arg(a, 0), arg(a, 1), all: false))
        case "replaceAll": return .str(try replace(s, arg(a, 0), arg(a, 1), all: true))
        case "match": return try match(s, arg(a, 0))
        default: throw unknown(.str(s), name)
        }
    }

    private static func pad(_ s: String, _ a: [JsValue], start: Bool) -> String {
        let len = toInt(Js.toNum(arg(a, 0)))
        let fill = arg(a, 1).isNull ? " " : Js.toStr(arg(a, 1))
        let cur = s.utf16.count
        if len <= cur || fill.isEmpty { return s }
        let need = len - cur
        let f = u16(fill)
        let padding = str((0..<need).map { f[$0 % f.count] })
        return start ? padding + s : s + padding
    }

    private static func split(_ s: String, _ a: [JsValue]) throws -> JsValue {
        let sep = arg(a, 0)
        let limit = arg(a, 1).isNull ? Int.max : max(0, toInt(Js.toNum(arg(a, 1))))
        var parts: [String]
        switch sep {
        case .null: parts = [s]
        case .regex(let r):
            if s.isEmpty { parts = [""]; break }
            let ns = s as NSString
            parts = []
            var last = 0
            for m in r.regex.matches(in: s, range: NSRange(location: 0, length: ns.length)) where m.range.length > 0 || m.range.location > last {
                parts.append(ns.substring(with: NSRange(location: last, length: m.range.location - last)))
                last = m.range.location + m.range.length
            }
            parts.append(ns.substring(from: last))
        default:
            let t = Js.toStr(sep)
            if t.isEmpty { parts = s.utf16.map { str([$0]) } }
            else {
                let u = u16(s), n = u16(t)
                parts = []
                var from = 0
                while true {
                    let at = indexOf(u, n, from: from)
                    if at < 0 { break }
                    parts.append(str(u[from..<at]))
                    from = at + n.count
                }
                parts.append(str(u[from...]))
            }
        }
        return .arr(JsArray(parts.prefix(limit).map { .str($0) }))
    }

    private static func groups(_ m: NSTextCheckingResult, _ ns: NSString) -> [JsValue] {
        (1..<max(1, m.numberOfRanges)).map { g in
            let r = m.range(at: g)
            return r.location == NSNotFound ? .null : .str(ns.substring(with: r))
        }
    }

    private static func replace(_ s: String, _ pattern: JsValue, _ with: JsValue, all: Bool) throws -> String {
        var f: JsFunction?
        if case .fn(let fn) = with { f = fn }
        let ns = s as NSString
        if case .regex(let re) = pattern {
            let global = all || re.global
            var matches = re.regex.matches(in: s, range: NSRange(location: 0, length: ns.length))
            if !global { matches = Array(matches.prefix(1)) }
            var out = ""
            var last = 0
            for m in matches {
                out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
                let whole = ns.substring(with: m.range)
                if let f = f {
                    out += Js.toStr(try f.impl([.str(whole)] + groups(m, ns) + [.num(Double(m.range.location)), .str(s)]))
                } else {
                    out += expand(Js.toStr(with), m, ns)
                }
                last = m.range.location + m.range.length
            }
            return out + ns.substring(from: last)
        }
        let needle = Js.toStr(pattern)
        let u = u16(s), n = u16(needle)
        func replacement(_ at: Int) throws -> String {
            if let f = f { return Js.toStr(try f.impl([.str(needle), .num(Double(at)), .str(s)])) }
            return Js.toStr(with).replacingOccurrences(of: "$&", with: needle)
        }
        if !all {
            let at = indexOf(u, n)
            return at < 0 ? s : str(u[..<at]) + (try replacement(at)) + str(u[(at + n.count)...])
        }
        if n.isEmpty { return s }
        var out = ""
        var from = 0
        while true {
            let at = indexOf(u, n, from: from)
            if at < 0 { break }
            out += str(u[from..<at]) + (try replacement(at))
            from = at + n.count
        }
        return out + str(u[from...])
    }

    // $1, $&, $$, $`, $'
    private static func expand(_ template: String, _ m: NSTextCheckingResult, _ input: NSString) -> String {
        let t = Array(template.utf16)
        var out: [UInt16] = []
        var i = 0
        let dollar: UInt16 = 36
        func isDigit(_ c: UInt16) -> Bool { c >= 48 && c <= 57 }
        while i < t.count {
            let c = t[i]
            if c != dollar || i + 1 >= t.count { out.append(c); i += 1; continue }
            let n = t[i + 1]
            switch n {
            case dollar: out.append(dollar); i += 2
            case 38: out += Array(input.substring(with: m.range).utf16); i += 2 // &
            case 96: out += Array(input.substring(to: m.range.location).utf16); i += 2 // `
            case 39: out += Array(input.substring(from: m.range.location + m.range.length).utf16); i += 2 // '
            default:
                if isDigit(n) {
                    var j = i + 1
                    while j < t.count && j < i + 3 && isDigit(t[j]) { j += 1 }
                    var g = Int(str(t[(i + 1)..<j]))!
                    if g >= m.numberOfRanges && j - i > 2 { j -= 1; g /= 10 }
                    if g >= 1 && g < m.numberOfRanges {
                        let r = m.range(at: g)
                        if r.location != NSNotFound { out += Array(input.substring(with: r).utf16) }
                    } else {
                        out += t[i..<j]
                    }
                    i = j
                } else {
                    out.append(c)
                    i += 1
                }
            }
        }
        return str(out)
    }

    private static func match(_ s: String, _ pattern: JsValue) throws -> JsValue {
        let re: JsRegExp
        if case .regex(let r) = pattern { re = r } else { re = try JsRegExp(NSRegularExpression.escapedPattern(for: Js.toStr(pattern)), "") }
        let ns = s as NSString
        let range = NSRange(location: 0, length: ns.length)
        if re.global {
            let all = re.regex.matches(in: s, range: range).map { JsValue.str(ns.substring(with: $0.range)) }
            return all.isEmpty ? .null : .arr(JsArray(all))
        }
        guard let m = re.regex.firstMatch(in: s, range: range) else { return .null }
        return .arr(JsArray([.str(ns.substring(with: m.range))] + groups(m, ns)))
    }

    // MARK: RegExp

    private static func regexp(_ re: JsRegExp, _ name: String, _ a: [JsValue]) throws -> JsValue {
        let s = Js.toStr(arg(a, 0))
        let ns = s as NSString
        let m = re.regex.firstMatch(in: s, range: NSRange(location: 0, length: ns.length))
        switch name {
        case "test": return .bool(m != nil)
        case "exec":
            guard let m = m else { return .null }
            return .arr(JsArray([.str(ns.substring(with: m.range))] + groups(m, ns)))
        default: throw unknown(.regex(re), name)
        }
    }

    // MARK: Number

    /// toFixed seperti JS: pembulatan setengah ke atas dari nilai biner yang persis.
    static func toFixed(_ d: Double, _ digits: Int) -> String {
        if abs(d) >= 1e21 || d.isNaN || d.isInfinite { return Js.numStr(d) }
        let f = max(0, min(100, digits))
        var text = String(format: "%.\(f)f", d)
        let scaled = abs(d) * Foundation.pow(10, Double(f))
        if scaled < 9007199254740992, scaled - scaled.rounded(.down) == 0.5 {
            // tepat di tengah: printf membulatkan ke genap, JS ke atas
            let up = (scaled.rounded(.down) + 1) / Foundation.pow(10, Double(f))
            text = String(format: "%.\(f)f", d < 0 ? -up : up)
        }
        if text.hasPrefix("-"), Double(text) == 0 { text.removeFirst() }
        return text
    }

    private static func number(_ d: Double, _ name: String, _ a: [JsValue]) throws -> JsValue {
        switch name {
        case "toFixed": return .str(toFixed(d, toInt(Js.toNum(a.isEmpty ? .num(0) : a[0]))))
        case "toPrecision":
            if arg(a, 0).isNull { return .str(Js.numStr(d)) }
            let p = max(1, toInt(Js.toNum(arg(a, 0))))
            if d == 0 { return .str(toFixed(0, p - 1)) }
            let e = Int(Foundation.floor(Foundation.log10(abs(d))))
            return .str(toFixed(d, max(0, p - 1 - e)))
        case "toString":
            if arg(a, 0).isNull { return .str(Js.numStr(d)) }
            let radix = toInt(Js.toNum(arg(a, 0)))
            if radix == 10 || d != d.rounded(.down) || abs(d) > 9e15 { return .str(Js.numStr(d)) }
            return .str(String(Int64(d), radix: radix))
        case "valueOf": return .num(d)
        default: throw unknown(.num(d), name)
        }
    }

    // MARK: Array

    private static func cb(_ f: JsFunction, _ v: JsValue, _ i: Int, _ list: JsArray) throws -> JsValue {
        try f.impl([v, .num(Double(i)), .arr(list)])
    }

    private static func array(_ list: JsArray, _ name: String, _ a: [JsValue]) throws -> JsValue {
        let items = list.items
        switch name {
        case "map":
            let f = try fn(a, 0)
            var out: [JsValue] = []
            out.reserveCapacity(items.count)
            for (i, v) in items.enumerated() { out.append(try cb(f, v, i, list)) }
            return .arr(JsArray(out))
        case "filter":
            let f = try fn(a, 0)
            var out: [JsValue] = []
            for (i, v) in items.enumerated() where Js.truthy(try cb(f, v, i, list)) { out.append(v) }
            return .arr(JsArray(out))
        case "forEach":
            let f = try fn(a, 0)
            for (i, v) in items.enumerated() { _ = try cb(f, v, i, list) }
            return .null
        case "find", "findIndex":
            let f = try fn(a, 0)
            for (i, v) in items.enumerated() where Js.truthy(try cb(f, v, i, list)) { return name == "find" ? v : .num(Double(i)) }
            return name == "find" ? .null : .num(-1)
        case "findLast", "findLastIndex":
            let f = try fn(a, 0)
            for (i, v) in items.enumerated().reversed() where Js.truthy(try cb(f, v, i, list)) { return name == "findLast" ? v : .num(Double(i)) }
            return name == "findLast" ? .null : .num(-1)
        case "some":
            let f = try fn(a, 0)
            for (i, v) in items.enumerated() where Js.truthy(try cb(f, v, i, list)) { return .bool(true) }
            return .bool(false)
        case "every":
            let f = try fn(a, 0)
            for (i, v) in items.enumerated() where !Js.truthy(try cb(f, v, i, list)) { return .bool(false) }
            return .bool(true)
        case "reduce", "reduceRight":
            let f = try fn(a, 0)
            var order = Array(items.indices)
            if name == "reduceRight" { order.reverse() }
            var pos = 0
            var acc: JsValue
            if a.count > 1 { acc = a[1] }
            else if !order.isEmpty { acc = items[order[0]]; pos = 1 }
            else { throw JsError("TypeError: reduce pada array kosong tanpa nilai awal") }
            while pos < order.count {
                let i = order[pos]
                acc = try f.impl([acc, items[i], .num(Double(i)), .arr(list)])
                pos += 1
            }
            return acc
        case "includes":
            let x = arg(a, 0)
            return .bool(items.contains { Js.same($0, x) || Js.seq($0, x) })
        case "indexOf":
            let x = arg(a, 0)
            return .num(Double(items.firstIndex { Js.seq($0, x) } ?? -1))
        case "lastIndexOf":
            let x = arg(a, 0)
            return .num(Double(items.lastIndex { Js.seq($0, x) } ?? -1))
        case "join":
            let sep = arg(a, 0).isNull ? "," : Js.toStr(arg(a, 0))
            return .str(items.map { $0.isNull ? "" : Js.toStr($0) }.joined(separator: sep))
        case "toString": return .str(Js.toStr(.arr(list)))
        case "slice":
            let from = idx(arg(a, 0), items.count, 0), to = idx(arg(a, 1), items.count, items.count)
            return .arr(JsArray(from < to ? Array(items[from..<to]) : []))
        case "concat":
            var out = items
            for x in a { if case .arr(let l) = x { out += l.items } else { out.append(x) } }
            return .arr(JsArray(out))
        case "at":
            var i = toInt(Js.toNum(arg(a, 0)))
            if i < 0 { i += items.count }
            return i >= 0 && i < items.count ? items[i] : .null
        case "flat": return .arr(JsArray(flat(items, arg(a, 0).isNull ? 1 : toInt(Js.toNum(arg(a, 0))))))
        case "flatMap":
            let f = try fn(a, 0)
            var out: [JsValue] = []
            for (i, v) in items.enumerated() {
                let r = try cb(f, v, i, list)
                if case .arr(let l) = r { out += l.items } else { out.append(r) }
            }
            return .arr(JsArray(out))
        case "keys": return .arr(JsArray(items.indices.map { .num(Double($0)) }))
        case "values": return .arr(JsArray(items))
        case "entries": return .arr(JsArray(items.enumerated().map { .arr(JsArray([.num(Double($0.offset)), $0.element])) }))
        case "toSorted":
            let copy = JsArray(items)
            try sortInPlace(copy, arg(a, 0))
            return .arr(copy)
        case "toReversed": return .arr(JsArray(items.reversed()))
        case "push":
            list.items += a
            return .num(Double(list.items.count))
        case "pop": return list.items.popLast() ?? .null
        case "shift": return list.items.isEmpty ? .null : list.items.removeFirst()
        case "unshift":
            list.items.insert(contentsOf: a, at: 0)
            return .num(Double(list.items.count))
        case "reverse":
            list.items.reverse()
            return .arr(list)
        case "sort":
            try sortInPlace(list, arg(a, 0))
            return .arr(list)
        case "fill":
            let from = idx(arg(a, 1), items.count, 0), to = idx(arg(a, 2), items.count, items.count)
            if from < to { for i in from..<to { list.items[i] = arg(a, 0) } }
            return .arr(list)
        case "splice":
            let start = idx(arg(a, 0), items.count, 0)
            let count = a.count < 2 ? items.count - start : min(max(toInt(Js.toNum(arg(a, 1))), 0), items.count - start)
            let removed = Array(list.items[start..<(start + count)])
            list.items.replaceSubrange(start..<(start + count), with: a.dropFirst(2))
            return .arr(JsArray(removed))
        default: throw unknown(.arr(list), name)
        }
    }

    private static func flat(_ items: [JsValue], _ depth: Int) -> [JsValue] {
        var out: [JsValue] = []
        for x in items {
            if case .arr(let l) = x, depth > 0 { out += flat(l.items, depth - 1) } else { out.append(x) }
        }
        return out
    }

    /// Merge sort yang stabil (seperti JS); undefined selalu di akhir.
    private static func sortInPlace(_ arr: JsArray, _ cmp: JsValue) throws {
        var f: JsFunction?
        if case .fn(let fn) = cmp { f = fn }
        func before(_ x: JsValue, _ y: JsValue) throws -> Bool { // x harus di depan y?
            if x.isNull { return false }
            if y.isNull { return true }
            if let f = f {
                let r = Js.toNum(try f.impl([x, y]))
                return !r.isNaN && r < 0
            }
            return Js.utf16Less(Js.toStr(x), Js.toStr(y))
        }
        func sort(_ a: [JsValue]) throws -> [JsValue] {
            if a.count < 2 { return a }
            let mid = a.count / 2
            let l = try sort(Array(a[..<mid])), r = try sort(Array(a[mid...]))
            var out: [JsValue] = []
            out.reserveCapacity(a.count)
            var i = 0, j = 0
            while i < l.count && j < r.count {
                if try before(r[j], l[i]) { out.append(r[j]); j += 1 } else { out.append(l[i]); i += 1 }
            }
            out += l[i...]
            out += r[j...]
            return out
        }
        arr.items = try sort(arr.items)
    }

    // MARK: Set / Map

    private static func set(_ s: JsSet, _ name: String, _ a: [JsValue]) throws -> JsValue {
        switch name {
        case "has": return .bool(s.members.contains(JsKey(arg(a, 0))))
        case "add": s.add(arg(a, 0)); return .set(s)
        case "delete": return .bool(s.remove(arg(a, 0)))
        case "clear": s.order = []; s.members = []; return .null
        case "values": return .arr(JsArray(s.values))
        case "forEach":
            let f = try fn(a, 0)
            for v in s.values { _ = try f.impl([v, v, .set(s)]) }
            return .null
        default: throw unknown(.set(s), name)
        }
    }

    private static func map(_ m: JsMap, _ name: String, _ a: [JsValue]) throws -> JsValue {
        switch name {
        case "has": return .bool(m.dict[JsKey(arg(a, 0))] != nil)
        case "get": return m.dict[JsKey(arg(a, 0))] ?? .null
        case "set": m.set(arg(a, 0), arg(a, 1)); return .map(m)
        case "delete": return .bool(m.remove(arg(a, 0)))
        case "clear": m.order = []; m.dict = [:]; return .null
        case "keys": return .arr(JsArray(m.order.map(\.value)))
        case "values": return .arr(JsArray(m.entries.map(\.1)))
        case "entries": return .arr(JsArray(m.entries.map { .arr(JsArray([$0.0, $0.1])) }))
        case "forEach":
            let f = try fn(a, 0)
            for (k, v) in m.entries { _ = try f.impl([v, k, .map(m)]) }
            return .null
        default: throw unknown(.map(m), name)
        }
    }

    // MARK: objek global

    private static func f(_ name: String, _ impl: @escaping JsImpl) -> JsValue { .fn(JsFunction(name, impl)) }
    private static func num(_ a: [JsValue], _ i: Int) -> Double { Js.toNum(arg(a, i)) }
    private static func math1(_ name: String, _ op: @escaping (Double) -> Double) -> (String, JsValue) {
        (name, f(name) { a in .num(op(num(a, 0))) })
    }

    static let Math: JsValue = .obj(JsObject([
        ("PI", .num(Double.pi)),
        ("E", .num(M_E)),
        math1("round") { $0.isNaN || $0.isInfinite ? $0 : Foundation.floor($0 + 0.5) },
        math1("floor") { Foundation.floor($0) },
        math1("ceil") { Foundation.ceil($0) },
        math1("trunc") { $0.rounded(.towardZero) },
        math1("abs") { Swift.abs($0) },
        math1("sign") { $0.isNaN ? .nan : ($0 > 0 ? 1 : ($0 < 0 ? -1 : $0)) },
        math1("sqrt") { $0.squareRoot() },
        math1("cbrt") { Foundation.cbrt($0) },
        ("pow", f("pow") { a in .num(Foundation.pow(num(a, 0), num(a, 1))) }),
        math1("exp") { Foundation.exp($0) },
        math1("log") { Foundation.log($0) },
        math1("log10") { Foundation.log10($0) },
        math1("log2") { Foundation.log2($0) },
        math1("sin") { Foundation.sin($0) },
        math1("cos") { Foundation.cos($0) },
        math1("tan") { Foundation.tan($0) },
        math1("atan") { Foundation.atan($0) },
        ("atan2", f("atan2") { a in .num(Foundation.atan2(num(a, 0), num(a, 1))) }),
        ("hypot", f("hypot") { a in .num(a.map { Js.toNum($0) * Js.toNum($0) }.reduce(0, +).squareRoot()) }),
        ("min", f("min") { a in
            let xs = a.map(Js.toNum)
            if xs.contains(where: \.isNaN) { return .num(.nan) }
            return .num(xs.min() ?? .infinity)
        }),
        ("max", f("max") { a in
            let xs = a.map(Js.toNum)
            if xs.contains(where: \.isNaN) { return .num(.nan) }
            return .num(xs.max() ?? -.infinity)
        }),
        ("random", f("random") { _ in .num(Double.random(in: 0..<1)) }),
    ]))

    static let Object: JsValue = .obj(JsObject([
        ("keys", f("keys") { a in .arr(JsArray(Js.keys(arg(a, 0)))) }),
        ("values", f("values") { a in
            switch arg(a, 0) {
            case .obj(let o): return .arr(JsArray(o.entries.map(\.1)))
            case .arr(let l): return .arr(JsArray(l.items))
            default: return .arr(JsArray())
            }
        }),
        ("entries", f("entries") { a in
            switch arg(a, 0) {
            case .obj(let o): return .arr(JsArray(o.entries.map { .arr(JsArray([.str($0.0), $0.1])) }))
            case .arr(let l): return .arr(JsArray(l.items.enumerated().map { .arr(JsArray([.str(String($0.offset)), $0.element])) }))
            default: return .arr(JsArray())
            }
        }),
        ("fromEntries", f("fromEntries") { a in
            let o = JsObject()
            for e in try Js.iter(arg(a, 0)) {
                if case .arr(let pair) = e { o[Js.key(arg(pair.items, 0))] = arg(pair.items, 1) }
            }
            return .obj(o)
        }),
        ("assign", f("assign") { a in
            guard case .obj(let target) = arg(a, 0) else { throw JsError("TypeError: Object.assign butuh object") }
            for src in a.dropFirst() { Js.spreadInto(target, src) }
            return .obj(target)
        }),
        ("freeze", f("freeze") { a in arg(a, 0) }),
        ("is", f("is") { a in .bool(Js.same(arg(a, 0), arg(a, 1))) }),
    ]))

    /// `Array(3)` / `new Array(3)` → 3 slot kosong; `Array(a, b)` → [a, b].
    private static func newArray(_ a: [JsValue]) -> JsValue {
        if a.count == 1, case .num(let n) = a[0] { return .arr(JsArray(Array(repeating: .null, count: max(0, toInt(n))))) }
        return .arr(JsArray(a))
    }

    static let ArrayFn = JsFunction("Array", statics: JsObject([
        ("isArray", f("isArray") { a in .bool(Js.isArray(arg(a, 0))) }),
        ("of", f("of") { a in .arr(JsArray(a)) }),
        ("from", f("from") { a in
            let src = arg(a, 0)
            var items: [JsValue]
            if case .obj(let o) = src, let len = o["length"] {
                items = Array(repeating: .null, count: max(0, toInt(Js.toNum(len))))
            } else {
                items = try Js.iter(src)
            }
            if case .fn(let m) = arg(a, 1) {
                items = try items.enumerated().map { try m.impl([$0.element, .num(Double($0.offset))]) }
            }
            return .arr(JsArray(items))
        }),
    ])) { a in newArray(a) }

    static let JSON: JsValue = .obj(JsObject([
        ("stringify", f("stringify") { a in a.isEmpty || a[0].isNull ? .null : .str(stringify(a[0])) }),
        ("parse", f("parse") { a in
            do {
                return try JsJSON.parse(Js.toStr(arg(a, 0)))
            } catch let e as JsJSON.ParseError {
                throw JsError(.obj(JsObject([("name", .str("SyntaxError")), ("message", .str(e.message))])))
            }
        }),
    ]))

    static func stringify(_ v: JsValue) -> String {
        switch v {
        case .fn, .null: return "null"
        case .num(let d): return d.isFinite ? Js.numStr(d) : "null"
        case .bool(let b): return b ? "true" : "false"
        case .str(let s): return XPJSON.quote(s)
        case .obj(let o):
            let parts = o.entries.compactMap { (k, x) -> String? in
                if case .fn = x { return nil }
                if x.isNull { return nil }
                return XPJSON.quote(k) + ":" + stringify(x)
            }
            return "{" + parts.joined(separator: ",") + "}"
        case .arr(let l): return "[" + l.items.map(stringify).joined(separator: ",") + "]"
        default: return XPJSON.quote(Js.toStr(v))
        }
    }

    static let NumberFn = JsFunction("Number", statics: JsObject([
        ("isInteger", f("isInteger") { a in
            if case .num(let d) = arg(a, 0) { return .bool(d.isFinite && d == d.rounded(.down)) }
            return .bool(false)
        }),
        ("isFinite", f("isFinite") { a in
            if case .num(let d) = arg(a, 0) { return .bool(d.isFinite) }
            return .bool(false)
        }),
        ("isNaN", f("isNaN") { a in
            if case .num(let d) = arg(a, 0) { return .bool(d.isNaN) }
            return .bool(false)
        }),
        ("parseFloat", f("parseFloat") { a in .num(parseFloat(arg(a, 0))) }),
        ("parseInt", f("parseInt") { a in .num(parseInt(arg(a, 0), arg(a, 1))) }),
        ("MAX_SAFE_INTEGER", .num(9007199254740991)),
        ("MIN_SAFE_INTEGER", .num(-9007199254740991)),
        ("EPSILON", .num(Double.ulpOfOne)),
    ])) { a in a.isEmpty ? .num(0) : .num(Js.toNum(a[0])) }

    static func parseFloat(_ v: JsValue) -> Double {
        let s = String(Js.toStr(v).drop { $0.isWhitespace })
        let re = try! NSRegularExpression(pattern: "^[+-]?(Infinity|\\d+\\.?\\d*([eE][+-]?\\d+)?|\\.\\d+([eE][+-]?\\d+)?)")
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return .nan }
        let text = ns.substring(with: m.range)
        if text.hasSuffix("Infinity") { return s.hasPrefix("-") ? -.infinity : .infinity }
        return Double(text) ?? .nan
    }

    static func parseInt(_ v: JsValue, _ radixArg: JsValue) -> Double {
        var s = Substring(Js.toStr(v).trimmingCharacters(in: .whitespacesAndNewlines))
        var neg = false
        if s.hasPrefix("-") || s.hasPrefix("+") { neg = s.first == "-"; s = s.dropFirst() }
        var radix = radixArg.isNull ? 0 : toInt(Js.toNum(radixArg))
        if (radix == 0 || radix == 16) && (s.hasPrefix("0x") || s.hasPrefix("0X")) { s = s.dropFirst(2); radix = 16 }
        if radix == 0 { radix = 10 }
        if radix < 2 || radix > 36 { return .nan }
        var n = 0.0
        var any = false
        for c in s {
            guard let d = c.hexDigitValue ?? (c.isLetter && c.isASCII ? Int(c.lowercased().unicodeScalars.first!.value) - 87 : nil), d < radix else { break }
            n = n * Double(radix) + Double(d)
            any = true
        }
        if !any { return .nan }
        return neg ? -n : n
    }

    static let StringFn: JsValue = f("String") { a in .str(a.isEmpty ? "" : Js.toStr(a[0])) }
    static let BooleanFn: JsValue = f("Boolean") { a in .bool(Js.truthy(arg(a, 0))) }

    static let console: JsValue = .obj(JsObject(["log", "info", "warn", "error", "debug"].map { level in
        (level, f(level) { a in
            JsConsole.sink(level, a.map(Js.toStr).joined(separator: " "))
            return .null
        })
    }))

    /// Jam (ms) untuk Date.now() dan `new Date()`; bisa diganti di tes.
    public static var clock: () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded(.down) }

    static let DateObj: JsValue = .obj(JsObject([("now", f("now") { _ in .num(clock()) })]))

    static func isoString(_ ms: Double) -> String {
        let secs = (ms / 1000).rounded(.down)
        let millis = Int(ms - secs * 1000)
        var t = time_t(secs)
        var tm = tm()
        gmtime_r(&t, &tm)
        return String(format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", Int(tm.tm_year) + 1900, Int(tm.tm_mon) + 1, Int(tm.tm_mday), Int(tm.tm_hour), Int(tm.tm_min), Int(tm.tm_sec), millis)
    }

    static let ErrorFn: JsFunction = JsFunction("Error") { a in try construct(.fn(ErrorFn), a) }
    static let TypeErrorFn: JsFunction = JsFunction("TypeError") { a in try construct(.fn(TypeErrorFn), a) }
    static let SetCtor = JsObject()
    static let MapCtor = JsObject()

    /// `new X(...)` yang didukung.
    public static func construct(_ ctor: JsValue, _ a: [JsValue]) throws -> JsValue {
        switch ctor {
        case .fn(let f) where f === ErrorFn || f === TypeErrorFn:
            return .obj(JsObject([
                ("name", .str(f === TypeErrorFn ? "TypeError" : "Error")),
                ("message", .str(arg(a, 0).isNull ? "" : Js.toStr(arg(a, 0)))),
            ]))
        case .fn(let f) where f === ArrayFn: return newArray(a)
        case .obj(let o) where o === SetCtor:
            let s = JsSet()
            if !arg(a, 0).isNull { for x in try Js.iter(arg(a, 0)) { s.add(x) } }
            return .set(s)
        case .obj(let o) where o === MapCtor:
            let m = JsMap()
            if !arg(a, 0).isNull {
                for e in try Js.iter(arg(a, 0)) { if case .arr(let p) = e { m.set(arg(p.items, 0), arg(p.items, 1)) } }
            }
            return .map(m)
        case .obj(let o) where Js.seq(.obj(o), DateObj):
            return .date(JsDate(arg(a, 0).isNull ? clock() : Js.toNum(arg(a, 0))))
        default:
            throw JsError("TypeError: 'new' untuk \(Js.typeOf(ctor)) belum didukung di target native")
        }
    }

    /// Nilai global yang boleh dipakai komponen.
    public static func global(_ name: String) throws -> JsValue {
        switch name {
        case "Math": return Math
        case "Object": return Object
        case "Array": return .fn(ArrayFn)
        case "JSON": return JSON
        case "Number": return .fn(NumberFn)
        case "String": return StringFn
        case "Boolean": return BooleanFn
        case "console": return console
        case "Date": return DateObj
        case "Error": return .fn(ErrorFn)
        case "TypeError": return .fn(TypeErrorFn)
        case "Set": return .obj(SetCtor)
        case "Map": return .obj(MapCtor)
        case "NaN": return .num(.nan)
        case "Infinity": return .num(.infinity)
        case "parseInt": return f("parseInt") { a in .num(parseInt(arg(a, 0), arg(a, 1))) }
        case "parseFloat": return f("parseFloat") { a in .num(parseFloat(arg(a, 0))) }
        case "isNaN": return f("isNaN") { a in .bool(Js.toNum(arg(a, 0)).isNaN) }
        case "isFinite": return f("isFinite") { a in .bool(Js.toNum(arg(a, 0)).isFinite) }
        default: throw JsError("ReferenceError: \(name) tidak tersedia di target native")
        }
    }
}

public enum JsConsole {
    /// Diganti app kalau perlu (mis. ke os_log); default ke stdout.
    public static var sink: (_ level: String, _ message: String) -> Void = { level, message in print("[xp:\(level)] \(message)") }
}

/// JSON → nilai JS dengan urutan kunci terjaga (JSONSerialization tidak menjaga urutan).
public enum JsJSON {
    struct ParseError: Error { let message: String }

    public static func parse(_ text: String) throws -> JsValue {
        var p = Parser(s: Array(text.utf16))
        let v = try p.value()
        p.ws()
        if p.i != p.s.count { throw p.err("sisa input") }
        return v
    }

    struct Parser {
        let s: [UInt16]
        var i = 0

        func err(_ m: String) -> ParseError { ParseError(message: "JSON tidak valid di posisi \(i): \(m)") }

        mutating func ws() { while i < s.count, [32, 9, 10, 13].contains(s[i]) { i += 1 } }

        mutating func value() throws -> JsValue {
            ws()
            guard i < s.count else { throw err("input habis") }
            switch s[i] {
            case 123: return try object() // {
            case 91: return try array() // [
            case 34: return .str(try string()) // "
            case 116: try word("true"); return .bool(true)
            case 102: try word("false"); return .bool(false)
            case 110: try word("null"); return .null
            default:
                if s[i] == 45 || (s[i] >= 48 && s[i] <= 57) { return try number() }
                throw err("karakter tidak terduga")
            }
        }

        mutating func word(_ w: String) throws {
            let u = Array(w.utf16)
            guard i + u.count <= s.count, Array(s[i..<(i + u.count)]) == u else { throw err("mengharapkan \(w)") }
            i += u.count
        }

        mutating func number() throws -> JsValue {
            let start = i
            while i < s.count, let c = Optional(s[i]), (c >= 48 && c <= 57) || [45, 43, 46, 101, 69].contains(c) { i += 1 }
            guard let d = Double(String(decoding: s[start..<i], as: UTF16.self)) else { throw err("angka tidak valid") }
            return .num(d)
        }

        mutating func string() throws -> String {
            i += 1
            var out: [UInt16] = []
            while i < s.count {
                let c = s[i]
                if c == 34 { i += 1; return String(decoding: out, as: UTF16.self) }
                if c == 92 {
                    i += 1
                    guard i < s.count else { break }
                    let e = s[i]
                    switch e {
                    case 110: out.append(10)
                    case 116: out.append(9)
                    case 114: out.append(13)
                    case 98: out.append(8)
                    case 102: out.append(12)
                    case 117:
                        guard i + 4 < s.count, let code = UInt16(String(decoding: s[(i + 1)...(i + 4)], as: UTF16.self), radix: 16) else { throw err("escape \\u tidak valid") }
                        out.append(code)
                        i += 4
                    default: out.append(e)
                    }
                    i += 1
                    continue
                }
                out.append(c)
                i += 1
            }
            throw err("string tidak ditutup")
        }

        mutating func array() throws -> JsValue {
            i += 1
            var items: [JsValue] = []
            ws()
            if i < s.count && s[i] == 93 { i += 1; return .arr(JsArray()) }
            while true {
                items.append(try value())
                ws()
                guard i < s.count else { throw err("array tidak ditutup") }
                if s[i] == 44 { i += 1; continue }
                if s[i] == 93 { i += 1; return .arr(JsArray(items)) }
                throw err("mengharapkan , atau ]")
            }
        }

        mutating func object() throws -> JsValue {
            i += 1
            let o = JsObject()
            ws()
            if i < s.count && s[i] == 125 { i += 1; return .obj(o) }
            while true {
                ws()
                guard i < s.count, s[i] == 34 else { throw err("mengharapkan key") }
                let k = try string()
                ws()
                guard i < s.count, s[i] == 58 else { throw err("mengharapkan :") }
                i += 1
                o[k] = try value()
                ws()
                guard i < s.count else { throw err("object tidak ditutup") }
                if s[i] == 44 { i += 1; continue }
                if s[i] == 125 { i += 1; return .obj(o) }
                throw err("mengharapkan , atau }")
            }
        }
    }
}
