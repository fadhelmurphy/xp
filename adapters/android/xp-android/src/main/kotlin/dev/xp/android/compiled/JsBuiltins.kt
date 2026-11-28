package dev.xp.android.compiled

import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor

/**
 * Method bawaan JS (String, Array, Number, RegExp, Set, Map) dan objek global (Math, Object,
 * Array, JSON, ...) untuk komponen yang dikompilasi ke Kotlin. Yang tidak ada di sini juga
 * ditolak compiler saat build kalau bisa dideteksi, jadi tidak gagal diam-diam di device.
 */
object JsBuiltins {
    private val STRING_METHODS = setOf(
        "replace", "replaceAll", "split", "toUpperCase", "toLowerCase", "trim", "trimStart", "trimEnd",
        "includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "slice", "substring", "charAt",
        "charCodeAt", "padStart", "padEnd", "repeat", "concat", "at", "match", "toString", "localeCompare",
        "toLocaleUpperCase", "toLocaleLowerCase", "normalize", "search",
    )
    private val ARRAY_METHODS = setOf(
        "map", "filter", "forEach", "reduce", "reduceRight", "find", "findIndex", "findLast", "findLastIndex",
        "some", "every", "includes", "indexOf", "lastIndexOf", "join", "slice", "concat", "push", "pop", "shift",
        "unshift", "splice", "reverse", "sort", "flat", "flatMap", "at", "fill", "keys", "values", "entries",
        "toString", "toSorted", "toReversed",
    )
    private val NUMBER_METHODS = setOf("toFixed", "toString", "toPrecision", "valueOf")

    fun hasMethod(obj: Any, name: String): Boolean = when (obj) {
        is String -> name in STRING_METHODS
        is List<*> -> name in ARRAY_METHODS
        is Double -> name in NUMBER_METHODS
        is JsRegExp -> name == "test" || name == "exec"
        is JsSet -> name in setOf("has", "add", "delete", "clear", "forEach", "values", "size")
        is JsMap -> name in setOf("has", "get", "set", "delete", "clear", "forEach", "keys", "values", "entries")
        is Map<*, *> -> name == "hasOwnProperty"
        is JsFunction -> name in setOf("call", "apply", "bind")
        is JsDate -> name in setOf("getTime", "valueOf", "toISOString")
        else -> false
    }

    fun callMethod(obj: Any, name: String, a: List<Any?>): Any? = when (obj) {
        is String -> string(obj, name, a)
        is List<*> -> array(obj, name, a)
        is Double -> number(obj, name, a)
        is JsRegExp -> regexp(obj, name, a)
        is JsSet -> set(obj, name, a)
        is JsMap -> map(obj, name, a)
        is Map<*, *> -> if (name == "hasOwnProperty") obj.containsKey(Js.key(a.getOrNull(0))) else unknown(obj, name)
        is JsDate -> when (name) {
            "getTime", "valueOf" -> obj.ms
            "toISOString" -> java.time.Instant.ofEpochMilli(obj.ms.toLong()).toString()
            else -> unknown(obj, name)
        }
        is JsFunction -> when (name) {
            "call" -> obj.impl(a.drop(1))
            "apply" -> obj.impl((a.getOrNull(1) as? List<*>)?.toList() ?: emptyList())
            "bind" -> JsFunction(obj.name) { more -> obj.impl(a.drop(1) + more) }
            else -> unknown(obj, name)
        }
        else -> unknown(obj, name)
    }

    private fun unknown(obj: Any, name: String): Nothing =
        throw JsError("TypeError: ${Js.typeOf(obj)}.$name bukan function")

    private fun arg(a: List<Any?>, i: Int) = a.getOrNull(i)
    private fun fn(a: List<Any?>, i: Int) = a.getOrNull(i) as? JsFunction ?: throw JsError("TypeError: argumen ${i + 1} harus function")
    private fun idx(v: Any?, len: Int, default: Int): Int {
        if (v == null) return default
        val n = Js.toNum(v).let { if (it.isNaN()) 0.0 else it }
        val i = if (n.isInfinite()) (if (n > 0) len else -len) else n.toLong().toInt()
        return if (i < 0) maxOf(0, len + i) else minOf(i, len)
    }

    // --- String ---

