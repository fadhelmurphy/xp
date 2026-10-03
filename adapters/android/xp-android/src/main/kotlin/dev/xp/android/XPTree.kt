package dev.xp.android

/**
 * Tree view native: hasil menerapkan operasi UI dari runtime xp.
 * Murni Kotlin (tanpa Android/Compose) supaya bisa diuji di JVM.
 * Implementasi acuannya: sdk-reference/tree.ts.
 */
class XPNode(val id: Int, val type: String) {
    val props: MutableMap<String, Any?> = LinkedHashMap()
    var children: List<Int> = emptyList()

    /** Key handler event, mis. props["onPress"] = {"$fn": "5:onPress"} → "5:onPress". */
    fun handler(prop: String): String? = (props[prop] as? Map<*, *>)?.get("\$fn") as? String

    fun string(prop: String): String? = props[prop] as? String

    fun bool(prop: String): Boolean = props[prop] == true

    @Suppress("UNCHECKED_CAST")
    fun style(): Map<String, Any?> = props["style"] as? Map<String, Any?> ?: emptyMap()
}

class XPTree {
    companion object {
        const val PROTOCOL = 1
        const val ROOT = 0
        val PRIMITIVES = setOf("View", "Text", "Image", "Pressable", "ScrollView", "TextInput", "Modal", "#text")
    }

    private val nodes = HashMap<Int, XPNode>().apply { put(ROOT, XPNode(ROOT, "#root")) }

    /** Bertambah setiap kali tree berubah (dipakai untuk memicu recompose). */
    var revision = 0
        private set

    val root: XPNode get() = nodes.getValue(ROOT)

    operator fun get(id: Int): XPNode = nodes[id] ?: error("node $id tidak ada (operasi tidak konsisten)")

    val size: Int get() = nodes.size

    /** Terapkan hasil XP.mount/update/dispatch/unmount: string JSON berisi daftar batch. */
    fun applyBatches(json: String) {
        val batches = XPJson.parse(json) as? List<*> ?: error("hasil runtime bukan array batch")
        if (batches.isEmpty()) return
        for (b in batches) applyBatch(b as Map<*, *>)
        revision++
    }

    private fun applyBatch(batch: Map<*, *>) {
        val v = (batch["v"] as? Number)?.toInt()
        require(v == PROTOCOL) { "protokol $v tidak didukung SDK ini (butuh $PROTOCOL)" }
        for (raw in batch["ops"] as List<*>) {
            val op = raw as List<*>
            val id = (op[1] as Number).toInt()
            when (op[0]) {
                "create" -> {
                    val type = op[2] as String
                    require(type in PRIMITIVES) { "primitive '$type' tidak didukung SDK ini" }
                    nodes[id] = XPNode(id, type)
                }
                "props" -> {
                    val n = get(id)
                    for ((k, value) in op[2] as Map<*, *>) {
                        if (value == null) n.props.remove(k as String) else n.props[k as String] = value
                    }
                }
                "children" -> get(id).children = (op[2] as List<*>).map { (it as Number).toInt() }
                "delete" -> nodes.remove(id)
                else -> error("operasi tidak dikenal: ${op[0]}")
            }
        }
    }

    /** Teks sebuah node = gabungan semua #text di bawahnya. */
    fun text(n: XPNode): String =
        if (n.type == "#text") n.props["value"]?.let { if (it is Double && it == Math.rint(it)) it.toLong().toString() else it.toString() } ?: ""
        else n.children.joinToString("") { text(get(it)) }

    fun walk(from: XPNode = root): Sequence<XPNode> = sequence {
        yield(from)
        for (c in from.children) yieldAll(walk(get(c)))
    }

    fun byTestID(id: String): XPNode? = walk().firstOrNull { it.props["testID"] == id }

    /** Node yang tidak terjangkau dari root = kebocoran. Harus selalu kosong. */
    fun orphans(): List<Int> {
        val reachable = walk().map { it.id }.toSet()
        return nodes.keys.filter { it !in reachable }
    }
}
