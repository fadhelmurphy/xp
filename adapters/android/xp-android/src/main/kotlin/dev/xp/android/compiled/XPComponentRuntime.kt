package dev.xp.android.compiled

/**
 * Runtime untuk komponen xp yang dikompilasi ke Kotlin. Isinya sama dengan runtime JS
 * (runtime/reconciler.ts + hosts/native.ts + hosts/timers.ts): hooks, rekonsiliasi, dan operasi
 * UI dengan bentuk yang sama, jadi renderer Compose yang sama bisa menampilkannya. Bedanya, kode
 * komponen dan runtime ini jalan sebagai kode JVM/ART biasa: tanpa engine JS dan tanpa JSON.
 *
 * Tidak thread-safe: panggil semua method dari satu thread (lihat XPCompiledRuntime).
 */
class XPElement(val type: Any, val props: Map<String, Any?>, val key: String?)

/** Komponen hasil `xp build`. */
interface XPCompiledComponent {
    val name: String

    /** Hash sumber komponen saat dikompilasi (sama dengan hash bundle web/native untuk versi itu). */
    val hash: String

    /** Jalankan modul komponen dan kembalikan fungsi komponennya (export default). */
    fun create(scope: XPScope): JsFunction
}

/** Daftar komponen terkompilasi milik app (object `dev.xp.generated.XPComponents`). */
interface XPComponentRegistry {
    val components: Map<String, XPCompiledComponent>
}

/** Akses kode komponen ke runtime: objek `__xp` (hooks, jsx) dan global (Math, setTimeout, ...). */
class XPScope internal constructor(private val rt: XPComponentRuntime) {
    fun global(name: String): Any? = rt.global(name)
}

class XPComponentRuntime(private val component: XPCompiledComponent) {
    companion object {
        const val PROTOCOL = 1
        const val TEXT = "#text"
        private const val ROOT_ID = 0
    }

    // --- host: operasi UI (bentuk sama dengan JSON dari runtime JS) ---

    private var ops = ArrayList<Any?>()
    private val queue = ArrayList<Any?>()
    val handlers = HashMap<String, JsFunction>()

    private fun hostCreate(id: Int, type: String) {
        ops.add(listOf("create", id, type))
    }

    private fun hostSetProps(id: Int, changed: Map<String, Any?>) {
        val out = LinkedHashMap<String, Any?>()
        var any = false
        for ((k, v) in changed) {
            val key = "$id:$k"
            if (v is JsFunction) {
                val known = handlers.containsKey(key)
                handlers[key] = v
                if (known) continue // hanya fungsinya yang berganti
                out[k] = mapOf("\$fn" to key)
            } else {
                if (handlers.remove(key) != null && v == null) {
                    out[k] = null
                    any = true
                    continue
                }
                // Salinan dangkal: object milik komponen bisa diubah lagi setelah dikirim.
                out[k] = when (v) {
                    is LinkedHashMap<*, *> -> LinkedHashMap(v)
                    is ArrayList<*> -> ArrayList(v)
                    else -> v
                }
            }
            any = true
        }
        if (any) ops.add(listOf("props", id, out))
    }

    private fun hostSetChildren(id: Int, children: List<Int>) {
        ops.add(listOf("children", id, children))
    }

    private fun hostRemove(id: Int) {
        val prefix = "$id:"
        handlers.keys.removeAll { it.startsWith(prefix) }
        ops.add(listOf("delete", id))
    }

    private fun hostCommit() {
        if (ops.isEmpty()) return
        queue.add(mapOf("v" to PROTOCOL, "ops" to ops))
        ops = ArrayList()
    }

    private fun drain(): List<Any?> {
        val out = ArrayList(queue)
        queue.clear()
        return out
    }

    // --- model instance ---

    private class Hook(val kind: String) {
        var hasValue = false
        var value: Any? = null
        var set: JsFunction? = null
        var owner: CompInst? = null
        var dispatch: ((Any?) -> Unit)? = null
        var ref: JsObject? = null
        var deps: List<Any?>? = null
        var hasDeps = false
        var pending: JsFunction? = null
        var cleanup: JsFunction? = null
    }

    private sealed class Inst {
        abstract val key: String?
        abstract val path: String
        abstract var props: Map<String, Any?>
        abstract var children: List<Inst>
    }

