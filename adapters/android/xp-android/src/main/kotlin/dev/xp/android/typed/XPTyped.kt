package dev.xp.android.typed

import dev.xp.android.compiled.Js

/**
 * Runtime untuk komponen xp yang dikompilasi ke Kotlin bertipe (`xp build`, mode typed).
 *
 * Kode komponen hasil compiler adalah Kotlin biasa dengan tipe yang jelas: state `Double`,
 * `String`, data class, dan seterusnya. Runtime ini hanya mengurus identitas komponen (hooks per
 * instance, key, urutan), effect, dan timer, dengan aturan yang sama dengan runtime/reconciler.ts.
 * Hasilnya tree node host (View, Text, ...) yang langsung dirender Compose/SwiftUI: tanpa daftar
 * operasi, tanpa JSON, tanpa XPTree.
 *
 * Tidak thread-safe: panggil dari satu thread (main thread di app).
 */

/** Handler event dari renderer: argumen sesuai event (onSwipe → arah, onChangeText → teks, ...). */
typealias XPHandler = (List<Any?>) -> Unit

/** Elemen hasil render komponen (sama dengan VNode di JS). */
class XPEl internal constructor(
    val type: String,
    val key: String?,
    val props: Map<String, Any?>,
    val handlers: Map<String, XPHandler>,
    val children: Any?,
    /** Komponen buatan user: fungsi render-nya. Null untuk primitive. */
    internal val render: ((XPHooks) -> Any?)?,
)

/** `<View style={...} onPress={...}>...</View>` */
fun el(
    type: String,
    props: Map<String, Any?> = emptyMap(),
    handlers: Map<String, XPHandler> = emptyMap(),
    key: String? = null,
    children: Any? = null,
): XPEl = XPEl(type, key, props, handlers, children, null)

/** `<Card title="..."/>`: komponen user. Identitasnya nama komponen + key/posisi, seperti di JS. */
fun comp(name: String, key: String?, render: (XPHooks) -> Any?): XPEl = XPEl(name, key, emptyMap(), emptyMap(), null, render)

/** Komponen terkompilasi (mode typed). Props dari app masih berupa map; komponen mengubahnya ke data class. */
interface XPTypedComponent {
    val name: String
    val hash: String
    fun render(props: Map<String, Any?>, h: XPHooks): Any?
}

/** Daftar komponen mode typed milik app (object `dev.xp.generated.XPTypedComponents` dari task Gradle). */
interface XPTypedRegistry {
    val components: Map<String, XPTypedComponent>
}

/** Node host di tree hasil: yang dirender Compose/SwiftUI. */
class XPHostNode internal constructor(
    val id: Int,
    val type: String,
    val key: String?,
    /** Revisi saat node dibuat: animasi `entering` hanya untuk node yang baru muncul. */
    val createdAt: Int,
) {
    var props: Map<String, Any?> = emptyMap()
        internal set
    var handlers: Map<String, XPHandler> = emptyMap()
        internal set
    var children: List<XPHostNode> = emptyList()
        internal set

    fun handler(name: String): XPHandler? = handlers[name]
}

/** Nilai `environment()`. */
data class XPEnv(val width: Double, val height: Double, val dark: Boolean)

class XPRef<T>(var current: T)

/** Setter dari useState: `setX(v)` atau `setX.update { prev -> ... }`. */
class XPSetter<T> internal constructor(private val hook: XPHooks.Slot) {
    operator fun invoke(value: T) = hook.set(value)

    @Suppress("UNCHECKED_CAST")
    fun update(f: (T) -> T) = hook.set(f(hook.value as T))
}

class XPState<T>(val value: T, val set: XPSetter<T>) {
    operator fun component1(): T = value
    operator fun component2(): XPSetter<T> = set
}

