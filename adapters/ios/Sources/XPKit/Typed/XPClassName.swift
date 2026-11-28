import Foundation

/// className (Tailwind) untuk komponen mode typed. Isinya sama dengan modul jsx className di
/// cli/classname.mjs dan XPClassName.kt: tabel class → style dibuat saat build, di sini dipilih
/// sesuai lebar layar / mode gelap lalu digabung dengan `style` milik elemen.
public enum XPClassName {
    final class Entry {
        let order: Double
        let style: [(String, Any?)]
        let cond: [String: Any?]?
        init(_ order: Double, _ style: [(String, Any?)], _ cond: [String: Any?]?) {
            self.order = order
            self.style = style
            self.cond = cond
        }
    }

    public final class Table {
        let entries: [String: Entry]
        let breakpoints: [Double]
        let viewport: Bool
        var cache: [String: Resolved] = [:]

        init(_ entries: [String: Entry]) {
            self.entries = entries
            var bp: [Double] = []
            for e in entries.values.sorted(by: { $0.order < $1.order }) {
                for k in ["minWidth", "maxWidth"] {
                    if let w = e.cond?[k] as? Double, !bp.contains(w) { bp.append(w) }
                }
            }
            breakpoints = bp
            viewport = entries.values.contains { e in e.style.contains { ($0.1 as? String).map { $0.hasSuffix("vh") || $0.hasSuffix("vw") } ?? false } }
        }
    }

    /// Style dengan urutan kunci terjaga (urutan berpengaruh untuk pasangan kunci gabungan).
    typealias Style = [(String, Any?)]

    final class Resolved {
        let style: Style
        let states: [String: Style]
        init(_ style: Style, _ states: [String: Style]) {
            self.style = style
            self.states = states
        }
    }

    /// Tabel dari JSON hasil build: class → [urutan, style, kondisi?, classCss?].
    public static func table(_ json: String) -> Table {
        var entries: [String: Entry] = [:]
        guard case .obj(let raw)? = try? JsJSON.parse(json) else { return Table(entries) }
        for (k, v) in raw.entries {
            guard case .arr(let e) = v else { continue }
            if e.items.count > 3, !e.items[3].isNull { continue } // class CSS: hanya untuk web
            var style: Style = []
            if case .obj(let s) = e.items[1] { for (sk, sv) in s.entries { style.append((sk, XPStd.native(sv))) } }
            let cond = e.items.count > 2 ? XPStd.native(e.items[2]) as? [String: Any?] : nil
            entries[k] = Entry(Js.toNum(e.items[0]), style, cond)
        }
        return Table(entries)
    }

    private static func matches(_ c: [String: Any?], _ env: XPEnv) -> Bool {
        if let w = XPStd.flat(c["minWidth"] ?? nil) as? Double, !(env.width >= w) { return false }
        if let w = XPStd.flat(c["maxWidth"] ?? nil) as? Double, !(env.width < w) { return false }
        if let d = XPStd.flat(c["dark"] ?? nil) as? Bool, d != env.dark { return false }
        return true
    }

    private static func resolve(_ t: Table, _ env: XPEnv, _ className: String) -> Resolved {
        var key = className + "|"
        for w in t.breakpoints { key += env.width >= w ? "1" : "0" }
        if env.dark { key += "d" }
        if t.viewport { key += XPStd.str(env.width) + "x" + XPStd.str(env.height) }
        if let hit = t.cache[key] { return hit }
        let list = className.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" || $0 == "\r" })
            .compactMap { t.entries[String($0)] }
            .enumerated().sorted { ($0.element.order, $0.offset) < ($1.element.order, $1.offset) }.map { $0.element }
        var style: Style = []
        var states: [String: Style] = [:]
        var stateOrder: [String] = []
        for e in list {
            guard let c = e.cond else { merge(&style, e.style); continue }
            guard matches(c, env) else { continue }
            if let st = XPStd.flat(c["state"] ?? nil) as? String {
                if states[st] == nil { states[st] = []; stateOrder.append(st) }
                merge(&states[st]!, e.style)
            } else {
                merge(&style, e.style)
            }
        }
        let r = Resolved(style, states)
        t.cache[key] = r
        return r
    }

    private static let pairs: [(String, [String])] = [
        ("lineHeight", ["__lineHeightRatio"]),
        ("letterSpacing", ["__letterSpacingEm"]),
        ("boxShadow", ["__shadow", "__shadowColor", "__ringWidth", "__ringColor"]),
        ("backgroundImage", ["__gradDir", "__gradFrom", "__gradVia", "__gradTo"]),
    ]

    private static func has(_ s: Style, _ k: String) -> Bool { s.contains { $0.0 == k } }

    private static func value(_ s: Style, _ k: String) -> Any? { XPStd.flat(s.last { $0.0 == k }?.1) }

    private static func remove(_ s: inout Style, _ k: String) { s.removeAll { $0.0 == k } }

    private static func put(_ s: inout Style, _ k: String, _ v: Any?) {
        if let i = s.firstIndex(where: { $0.0 == k }) { s[i].1 = v } else { s.append((k, v)) }
    }