    private class HostInst(
        val type: String,
        val id: Int,
        override val key: String?,
        override val path: String,
        override var props: Map<String, Any?>,
    ) : Inst() {
        override var children: List<Inst> = emptyList()
        var lastIds: List<Int> = emptyList()
    }

    private class CompInst(
        val type: JsFunction,
        override val key: String?,
        override val path: String,
        override var props: Map<String, Any?>,
        val hostParent: HostInst,
        val depth: Int,
    ) : Inst() {
        override var children: List<Inst> = emptyList()
        val hooks = ArrayList<Hook>()
        var unmounted = false
        var renderedIn = -1
    }

    // --- state root ---

    private var nextId = 1
    private val dirty = LinkedHashSet<CompInst>()
    private var scheduled = false
    private var flushId = 0
    private var effects = ArrayList<Hook>()
    private val container = HostInst("#root", ROOT_ID, null, "", emptyMap())
    private var lastElement: Any? = null

    private var current: CompInst? = null
    private var hookIndex = 0

    // --- JSX ---

    val fragment = JsFunction("Fragment") { a -> (a.getOrNull(0) as? Map<*, *>)?.get("children") }

    private val jsx = JsFunction("jsx") { a ->
        val type = a.getOrNull(0) ?: throw JsError("TypeError: jsx tanpa type")
        @Suppress("UNCHECKED_CAST")
        val props = (a.getOrNull(1) as? Map<String, Any?>) ?: emptyMap()
        val key = a.getOrNull(2)?.let { Js.toStr(it) }
        XPElement(type, props, key)
    }

    private val createElement = JsFunction("createElement") { a ->
        val type = a.getOrNull(0) ?: throw JsError("TypeError: createElement tanpa type")
        val src = a.getOrNull(1) as? Map<*, *>
        val props = JsObject()
        var key: String? = null
        if (src != null) for ((k, v) in src) if (k == "key") key = v?.let { Js.toStr(it) } else props[k.toString()] = v
        val children = a.drop(2)
        if (children.isNotEmpty()) props["children"] = if (children.size == 1) children[0] else JsArray(children)
        XPElement(type, props, key)
    }

    private fun normalize(node: Any?, out: ArrayList<XPElement> = ArrayList()): ArrayList<XPElement> {
        when (node) {
            null, is Boolean -> Unit
            is List<*> -> for (n in node) normalize(n, out)
            is String -> out.add(XPElement(TEXT, mapOf("value" to node), null))
            is Number -> out.add(XPElement(TEXT, mapOf("value" to Js.toStr(node)), null))
            is XPElement -> out.add(node)
            else -> throw JsError("Child tidak didukung: ${Js.toStr(node)}")
        }
        return out
    }

    // --- hooks ---

    private fun nextHook(kind: String): Hook {
        val comp = current ?: throw JsError("Hooks hanya boleh dipanggil di dalam komponen")
        val i = hookIndex++
        if (i < comp.hooks.size) return comp.hooks[i]
        val h = Hook(kind)
        comp.hooks.add(h)
        return h
    }

    private fun depsChanged(a: List<Any?>?, b: List<Any?>?): Boolean =
        a == null || b == null || a.size != b.size || a.indices.any { !Js.same(a[it], b[it]) }

    private val useState = JsFunction("useState") { a ->
        val comp = current ?: throw JsError("Hooks hanya boleh dipanggil di dalam komponen")
        val h = nextHook("state")
        if (!h.hasValue) {
            val init = a.getOrNull(0)
            h.value = if (init is JsFunction) init.impl(emptyList()) else init
            h.hasValue = true
            h.set = JsFunction("setState") { args -> h.dispatch?.invoke(args.getOrNull(0)); null }
        }
        if (h.owner !== comp) {
            h.owner = comp
            h.dispatch = { v ->
                val next = if (v is JsFunction) v.impl(listOf(h.value)) else v
                if (!Js.same(next, h.value)) {
                    h.value = next
                    schedule(h.owner!!)
                }
            }
        }
        JsArray(listOf(h.value, h.set))
    }

    private val useRef = JsFunction("useRef") { a ->
        val h = nextHook("ref")
        if (h.ref == null) h.ref = JsObject().apply { this["current"] = a.getOrNull(0) }
        h.ref
    }

