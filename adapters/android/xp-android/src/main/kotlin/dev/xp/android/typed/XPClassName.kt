package dev.xp.android.typed

import dev.xp.android.XPJson

/**
 * className (Tailwind) untuk komponen mode typed. Isinya sama dengan modul jsx className di
 * cli/classname.mjs (mergeStyle, finishStyle, resolve, jsx): tabel class → style dibuat saat build,
 * di sini dipilih sesuai lebar layar / mode gelap lalu digabung dengan `style` milik elemen.
 */
object XPClassName {
    class Entry(val order: Double, val style: Map<String, Any?>, val cond: Map<String, Any?>?)

    class Table(val entries: Map<String, Entry>) {
        val breakpoints: List<Double> = entries.values
            .filter { it.cond != null }
            .flatMap { listOfNotNull(it.cond!!["minWidth"] as? Double, it.cond["maxWidth"] as? Double) }
            .distinct()
        val viewport: Boolean = entries.values.any { e -> e.style.values.any { it is String && Regex("v[hw]$").containsMatchIn(it) } }
        internal val cache = HashMap<String, Resolved>()
    }

    internal class Resolved(val style: Map<String, Any?>, val states: Map<String, Map<String, Any?>>)

    /** Tabel dari JSON hasil build: class → [urutan, style, kondisi?, classCss?]. */
    @Suppress("UNCHECKED_CAST")
    fun table(json: String): Table {
        val raw = XPJson.parse(json) as Map<String, Any?>
        val entries = LinkedHashMap<String, Entry>()
        for ((k, v) in raw) {
            val e = v as List<Any?>
            if (e.getOrNull(3) != null) continue // class CSS: hanya untuk web
            entries[k] = Entry((e[0] as Number).toDouble(), e[1] as Map<String, Any?>, e.getOrNull(2) as? Map<String, Any?>)
        }
        return Table(entries)
    }

    private fun matches(c: Map<String, Any?>, env: XPEnv): Boolean {
        (c["minWidth"] as? Double)?.let { if (!(env.width >= it)) return false }
        (c["maxWidth"] as? Double)?.let { if (!(env.width < it)) return false }
        (c["dark"] as? Boolean)?.let { if (it != env.dark) return false }
        return true
    }

    private fun resolve(t: Table, env: XPEnv, className: String): Resolved {
        val key = buildString {
            append(className).append('|')
            for (w in t.breakpoints) append(if (env.width >= w) '1' else '0')
            if (env.dark) append('d')
            if (t.viewport) append(XPStd.str(env.width)).append('x').append(XPStd.str(env.height))
        }
        t.cache[key]?.let { return it }
        val list = className.split(Regex("\\s+")).mapNotNull { t.entries[it] }.sortedBy { it.order }
        val style = LinkedHashMap<String, Any?>()
        val states = LinkedHashMap<String, LinkedHashMap<String, Any?>>()
        for (e in list) {
            val c = e.cond
            if (c == null) merge(style, e.style)
            else if (matches(c, env)) {
                val st = c["state"] as? String
                if (st != null) merge(states.getOrPut(st) { LinkedHashMap() }, e.style) else merge(style, e.style)
            }
        }
        return Resolved(style, states).also { t.cache[key] = it }
    }

    private val PAIRS = listOf(
        "lineHeight" to listOf("__lineHeightRatio"),
        "letterSpacing" to listOf("__letterSpacingEm"),
        "boxShadow" to listOf("__shadow", "__shadowColor", "__ringWidth", "__ringColor"),
        "backgroundImage" to listOf("__gradDir", "__gradFrom", "__gradVia", "__gradTo"),
    )

    internal fun merge(into: LinkedHashMap<String, Any?>, s: Map<String, Any?>): LinkedHashMap<String, Any?> {
        for ((final, parts) in PAIRS) {
            if (s.containsKey(final)) parts.forEach { into.remove(it) }
            else if (parts.any { s.containsKey(it) }) into.remove(final)
        }
        into.putAll(s)
        return into
    }

    private fun round(n: Double): Double = XPStd.round(n * 100) / 100

