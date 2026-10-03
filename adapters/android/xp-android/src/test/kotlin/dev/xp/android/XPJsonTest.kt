package dev.xp.android

import org.junit.Test
import kotlin.test.assertEquals

class XPJsonTest {
    @Test
    fun roundTrip() {
        val v = mapOf("a" to listOf(1, 2.5, true, null), "s" to "baris\n\"kutip\"   é")
        assertEquals(v.toString().length > 0, true)
        val back = XPJson.parse(XPJson.stringify(v)) as Map<*, *>
        assertEquals(listOf(1.0, 2.5, true, null), back["a"])
        assertEquals("baris\n\"kutip\"   é", back["s"])
    }

    @Test
    fun quoteIsSafeJsLiteral() {
        assertEquals("\"a\\u2028b\\\\\"", XPJson.quote("a b\\"))
    }

    @Test
    fun integersStayIntegers() {
        assertEquals("""{"price":150000,"r":0.5}""", XPJson.stringify(mapOf("price" to 150000.0, "r" to 0.5)))
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsTrailingGarbage() {
        XPJson.parse("[1] x")
    }
}
