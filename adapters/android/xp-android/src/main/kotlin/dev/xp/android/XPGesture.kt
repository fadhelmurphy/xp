package dev.xp.android

import kotlin.math.abs
import kotlin.math.max

/** Penentuan arah swipe. Sama dengan runtime/hosts/gesture.ts. */
object XPGesture {
    /** Jarak minimal (dp) supaya geseran dihitung sebagai swipe. */
    const val THRESHOLD = 40f

    /** "left" | "right" | "up" | "down", atau null kalau terlalu pendek. Sumbu yang dominan menang. */
    fun direction(dx: Float, dy: Float, threshold: Float = THRESHOLD): String? {
        if (max(abs(dx), abs(dy)) < threshold) return null
        return if (abs(dx) >= abs(dy)) {
            if (dx < 0) "left" else "right"
        } else {
            if (dy < 0) "up" else "down"
        }
    }
}
