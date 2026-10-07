import CoreGraphics
import Foundation

public enum XPSize: Equatable {
    case points(Double)
    case percent(Double) // 0...1 (translate boleh negatif)
    /// "50vh" / "100vw": bagian dari tinggi/lebar layar.
    case screen(Double, vertical: Bool)

    /// Ukuran dalam point; persen terhadap `full`, layar terhadap `screen`.
    public func points(of full: Double, screen: CGSize) -> Double {
        switch self {
        case .points(let v): return v
        case .percent(let f): return f * full
        case .screen(let f, let vertical): return f * Double(vertical ? screen.height : screen.width)
        }
    }
}

public struct XPCorners: Equatable {
    public var topLeading = 0.0
    public var topTrailing = 0.0
    public var bottomTrailing = 0.0
    public var bottomLeading = 0.0
    public var isZero: Bool { topLeading == 0 && topTrailing == 0 && bottomTrailing == 0 && bottomLeading == 0 }
    public var isUniform: Bool { topLeading == topTrailing && topTrailing == bottomTrailing && bottomTrailing == bottomLeading }
}

/// Satu lapisan box-shadow. blur 0 + spread > 0 = garis luar (ring).
public struct XPShadow: Equatable {
    public var x, y, blur, spread: Double
    public var color: UInt32
    public var isRing: Bool { blur == 0 && x == 0 && y == 0 && spread > 0 }
}

/// Gradien linear: sudut CSS (0 = ke atas, 90 = ke kanan) dan warna ARGB yang tersebar rata.
public struct XPGradient: Equatable {
    public var angle: Double
    public var colors: [UInt32]
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
    public var isUniform: Bool { top == leading && leading == bottom && bottom == trailing }
}

/// Style xp (subset flexbox ala React Native) yang sudah di-parse. Angka = point, sama seperti px di web.
public struct XPStyle: Equatable {
    public var display = "flex"
    public var direction = "column"
    public var reverse = false
    public var justify = "flex-start"
    public var alignItems = "stretch"
    public var alignSelf: String?
    public var gap = 0.0
    public var columnGap: Double?
    public var rowGap: Double?
    public var gridColumns = 1
    public var gridColumnSpan = 1
    public var flex = 0.0
    public var width: XPSize?
    public var height: XPSize?
    public var minWidth: Double?
    public var maxWidth: Double?
    public var minHeight: Double?
    public var maxHeight: Double?
    public var aspectRatio: Double?
    public var absolute = false
    public var top: XPSize?
    public var right: XPSize?
    public var bottom: XPSize?
    public var left: XPSize?
    public var zIndex = 0.0
    public var clip = false
    public var padding = XPEdges()
    public var margin = XPEdges()
    /// Sisi margin bernilai "auto": "leading", "trailing", "top", "bottom".
    public var autoMargin: Set<String> = []
    public var background: UInt32? // ARGB
    public var gradient: XPGradient?
    public var radius = 0.0
    public var corners = XPCorners()
    public var borderWidth = 0.0
    public var borders = XPEdges()
    public var borderColor: UInt32?
    public var borderStyle = "solid"
    public var shadows: [XPShadow] = []
    public var dividerWidth = 0.0
    public var dividerColor: UInt32?
    public var opacity = 1.0
    public var scaleX = 1.0
    public var scaleY = 1.0
    public var translateX: XPSize?
    public var translateY: XPSize?
    public var rotate = 0.0
    public var animation: String?
    public var color: UInt32?
    public var fontSize: Double?
    public var fontWeight: Int?
    public var italic = false
    public var fontFamily: String?
    public var lineHeight: Double?
    public var letterSpacing: Double?
    public var textAlign: String?
    public var textDecoration: String?
    public var textTransform: String?
    public var noWrap = false
    public var ellipsis = false
    public var lineClamp: Int?
    public var objectFit: String?
    public var pointerEventsNone = false
    /// Animasi perubahan style, dalam detik (0 = tanpa animasi).
    public var transition = 0.0
    public var easing = "ease"

    public init() {}

