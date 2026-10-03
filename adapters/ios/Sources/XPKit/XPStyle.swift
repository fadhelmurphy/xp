import Foundation

public enum XPSize: Equatable {
    case points(Double)
    case percent(Double) // 0...1
}

public struct XPEdges: Equatable {
    public var top = 0.0
    public var leading = 0.0
    public var bottom = 0.0
    public var trailing = 0.0

    public init(top: Double = 0, leading: Double = 0, bottom: Double = 0, trailing: Double = 0) {
        self.top = top
        self.leading = leading
        self.bottom = bottom
        self.trailing = trailing
    }

    public var isZero: Bool { top == 0 && leading == 0 && bottom == 0 && trailing == 0 }
}

/// Style xp (subset flexbox ala React Native) yang sudah di-parse. Angka = point, sama seperti px di web.
public struct XPStyle: Equatable {
    public var direction = "column"
    public var justify = "flex-start"
    public var alignItems = "stretch"
    public var alignSelf: String?
    public var gap = 0.0
    public var flex = 0.0
    public var width: XPSize?
    public var height: XPSize?
    public var minWidth: Double?
    public var maxWidth: Double?
    public var minHeight: Double?
    public var padding = XPEdges()
    public var margin = XPEdges()
    public var background: UInt32? // ARGB
    public var radius = 0.0
    public var borderWidth = 0.0
    public var borderColor: UInt32?
    public var opacity = 1.0
    public var color: UInt32?
    public var fontSize: Double?
    public var fontWeight: Int?
    public var textAlign: String?

    public init() {}

    public static func parse(_ s: [String: Any]) -> XPStyle {
        func num(_ k: String) -> Double? { (s[k] as? NSNumber)?.doubleValue }
        func str(_ k: String) -> String? { s[k] as? String }
        func edges(_ all: String, _ h: String, _ v: String) -> XPEdges {
            XPEdges(
                top: num("\(all)Top") ?? num(v) ?? num(all) ?? 0,
                leading: num("\(all)Left") ?? num(h) ?? num(all) ?? 0,
                bottom: num("\(all)Bottom") ?? num(v) ?? num(all) ?? 0,
                trailing: num("\(all)Right") ?? num(h) ?? num(all) ?? 0
            )
        }

        var st = XPStyle()
        st.direction = str("flexDirection") ?? "column"
        st.justify = str("justifyContent") ?? "flex-start"
        st.alignItems = str("alignItems") ?? "stretch"
        st.alignSelf = str("alignSelf").flatMap { $0 == "auto" ? nil : $0 }
        st.gap = num("gap") ?? 0
        st.flex = num("flex") ?? num("flexGrow") ?? 0
        st.width = size(s["width"])
        st.height = size(s["height"])
        st.minWidth = num("minWidth")
        st.maxWidth = num("maxWidth")
        st.minHeight = num("minHeight")
        st.padding = edges("padding", "paddingHorizontal", "paddingVertical")
        st.margin = edges("margin", "marginHorizontal", "marginVertical")
        st.background = str("backgroundColor").flatMap(parseColor)
        st.radius = num("borderRadius") ?? 0
        st.borderWidth = num("borderWidth") ?? 0
        st.borderColor = str("borderColor").flatMap(parseColor)
        st.opacity = num("opacity") ?? 1
        st.color = str("color").flatMap(parseColor)
        st.fontSize = num("fontSize")
        st.fontWeight = str("fontWeight").flatMap { Int($0) } ?? (s["fontWeight"] as? NSNumber)?.intValue
        st.textAlign = str("textAlign")
        return st
    }

    private static func size(_ v: Any?) -> XPSize? {
        if let n = v as? NSNumber { return .points(n.doubleValue) }
        if let s = (v as? String)?.trimmingCharacters(in: .whitespaces), s.hasSuffix("%"),
           let p = Double(s.dropLast()) {
            return .percent(min(max(p / 100, 0), 1))
        }
        return nil
    }

    private static let named: [String: UInt32] = [
        "transparent": 0x0000_0000, "black": 0xFF00_0000, "white": 0xFFFF_FFFF,
        "red": 0xFFFF_0000, "green": 0xFF00_8000, "blue": 0xFF00_00FF, "gray": 0xFF80_8080,
    ]

    /// "#RGB", "#RRGGBB", "#RRGGBBAA" (format web), "rgb()", "rgba()", nama dasar → ARGB. Tidak dikenal → nil.
    public static func parseColor(_ raw: String) -> UInt32? {
        let c = raw.trimmingCharacters(in: .whitespaces).lowercased()
        if let n = named[c] { return n }
        if c.hasPrefix("#") {
            let h = String(c.dropFirst())
            guard let v = UInt64(h, radix: 16) else { return nil }
            switch h.count {
            case 3:
                let r = (v >> 8) & 0xF, g = (v >> 4) & 0xF, b = v & 0xF
                return UInt32(0xFF00_0000 | (r * 17) << 16 | (g * 17) << 8 | (b * 17))
            case 6:
                return UInt32(0xFF00_0000 | v)
            case 8:
                return UInt32(((v & 0xFF) << 24) | (v >> 8)) // RRGGBBAA → AARRGGBB
            default:
                return nil
            }
        }
        guard c.hasPrefix("rgb"), let open = c.firstIndex(of: "("), let close = c.lastIndex(of: ")") else { return nil }
        let parts = c[c.index(after: open)..<close].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count == 3 || parts.count == 4 else { return nil }
        let rgb = parts.prefix(3).compactMap { Double($0) }.map { UInt32(min(max($0, 0), 255)) }
        guard rgb.count == 3 else { return nil }
        let alpha = parts.count == 4 ? (Double(parts[3]) ?? 1) : 1
        let a = UInt32((min(max(alpha, 0), 1) * 255).rounded())
        return a << 24 | rgb[0] << 16 | rgb[1] << 8 | rgb[2]
    }
}