    private fun string(s: String, name: String, a: List<Any?>): Any? = when (name) {
        "toUpperCase", "toLocaleUpperCase" -> s.uppercase(Locale.ROOT)
        "toLowerCase", "toLocaleLowerCase" -> s.lowercase(Locale.ROOT)
        "trim" -> s.trim()
        "trimStart" -> s.trimStart()
        "trimEnd" -> s.trimEnd()
        "toString", "normalize" -> s
        "includes" -> s.contains(Js.toStr(arg(a, 0)))
        "startsWith" -> s.startsWith(Js.toStr(arg(a, 0)), idx(arg(a, 1), s.length, 0))
        "endsWith" -> s.substring(0, idx(arg(a, 1), s.length, s.length)).endsWith(Js.toStr(arg(a, 0)))
        "indexOf" -> s.indexOf(Js.toStr(arg(a, 0)), idx(arg(a, 1), s.length, 0)).toDouble()
        "lastIndexOf" -> s.lastIndexOf(Js.toStr(arg(a, 0))).toDouble()
        "search" -> (arg(a, 0) as? JsRegExp)?.regex?.find(s)?.range?.first?.toDouble() ?: -1.0
        "slice" -> {
            val from = idx(arg(a, 0), s.length, 0)
            val to = idx(arg(a, 1), s.length, s.length)
            if (from < to) s.substring(from, to) else ""
        }
        "substring" -> {
            fun c(v: Any?, d: Int) = if (v == null) d else Js.toNum(v).let { if (it.isNaN()) 0 else it.toInt().coerceIn(0, s.length) }
            val x = c(arg(a, 0), 0)
            val y = c(arg(a, 1), s.length)
            s.substring(minOf(x, y), maxOf(x, y))
        }
        "charAt" -> s.getOrNull(Js.toNum(arg(a, 0) ?: 0.0).toInt())?.toString() ?: ""
        "charCodeAt" -> s.getOrNull(Js.toNum(arg(a, 0) ?: 0.0).toInt())?.code?.toDouble() ?: Double.NaN
        "at" -> Js.toNum(arg(a, 0)).toInt().let { i -> s.getOrNull(if (i < 0) s.length + i else i)?.toString() }
        "padStart" -> pad(s, a, start = true)
        "padEnd" -> pad(s, a, start = false)
        "repeat" -> s.repeat(Js.toNum(arg(a, 0)).toInt().coerceAtLeast(0))
        "concat" -> s + a.joinToString("") { Js.toStr(it) }
        "localeCompare" -> s.compareTo(Js.toStr(arg(a, 0))).coerceIn(-1, 1).toDouble()
        "split" -> split(s, a)
        "replace" -> replace(s, arg(a, 0), arg(a, 1), all = false)
        "replaceAll" -> replace(s, arg(a, 0), arg(a, 1), all = true)
        "match" -> match(s, arg(a, 0))
        else -> unknown(s, name)
    }

    private fun pad(s: String, a: List<Any?>, start: Boolean): String {
        val len = Js.toNum(arg(a, 0)).toInt()
        val fill = arg(a, 1)?.let { Js.toStr(it) } ?: " "
        if (len <= s.length || fill.isEmpty()) return s
        val need = len - s.length
        val padding = fill.repeat(need / fill.length + 1).substring(0, need)
        return if (start) padding + s else s + padding
    }

    private fun split(s: String, a: List<Any?>): JsArray {
        val sep = arg(a, 0)
        val limit = arg(a, 1)?.let { Js.toNum(it).toInt() } ?: Int.MAX_VALUE
        val parts: List<String> = when (sep) {
            null -> listOf(s)
            is JsRegExp -> if (s.isEmpty()) listOf("") else s.split(sep.regex)
            else -> {
                val t = Js.toStr(sep)
                if (t.isEmpty()) s.map { it.toString() } else s.split(t)
            }
        }
        return JsArray(parts.take(limit))
    }

