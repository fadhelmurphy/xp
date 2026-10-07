package dev.xp.android

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

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

    @Test
    fun transition() {
        val s = XPStyle.parse(mapOf("transitionDuration" to 300.0, "transitionTimingFunction" to "ease-out"))
        assertEquals(300, s.transitionMs)
        assertEquals("ease-out", s.easing)
        assertEquals(0, XPStyle.parse(emptyMap()).transitionMs)
    }
}

class XPStyleTailwindTest {
    @Test
    fun layoutKeys() {
        val s = XPStyle.parse(
            mapOf(
                "display" to "grid", "gridColumns" to 3.0, "columnGap" to 8.0, "rowGap" to 4.0, "gap" to 2.0,
                "position" to "absolute", "top" to 8.0, "left" to "50%", "zIndex" to 10.0, "overflow" to "hidden",
                "marginLeft" to "auto", "aspectRatio" to 1.5, "height" to "100vh", "flexDirection" to "row-reverse",
            ),
        )
        assertEquals("grid", s.display)
        assertEquals(3, s.gridColumns)
        assertEquals(8f, s.mainGap) // row → columnGap
        assertTrue(s.absolute)
        assertEquals(XPSize.Dp(8f), s.top)
        assertEquals(XPSize.Percent(0.5f), s.left)
        assertEquals(10f, s.zIndex)
        assertTrue(s.clip)
        assertEquals(setOf("start"), s.autoMargin)
        assertEquals(0f, s.margin.start)
        assertEquals(1.5f, s.aspectRatio)
        assertEquals(XPSize.Screen(1f, vertical = true), s.height)
        assertTrue(s.isRow && s.reverse)
        assertTrue(XPStyle.parse(mapOf("display" to "none")).hidden)
    }

    @Test
    fun boxKeys() {
        val s = XPStyle.parse(
            mapOf(
                "borderRadius" to 4.0, "borderTopLeftRadius" to 8.0, "borderTopWidth" to 2.0, "borderStyle" to "dashed",
                "boxShadow" to "0px 10px 15px -3px #2b7fff66, 0px 0px 0px 2px #ffffff99",
                "backgroundImage" to "linear-gradient(to right, #2b7fff, #ffffff, #f6339a80)",
                "scaleX" to 0.95, "translateY" to "-50%", "rotate" to -12.0, "animation" to "spin",
                "dividerColor" to "#e5e7eb",
            ),
        )
        assertEquals(XPCorners(8f, 4f, 4f, 4f), s.cornerRadii)
        assertEquals(XPEdges(start = 0f, top = 2f, end = 0f, bottom = 0f), s.borderEdges)
        assertTrue(s.hasBorder)
        assertEquals("dashed", s.borderStyle)
        assertEquals(XPShadow(0f, 10f, 15f, -3f, 0x662B7FFFL), s.shadows[0])
        assertTrue(s.shadows[1].isRing)
        assertEquals(XPGradient(90f, listOf(0xFF2B7FFFL, 0xFFFFFFFFL, 0x80F6339AL)), s.gradient)
        assertEquals(0.95f, s.scaleX)
        assertEquals(1f, s.scaleY)
        assertEquals(XPSize.Percent(-0.5f), s.translateY)
        assertEquals(-12f, s.rotate)
        assertEquals("spin", s.animation)
        assertEquals(1f, s.dividerWidth)
        assertEquals(135f, XPStyle.parseGradient("linear-gradient(to bottom right, red, blue)")!!.angle)
        assertEquals(45f, XPStyle.parseGradient("linear-gradient(45deg, red, blue)")!!.angle)
    }

    @Test
    fun textKeys() {
        val s = XPStyle.parse(
            mapOf(
                "fontStyle" to "italic", "fontFamily" to "monospace", "letterSpacing" to 0.8,
                "textDecorationLine" to "underline", "textTransform" to "capitalize",
                "whiteSpace" to "nowrap", "textOverflow" to "ellipsis", "lineClamp" to 2.0, "objectFit" to "contain",
            ),
        )
        assertTrue(s.italic && s.noWrap && s.ellipsis)
        assertEquals("monospace", s.fontFamily)
        assertEquals(0.8f, s.letterSpacing)
        assertEquals("underline", s.textDecoration)
        assertEquals("Promo Akhir Tahun", s.transform("promo akhir tahun"))
        assertEquals(2, s.lineClamp)
        assertEquals("contain", s.objectFit)
    }
}