    @Suppress("UNCHECKED_CAST")
    private fun memo(fn: () -> Any?, deps: List<Any?>?): Any? {
        val h = nextHook("memo")
        if (!h.hasValue || depsChanged(h.deps, deps)) {
            h.value = fn()
            h.hasValue = true
            h.deps = deps
        }
        return h.value
    }

    @Suppress("UNCHECKED_CAST")
    private val useMemo = JsFunction("useMemo") { a ->
        val fn = a.getOrNull(0) as? JsFunction ?: throw JsError("TypeError: useMemo butuh function")
        memo({ fn.impl(emptyList()) }, a.getOrNull(1) as? List<Any?>)
    }

    @Suppress("UNCHECKED_CAST")
    private val useCallback = JsFunction("useCallback") { a ->
        val fn = a.getOrNull(0)
        memo({ fn }, a.getOrNull(1) as? List<Any?>)
    }

    @Suppress("UNCHECKED_CAST")
    private val useEffect = JsFunction("useEffect") { a ->
        val fn = a.getOrNull(0) as? JsFunction ?: throw JsError("TypeError: useEffect butuh function")
        val deps = a.getOrNull(1) as? List<Any?>
        val h = nextHook("effect")
        if (a.size < 2 || a[1] == null || !h.hasDeps || depsChanged(h.deps, deps)) {
            h.pending = fn
            h.deps = deps
            h.hasDeps = true
            effects.add(h)
        }
        null
    }

    // --- rekonsiliasi ---

    private fun hostIds(inst: Inst): List<Int> = when (inst) {
        is HostInst -> listOf(inst.id)
        is CompInst -> inst.children.flatMap { hostIds(it) }
    }

    private fun syncChildren(h: HostInst) {
        val ids = h.children.flatMap { hostIds(it) }
        if (ids != h.lastIds) {
            hostSetChildren(h.id, ids)
            h.lastIds = ids
        }
    }

    private fun plainEqual(a: Any?, b: Any?): Boolean {
        if (a !is Map<*, *> || b !is Map<*, *>) return false
        if (a.size != b.size) return false
        for ((k, v) in a) {
            if (!b.containsKey(k) || !Js.same(v, b[k])) return false
        }
        return true
    }

    private fun propsDiff(prev: Map<String, Any?>, next: Map<String, Any?>): Map<String, Any?>? {
        val changed = LinkedHashMap<String, Any?>()
        for ((k, v) in next) {
            if (k == "children") continue
            val p = prev[k]
            if (v == null && !prev.containsKey(k)) continue // undefined baru: tidak ada yang dikirim
            if (!Js.same(p, v) && !plainEqual(p, v) || !prev.containsKey(k)) changed[k] = v
        }
        for (k in prev.keys) if (k != "children" && (!next.containsKey(k))) changed[k] = null
        return if (changed.isEmpty()) null else changed
    }

    private fun segment(v: XPElement, index: Int) = "${if (v.type is String) v.type else "C"}#${v.key ?: index}"

    private fun mount(v: XPElement, hostParent: HostInst, depth: Int, path: String): Inst {
        val type = v.type
        if (type is String) {
            val inst = HostInst(type, nextId++, v.key, path, v.props)
            hostCreate(inst.id, type)
            propsDiff(emptyMap(), v.props)?.let { hostSetProps(inst.id, it) }
            inst.children = reconcile(emptyList(), normalize(v.props["children"]), inst, depth + 1, path)
            syncChildren(inst)
            return inst
        }
        val fn = type as? JsFunction ?: throw JsError("TypeError: type elemen bukan komponen: ${Js.toStr(type)}")
        val inst = CompInst(fn, v.key, path, v.props, hostParent, depth)
        renderComp(inst)
        return inst
    }

    private fun update(inst: Inst, v: XPElement, depth: Int) {
        when (inst) {
            is HostInst -> {
                propsDiff(inst.props, v.props)?.let { hostSetProps(inst.id, it) }
                inst.props = v.props
                inst.children = reconcile(inst.children, normalize(v.props["children"]), inst, depth + 1, inst.path)
                syncChildren(inst)
            }
            is CompInst -> {
                inst.props = v.props
                renderComp(inst)
            }
        }
    }