    private fun replace(s: String, pattern: Any?, with: Any?, all: Boolean): String {
        val f = with as? JsFunction
        if (pattern is JsRegExp) {
            val global = all || pattern.global
            val transform: (MatchResult) -> String = { m ->
                if (f != null) {
                    val args = JsArray()
                    args.add(m.value)
                    for (g in 1 until m.groupValues.size) args.add(m.groups[g]?.value)
                    args.add(m.range.first.toDouble())
                    args.add(s)
                    Js.toStr(f.impl(args))
                } else {
                    expand(Js.toStr(with), m, s)
                }
            }
            return if (global) pattern.regex.replace(s, transform)
            else pattern.regex.find(s)?.let { m -> s.replaceRange(m.range, transform(m)) } ?: s
        }
        val needle = Js.toStr(pattern)
        val replacement: (Int) -> String = { at ->
            if (f != null) Js.toStr(f.impl(listOf(needle, at.toDouble(), s))) else Js.toStr(with).replace("$&", needle)
        }
        if (!all) {
            val at = s.indexOf(needle)
            return if (at < 0) s else s.substring(0, at) + replacement(at) + s.substring(at + needle.length)
        }
        if (needle.isEmpty()) return s
        val sb = StringBuilder()
        var from = 0
        while (true) {
            val at = s.indexOf(needle, from)
            if (at < 0) break
            sb.append(s, from, at).append(replacement(at))
            from = at + needle.length
        }
        return sb.append(s.substring(from)).toString()
    }

    // $1, $&, $$, $<name>
    private fun expand(template: String, m: MatchResult, input: String): String {
        val sb = StringBuilder()
        var i = 0
        while (i < template.length) {
            val c = template[i]
            if (c != '$' || i + 1 >= template.length) {
                sb.append(c)
                i++
                continue
            }
            val n = template[i + 1]
            when {
                n == '$' -> { sb.append('$'); i += 2 }
                n == '&' -> { sb.append(m.value); i += 2 }
                n == '`' -> { sb.append(input, 0, m.range.first); i += 2 }
                n == '\'' -> { sb.append(input.substring(m.range.last + 1)); i += 2 }
                n.isDigit() -> {
                    var j = i + 1
                    while (j < template.length && j < i + 3 && template[j].isDigit()) j++
                    var g = template.substring(i + 1, j).toInt()
                    if (g >= m.groupValues.size && j - i > 2) { j--; g /= 10 }
                    if (g in 1 until m.groupValues.size) sb.append(m.groups[g]?.value ?: "") else sb.append(template, i, j)
                    i = j
                }
                else -> { sb.append(c); i++ }
            }
        }
        return sb.toString()
    }

    private fun match(s: String, pattern: Any?): Any? {
        val re = pattern as? JsRegExp ?: Js.regex(Regex.escape(Js.toStr(pattern)), "")
        if (re.global) return re.regex.findAll(s).map { it.value }.toList().takeIf { it.isNotEmpty() }?.let { JsArray(it) }
        val m = re.regex.find(s) ?: return null
        return execResult(m, s)
    }

    private fun execResult(m: MatchResult, s: String): JsArray = JsArray().apply {
        add(m.value)
        for (g in 1 until m.groupValues.size) add(m.groups[g]?.value)
    }

    // --- RegExp ---

    private fun regexp(re: JsRegExp, name: String, a: List<Any?>): Any? = when (name) {
        "test" -> re.regex.containsMatchIn(Js.toStr(arg(a, 0)))
        "exec" -> Js.toStr(arg(a, 0)).let { s -> re.regex.find(s)?.let { execResult(it, s) } }
        else -> unknown(re, name)
    }

    // --- Number ---

    private fun number(d: Double, name: String, a: List<Any?>): Any? = when (name) {
        "toFixed" -> {
            val digits = Js.toNum(arg(a, 0) ?: 0.0).toInt()
            if (abs(d) >= 1e21) Js.numStr(d)
            else java.math.BigDecimal(d).setScale(digits, java.math.RoundingMode.HALF_UP).toPlainString()
        }
        "toPrecision" -> if (arg(a, 0) == null) Js.numStr(d)
            else java.math.BigDecimal(d).round(java.math.MathContext(Js.toNum(arg(a, 0)).toInt())).toPlainString()
        "toString" -> arg(a, 0)?.let { r ->
            val radix = Js.toNum(r).toInt()
            if (radix == 10 || d != floor(d)) Js.numStr(d) else d.toLong().toString(radix)
        } ?: Js.numStr(d)
        "valueOf" -> d
        else -> unknown(d, name)
    }

    // --- Array ---

