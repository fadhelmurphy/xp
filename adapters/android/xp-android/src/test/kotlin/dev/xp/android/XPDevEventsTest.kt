package dev.xp.android

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class XPDevEventsTest {
    @Test
    fun parsesUpdateEvents() {
        assertEquals(listOf("promo-slider"), XPDevEvents.parse("""data: {"type":"update","components":["promo-slider"]}"""))
        assertNull(XPDevEvents.parse("""data: {"type":"hello"}"""))
        assertNull(XPDevEvents.parse(": ping"))
        assertNull(XPDevEvents.parse("data: bukan json"))
    }
}