    private fun renderComp(inst: CompInst) {
        val prev = current
        val prevIndex = hookIndex
        current = inst
        hookIndex = 0
        try {
            val out = if (inst.type === fragment) inst.props["children"] else inst.type.impl(listOf(inst.props))
            inst.renderedIn = flushId
            inst.children = reconcile(inst.children, normalize(out), inst.hostParent, inst.depth + 1, inst.path)
        } finally {
            current = prev
            hookIndex = prevIndex
        }
    }

    private fun unmount(inst: Inst) {
        when (inst) {
            is CompInst -> {
                inst.unmounted = true
                for (h in inst.hooks) h.cleanup?.impl(emptyList())
                for (c in inst.children) unmount(c)
            }
            is HostInst -> {
                for (c in inst.children) unmount(c)
                hostRemove(inst.id)
            }
        }
    }

    private fun sameType(inst: Inst, v: XPElement): Boolean = when (inst) {
        is HostInst -> inst.type == v.type
        is CompInst -> inst.type === v.type
    }

    private fun reconcile(old: List<Inst>, next: List<XPElement>, hostParent: HostInst, depth: Int, path: String): List<Inst> {
        val byKey = HashMap<String, Inst>()
        val unkeyed = ArrayList<Inst>()
        for (o in old) if (o.key != null) byKey[o.key!!] = o else unkeyed.add(o)
        val used = HashSet<Inst>()
        var u = 0
        val result = next.mapIndexed { i, v ->
            val match = if (v.key != null) byKey[v.key] else unkeyed.getOrNull(u++)
            if (match != null && match !in used && sameType(match, v)) {
                used.add(match)
                update(match, v, depth)
                match
            } else {
                mount(v, hostParent, depth, "$path/${segment(v, i)}")
            }
        }
        for (o in old) if (o !in used) unmount(o)
        return result
    }

    // --- penjadwalan ---

    private fun schedule(comp: CompInst) {
        dirty.add(comp)
        scheduled = true
    }

    private fun flush() {
        scheduled = false
        flushId++
        val list = dirty.sortedBy { it.depth }
        dirty.clear()
        val parents = LinkedHashSet<HostInst>()
        for (c in list) {
            if (c.unmounted || c.renderedIn == flushId) continue
            renderComp(c)
            parents.add(c.hostParent)
        }
        for (p in parents) syncChildren(p)
        commit()
    }

    private fun commit() {
        hostCommit()
        val run = effects
        effects = ArrayList()
        for (h in run) {
            h.cleanup?.impl(emptyList())
            val c = h.pending?.impl(emptyList())
            h.cleanup = c as? JsFunction
        }
    }

    private fun flushSync() {
        var i = 0
        while (scheduled) {
            if (i++ > 50) throw JsError("Terlalu banyak update berantai (setState di dalam effect?)")
            flush()
        }
    }

    private fun render(element: Any?) {
        lastElement = element
        flushId++
        container.children = reconcile(container.children, normalize(element), container, 0, "")
        syncChildren(container)
        commit()
    }

    // --- timer (setTimeout / setInterval) ---

    private class Timer(var at: Long, val fn: JsFunction, val args: List<Any?>, val every: Long?)

    private val timers = LinkedHashMap<Int, Timer>()
    private var lastTimer = 0

    /** Jam untuk timer; bisa diganti di tes. */
    var clock: () -> Long = { System.currentTimeMillis() }

    private fun addTimer(a: List<Any?>, repeat: Boolean): Any? {
        val fn = a.getOrNull(0) as? JsFunction ?: throw JsError("TypeError: setTimeout/setInterval butuh function")
        val delay = maxOf(0L, Js.toNum(a.getOrNull(1)).let { if (it.isNaN()) 0L else it.toLong() })
        val id = ++lastTimer
        timers[id] = Timer(clock() + delay, fn, a.drop(2), if (repeat) maxOf(1L, delay) else null)
        return id.toDouble()
    }

    private val clearTimer = JsFunction("clearTimeout") { a ->
        timers.remove(Js.toNum(a.getOrNull(0)).let { if (it.isNaN()) -1 else it.toInt() })
        null
    }