    private fun cb(f: JsFunction, v: Any?, i: Int, list: List<*>) = f.impl(listOf(v, i.toDouble(), list))

    @Suppress("UNCHECKED_CAST")
    private fun array(list: List<*>, name: String, a: List<Any?>): Any? {
        val m = list as? JsArray
        return when (name) {
            "map" -> fn(a, 0).let { f -> JsArray(list.size).apply { list.forEachIndexed { i, v -> add(cb(f, v, i, list)) } } }
            "filter" -> fn(a, 0).let { f -> JsArray().apply { list.forEachIndexed { i, v -> if (Js.truthy(cb(f, v, i, list))) add(v) } } }
            "forEach" -> { fn(a, 0).let { f -> list.forEachIndexed { i, v -> cb(f, v, i, list) } }; null }
            "find" -> fn(a, 0).let { f -> list.withIndex().firstOrNull { (i, v) -> Js.truthy(cb(f, v, i, list)) }?.value }
            "findIndex" -> fn(a, 0).let { f -> list.withIndex().firstOrNull { (i, v) -> Js.truthy(cb(f, v, i, list)) }?.index?.toDouble() ?: -1.0 }
            "findLast" -> fn(a, 0).let { f -> list.withIndex().lastOrNull { (i, v) -> Js.truthy(cb(f, v, i, list)) }?.value }
            "findLastIndex" -> fn(a, 0).let { f -> list.withIndex().lastOrNull { (i, v) -> Js.truthy(cb(f, v, i, list)) }?.index?.toDouble() ?: -1.0 }
            "some" -> fn(a, 0).let { f -> list.withIndex().any { (i, v) -> Js.truthy(cb(f, v, i, list)) } }
            "every" -> fn(a, 0).let { f -> list.withIndex().all { (i, v) -> Js.truthy(cb(f, v, i, list)) } }
            "reduce", "reduceRight" -> {
                val f = fn(a, 0)
                val order = if (name == "reduce") list.indices else list.indices.reversed()
                val it = order.iterator()
                var acc: Any? = if (a.size > 1) a[1] else if (it.hasNext()) list[it.next()] else throw JsError("TypeError: reduce pada array kosong tanpa nilai awal")
                while (it.hasNext()) {
                    val i = it.next()
                    acc = f.impl(listOf(acc, list[i], i.toDouble(), list))
                }
                acc
            }
            "includes" -> arg(a, 0).let { x -> list.any { Js.same(it, x) || (it == null && x == null) || Js.seq(it, x) } }
            "indexOf" -> arg(a, 0).let { x -> list.indexOfFirst { Js.seq(it, x) }.toDouble() }
            "lastIndexOf" -> arg(a, 0).let { x -> list.indexOfLast { Js.seq(it, x) }.toDouble() }
            "join" -> list.joinToString(arg(a, 0)?.let { Js.toStr(it) } ?: ",") { if (it == null) "" else Js.toStr(it) }
            "toString" -> Js.toStr(list)
            "slice" -> {
                val from = idx(arg(a, 0), list.size, 0)
                val to = idx(arg(a, 1), list.size, list.size)
                JsArray(if (from < to) list.subList(from, to) else emptyList())
            }
            "concat" -> JsArray(list).apply { for (x in a) if (x is List<*>) addAll(x) else add(x) }
            "at" -> Js.toNum(arg(a, 0)).toInt().let { i -> list.getOrNull(if (i < 0) list.size + i else i) }
            "flat" -> flat(list, (arg(a, 0)?.let { Js.toNum(it).toInt() } ?: 1))
            "flatMap" -> fn(a, 0).let { f -> JsArray().apply { list.forEachIndexed { i, v -> val r = cb(f, v, i, list); if (r is List<*>) addAll(r) else add(r) } } }
            "keys" -> JsArray(list.indices.map { it.toDouble() })
            "values" -> JsArray(list)
            "entries" -> JsArray(list.mapIndexed { i, v -> JsArray(listOf(i.toDouble(), v)) })
            "toSorted" -> JsArray(list).also { sortInPlace(it, arg(a, 0) as? JsFunction) }
            "toReversed" -> JsArray(list.reversed())
            // yang mengubah array
            "push" -> mut(m, name).let { arr -> arr.addAll(a); arr.size.toDouble() }
            "pop" -> mut(m, name).let { arr -> if (arr.isEmpty()) null else arr.removeAt(arr.size - 1) }
            "shift" -> mut(m, name).let { arr -> if (arr.isEmpty()) null else arr.removeAt(0) }
            "unshift" -> mut(m, name).let { arr -> arr.addAll(0, a); arr.size.toDouble() }
            "reverse" -> mut(m, name).also { it.reverse() }
            "sort" -> mut(m, name).also { sortInPlace(it, arg(a, 0) as? JsFunction) }
            "fill" -> mut(m, name).also { arr ->
                val from = idx(arg(a, 1), arr.size, 0)
                val to = idx(arg(a, 2), arr.size, arr.size)
                for (i in from until to) arr[i] = arg(a, 0)
            }
            "splice" -> mut(m, name).let { arr ->
                val start = idx(arg(a, 0), arr.size, 0)
                val count = if (a.size < 2) arr.size - start else Js.toNum(arg(a, 1)).toInt().coerceIn(0, arr.size - start)
                val removed = JsArray(arr.subList(start, start + count))
                repeat(count) { arr.removeAt(start) }
                arr.addAll(start, a.drop(2))
                removed
            }
            else -> unknown(list, name)
        }
    }