    internal fun finish(s: Map<String, Any?>, env: XPEnv?, fontSizeCtx: Double? = null): LinkedHashMap<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        for ((k, v) in s) if (!k.startsWith("__")) out[k] = v
        val fontSize = out["fontSize"] as? Double ?: fontSizeCtx?.takeIf { it != 0.0 } ?: 16.0
        (s["__lineHeightRatio"] as? Double)?.let { if (out["lineHeight"] == null) out["lineHeight"] = round(fontSize * it) }
        (s["__letterSpacingEm"] as? Double)?.let { if (out["letterSpacing"] == null) out["letterSpacing"] = round(fontSize * it) }
        if (out["boxShadow"] == null && (s.containsKey("__shadow") || s.containsKey("__ringWidth"))) {
            val layers = ArrayList<String>()
            val ring = s["__ringWidth"]
            if (XPStd.truthy(ring)) layers.add("0px 0px 0px ${XPStd.str(ring)}px ${s["__ringColor"] ?: out["color"] ?: "#000000"}")
            for (l in (s["__shadow"] as? List<*>) ?: emptyList<Any?>()) {
                l as Map<*, *>
                layers.add("${XPStd.str(l["x"])}px ${XPStd.str(l["y"])}px ${XPStd.str(l["blur"])}px ${XPStd.str(l["spread"])}px ${s["__shadowColor"] ?: l["color"]}")
            }
            out["boxShadow"] = if (layers.isEmpty()) "none" else layers.joinToString(", ")
        }
        if (out["backgroundImage"] == null && XPStd.truthy(s["__gradDir"])) {
            val none = "#00000000"
            val stops = ArrayList<String>()
            stops.add(s["__gradFrom"] as? String ?: none)
            (s["__gradVia"] as? String)?.let { stops.add(it) }
            stops.add(s["__gradTo"] as? String ?: none)
            out["backgroundImage"] = "linear-gradient(${s["__gradDir"]}, ${stops.joinToString(", ")})"
        }
        if (env != null) {
            for (k in out.keys.toList()) {
                val v = out[k] as? String ?: continue
                val m = Regex("^(-?[\\d.]+)(vh|vw)$").find(v) ?: continue
                out[k] = round(m.groupValues[1].toDouble() / 100 * (if (m.groupValues[2] == "vh") env.height else env.width))
            }
        }
        return out
    }

    private fun family(k: String): String = Regex("^(padding|margin|border.*Width|border.*Radius|inset|top|right|bottom|left)").find(k)?.groupValues?.get(1) ?: k

    /** Props elemen + className → props dengan style (dan pressedStyle/hoverStyle/focusStyle). */
    @Suppress("UNCHECKED_CAST")
    fun props(t: Table, h: XPHooks, props: Map<String, Any?>, className: String?): Map<String, Any?> {
        if (className == null) return props
        val env = h.env
        h.rt.registerBreakpoints(t.breakpoints, t.viewport)
        val r = resolve(t, env, className)
        val user = props["style"] as? Map<String, Any?>
        val raw = merge(LinkedHashMap(), r.style)
        if (XPStd.truthy(props["disabled"])) r.states["disabled"]?.let { merge(raw, it) }
        if (user != null) merge(raw, user)
        val style = finish(raw, env)
        val out = LinkedHashMap(props)
        if (style.isNotEmpty()) out["style"] = style
        val userKeys = user?.keys?.map { family(it) } ?: emptyList()
        for (st in listOf("pressed", "hover", "focus")) {
            val extra = r.states[st] ?: continue
            val whole = finish(merge(merge(LinkedHashMap(), raw), extra), env, style["fontSize"] as? Double)
            val own = LinkedHashMap<String, Any?>()
            for ((k, v) in whole) if (v != style[k] && family(k) !in userKeys) own[k] = v
            if (own.isEmpty()) continue
            val prop = "${st}Style"
            val existing = out[prop] as? Map<String, Any?>
            out[prop] = if (existing != null) LinkedHashMap(own).apply { putAll(existing) } else own
        }
        return out
    }
}