/** Hooks satu instance komponen. Urutan pemanggilan harus tetap (aturan hooks yang sama dengan React). */
class XPHooks internal constructor(internal val rt: XPTypedRuntime, internal val inst: XPTypedRuntime.CompInst) {
    internal class Slot(val rt: XPTypedRuntime) {
        var hasValue = false
        var value: Any? = null
        var owner: XPTypedRuntime.CompInst? = null
        var setter: XPSetter<*>? = null
        var deps: List<Any?>? = null
        var hasDeps = false
        var pending: (() -> (() -> Unit)?)? = null
        var cleanup: (() -> Unit)? = null

        fun set(next: Any?) {
            if (XPStd.same(next, value)) return
            value = next
            owner?.let { rt.schedule(it) }
        }
    }

    internal val slots = ArrayList<Slot>()
    internal var index = 0

    private fun next(): Slot {
        val i = index++
        if (i < slots.size) return slots[i]
        return Slot(rt).also { slots.add(it) }
    }

    @Suppress("UNCHECKED_CAST")
    fun <T> state(init: () -> T): XPState<T> {
        val s = next()
        if (!s.hasValue) {
            s.value = init()
            s.hasValue = true
            s.setter = XPSetter<T>(s)
        }
        s.owner = inst
        return XPState(s.value as T, s.setter as XPSetter<T>)
    }

    @Suppress("UNCHECKED_CAST")
    fun <T> ref(init: () -> T): XPRef<T> {
        val s = next()
        if (!s.hasValue) {
            s.value = XPRef(init())
            s.hasValue = true
        }
        return s.value as XPRef<T>
    }

    @Suppress("UNCHECKED_CAST")
    fun <T> memo(deps: List<Any?>, f: () -> T): T {
        val s = next()
        if (!s.hasValue || XPTypedRuntime.depsChanged(s.deps, deps)) {
            s.value = f()
            s.hasValue = true
            s.deps = deps
        }
        return s.value as T
    }

    /** useEffect. deps null = setiap render. Fungsi boleh mengembalikan cleanup. */
    fun effect(deps: List<Any?>?, f: () -> (() -> Unit)?) {
        val s = next()
        if (deps == null || !s.hasDeps || XPTypedRuntime.depsChanged(s.deps, deps)) {
            s.pending = f
            s.deps = deps
            s.hasDeps = true
            rt.effects.add(s)
        }
    }

    val env: XPEnv get() = rt.env

    fun setTimeout(ms: Double, f: () -> Unit): Double = rt.addTimer(ms, f, repeating = false)
    fun setInterval(ms: Double, f: () -> Unit): Double = rt.addTimer(ms, f, repeating = true)
    fun clearTimeout(id: Double?) = rt.removeTimer(id)
    fun clearInterval(id: Double?) = rt.removeTimer(id)
}

class XPTypedRuntime(private val component: XPTypedComponent) {
    companion object {
        internal const val TEXT = "#text"
        internal fun depsChanged(a: List<Any?>?, b: List<Any?>?): Boolean =
            a == null || b == null || a.size != b.size || a.indices.any { !XPStd.same(a[it], b[it]) }
    }

    /** Dipanggil setiap ada state yang berubah di luar render (event, timer): host menjadwalkan flush(). */
    var onInvalidate: () -> Unit = {}

    /** Dipanggil setelah tree berubah (sesudah flush). */
    var onCommit: () -> Unit = {}

    var clock: () -> Long = { System.currentTimeMillis() }

    // --- instance ---

    internal sealed class Inst {
        abstract val key: String?
        abstract var children: List<Inst>
    }

    internal class HostInst(val node: XPHostNode) : Inst() {
        override val key: String? get() = node.key
        override var children: List<Inst> = emptyList()
    }

    internal class CompInst(
        val name: String,
        override val key: String?,
        var render: (XPHooks) -> Any?,
        val hostParent: HostInst,
        val depth: Int,
    ) : Inst() {
        override var children: List<Inst> = emptyList()
        var hooks: XPHooks? = null
        var unmounted = false
        var renderedIn = -1
    }