    private fun mut(m: JsArray?, name: String): JsArray = m ?: throw JsError("TypeError: array ini tidak bisa diubah ($name)")

    private fun flat(list: List<*>, depth: Int): JsArray = JsArray().apply {
        for (x in list) if (x is List<*> && depth > 0) addAll(flat(x, depth - 1)) else add(x)
    }

    private fun sortInPlace(arr: JsArray, cmp: JsFunction?) {
        val c: Comparator<Any?> = if (cmp != null) {
            Comparator { x, y ->
                when {
                    x == null && y == null -> 0
                    x == null -> 1
                    y == null -> -1
                    else -> Js.toNum(cmp.impl(listOf(x, y))).let { if (it.isNaN()) 0 else it.compareTo(0.0) }
                }
            }
        } else {
            Comparator { x, y ->
                when {
                    x == null && y == null -> 0
                    x == null -> 1
                    y == null -> -1
                    else -> Js.toStr(x).compareTo(Js.toStr(y))
                }
            }
        }
        arr.sortWith(c) // stabil, sama seperti JS
    }

    // --- Set / Map ---

    private fun set(s: JsSet, name: String, a: List<Any?>): Any? = when (name) {
        "has" -> s.items.contains(JsKey.of(arg(a, 0)))
        "add" -> s.also { it.items.add(JsKey.of(arg(a, 0))) }
        "delete" -> s.items.remove(JsKey.of(arg(a, 0)))
        "clear" -> { s.items.clear(); null }
        "values" -> JsArray(s.items.map { JsKey.unwrap(it) })
        "forEach" -> { fn(a, 0).let { f -> s.items.toList().forEach { v -> f.impl(listOf(JsKey.unwrap(v), JsKey.unwrap(v), s)) } }; null }
        else -> unknown(s, name)
    }

    private fun map(m: JsMap, name: String, a: List<Any?>): Any? = when (name) {
        "has" -> m.entries.containsKey(JsKey.of(arg(a, 0)))
        "get" -> m.entries[JsKey.of(arg(a, 0))]
        "set" -> m.also { it.entries[JsKey.of(arg(a, 0))] = arg(a, 1) }
        "delete" -> m.entries.remove(JsKey.of(arg(a, 0))) != null
        "clear" -> { m.entries.clear(); null }
        "keys" -> JsArray(m.entries.keys.map { JsKey.unwrap(it) })
        "values" -> JsArray(m.entries.values)
        "entries" -> JsArray(m.entries.map { (k, v) -> JsArray(listOf(JsKey.unwrap(k), v)) })
        "forEach" -> { fn(a, 0).let { f -> m.entries.toList().forEach { (k, v) -> f.impl(listOf(v, JsKey.unwrap(k), m)) } }; null }
        else -> unknown(m, name)
    }

    // --- objek global ---

    private fun f(name: String, impl: (List<Any?>) -> Any?) = JsFunction(name, null, impl)

    private fun num(a: List<Any?>, i: Int) = Js.toNum(a.getOrNull(i))

