package dev.xp.android

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class XPGestureTest {
    @Test
    fun directionFollowsDominantAxis() {
        assertEquals("left", XPGesture.direction(-60f, 10f))
        assertEquals("right", XPGesture.direction(60f, -20f))
        assertEquals("up", XPGesture.direction(5f, -80f))
        assertEquals("down", XPGesture.direction(0f, 45f))
        assertNull(XPGesture.direction(30f, 30f))
    }

    @Test
    fun followOnlyOnItsAxis() {
        assertEquals(-30f to 0f, XPGesture.follow("x", -30f, 12f))
        assertEquals(0f to 12f, XPGesture.follow("y", -30f, 12f))
    }
}