    static func merge(_ into: inout Style, _ s: Style) {
        for (final, parts) in pairs {
            if has(s, final) { parts.forEach { remove(&into, $0) } }
            else if parts.contains(where: { has(s, $0) }) { remove(&into, final) }
        }
        for (k, v) in s { put(&into, k, v) }
    }

    private static func round2(_ n: Double) -> Double { XPStd.round(n * 100) / 100 }

    static func finish(_ s: Style, _ env: XPEnv?, _ fontSizeCtx: Double? = nil) -> Style {
        var out: Style = s.filter { !$0.0.hasPrefix("__") }
        let ctx = fontSizeCtx.flatMap { $0 != 0 ? $0 : nil }
        let fontSize = value(out, "fontSize") as? Double ?? ctx ?? 16
        if let r = value(s, "__lineHeightRatio") as? Double, value(out, "lineHeight") == nil { put(&out, "lineHeight", round2(fontSize * r)) }
        if let r = value(s, "__letterSpacingEm") as? Double, value(out, "letterSpacing") == nil { put(&out, "letterSpacing", round2(fontSize * r)) }
        if value(out, "boxShadow") == nil, has(s, "__shadow") || has(s, "__ringWidth") {
            var layers: [String] = []
            let ring = value(s, "__ringWidth")
            if XPStd.truthy(ring) {
                let color = value(s, "__ringColor") ?? value(out, "color") ?? "#000000"
                layers.append("0px 0px 0px \(XPStd.str(ring))px \(XPStd.str(color))")
            }
            for l in (value(s, "__shadow") as? [Any?]) ?? [] {
                let m = XPStd.map(l)
                let color = value(s, "__shadowColor") ?? XPStd.get(m, "color")
                layers.append("\(XPStd.str(XPStd.get(m, "x")))px \(XPStd.str(XPStd.get(m, "y")))px \(XPStd.str(XPStd.get(m, "blur")))px \(XPStd.str(XPStd.get(m, "spread")))px \(XPStd.str(color))")
            }
            put(&out, "boxShadow", layers.isEmpty ? "none" : layers.joined(separator: ", "))
        }
        if value(out, "backgroundImage") == nil, XPStd.truthy(value(s, "__gradDir")) {
            let none = "#00000000"
            var stops = [value(s, "__gradFrom") as? String ?? none]
            if let via = value(s, "__gradVia") as? String { stops.append(via) }
            stops.append(value(s, "__gradTo") as? String ?? none)
            put(&out, "backgroundImage", "linear-gradient(\(XPStd.str(value(s, "__gradDir"))), \(stops.joined(separator: ", ")))")
        }
        if let env = env {
            for i in out.indices {
                guard let v = XPStd.flat(out[i].1) as? String else { continue }
                let unit = v.hasSuffix("vh") ? "vh" : v.hasSuffix("vw") ? "vw" : nil
                guard let u = unit, let n = Double(v.dropLast(2)) else { continue }
                out[i].1 = round2(n / 100 * (u == "vh" ? env.height : env.width))
            }
        }
        return out
    }

    private static func family(_ k: String) -> String {
        // Sama dengan /^(padding|margin|border.*Width|border.*Radius|inset|top|right|bottom|left)/
        for p in ["padding", "margin", "inset", "top", "right", "bottom", "left"] where k.hasPrefix(p) { return p }
        if k.hasPrefix("border") {
            let rest = k.dropFirst(6)
            for suffix in ["Width", "Radius"] {
                if let r = rest.range(of: suffix, options: .backwards) { return "border" + rest[..<r.upperBound] }
            }
        }
        return k
    }

    private static func dict(_ s: Style) -> [String: Any?] {
        var m: [String: Any?] = [:]
        for (k, v) in s { m[k] = v }
        return m
    }

    /// Props elemen + className → props dengan style (dan pressedStyle/hoverStyle/focusStyle).
    public static func props(_ t: Table, _ h: XPHooks, _ props: [String: Any?], _ className: String?) -> [String: Any?] {
        guard let className = className else { return props }
        let env = h.env
        h.rt.registerBreakpoints(t.breakpoints, t.viewport)
        let r = resolve(t, env, className)
        let user = XPStd.flat(props["style"] ?? nil) as? [String: Any?]
        var raw: Style = []
        merge(&raw, r.style)
        if XPStd.truthy(props["disabled"] ?? nil), let d = r.states["disabled"] { merge(&raw, d) }
        if let user = user { merge(&raw, user.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }) }
        let style = finish(raw, env)
        var out = props
        if !style.isEmpty { out["style"] = dict(style) }
        let userKeys = Set((user?.keys).map { $0.map(family) } ?? [])
        for st in ["pressed", "hover", "focus"] {
            guard let extra = r.states[st] else { continue }
            var whole = raw
            merge(&whole, extra)
            let finished = finish(whole, env, value(style, "fontSize") as? Double)
            var own: [String: Any?] = [:]
            for (k, v) in finished where !XPStd.equal(v, value(style, k)) && !userKeys.contains(family(k)) { own[k] = v }
            if own.isEmpty { continue }
            let prop = "\(st)Style"
            if let existing = XPStd.flat(out[prop] ?? nil) as? [String: Any?] { own.merge(existing) { _, e in e } }
            out[prop] = own
        }
        return out
    }
}
