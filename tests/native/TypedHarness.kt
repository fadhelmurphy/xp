// Tes diferensial mode typed: komponen yang dikompilasi ke Kotlin bertipe dijalankan dengan
// skenario JSON yang sama dengan bundle JS, tree host-nya dicetak setelah setiap langkah.
import dev.xp.android.XPJson
import dev.xp.android.typed.XPHostNode
import dev.xp.android.typed.XPTypedRegistry
import dev.xp.android.typed.XPTypedRuntime

private fun snapshot(n: XPHostNode): Any? {
    if (n.type == "#text") return n.props["value"]
    val props = sortedMapOf<String, Any?>()
    for ((k, v) in n.props) if (v != null) props[k] = v
    for (k in n.handlers.keys) props[k] = "fn"
    return mapOf("type" to n.type, "props" to props, "children" to n.children.map { snapshot(it) })
}

private fun find(nodes: List<XPHostNode>, testID: String): XPHostNode? {
    for (n in nodes) {
        if (n.props["testID"] == testID) return n
        find(n.children, testID)?.let { return it }
    }
    return null
}

fun main(args: Array<String>) {
    val registry = (Class.forName("dev.xp.generated.XPTypedComponents").getField("INSTANCE").get(null) as XPTypedRegistry).components
    val script = XPJson.parse(java.io.File(args[0]).readText()) as Map<*, *>
    val rt = XPTypedRuntime(registry.getValue(script["component"] as String))
    var now = 1_000_000L
    rt.clock = { now }
    dev.xp.android.compiled.JsBuiltins.clock = { now }
    @Suppress("UNCHECKED_CAST")
    val props = (script["props"] as? Map<String, Any?>) ?: emptyMap()
    val out = ArrayList<Any?>()
    val env = script["env"] as? Map<*, *>
    if (env != null) rt.environment((env["width"] as Number).toDouble(), (env["height"] as Number).toDouble(), env["dark"] == true)
    rt.mount(props)
    out.add(rt.root.map { snapshot(it) })
    for (step in script["steps"] as List<*>) {
        step as Map<*, *>
        when {
            step.containsKey("event") -> {
                val (testID, prop, a) = step["event"] as List<*>
                val node = find(rt.root, testID as String) ?: error("testID $testID tidak ada")
                val handler = node.handler(prop as String) ?: error("$testID tidak punya $prop")
                rt.dispatch(handler, a as List<Any?>)
            }
            step.containsKey("advance") -> {
                now += (step["advance"] as Number).toLong()
                rt.tick()
            }
            step.containsKey("props") -> {
                @Suppress("UNCHECKED_CAST")
                rt.update(step["props"] as Map<String, Any?>)
            }
            step.containsKey("env") -> {
                val e = step["env"] as Map<*, *>
                rt.environment((e["width"] as Number).toDouble(), (e["height"] as Number).toDouble(), e["dark"] == true)
            }
            step.containsKey("unmount") -> rt.unmount()
        }
        out.add(rt.root.map { snapshot(it) })
    }
    java.io.PrintStream(System.out, true, "UTF-8").println(XPJson.stringify(out))
}
