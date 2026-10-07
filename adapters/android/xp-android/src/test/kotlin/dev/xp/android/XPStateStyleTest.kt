package dev.xp.android

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class XPStateStyleTest {
    private fun node(): XPNode {
        val tree = XPTree()
        tree.applyBatches(
            """[{"v":1,"ops":[["create",1,"Pressable"],["props",1,{
              "style":{"backgroundColor":"#2b7fff","padding":16},
              "hoverStyle":{"backgroundColor":"#155dfc"},
              "pressedStyle":{"backgroundColor":"#1447e6","opacity":0.9}}],["children",0,[1]]]}]""",
        )
        return tree[1]
    }

    @Test
    fun stateStylesLayerOverStyle() {
        val n = node()
        assertEquals("#2b7fff", n.styleFor()["backgroundColor"])
        assertEquals("#155dfc", n.styleFor(hovered = true)["backgroundColor"])
        // pressed menang atas hover, seperti urutan varian Tailwind
        assertEquals("#1447e6", n.styleFor(pressed = true, hovered = true)["backgroundColor"])
        assertEquals(16.0, n.styleFor(pressed = true)["padding"])
        assertTrue(n.hasStateStyle("pressed"))
        assertFalse(n.hasStateStyle("focus"))
    }

    @Test
    fun environmentJson() {
        assertEquals("""{"width":390,"height":844,"dark":true}""", environmentJson(390, 844, true))
    }
}