    private var nextId = 1
    private val container = HostInst(XPHostNode(0, "#root", null, 0))
    private val dirty = LinkedHashSet<CompInst>()
    private var scheduled = false
    private var flushId = 0
    internal var effects = ArrayList<XPHooks.Slot>()
    private var lastElement: XPEl? = null
    private var rendering = false

    /** Node teratas yang dirender host. */
    val root: List<XPHostNode> get() = container.node.children

    /** Naik setiap kali tree berubah; host Compose memakai ini untuk render ulang. */
    var revision = 0
        private set

    var env = XPEnv(0.0, 0.0, false)
        private set

    private fun normalize(node: Any?, out: ArrayList<XPEl> = ArrayList()): ArrayList<XPEl> {
        when (node) {
            null, is Boolean, Unit -> Unit
            is List<*> -> for (n in node) normalize(n, out)
            is String -> out.add(el(TEXT, mapOf("value" to node)))
            is Double -> out.add(el(TEXT, mapOf("value" to XPStd.str(node))))
            is Number -> out.add(el(TEXT, mapOf("value" to XPStd.str(node.toDouble()))))
            is XPEl -> out.add(node)
            else -> throw IllegalStateException("child tidak didukung: $node")
        }
        return out
    }

    private fun hostNodes(inst: Inst): List<XPHostNode> = when (inst) {
        is HostInst -> listOf(inst.node)
        is CompInst -> inst.children.flatMap { hostNodes(it) }
    }

    private fun syncChildren(h: HostInst) {
        val nodes = h.children.flatMap { hostNodes(it) }
        if (nodes != h.node.children) h.node.children = nodes
    }

    private fun mount(v: XPEl, hostParent: HostInst, depth: Int): Inst {
        val render = v.render
        if (render == null) {
            val inst = HostInst(XPHostNode(nextId++, v.type, v.key, revision + 1))
            inst.node.props = v.props
            inst.node.handlers = v.handlers
            inst.children = reconcile(emptyList(), normalize(v.children), inst, depth + 1)
            syncChildren(inst)
            return inst
        }
        val inst = CompInst(v.type, v.key, render, hostParent, depth)
        renderComp(inst)
        return inst
    }

    private fun update(inst: Inst, v: XPEl, depth: Int) {
        when (inst) {
            is HostInst -> {
                inst.node.props = v.props
                inst.node.handlers = v.handlers
                inst.children = reconcile(inst.children, normalize(v.children), inst, depth + 1)
                syncChildren(inst)
            }
            is CompInst -> {
                inst.render = v.render!!
                renderComp(inst)
            }
        }
    }

    private fun renderComp(inst: CompInst) {
        val h = inst.hooks ?: XPHooks(this, inst).also { inst.hooks = it }
        h.index = 0
        val out = inst.render(h)
        inst.renderedIn = flushId
        inst.children = reconcile(inst.children, normalize(out), inst.hostParent, inst.depth + 1)
    }

    private fun unmount(inst: Inst) {
        when (inst) {
            is CompInst -> {
                inst.unmounted = true
                inst.hooks?.slots?.forEach { it.cleanup?.invoke() }
                for (c in inst.children) unmount(c)
            }
            is HostInst -> for (c in inst.children) unmount(c)
        }
    }

    private fun sameType(inst: Inst, v: XPEl): Boolean = when (inst) {
        is HostInst -> v.render == null && inst.node.type == v.type
        is CompInst -> v.render != null && inst.name == v.type
    }

    private fun reconcile(old: List<Inst>, next: List<XPEl>, hostParent: HostInst, depth: Int): List<Inst> {
        val byKey = HashMap<String, Inst>()
        val unkeyed = ArrayList<Inst>()
        for (o in old) o.key?.let { byKey[it] = o } ?: unkeyed.add(o)
        val used = HashSet<Inst>()
        var u = 0
        val result = next.map { v ->
            val match = if (v.key != null) byKey[v.key] else unkeyed.getOrNull(u++)
            if (match != null && match !in used && sameType(match, v)) {
                used.add(match)
                update(match, v, depth)
                match
            } else {
                mount(v, hostParent, depth)
            }
        }
        for (o in old) if (o !in used) unmount(o)
        return result
    }