    val Math: JsObject = Js.obj {
        this["PI"] = kotlin.math.PI
        this["E"] = kotlin.math.E
        this["round"] = f("round") { a -> num(a, 0).let { if (it.isNaN() || it.isInfinite()) it else floor(it + 0.5) } }
        this["floor"] = f("floor") { a -> floor(num(a, 0)) }
        this["ceil"] = f("ceil") { a -> kotlin.math.ceil(num(a, 0)) }
        this["trunc"] = f("trunc") { a -> kotlin.math.truncate(num(a, 0)) }
        this["abs"] = f("abs") { a -> abs(num(a, 0)) }
        this["sign"] = f("sign") { a -> kotlin.math.sign(num(a, 0)) }
        this["sqrt"] = f("sqrt") { a -> kotlin.math.sqrt(num(a, 0)) }
        this["cbrt"] = f("cbrt") { a -> kotlin.math.cbrt(num(a, 0)) }
        this["pow"] = f("pow") { a -> java.lang.Math.pow(num(a, 0), num(a, 1)) }
        this["exp"] = f("exp") { a -> kotlin.math.exp(num(a, 0)) }
        this["log"] = f("log") { a -> kotlin.math.ln(num(a, 0)) }
        this["log10"] = f("log10") { a -> kotlin.math.log10(num(a, 0)) }
        this["log2"] = f("log2") { a -> kotlin.math.log2(num(a, 0)) }
        this["sin"] = f("sin") { a -> kotlin.math.sin(num(a, 0)) }
        this["cos"] = f("cos") { a -> kotlin.math.cos(num(a, 0)) }
        this["tan"] = f("tan") { a -> kotlin.math.tan(num(a, 0)) }
        this["atan"] = f("atan") { a -> kotlin.math.atan(num(a, 0)) }
        this["atan2"] = f("atan2") { a -> kotlin.math.atan2(num(a, 0), num(a, 1)) }
        this["hypot"] = f("hypot") { a -> kotlin.math.sqrt(a.sumOf { Js.toNum(it).let { x -> x * x } }) }
        this["min"] = f("min") { a -> if (a.isEmpty()) Double.POSITIVE_INFINITY else a.map { Js.toNum(it) }.let { xs -> if (xs.any { it.isNaN() }) Double.NaN else xs.min() } }
        this["max"] = f("max") { a -> if (a.isEmpty()) Double.NEGATIVE_INFINITY else a.map { Js.toNum(it) }.let { xs -> if (xs.any { it.isNaN() }) Double.NaN else xs.max() } }
        this["random"] = f("random") { _ -> kotlin.random.Random.nextDouble() }
    }

    val Object: JsObject = Js.obj {
        this["keys"] = f("keys") { a -> JsArray(Js.keys(a.getOrNull(0))) }
        this["values"] = f("values") { a ->
            when (val o = a.getOrNull(0)) {
                is Map<*, *> -> JsArray(o.values)
                is List<*> -> JsArray(o)
                else -> JsArray()
            }
        }
        this["entries"] = f("entries") { a ->
            when (val o = a.getOrNull(0)) {
                is Map<*, *> -> JsArray(o.map { (k, v) -> JsArray(listOf(k.toString(), v)) })
                is List<*> -> JsArray(o.mapIndexed { i, v -> JsArray(listOf(i.toString(), v)) })
                else -> JsArray()
            }
        }
        this["fromEntries"] = f("fromEntries") { a ->
            JsObject().apply { for (e in Js.iter(a.getOrNull(0))) if (e is List<*>) this[Js.key(e.getOrNull(0))] = e.getOrNull(1) }
        }
        this["assign"] = f("assign") { a ->
            val target = a.getOrNull(0) as? JsObject ?: throw JsError("TypeError: Object.assign butuh object")
            for (src in a.drop(1)) Js.spreadInto(target, src)
            target
        }
        this["freeze"] = f("freeze") { a -> a.getOrNull(0) }
        this["is"] = f("is") { a -> Js.same(a.getOrNull(0), a.getOrNull(1)) }
    }

