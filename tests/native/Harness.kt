// Untuk tes diferensial: jalankan komponen terkompilasi dengan skenario JSON, cetak tree setelah
// setiap langkah. Skenario yang sama dijalankan di bundle JS (tests/native-kotlin.test.ts).
import dev.xp.android.XPJson
import dev.xp.android.XPNode
import dev.xp.android.XPTree
import dev.xp.android.compiled.XPComponentRegistry
import dev.xp.android.compiled.XPComponentRuntime

private fun snapshot(tree: XPTree, n: XPNode): Any? {
    if (n.type == "#text") return n.props["value"]
    val props = LinkedHashMap<String, Any?>()
    for ((k, v) in n.props.toSortedMap()) props[k] = if (v is Map<*, *> && v.containsKey("\$fn")) "fn" else v
    return mapOf("type" to n.type, "props" to props, "children" to n.children.map { snapshot(tree, tree[it]) })
}

fun main(args: Array<String>) {
    val registry = Class.forName("dev.xp.generated.XPComponents").getField("INSTANCE").get(null) as XPComponentRegistry
    val script = XPJson.parse(java.io.File(args[0]).readText()) as Map<*, *>
    val component = registry.components.getValue(script["component"] as String)
    val rt = XPComponentRuntime(component)
    var now = 1_000_000L
    rt.clock = { now }
    dev.xp.android.compiled.JsBuiltins.clock = { now }
    val tree = XPTree()
    @Suppress("UNCHECKED_CAST")
    val props = (script["props"] as? Map<String, Any?>) ?: emptyMap()
    val out = ArrayList<Any?>()
    val env = script["env"] as? Map<*, *>
    if (env != null) tree.applyBatches(rt.environment((env["width"] as Number).toDouble(), (env["height"] as Number).toDouble(), env["dark"] == true))
    tree.applyBatches(rt.mount(props))
    out.add(tree.root.children.map { snapshot(tree, tree[it]) })
    for (step in script["steps"] as List<*>) {
        step as Map<*, *>
        when {
            step.containsKey("event") -> {
                val (testID, prop, a) = step["event"] as List<*>
                val node = tree.byTestID(testID as String) ?: error("testID $testID tidak ada")
                val key = node.handler(prop as String) ?: error("$testID tidak punya $prop")
                tree.applyBatches(rt.dispatch(key, a as List<Any?>))
            }
            step.containsKey("advance") -> {
                now += (step["advance"] as Number).toLong()
                tree.applyBatches(rt.tick())
            }
            step.containsKey("props") -> {
                @Suppress("UNCHECKED_CAST")
                tree.applyBatches(rt.update(step["props"] as Map<String, Any?>))
            }
            step.containsKey("env") -> {
                val e = step["env"] as Map<*, *>
                tree.applyBatches(rt.environment((e["width"] as Number).toDouble(), (e["height"] as Number).toDouble(), e["dark"] == true))
            }
            step.containsKey("unmount") -> tree.applyBatches(rt.unmount())
        }
        out.add(tree.root.children.map { snapshot(tree, tree[it]) })
    }
    java.io.PrintStream(System.out, true, "UTF-8").println(XPJson.stringify(out))
}