    // --- penjadwalan ---

    internal fun schedule(comp: CompInst) {
        dirty.add(comp)
        if (!scheduled) {
            scheduled = true
            if (!rendering) onInvalidate()
        }
    }

    private fun flushOnce() {
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
        revision++
        val run = effects
        effects = ArrayList()
        for (s in run) {
            s.cleanup?.invoke()
            s.cleanup = s.pending?.invoke()
        }
    }

    /** Render ulang semua komponen yang state-nya berubah, sampai stabil. */
    fun flush() {
        var i = 0
        rendering = true
        try {
            while (scheduled) {
                check(i++ <= 50) { "terlalu banyak update berantai (setState di dalam effect?)" }
                flushOnce()
            }
        } finally {
            rendering = false
        }
        onCommit()
    }

    private fun renderRoot(element: XPEl) {
        lastElement = element
        rendering = true
        try {
            flushId++
            container.children = reconcile(container.children, listOf(element), container, 0)
            syncChildren(container)
            commit()
        } finally {
            rendering = false
        }
        flush()
    }

    // --- timer ---

    private class Timer(var at: Long, val fn: () -> Unit, val every: Long?)

    private val timers = LinkedHashMap<Int, Timer>()
    private var lastTimer = 0

    internal fun addTimer(ms: Double, fn: () -> Unit, repeating: Boolean): Double {
        val delay = if (ms.isNaN()) 0L else ms.toLong().coerceAtLeast(0L)
        timers[++lastTimer] = Timer(clock() + delay, fn, if (repeating) delay.coerceAtLeast(1L) else null)
        return lastTimer.toDouble()
    }

    internal fun removeTimer(id: Double?) {
        if (id != null && !id.isNaN()) timers.remove(id.toInt())
    }

    /** Jalankan timer yang sudah jatuh tempo, lalu render ulang. */
    fun tick() {
        val now = clock()
        var error: Throwable? = null
        for (round in 0 until 1000) {
            val (id, t) = timers.entries.filter { it.value.at <= now }.minByOrNull { it.value.at }?.toPair() ?: break
            if (t.every != null) {
                t.at += t.every
                if (t.at <= now) t.at = now + t.every
            } else {
                timers.remove(id)
            }
            try {
                t.fn()
            } catch (e: Throwable) {
                if (error == null) error = e
            }
        }
        flush()
        error?.let { throw it }
    }

    /** ms sampai timer berikutnya, atau -1 kalau tidak ada. */
    fun nextTimer(): Long = timers.values.minOfOrNull { it.at }?.let { (it - clock()).coerceAtLeast(0L) } ?: -1L

    // --- API untuk host (sama dengan XP.* di bundle JS) ---

    fun mount(props: Map<String, Any?>) {
        renderRoot(comp(component.name, null) { h -> component.render(props, h) })
    }

    fun update(props: Map<String, Any?>) = mount(props)

    private val breakpoints = LinkedHashSet<Double>()
    private var viewportUnits = false

    /** Dari className: lebar layar yang mengubah tampilan, dan apakah ada satuan vh/vw. */
    internal fun registerBreakpoints(list: List<Double>, viewport: Boolean) {
        breakpoints.addAll(list)
        if (viewport) viewportUnits = true
    }

    /** Ukuran layar / mode gelap. Render ulang hanya kalau tampilannya bisa berubah (sama dengan JS). */
    fun environment(width: Double, height: Double, dark: Boolean) {
        val prev = env
        val next = XPEnv(width, height, dark)
        env = next
        val crossed = breakpoints.any { (prev.width >= it) != (next.width >= it) }
        val resized = viewportUnits && (prev.width != next.width || prev.height != next.height)
        if ((crossed || resized || prev.dark != next.dark) && lastElement != null) renderRoot(lastElement!!)
    }

