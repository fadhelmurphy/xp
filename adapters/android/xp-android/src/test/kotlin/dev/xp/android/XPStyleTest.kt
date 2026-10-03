package dev.xp.android

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class XPStyleTest {
    @Test
    fun parsesButtonStyleFromPromoModal() {
        val s = XPStyle.parse(
            mapOf(
                "backgroundColor" to "#1F6FEB", "paddingVertical" to 10.0, "paddingHorizontal" to 16.0,
                "borderRadius" to 8.0, "alignItems" to "center",
            ),
        )
        assertEquals(0xFF1F6FEBL, s.background)
        assertEquals(XPEdges(start = 16f, top = 10f, end = 16f, bottom = 10f), s.padding)
        assertEquals(8f, s.radius)
        assertEquals("center", s.alignItems)
        assertEquals("column", s.direction)
    }

    @Test
    fun specificPaddingWinsOverShorthand() {
        val s = XPStyle.parse(mapOf("padding" to 4.0, "paddingHorizontal" to 8.0, "paddingLeft" to 12.0))
        assertEquals(XPEdges(start = 12f, top = 4f, end = 8f, bottom = 4f), s.padding)
    }

    @Test
    fun sizes() {
        val s = XPStyle.parse(mapOf("width" to "100%", "height" to 160.0, "maxWidth" to 360.0))
        assertEquals(XPSize.Percent(1f), s.width)
        assertEquals(XPSize.Dp(160f), s.height)
        assertEquals(360f, s.maxWidth)
        assertNull(XPStyle.parse(mapOf("width" to "auto")).width)
    }

    @Test
    fun colors() {
        assertEquals(0xFFFFFFFFL, XPStyle.parseColor("#fff"))
        assertEquals(0xFF57606AL, XPStyle.parseColor("#57606A"))
        assertEquals(0x801F6FEBL, XPStyle.parseColor("#1F6FEB80")) // format web RRGGBBAA
        assertEquals(0x73000000L, XPStyle.parseColor("rgba(0,0,0,.45)"))
        assertEquals(0x00000000L, XPStyle.parseColor("transparent"))
        assertNull(XPStyle.parseColor("hsl(0, 0%, 0%)"))
    }

    @Test
    fun fontWeightAsString() {
        assertEquals(700, XPStyle.parse(mapOf("fontWeight" to "700")).fontWeight)
    }
}
