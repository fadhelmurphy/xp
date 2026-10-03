package dev.xp.android

/**
 * Parser & writer JSON minimal (tanpa dependency) untuk protokol xp.
 * Nilai: null, Boolean, Double, String, List<Any?>, Map<String, Any?>.
 */
object XPJson {
    fun parse(text: String): Any? = Parser(text).run { val v = value(); ws(); if (i != s.length) err("sisa input"); v }

    fun stringify(v: Any?): String = StringBuilder().also { write(it, v) }.toString()

    /** String Kotlin → literal string JS/JSON yang aman dimasukkan ke script. */
    fun quote(s: String): String = StringBuilder().also { writeString(it, s) }.toString()

    private fun write(sb: StringBuilder, v: Any?) {
        when (v) {
            null -> sb.append("null")
            is Boolean -> sb.append(v)
            is Int, is Long, is Short, is Byte -> sb.append(v)
            is Number -> {
                val d = v.toDouble()
                require(d.isFinite()) { "angka tidak valid untuk JSON: $d" }
                if (d == Math.rint(d) && Math.abs(d) < 1e15) sb.append(d.toLong()) else sb.append(d)
            }
            is String -> writeString(sb, v)
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, x) in v) {
                    if (!first) sb.append(',')
                    first = false
                    writeString(sb, k.toString())
                    sb.append(':')
                    write(sb, x)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                v.forEachIndexed { idx, x -> if (idx > 0) sb.append(','); write(sb, x) }
                sb.append(']')
            }
            is Array<*> -> write(sb, v.asList())
            else -> writeString(sb, v.toString())
        }
    }

    private fun writeString(sb: StringBuilder, s: String) {
        sb.append('"')
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                // U+2028/2029 sah di JSON tapi memutus string literal di JS lama.
                ' ' -> sb.append("\\u2028")
                ' ' -> sb.append("\\u2029")
                else -> if (c < ' ') sb.append(String.format("\\u%04x", c.code)) else sb.append(c)
            }
        }
        sb.append('"')
    }

    private class Parser(val s: String) {
        var i = 0

        fun err(msg: String): Nothing = throw IllegalArgumentException("JSON tidak valid di posisi $i: $msg")

        fun ws() {
            while (i < s.length && s[i].isWhitespace()) i++
        }

        fun value(): Any? {
            ws()
            if (i >= s.length) err("input habis")
            return when (val c = s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> lit("true", true)
                'f' -> lit("false", false)
                'n' -> lit("null", null)
                else -> if (c == '-' || c.isDigit()) num() else err("karakter '$c'")
            }
        }

        fun lit(word: String, v: Any?): Any? {
            if (!s.startsWith(word, i)) err("mengharapkan $word")
            i += word.length
            return v
        }

        fun num(): Double {
            val start = i
            if (s[i] == '-') i++
            while (i < s.length && (s[i].isDigit() || s[i] in ".eE+-")) i++
            return s.substring(start, i).toDoubleOrNull() ?: err("angka")
        }

        fun str(): String {
            i++ // "
            val sb = StringBuilder()
            while (true) {
                if (i >= s.length) err("string tidak ditutup")
                val c = s[i++]
                when (c) {
                    '"' -> return sb.toString()
                    '\\' -> {
                        if (i >= s.length) err("escape terpotong")
                        when (val e = s[i++]) {
                            '"', '\\', '/' -> sb.append(e)
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000C')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) err("\\u terpotong")
                                sb.append(s.substring(i, i + 4).toInt(16).toChar())
                                i += 4
                            }
                            else -> err("escape \\$e")
                        }
                    }
                    else -> sb.append(c)
                }
            }
        }

        fun arr(): List<Any?> {
            i++
            val out = ArrayList<Any?>()
            ws()
            if (s.getOrNull(i) == ']') { i++; return out }
            while (true) {
                out.add(value())
                ws()
                when (s.getOrNull(i)) {
                    ',' -> i++
                    ']' -> { i++; return out }
                    else -> err("mengharapkan , atau ]")
                }
            }
        }

        fun obj(): Map<String, Any?> {
            i++
            val out = LinkedHashMap<String, Any?>()
            ws()
            if (s.getOrNull(i) == '}') { i++; return out }
            while (true) {
                ws()
                if (s.getOrNull(i) != '"') err("mengharapkan key")
                val k = str()
                ws()
                if (s.getOrNull(i) != ':') err("mengharapkan :")
                i++
                out[k] = value()
                ws()
                when (s.getOrNull(i)) {
                    ',' -> i++
                    '}' -> { i++; return out }
                    else -> err("mengharapkan , atau }")
                }
            }
        }
    }
}
