// Benchmark mode dinamis vs mode typed untuk satu komponen (dipanggil dari scripts/bench-native.mjs).
// Yang diukur sama dengan jalur di app: event → render ulang → tree yang dibaca renderer Compose.
import dev.xp.android.XPTree
import dev.xp.android.compiled.XPComponentRegistry
import dev.xp.android.compiled.XPComponentRuntime
import dev.xp.android.typed.XPHostNode
import dev.xp.android.typed.XPTypedRegistry
import dev.xp.android.typed.XPTypedRuntime

private fun find(nodes: List<XPHostNode>, testID: String): XPHostNode? {
    for (n in nodes) {
        if (n.props["testID"] == testID) return n
        find(n.children, testID)?.let { return it }
    }
    return null
}

private fun time(label: String, rounds: Int, block: () -> Unit): Double {
    repeat(rounds / 5) { block() } // pemanasan JIT
    val start = System.nanoTime()
    repeat(rounds) { block() }
    val us = (System.nanoTime() - start) / 1000.0 / rounds
    println("$label: ${"%.1f".format(us)} us")
    return us
}

fun main(args: Array<String>) {
    val name = args[0]
    val taps = args.getOrNull(1)?.toInt() ?: 20000
    val dynamic = (Class.forName("dev.xp.generated.XPComponents").getField("INSTANCE").get(null) as XPComponentRegistry).components.getValue(name)
    val typed = (Class.forName("dev.xp.generated.XPTypedComponents").getField("INSTANCE").get(null) as XPTypedRegistry).components.getValue(name)
    val props = emptyMap<String, Any?>()

    val mountDyn = time("dinamis  mount", 2000) { XPTree().applyBatches(XPComponentRuntime(dynamic).mount(props)) }
    val mountTyped = time("typed    mount", 2000) { XPTypedRuntime(typed).mount(props) }

    val rt = XPComponentRuntime(dynamic)
    val tree = XPTree()
    tree.applyBatches(rt.mount(props))
    val tapDyn = time("dinamis  tap", taps) {
        val key = tree.byTestID("next")!!.handler("onPress")!!
        tree.applyBatches(rt.dispatch(key, emptyList()))
    }
    val trt = XPTypedRuntime(typed)
    trt.mount(props)
    val tapTyped = time("typed    tap", taps) {
        trt.dispatch(find(trt.root, "next")!!.handler("onPress")!!, emptyList())
    }
    println("typed lebih cepat: mount ${"%.1f".format(mountDyn / mountTyped)}x, tap ${"%.1f".format(tapDyn / tapTyped)}x")
}