    public var hidden: Bool { display == "none" }
    public var isRow: Bool { direction == "row" }
    public var hasBorder: Bool { borderWidth > 0 || !borders.isZero }
    /// Lebar border per sisi (border-t dll menimpa borderWidth).
    public var borderEdges: XPEdges {
        borders.isZero ? XPEdges(top: borderWidth, leading: borderWidth, bottom: borderWidth, trailing: borderWidth) : borders
    }
    /// Jarak antar anak di sumbu utama.
    public var mainGap: Double { (isRow ? columnGap : rowGap) ?? gap }
    /// Sudut per pojok (rounded-t-lg dll menimpa borderRadius).
    public var cornerRadii: XPCorners {
        corners.isZero ? XPCorners(topLeading: radius, topTrailing: radius, bottomTrailing: radius, bottomLeading: radius) : corners
    }
    public var rounded: Bool { radius > 0 || !corners.isZero }
    public var transformed: Bool { scaleX != 1 || scaleY != 1 || rotate != 0 || translateX != nil || translateY != nil }

    /// Teks setelah text-transform.
    public func transform(_ text: String) -> String {
        switch textTransform {
        case "uppercase": return text.uppercased()
        case "lowercase": return text.lowercased()
        case "capitalize": return text.split(separator: " ", omittingEmptySubsequences: false).map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
        default: return text
        }
    }

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

        func auto(_ k: String) -> Bool { str(k) == "auto" }

