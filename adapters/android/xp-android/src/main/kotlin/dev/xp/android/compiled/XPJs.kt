package dev.xp.android.compiled

import java.math.BigDecimal
import kotlin.math.abs
import kotlin.math.floor

/**
 * Nilai JavaScript di Kotlin, untuk komponen xp yang dikompilasi ke Kotlin (`xp build`).
 *
 * Representasi (sama dengan hasil JSON, jadi bisa langsung dipakai renderer Compose):
 *   undefined / null → null       number → Double      string → String     boolean → Boolean
 *   object → JsObject (LinkedHashMap)    array → JsArray (ArrayList)    function → JsFunction
 *
 * undefined dan null sama-sama `null`: parameter default juga dipakai saat nilainya null.
 */
typealias JsObject = LinkedHashMap<String, Any?>
typealias JsArray = ArrayList<Any?>

/** Function JS. `statics`: properti function itu sendiri (mis. Array.isArray, Number.isInteger). */
class JsFunction(val name: String = "", val statics: Map<String, Any?>? = null, val impl: (List<Any?>) -> Any?) {
    operator fun invoke(vararg args: Any?): Any? = impl(args.asList())
    override fun toString() = "function $name() { [native code] }"
}

/** Error yang dilempar kode komponen (`throw`). */
class JsError(val value: Any?) : RuntimeException(Js.errorMessage(value))

class JsRegExp(val source: String, val flags: String) {
    val global = 'g' in flags
    val regex: Regex = Regex(
        source,
        buildSet {
            if ('i' in flags) add(RegexOption.IGNORE_CASE)
            if ('m' in flags) add(RegexOption.MULTILINE)
            if ('s' in flags) add(RegexOption.DOT_MATCHES_ALL)
        },
    )
    override fun toString() = "/$source/$flags"
}

@Suppress("NOTHING_TO_INLINE", "MemberVisibilityCanBePrivate")
object Js {
    // --- konversi ---

    fun truthy(v: Any?): Boolean = when (v) {
        null -> false
        is Boolean -> v
        is Double -> !(v == 0.0 || v.isNaN())
        is Number -> v.toDouble().let { !(it == 0.0 || it.isNaN()) }
        is String -> v.isNotEmpty()
        else -> true
    }

    fun toNum(v: Any?): Double = when (v) {
        is Double -> v
        is Number -> v.toDouble()
        null -> Double.NaN
        is Boolean -> if (v) 1.0 else 0.0
        is String -> v.trim().let { s ->
            when {
                s.isEmpty() -> 0.0
                s.startsWith("0x") || s.startsWith("0X") -> s.drop(2).toLongOrNull(16)?.toDouble() ?: Double.NaN
                s == "Infinity" || s == "+Infinity" -> Double.POSITIVE_INFINITY
                s == "-Infinity" -> Double.NEGATIVE_INFINITY
                else -> s.toDoubleOrNull()?.takeIf { s.last().isDigit() || s.last() == '.' } ?: Double.NaN
            }
        }
        is List<*> -> if (v.isEmpty()) 0.0 else if (v.size == 1) toNum(v[0]) else Double.NaN
        else -> Double.NaN
    }

    fun toInt32(v: Any?): Int {
        val d = toNum(v)
        if (d.isNaN() || d.isInfinite()) return 0
        return (d.toLong() and 0xFFFFFFFFL).toInt()
    }

    fun numStr(d: Double): String {
        if (d.isNaN()) return "NaN"
        if (d.isInfinite()) return if (d > 0) "Infinity" else "-Infinity"
        if (d == 0.0) return "0"
        if (d == floor(d) && abs(d) < 1e21) return BigDecimal(d).toPlainString()
        val a = abs(d)
        if (a >= 1e-6 && a < 1e21) return BigDecimal(d.toString()).stripTrailingZeros().toPlainString()
        // eksponen seperti JS: 1e-7, 1.5e+21
        val s = d.toString() // mis. 1.0E-7
        val (m, e) = s.split('E')
        val mant = m.removeSuffix(".0")
        val exp = e.toInt()
        return mant + "e" + (if (exp >= 0) "+" else "") + exp
    }

