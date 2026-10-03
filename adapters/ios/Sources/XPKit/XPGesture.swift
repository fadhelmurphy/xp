import Foundation

/// Penentuan arah swipe. Sama dengan runtime/hosts/gesture.ts.
public enum XPGesture {
    /// Jarak minimal (pt) supaya geseran dihitung sebagai swipe.
    public static let threshold: Double = 40

    /// "left" | "right" | "up" | "down", atau nil kalau terlalu pendek. Sumbu yang dominan menang.
    public static func direction(dx: Double, dy: Double, threshold: Double = threshold) -> String? {
        guard max(abs(dx), abs(dy)) >= threshold else { return nil }
        if abs(dx) >= abs(dy) { return dx < 0 ? "left" : "right" }
        return dy < 0 ? "up" : "down"
    }

    /// Geseran yang diikuti view dengan dragAxis "x" atau "y": sumbu lain tetap 0.
    public static func follow(axis: String?, dx: Double, dy: Double) -> (x: Double, y: Double) {
        switch axis {
        case "x": return (dx, 0)
        case "y": return (0, dy)
        default: return (0, 0)
        }
    }
}