    private fun runDueTimers() {
        val now = clock()
        var error: Throwable? = null
        for (i in 0 until 1000) {
            val due = timers.entries.filter { it.value.at <= now }.minByOrNull { it.value.at } ?: break
            val t = due.value
            if (t.every == null) timers.remove(due.key)
            else {
                t.at += t.every
                if (t.at <= now) t.at = now + t.every
            }
            try {
                t.fn.impl(t.args)
            } catch (e: Throwable) {
                if (error == null) error = e
            }
        }
        error?.let { throw it }
    }

    // --- environment (lebar layar & mode gelap) ---

    private var env = JsObject().apply {
        this["width"] = 0.0
        this["height"] = 0.0
        this["dark"] = false
    }
    private val breakpoints = LinkedHashSet<Double>()
    private var viewportUnits = false

    private fun setEnvironment(next: Map<String, Any?>) {
        val prev = env
        env = JsObject(prev).apply { for ((k, v) in next) this[k] = Js.fromHost(v) }
        val pw = Js.toNum(prev["width"])
        val w = Js.toNum(env["width"])
        val crossed = breakpoints.any { (pw >= it) != (w >= it) }
        val resized = viewportUnits && (pw != w || Js.toNum(prev["height"]) != Js.toNum(env["height"]))
        if ((crossed || resized || prev["dark"] != env["dark"]) && lastElement != null) {
            flushId++
            container.children = reconcile(container.children, normalize(lastElement), container, 0, "")
            syncChildren(container)
            commit()
        }
    }

    // --- objek yang dilihat kode komponen ---

    val api: JsObject = Js.obj {
        this["jsx"] = jsx
        this["jsxs"] = jsx
        this["jsxDEV"] = jsx
        this["Fragment"] = fragment
        this["createElement"] = createElement
        this["useState"] = useState
        this["useEffect"] = useEffect
        this["useMemo"] = useMemo
        this["useCallback"] = useCallback
        this["useRef"] = useRef
        this["environment"] = JsFunction("environment") { _ -> env }
        this["registerBreakpoints"] = JsFunction("registerBreakpoints") { a ->
            for (w in Js.iter(a.getOrNull(0) ?: JsArray())) breakpoints.add(Js.toNum(w))
            if (Js.truthy(a.getOrNull(1))) viewportUnits = true
            null
        }
    }

    private val setTimeoutFn = JsFunction("setTimeout") { a -> addTimer(a, repeat = false) }
    private val setIntervalFn = JsFunction("setInterval") { a -> addTimer(a, repeat = true) }

    internal fun global(name: String): Any? = when (name) {
        "__xp" -> api
        "setTimeout" -> setTimeoutFn
        "setInterval" -> setIntervalFn
        "clearTimeout", "clearInterval" -> clearTimer
        else -> JsBuiltins.global(name)
    }

    private val componentFn: JsFunction by lazy { component.create(XPScope(this)) }

    private fun done(): List<Any?> {
        flushSync()
        return drain()
    }

    // --- API untuk SDK (sama dengan XP.* di bundle JS) ---

    fun mount(props: Map<String, Any?>): List<Any?> {
        render(XPElement(componentFn, Js.fromHost(props) as JsObject, null))
        return done()
    }

    fun update(props: Map<String, Any?>): List<Any?> = mount(props)

    fun dispatch(handlerKey: String, args: List<Any?>): List<Any?> {
        handlers[handlerKey]?.impl(args.map { Js.fromHost(it) }) // node sudah dihapus: abaikan event basi
        return done()
    }

    fun tick(): List<Any?> {
        runDueTimers()
        return done()
    }

    /** ms sampai timer berikutnya, atau -1 kalau tidak ada. */
    fun nextTimer(): Long {
        if (timers.isEmpty()) return -1
        val min = timers.values.minOf { it.at }
        return maxOf(0L, min - clock())
    }

    fun environment(width: Double, height: Double, dark: Boolean): List<Any?> {
        setEnvironment(mapOf("width" to width, "height" to height, "dark" to dark))
        return done()
    }

    fun unmount(): List<Any?> {
        lastElement = null
        for (c in container.children) unmount(c)
        container.children = emptyList()
        syncChildren(container)
        hostCommit()
        timers.clear()
        return drain()
    }
}