    fun toStr(v: Any?): String = when (v) {
        null -> "undefined"
        is String -> v
        is Double -> numStr(v)
        is Number -> numStr(v.toDouble())
        is Boolean -> v.toString()
        is List<*> -> v.joinToString(",") { if (it == null) "" else toStr(it) }
        is Map<*, *> -> "[object Object]"
        else -> v.toString()
    }

    fun key(v: Any?): String = if (v is String) v else toStr(v)

    fun typeOf(v: Any?): String = when (v) {
        null -> "undefined"
        is Boolean -> "boolean"
        is Number -> "number"
        is String -> "string"
        is JsFunction -> "function"
        else -> "object"
    }

    /** Nilai dari luar (props app, argumen event dari Compose) → nilai JS (angka jadi Double). */
    fun fromHost(v: Any?): Any? = when (v) {
        null, is String, is Boolean, is Double, is JsFunction -> v
        is Number -> v.toDouble()
        is Map<*, *> -> JsObject().also { o -> for ((k, x) in v) o[k.toString()] = fromHost(x) }
        is Iterable<*> -> JsArray().also { a -> for (x in v) a.add(fromHost(x)) }
        is Array<*> -> JsArray().also { a -> for (x in v) a.add(fromHost(x)) }
        else -> v.toString()
    }

    // --- operator ---

    fun add(a: Any?, b: Any?): Any? {
        if (a is Double && b is Double) return a + b
        val pa = prim(a)
        val pb = prim(b)
        return if (pa is String || pb is String) toStr(pa) + toStr(pb) else toNum(pa) + toNum(pb)
    }

    private fun prim(v: Any?): Any? = when (v) {
        is List<*>, is Map<*, *>, is JsFunction, is JsRegExp -> toStr(v)
        else -> v
    }

    inline fun sub(a: Any?, b: Any?): Double = toNum(a) - toNum(b)
    inline fun mul(a: Any?, b: Any?): Double = toNum(a) * toNum(b)
    inline fun div(a: Any?, b: Any?): Double = toNum(a) / toNum(b)
    inline fun mod(a: Any?, b: Any?): Double = toNum(a) % toNum(b)
    fun pow(a: Any?, b: Any?): Double = Math.pow(toNum(a), toNum(b))
    inline fun neg(a: Any?): Double = -toNum(a)

    fun bitAnd(a: Any?, b: Any?): Double = (toInt32(a) and toInt32(b)).toDouble()
    fun bitOr(a: Any?, b: Any?): Double = (toInt32(a) or toInt32(b)).toDouble()
    fun bitXor(a: Any?, b: Any?): Double = (toInt32(a) xor toInt32(b)).toDouble()
    fun bitNot(a: Any?): Double = toInt32(a).inv().toDouble()
    fun shl(a: Any?, b: Any?): Double = (toInt32(a) shl (toInt32(b) and 31)).toDouble()
    fun shr(a: Any?, b: Any?): Double = (toInt32(a) shr (toInt32(b) and 31)).toDouble()
    fun ushr(a: Any?, b: Any?): Double = ((toInt32(a).toLong() and 0xFFFFFFFFL) ushr (toInt32(b) and 31)).toDouble()

    private fun cmp(a: Any?, b: Any?): Int? {
        val pa = prim(a)
        val pb = prim(b)
        if (pa is String && pb is String) return pa.compareTo(pb)
        val x = toNum(pa)
        val y = toNum(pb)
        if (x.isNaN() || y.isNaN()) return null
        return x.compareTo(y).let { if (x == y) 0 else it }
    }

    fun lt(a: Any?, b: Any?): Boolean = if (a is Double && b is Double) a < b else (cmp(a, b) ?: 1) < 0
    fun gt(a: Any?, b: Any?): Boolean = if (a is Double && b is Double) a > b else (cmp(a, b) ?: -1) > 0
    fun le(a: Any?, b: Any?): Boolean = if (a is Double && b is Double) a <= b else (cmp(a, b) ?: 1) <= 0
    fun ge(a: Any?, b: Any?): Boolean = if (a is Double && b is Double) a >= b else (cmp(a, b) ?: -1) >= 0

