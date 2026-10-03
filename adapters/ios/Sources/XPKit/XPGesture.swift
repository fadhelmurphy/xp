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
}
