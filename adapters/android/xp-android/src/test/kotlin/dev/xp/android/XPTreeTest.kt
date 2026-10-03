package dev.xp.android

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Memutar ulang sesi yang direkam dari bundle promo-modal di QuickJS
 * (tests/native-queue.test.ts di repo xp) ke tree Android, lalu memeriksa hasilnya.
 */
class XPTreeTest {
    private fun session(): List<Map<*, *>> {
        val text = javaClass.classLoader!!.getResource("promo-modal.session.json")!!.readText()
        @Suppress("UNCHECKED_CAST")
        return XPJson.parse(text) as List<Map<*, *>>
    }

    private fun XPTree.step(s: Map<*, *>) = applyBatches(XPJson.stringify(s["batches"]))
    private fun XPTree.modal() = walk().first { it.type == "Modal" }
    private fun XPTree.textOf(id: String) = text(byTestID(id)!!)

    @Test
    fun replayPromoModalSession() {
        val steps = session()
        val tree = XPTree()

        tree.step(steps[0]) // mount
        assertEquals("Kelas IELTS", tree.textOf("title"))
        assertEquals("Rp150.000 / orang", tree.text(tree.walk().filter { it.type == "Text" }.toList()[1]))
        assertFalse(tree.modal().bool("visible"))
        assertEquals("${tree.byTestID("open")!!.id}:onPress", tree.byTestID("open")!!.handler("onPress"))
        assertTrue(tree.byTestID("minus")!!.bool("disabled"))

        tree.step(steps[1]) // tekan "Lihat detail"
        assertTrue(tree.modal().bool("visible"))

        tree.step(steps[2]) // +
        tree.step(steps[3]) // +
        assertEquals("Peserta: 3", tree.textOf("qty"))
        assertEquals("Total: Rp450.000", tree.textOf("total"))
        assertEquals("Kuota penuh", tree.textOf("full"))
        assertTrue(tree.byTestID("plus")!!.bool("disabled"))

        tree.step(steps[4]) // tutup
        assertFalse(tree.modal().bool("visible"))
        assertEquals(emptyList(), tree.orphans())

        val before = tree.revision
        tree.step(steps[5]) // event tanpa perubahan
        assertEquals(before, tree.revision, "batch kosong tidak memicu recompose")
    }

    @Test
    fun deleteAndPropRemoval() {
        val tree = XPTree()
        tree.applyBatches(
            """[{"v":1,"ops":[["create",1,"View"],["create",2,"Text"],["create",3,"#text"],
               ["props",3,{"value":"hai"}],["props",1,{"testID":"a","onPress":{"${'$'}fn":"1:onPress"}}],
               ["children",2,[3]],["children",1,[2]],["children",0,[1]]]}]""",
        )
        assertEquals("hai", tree.text(tree.byTestID("a")!!))
        tree.applyBatches("""[{"v":1,"ops":[["props",1,{"onPress":null}],["children",1,[]],["delete",3],["delete",2]]}]""")
        assertNull(tree.byTestID("a")!!.handler("onPress"))
        assertEquals(2, tree.size)
        assertEquals(emptyList(), tree.orphans())
    }

    @Test
    fun numericTextHasNoDecimal() {
        val tree = XPTree()
        tree.applyBatches("""[{"v":1,"ops":[["create",1,"#text"],["props",1,{"value":3}],["children",0,[1]]]}]""")
        assertEquals("3", tree.text(tree.root))
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsUnknownProtocol() {
        XPTree().applyBatches("""[{"v":2,"ops":[]}]""")
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsUnknownPrimitive() {
        XPTree().applyBatches("""[{"v":1,"ops":[["create",1,"Video"]]}]""")
    }
}