    /** `===` */
    fun seq(a: Any?, b: Any?): Boolean = when {
        a is Double && b is Double -> a == b && !a.isNaN()
        a is Number && b is Number -> a.toDouble() == b.toDouble()
        a is String && b is String -> a == b
        a is Boolean && b is Boolean -> a == b
        else -> a === b
    }

    /** `==` */
    fun eq(a: Any?, b: Any?): Boolean = when {
        a == null || b == null -> a == null && b == null
        a is Number && b is String || a is String && b is Number || a is Boolean || b is Boolean ->
            if (a is Boolean && b is Boolean) a == b else toNum(a) == toNum(b)
        else -> seq(a, b)
    }

    /** Object.is (dipakai hooks): NaN sama dengan NaN, +0 beda dengan -0. */
    fun same(a: Any?, b: Any?): Boolean = when {
        a is Double && b is Double -> a.equals(b)
        else -> seq(a, b)
    }

    fun hasKey(key: Any?, obj: Any?): Boolean = when (obj) {
        is Map<*, *> -> obj.containsKey(key(key))
        is List<*> -> toNum(key).let { it >= 0 && it < obj.size && it == floor(it) } || key == "length"
        else -> throw JsError("operator 'in' butuh object")
    }

    // --- properti ---

    fun get(obj: Any?, k: Any?): Any? = when (obj) {
        null -> throw JsError("TypeError: tidak bisa membaca '${toStr(k)}' dari undefined")
        else -> getOpt(obj, k)
    }

    /** Akses properti yang mengembalikan undefined kalau obj undefined (optional chaining). */
    fun getOpt(obj: Any?, k: Any?): Any? = when (obj) {
        null -> null
        is Map<*, *> -> (obj as Map<String, Any?>)[key(k)] ?: if (k == "hasOwnProperty") method(obj, "hasOwnProperty") else null
        is List<*> -> when {
            k is Double -> obj.getOrNull(k.toInt().takeIf { it.toDouble() == k } ?: -1)
            k == "length" -> obj.size.toDouble()
            k is String && k.isNotEmpty() && k.all { it.isDigit() } -> obj.getOrNull(k.toInt())
            k is String -> method(obj, k)
            else -> null
        }
        is String -> when {
            k is Double -> obj.getOrNull(k.toInt())?.toString()
            k == "length" -> obj.length.toDouble()
            k is String -> method(obj, k)
            else -> null
        }
        is JsFunction -> when {
            k == "name" -> obj.name
            k is String -> obj.statics?.get(k) ?: method(obj, k)
            else -> null
        }
        is JsRegExp -> when (k) {
            "source" -> obj.source
            "flags" -> obj.flags
            "global" -> obj.global
            else -> method(obj, key(k))
        }
        is Double -> if (k is String) method(obj, k) else null
        else -> null
    }

    fun set(obj: Any?, k: Any?, v: Any?): Any? {
        when (obj) {
            is MutableMap<*, *> -> (obj as MutableMap<String, Any?>)[key(k)] = v
            is ArrayList<*> -> {
                @Suppress("UNCHECKED_CAST")
                val obj = obj as ArrayList<Any?>
                if (k == "length") {
                    val n = toNum(v).toInt()
                    while (obj.size > n) obj.removeAt(obj.size - 1)
                    while (obj.size < n) obj.add(null)
                } else {
                    val i = toNum(k).toInt()
                    while (obj.size <= i) obj.add(null)
                    obj[i] = v
                }
            }
            null -> throw JsError("TypeError: tidak bisa mengisi '${toStr(k)}' di undefined")
            else -> throw JsError("TypeError: tidak bisa mengisi '${toStr(k)}' di ${typeOf(obj)}")
        }
        return v
    }

    fun delete(obj: Any?, k: Any?): Boolean {
        if (obj is MutableMap<*, *>) obj.remove(key(k))
        return true
    }

    /** Method bawaan sebagai nilai (mis. `arr.map` tanpa dipanggil). */
    private fun method(obj: Any, name: String): JsFunction? =
        if (JsBuiltins.hasMethod(obj, name)) JsFunction(name) { args -> JsBuiltins.callMethod(obj, name, args) } else null