    val Array: JsFunction = JsFunction(
        "Array",
        Js.obj {
            this["isArray"] = f("isArray") { a -> a.getOrNull(0) is List<*> }
            this["of"] = f("of") { a -> JsArray(a) }
            this["from"] = f("from") { a ->
                val src = a.getOrNull(0)
                val mapFn = a.getOrNull(1) as? JsFunction
                val items: List<Any?> = when {
                    src is Map<*, *> && src.containsKey("length") -> List(Js.toNum(src["length"]).toInt()) { null }
                    else -> Js.iter(src)
                }
                JsArray(if (mapFn == null) items else items.mapIndexed { i, v -> mapFn.impl(listOf(v, i.toDouble())) })
            }
        },
    ) { a -> newArray(a) }

    /** `Array(3)` / `new Array(3)` → 3 slot kosong; `Array(a, b)` → [a, b]. */
    private fun newArray(a: List<Any?>): JsArray =
        if (a.size == 1 && a[0] is Double) JsArray(List(Js.toNum(a[0]).toInt()) { null }) else JsArray(a)

    val JSON: JsObject = Js.obj {
        this["stringify"] = f("stringify") { a -> a.getOrNull(0)?.let { jsonStringify(it) } }
        this["parse"] = f("parse") { a ->
            try {
                Js.fromHost(dev.xp.android.XPJson.parse(Js.toStr(a.getOrNull(0))))
            } catch (e: IllegalArgumentException) {
                throw JsError(JsObject().apply { this["name"] = "SyntaxError"; this["message"] = e.message ?: "JSON tidak valid" })
            }
        }
    }

    private fun jsonStringify(v: Any?): String = when (v) {
        is JsFunction -> "null"
        is Double -> if (v.isFinite()) Js.numStr(v) else "null"
        is Map<*, *> -> v.entries.filter { it.value !is JsFunction && it.value != null }
            .joinToString(",", "{", "}") { (k, x) -> dev.xp.android.XPJson.quote(k.toString()) + ":" + jsonStringify(x) }
        is List<*> -> v.joinToString(",", "[", "]") { jsonStringify(it) }
        else -> dev.xp.android.XPJson.stringify(v)
    }

    private val NumberStatics: JsObject = Js.obj {
        this["isInteger"] = f("isInteger") { a -> (a.getOrNull(0) as? Double)?.let { it.isFinite() && it == floor(it) } ?: false }
        this["isFinite"] = f("isFinite") { a -> (a.getOrNull(0) as? Double)?.isFinite() ?: false }
        this["isNaN"] = f("isNaN") { a -> (a.getOrNull(0) as? Double)?.isNaN() ?: false }
        this["parseFloat"] = f("parseFloat") { a -> parseFloat(a.getOrNull(0)) }
        this["parseInt"] = f("parseInt") { a -> parseInt(a.getOrNull(0), a.getOrNull(1)) }
        this["MAX_SAFE_INTEGER"] = 9007199254740991.0
        this["MIN_SAFE_INTEGER"] = -9007199254740991.0
        this["EPSILON"] = java.lang.Math.ulp(1.0)
    }

    val Number: JsFunction = JsFunction("Number", NumberStatics) { a -> if (a.isEmpty()) 0.0 else Js.toNum(a[0]) }

    fun parseFloat(v: Any?): Double {
        val s = Js.toStr(v).trimStart()
        val m = Regex("^[+-]?(Infinity|\\d+\\.?\\d*([eE][+-]?\\d+)?|\\.\\d+([eE][+-]?\\d+)?)").find(s) ?: return Double.NaN
        return if (m.groupValues[1] == "Infinity") (if (s.startsWith("-")) Double.NEGATIVE_INFINITY else Double.POSITIVE_INFINITY) else m.value.toDouble()
    }

    fun parseInt(v: Any?, radixArg: Any?): Double {
        var s = Js.toStr(v).trim()
        var neg = false
        if (s.startsWith("-") || s.startsWith("+")) { neg = s[0] == '-'; s = s.substring(1) }
        var radix = radixArg?.let { Js.toNum(it).toInt() } ?: 0
        if ((radix == 0 || radix == 16) && (s.startsWith("0x") || s.startsWith("0X"))) { s = s.substring(2); radix = 16 }
        if (radix == 0) radix = 10
        val digits = s.takeWhile { Character.digit(it, radix) >= 0 }
        if (digits.isEmpty()) return Double.NaN
        val n = digits.toBigInteger(radix).toDouble()
        return if (neg) -n else n
    }

