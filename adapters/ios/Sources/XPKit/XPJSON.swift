import Foundation

/// Helper JSON untuk protokol xp (hanya Foundation).
enum XPJSON {
    static func parse(_ text: String) throws -> Any {
        try JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])
    }

    static func stringify(_ value: Any) throws -> String {
        guard JSONSerialization.isValidJSONObject(value) || value is String || value is NSNumber || value is NSNull else {
            throw XPError.invalid("nilai tidak bisa dijadikan JSON: \(type(of: value))")
        }
        let data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        return String(decoding: data, as: UTF8.self)
    }

    /// String Swift → literal string JS/JSON yang aman dimasukkan ke script.
    static func quote(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }
}

public enum XPError: Error, LocalizedError {
    case protocolMismatch(Int?)
    case unknownPrimitive(String)
    case invalid(String)
    case load(String)
    case script(String)

    public var errorDescription: String? {
        switch self {
        case .protocolMismatch(let v): return "protokol \(v.map(String.init) ?? "?") tidak didukung SDK ini (butuh \(XPTree.protocolVersion))"
        case .unknownPrimitive(let t): return "primitive '\(t)' tidak didukung SDK ini"
        case .invalid(let m): return "data tidak valid: \(m)"
        case .load(let m): return m
        case .script(let m): return "error JS: \(m)"
        }
    }
}