    // --- pemanggilan ---

    fun call(f: Any?, args: List<Any?>): Any? =
        (f as? JsFunction ?: throw JsError("TypeError: ${typeOf(f)} bukan function")).impl(args)

    fun callOpt(f: Any?, args: List<Any?>): Any? = if (f == null) null else call(f, args)

    fun callMethod(obj: Any?, name: String, args: List<Any?>): Any? {
        if (obj == null) throw JsError("TypeError: tidak bisa memanggil '$name' pada undefined")
        if (obj is JsFunction) obj.statics?.get(name)?.let { return call(it, args) }
        if (obj is Map<*, *>) {
            val f = obj[name]
            if (f is JsFunction) return f.impl(args)
            if (f != null) throw JsError("TypeError: '$name' bukan function")
        }
        return JsBuiltins.callMethod(obj, name, args)
    }

    fun callMethodOpt(obj: Any?, name: String, args: List<Any?>): Any? =
        if (obj == null) null else callMethod(obj, name, args)

    // --- literal ---

    inline fun obj(build: JsObject.() -> Unit): JsObject = JsObject().apply(build)
    inline fun arr(build: JsArray.() -> Unit): JsArray = JsArray().apply(build)

    /** `{...x}` */
    fun spreadInto(target: JsObject, src: Any?) {
        when (src) {
            is Map<*, *> -> for ((k, v) in src) target[k.toString()] = v
            is List<*> -> src.forEachIndexed { i, v -> target[i.toString()] = v }
            is String -> src.forEachIndexed { i, c -> target[i.toString()] = c.toString() }
        }
    }

    /** `const { a, ...rest } = obj`: salinan obj tanpa kunci yang sudah diambil. */
    fun omit(src: Any?, taken: List<String>): JsObject = JsObject().also { out ->
        if (src is Map<*, *>) for ((k, v) in src) if (k.toString() !in taken) out[k.toString()] = v
    }

    /** `[...x]` dan `f(...x)` */
    fun spreadList(src: Any?): List<Any?> = when (src) {
        is List<*> -> src
        is String -> src.map { it.toString() }
        is JsSet -> src.items.toList()
        is JsMap -> src.entries.map { (k, v) -> JsArray(listOf(k, v)) }
        null -> throw JsError("TypeError: undefined tidak bisa di-spread")
        else -> throw JsError("TypeError: ${typeOf(src)} tidak bisa di-spread")
    }

    fun iter(src: Any?): List<Any?> = spreadList(src)

    /** `for (k in obj)` */
    fun keys(src: Any?): List<Any?> = when (src) {
        is Map<*, *> -> src.keys.map { it.toString() }
        is List<*> -> src.indices.map { it.toString() }
        is String -> src.indices.map { it.toString() }
        else -> emptyList()
    }

    private val regexCache = HashMap<String, JsRegExp>()

    fun regex(source: String, flags: String): JsRegExp =
        if ('g' in flags || 'y' in flags) JsRegExp(source, flags) else regexCache.getOrPut("$flags/$source") { JsRegExp(source, flags) }

    fun concat(vararg parts: Any?): String {
        val sb = StringBuilder()
        for (p in parts) sb.append(toStr(p))
        return sb.toString()
    }

    fun errorMessage(v: Any?): String = when (v) {
        is Map<*, *> -> toStr(v["message"] ?: v)
        else -> toStr(v)
    }

    /** Nilai yang ditangkap `catch (e)`. */
    fun caught(t: Throwable): Any? = when (t) {
        is JsError -> t.value
        else -> JsObject().apply {
            this["name"] = "Error"
            this["message"] = t.message ?: t.toString()
        }
    }

    fun throwValue(v: Any?): Nothing = throw JsError(v)
}

/** `new Set()` dan `new Map()` (urutan sisip dipertahankan). */
class JsSet(val items: LinkedHashSet<Any?> = LinkedHashSet())

class JsMap(val entries: LinkedHashMap<Any?, Any?> = LinkedHashMap())