    val String: JsFunction = f("String") { a -> if (a.isEmpty()) "" else Js.toStr(a[0]) }
    val Boolean: JsFunction = f("Boolean") { a -> Js.truthy(a.getOrNull(0)) }

    val console: JsObject = Js.obj {
        for (level in listOf("log", "info", "warn", "error", "debug")) {
            this[level] = f(level) { a -> JsConsole.log(level, a.joinToString(" ") { Js.toStr(it) }); null }
        }
    }

    /** Jam untuk Date.now() dan `new Date()`; bisa diganti di tes. */
    var clock: () -> Long = { System.currentTimeMillis() }

    val Date: JsObject = Js.obj {
        this["now"] = f("now") { _ -> clock().toDouble() }
    }

    /** `new X(...)` yang didukung. */
    fun construct(ctor: Any?, a: List<Any?>): Any? = when {
        ctor === Error || ctor === TypeError -> JsObject().apply {
            this["name"] = if (ctor === TypeError) "TypeError" else "Error"
            this["message"] = a.getOrNull(0)?.let { Js.toStr(it) } ?: ""
        }
        ctor === SetCtor -> JsSet().apply { a.getOrNull(0)?.let { src -> for (x in Js.iter(src)) items.add(JsKey.of(x)) } }
        ctor === MapCtor -> JsMap().apply { a.getOrNull(0)?.let { src -> for (e in Js.iter(src)) if (e is List<*>) entries[JsKey.of(e.getOrNull(0))] = e.getOrNull(1) } }
        ctor === Array -> newArray(a)
        ctor === Date -> JsDate(a.getOrNull(0)?.let { Js.toNum(it) } ?: clock().toDouble())
        else -> throw JsError("TypeError: 'new' untuk ${Js.typeOf(ctor)} belum didukung di target native")
    }

    val Error: JsFunction = f("Error") { a -> construct(Error, a) }
    val TypeError: JsFunction = f("TypeError") { a -> construct(TypeError, a) }
    val SetCtor: JsObject = JsObject()
    val MapCtor: JsObject = JsObject()

    /** Nilai global yang boleh dipakai komponen. */
    fun global(name: String): Any? = when (name) {
        "Math" -> Math
        "Object" -> Object
        "Array" -> Array
        "JSON" -> JSON
        "Number" -> Number
        "String" -> String
        "Boolean" -> Boolean
        "console" -> console
        "Date" -> Date
        "Error" -> Error
        "TypeError" -> TypeError
        "Set" -> SetCtor
        "Map" -> MapCtor
        "NaN" -> Double.NaN
        "Infinity" -> Double.POSITIVE_INFINITY
        "parseInt" -> f("parseInt") { a -> parseInt(a.getOrNull(0), a.getOrNull(1)) }
        "parseFloat" -> f("parseFloat") { a -> parseFloat(a.getOrNull(0)) }
        "isNaN" -> f("isNaN") { a -> Js.toNum(a.getOrNull(0)).isNaN() }
        "isFinite" -> f("isFinite") { a -> Js.toNum(a.getOrNull(0)).isFinite() }
        else -> throw JsError("ReferenceError: $name tidak tersedia di target native")
    }

}

/** `new Date(ms)`: hanya getTime/valueOf/toISOString. */
class JsDate(val ms: Double)

/** Kunci Set/Map: angka & string dibandingkan isinya, object dibandingkan identitasnya. */
class JsKey private constructor(val value: Any?) {
    override fun equals(other: Any?): Boolean = other is JsKey && Js.same(value, other.value)
    override fun hashCode(): Int = when (value) {
        null -> 0
        is Double, is String, is Boolean -> value.hashCode()
        else -> System.identityHashCode(value)
    }

    companion object {
        fun of(v: Any?): Any? = if (v == null || v is Double || v is String || v is Boolean) v else JsKey(v)
        fun unwrap(k: Any?): Any? = if (k is JsKey) k.value else k
    }
}

object JsConsole {
    /** Diganti SDK Android dengan android.util.Log; di JVM (tes) ke stdout. */
    var sink: (level: String, message: String) -> Unit = { level, message -> println("[xp:$level] $message") }

    fun log(level: String, message: String) = sink(level, message)
}