        var st = XPStyle()
        st.display = str("display") ?? "flex"
        let direction = str("flexDirection") ?? "column"
        st.direction = direction.hasSuffix("-reverse") ? String(direction.dropLast(8)) : direction
        st.reverse = direction.hasSuffix("-reverse")
        st.columnGap = num("columnGap")
        st.rowGap = num("rowGap")
        st.gridColumns = max(Int(num("gridColumns") ?? 1), 1)
        st.gridColumnSpan = Int(num("gridColumnSpan") ?? 1)
        st.maxHeight = num("maxHeight")
        st.aspectRatio = num("aspectRatio").flatMap { $0 > 0 ? $0 : nil }
        st.absolute = str("position") == "absolute"
        st.top = size(s["top"], clamp: false)
        st.right = size(s["right"], clamp: false)
        st.bottom = size(s["bottom"], clamp: false)
        st.left = size(s["left"], clamp: false)
        st.zIndex = num("zIndex") ?? 0
        st.clip = str("overflow") == "hidden"
        if auto("marginLeft") || auto("marginHorizontal") || auto("margin") { st.autoMargin.insert("leading") }
        if auto("marginRight") || auto("marginHorizontal") || auto("margin") { st.autoMargin.insert("trailing") }
        if auto("marginTop") || auto("marginVertical") || auto("margin") { st.autoMargin.insert("top") }
        if auto("marginBottom") || auto("marginVertical") || auto("margin") { st.autoMargin.insert("bottom") }
        st.gradient = str("backgroundImage").flatMap(parseGradient)
        let r = num("borderRadius") ?? 0
        if ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"].contains(where: { s[$0] != nil }) {
            st.corners = XPCorners(topLeading: num("borderTopLeftRadius") ?? r, topTrailing: num("borderTopRightRadius") ?? r,
                                   bottomTrailing: num("borderBottomRightRadius") ?? r, bottomLeading: num("borderBottomLeftRadius") ?? r)
        }
        let w = num("borderWidth") ?? 0
        if ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"].contains(where: { s[$0] != nil }) {
            st.borders = XPEdges(top: num("borderTopWidth") ?? w, leading: num("borderLeftWidth") ?? w,
                                 bottom: num("borderBottomWidth") ?? w, trailing: num("borderRightWidth") ?? w)
        }
        st.borderStyle = str("borderStyle") ?? "solid"
        st.shadows = str("boxShadow").map(parseShadows) ?? []
        st.dividerWidth = num("dividerWidth") ?? (s["dividerColor"] != nil ? 1 : 0)
        st.dividerColor = str("dividerColor").flatMap(parseColor)
        st.scaleX = num("scaleX") ?? 1
        st.scaleY = num("scaleY") ?? 1
        st.translateX = size(s["translateX"], clamp: false)
        st.translateY = size(s["translateY"], clamp: false)
        st.rotate = num("rotate") ?? 0
        st.animation = str("animation").flatMap { $0 == "none" ? nil : $0 }
        st.italic = str("fontStyle") == "italic"
        st.fontFamily = str("fontFamily")
        st.lineHeight = num("lineHeight")
        st.letterSpacing = num("letterSpacing")
        st.textDecoration = str("textDecorationLine").flatMap { $0 == "none" ? nil : $0 }
        st.textTransform = str("textTransform").flatMap { $0 == "none" ? nil : $0 }
        st.noWrap = str("whiteSpace") == "nowrap"
        st.ellipsis = str("textOverflow") == "ellipsis"
        st.lineClamp = num("lineClamp").map { Int($0) }.flatMap { $0 > 0 ? $0 : nil }
        st.objectFit = str("objectFit")
        st.pointerEventsNone = str("pointerEvents") == "none"
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
        st.transition = (num("transitionDuration") ?? 0) / 1000
        st.easing = str("transitionTimingFunction") ?? "ease"
        return st
    }

    private static func size(_ v: Any?, clamp: Bool = true) -> XPSize? {
        if let n = v as? NSNumber { return .points(n.doubleValue) }
        guard let s = (v as? String)?.trimmingCharacters(in: .whitespaces) else { return nil }
        if s.hasSuffix("%"), let p = Double(s.dropLast()) {
            return .percent(clamp ? min(max(p / 100, 0), 1) : p / 100)
        }
        if s.hasSuffix("vh"), let p = Double(s.dropLast(2)) { return .screen(p / 100, vertical: true) }
        if s.hasSuffix("vw"), let p = Double(s.dropLast(2)) { return .screen(p / 100, vertical: false) }
        if s.hasSuffix("px"), let p = Double(s.dropLast(2)) { return .points(p) }
        return nil
    }

    /// Pisah di koma/spasi tingkat atas (tidak di dalam kurung).
    private static func split(_ s: String, on sep: (Character) -> Bool) -> [String] {
        var out: [String] = []
        var depth = 0
        var cur = ""
        for ch in s {
            if ch == "(" { depth += 1 }
            if ch == ")" { depth -= 1 }
            if depth == 0 && sep(ch) {
                if !cur.trimmingCharacters(in: .whitespaces).isEmpty { out.append(cur.trimmingCharacters(in: .whitespaces)) }
                cur = ""
            } else {
                cur.append(ch)
            }
        }
        if !cur.trimmingCharacters(in: .whitespaces).isEmpty { out.append(cur.trimmingCharacters(in: .whitespaces)) }
        return out
    }

    /// "0px 4px 6px -1px #0000001a, 0 0 0 2px #fff" → lapisan. Lapisan inset dilewati.
    public static func parseShadows(_ raw: String) -> [XPShadow] {
        split(raw) { $0 == "," }.compactMap { layer in
            let parts = split(layer) { $0 == " " }
            if parts.isEmpty || parts.contains("inset") || parts == ["none"] { return nil }
            let nums = parts.compactMap { Double($0.hasSuffix("px") ? String($0.dropLast(2)) : $0) }
            let color = parts.first { Double($0.hasSuffix("px") ? String($0.dropLast(2)) : $0) == nil }.flatMap(parseColor) ?? 0xFF00_0000
            guard nums.count >= 2 else { return nil }
            return XPShadow(x: nums[0], y: nums[1], blur: nums.count > 2 ? nums[2] : 0, spread: nums.count > 3 ? nums[3] : 0, color: color)
        }
    }

    /// "linear-gradient(to right, #fff, #000)" / "linear-gradient(45deg, ...)" → XPGradient.
    public static func parseGradient(_ raw: String) -> XPGradient? {
        let t = raw.trimmingCharacters(in: .whitespaces)
        guard t.hasPrefix("linear-gradient("), t.hasSuffix(")") else { return nil }
        var parts = split(String(t.dropFirst(16).dropLast())) { $0 == "," }
        guard let first = parts.first else { return nil }
        var angle = 180.0
        if first.hasPrefix("to ") {
            let dir = Set(first.dropFirst(3).split(separator: " ").map(String.init))
            let x = dir.contains("right") ? 1 : dir.contains("left") ? -1 : 0
            let y = dir.contains("top") ? 1 : dir.contains("bottom") ? -1 : 0
            switch (x, y) {
            case (0, 1): angle = 0
            case (1, 0): angle = 90
            case (0, -1): angle = 180
            case (-1, 0): angle = 270
            case (1, 1): angle = 45
            case (1, -1): angle = 135
            case (-1, -1): angle = 225
            default: angle = 315
            }
            parts.removeFirst()
        } else if first.hasSuffix("deg"), let a = Double(first.dropLast(3)) {
            angle = a
            parts.removeFirst()
        }
        let colors = parts.compactMap { parseColor(String($0.split(separator: " ")[0])) }
        guard colors.count == parts.count, colors.count >= 2 else { return nil }
        return XPGradient(angle: angle, colors: colors)
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