    /** Panggil handler event milik node (dari renderer), lalu render ulang. */
    fun dispatch(handler: XPHandler, args: List<Any?>) {
        rendering = true
        try {
            handler(args)
        } finally {
            rendering = false
        }
        flush()
    }

    fun unmount() {
        lastElement = null
        for (c in container.children) unmount(c)
        container.children = emptyList()
        syncChildren(container)
        timers.clear()
        revision++
        onCommit()
    }
}

/** Class hasil compiler (type alias / interface) yang bisa dikirim ke renderer sebagai map. */
interface XPHostValue {
    fun toHost(): Map<String, Any?>
}

/** Map untuk props/style. Urutan kunci dipertahankan. */
fun xpMap(vararg entries: Pair<String, Any?>): Map<String, Any?> = LinkedHashMap<String, Any?>(entries.size).apply { for ((k, v) in entries) put(k, v) }

/** Props primitive: nilai null (undefined di JS) tidak dikirim. */
fun xpProps(vararg entries: Pair<String, Any?>): Map<String, Any?> =
    LinkedHashMap<String, Any?>(entries.size).apply { for ((k, v) in entries) if (v != null) put(k, v) }

/** `{ ...a, ...b, x: 1 }` */
fun xpMerge(vararg parts: Map<String, Any?>?): Map<String, Any?> = LinkedHashMap<String, Any?>().apply { for (p in parts) if (p != null) putAll(p) }

/** Perilaku JS yang dipakai kode bertipe: angka → teks, perbandingan Object.is, truthy, Math, dst. */
object XPStd {
    fun str(d: Double): String = Js.numStr(d)
    fun str(v: Any?): String = when (v) {
        null -> "undefined"
        is String -> v
        is Double -> Js.numStr(v)
        is Boolean -> if (v) "true" else "false"
        is XPHostValue -> "[object Object]"
        else -> Js.toStr(Js.fromHost(v))
    }

    fun num(v: Any?): Double = when (v) {
        is Double -> v
        is Number -> v.toDouble()
        else -> Js.toNum(Js.fromHost(v))
    }

    fun numOrNull(v: Any?): Double? = if (v == null) null else num(v)

    @Suppress("UNCHECKED_CAST")
    fun map(v: Any?): Map<String, Any?> = v as? Map<String, Any?> ?: emptyMap()

    fun same(a: Any?, b: Any?): Boolean = when {
        a is Double && b is Double -> if (a.isNaN() && b.isNaN()) true else a == b && (a != 0.0 || 1.0 / a == 1.0 / b)
        a is String || a is Boolean -> a == b
        else -> a === b
    }

    /** `===` untuk nilai yang tipenya tidak pasti. */
    fun strictEquals(a: Any?, b: Any?): Boolean = when {
        a is Double && b is Double -> a == b
        a is String || a is Boolean -> a == b
        else -> a === b
    }

    fun truthy(d: Double): Boolean = d != 0.0 && !d.isNaN()
    fun truthy(s: String?): Boolean = !s.isNullOrEmpty()
    fun truthy(d: Double?): Boolean = d != null && truthy(d)
    fun truthy(v: Any?): Boolean = when (v) {
        null -> false
        is Boolean -> v
        is Double -> truthy(v)
        is String -> v.isNotEmpty()
        else -> true
    }

    // Math dengan aturan JS
    fun round(d: Double): Double = if (d.isNaN() || d.isInfinite()) d else Math.floor(d + 0.5)
    fun trunc(d: Double): Double = if (d < 0) Math.ceil(d) else Math.floor(d)
    fun sign(d: Double): Double = if (d.isNaN()) d else if (d > 0) 1.0 else if (d < 0) -1.0 else d
    fun min(vararg xs: Double): Double = xs.fold(Double.POSITIVE_INFINITY) { a, b -> if (a.isNaN() || b.isNaN()) Double.NaN else Math.min(a, b) }
    fun max(vararg xs: Double): Double = xs.fold(Double.NEGATIVE_INFINITY) { a, b -> if (a.isNaN() || b.isNaN()) Double.NaN else Math.max(a, b) }
    fun hypot(vararg xs: Double): Double = Math.sqrt(xs.sumOf { it * it })
    fun now(): Double = dev.xp.android.compiled.JsBuiltins.clock().toDouble()

