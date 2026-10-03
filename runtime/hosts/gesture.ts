// Penentuan arah swipe. Logika yang sama dipakai SDK Android (XPGesture.kt) dan iOS (XPGesture.swift).
import type { SwipeDirection } from "../index";

/** Jarak minimal (px / dp / pt) supaya geseran dihitung sebagai swipe. */
export const SWIPE_THRESHOLD = 40;

/** Arah dari total geseran, atau null kalau terlalu pendek. Sumbu yang dominan menang. */
export function swipeDirection(dx: number, dy: number, threshold = SWIPE_THRESHOLD): SwipeDirection | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "up" : "down";
}