    fun isInteger(v: Any?): Boolean = v is Double && !v.isInfinite() && v == Math.floor(v)
    fun isFiniteNum(v: Any?): Boolean = v is Double && !v.isInfinite() && !v.isNaN()
    fun isNaNNum(v: Any?): Boolean = v is Double && v.isNaN()

    fun parseFloat(s: String?): Double = Js.toNum(Js.call(dev.xp.android.compiled.JsBuiltins.global("parseFloat"), listOf(s)))
    fun parseInt(s: String?, radix: Double? = null): Double = Js.toNum(Js.call(dev.xp.android.compiled.JsBuiltins.global("parseInt"), listOfNotNull(s, radix)))

    private fun i32(d: Double): Int = Js.toInt32(d)
    fun bitAnd(a: Double, b: Double): Double = (i32(a) and i32(b)).toDouble()
    fun bitOr(a: Double, b: Double): Double = (i32(a) or i32(b)).toDouble()
    fun bitXor(a: Double, b: Double): Double = (i32(a) xor i32(b)).toDouble()
    fun bitNot(a: Double): Double = i32(a).inv().toDouble()
    fun shl(a: Double, b: Double): Double = (i32(a) shl (i32(b) and 31)).toDouble()
    fun shr(a: Double, b: Double): Double = (i32(a) shr (i32(b) and 31)).toDouble()
    fun ushr(a: Double, b: Double): Double = (i32(a).toUInt() shr (i32(b) and 31)).toDouble()

    fun toFixed(d: Double, digits: Double): String = method(d, "toFixed", digits) as String
    fun toString(d: Double, radix: Double): String = method(d, "toString", radix) as String

    // String
    fun trim(s: String): String = method(s, "trim") as String
    fun charAt(s: String, i: Double): String = method(s, "charAt", i) as String
    fun split(s: String, sep: String?): List<String> = strList(method(s, "split", sep))!!

    // Array
    fun <T> join(list: List<T>, sep: String): String = list.joinToString(sep) { if (it == null) "" else str(it) }
    fun <T> slice(list: List<T>, start: Double = 0.0, end: Double = list.size.toDouble()): List<T> {
        fun idx(v: Double): Int {
            val n = if (v.isNaN()) 0.0 else v
            val i = if (n < 0) Math.max(0.0, list.size + trunc(n)) else Math.min(trunc(n), list.size.toDouble())
            return i.toInt()
        }
        val a = idx(start)
        val b = idx(end)
        return if (a < b) list.subList(a, b).toList() else emptyList()
    }

    // RegExp
    fun regex(source: String, flags: String): Any = Js.regex(source, flags)
    fun test(re: Any, s: String): Boolean = Js.callMethod(re, "test", listOf(s)) == true

    /** Method JS lain lewat implementasi yang sama dengan mode dinamis. */
    fun method(recv: Any?, name: String, vararg args: Any?): Any? =
        Js.callMethod(Js.fromHost(recv), name, args.map { if (it is Map<*, *> || it is List<*>) Js.fromHost(it) else it })

    fun strList(v: Any?): List<String>? = (v as? List<*>)?.map { it as String }

    fun json(v: Any?): String = Js.toStr(Js.callMethod(dev.xp.android.compiled.JsBuiltins.global("JSON"), "stringify", listOf(Js.fromHost(v))))

    fun log(level: String, vararg args: Any?) = dev.xp.android.compiled.JsConsole.sink(level, args.joinToString(" ") { str(it) })

    fun error(v: Any?): Throwable = dev.xp.android.compiled.JsError(Js.fromHost(v))
}
