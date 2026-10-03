package dev.xp.android

/**
 * Style xp (subset flexbox ala React Native) yang sudah di-parse jadi nilai bertipe.
 * Murni Kotlin; pemetaan ke Modifier Compose ada di XPCompose.kt.
 * Satuan: angka = dp (fontSize = sp), sama seperti px di web.
 */
sealed interface XPSize {
    data class Dp(val value: Float) : XPSize
    data class Percent(val fraction: Float) : XPSize
}

data class XPEdges(val start: Float = 0f, val top: Float = 0f, val end: Float = 0f, val bottom: Float = 0f) {
    val isZero get() = start == 0f && top == 0f && end == 0f && bottom == 0f
}

data class XPStyle(
    val direction: String = "column",
    val justify: String = "flex-start",
    val alignItems: String = "stretch",
    val alignSelf: String? = null,
    val gap: Float = 0f,
    val flex: Float = 0f,
    val width: XPSize? = null,
    val height: XPSize? = null,
    val minWidth: Float? = null,
    val maxWidth: Float? = null,
    val minHeight: Float? = null,
    val padding: XPEdges = XPEdges(),
    val margin: XPEdges = XPEdges(),
    val background: Long? = null, // ARGB
    val radius: Float = 0f,
    val borderWidth: Float = 0f,
    val borderColor: Long? = null,
    val opacity: Float = 1f,
    // teks
    val color: Long? = null,
    val fontSize: Float? = null,
    val fontWeight: Int? = null,
    val lineHeight: Float? = null,
    val textAlign: String? = null,
) {
    companion object {
        fun parse(s: Map<String, Any?>): XPStyle {
            fun num(k: String) = (s[k] as? Number)?.toFloat()
            fun str(k: String) = s[k] as? String
            fun edges(all: String, h: String, v: String) = XPEdges(
                start = num("${all}Left") ?: num(h) ?: num(all) ?: 0f,
                end = num("${all}Right") ?: num(h) ?: num(all) ?: 0f,
                top = num("${all}Top") ?: num(v) ?: num(all) ?: 0f,
                bottom = num("${all}Bottom") ?: num(v) ?: num(all) ?: 0f,
            )
            return XPStyle(
                direction = str("flexDirection") ?: "column",
                justify = str("justifyContent") ?: "flex-start",
                alignItems = str("alignItems") ?: "stretch",
                alignSelf = str("alignSelf")?.takeIf { it != "auto" },
                gap = num("gap") ?: 0f,
                flex = num("flex") ?: num("flexGrow") ?: 0f,
                width = size(s["width"]),
                height = size(s["height"]),
                minWidth = num("minWidth"),
                maxWidth = num("maxWidth"),
                minHeight = num("minHeight"),
                padding = edges("padding", "paddingHorizontal", "paddingVertical"),
                margin = edges("margin", "marginHorizontal", "marginVertical"),
                background = str("backgroundColor")?.let(::parseColor),
                radius = num("borderRadius") ?: 0f,
                borderWidth = num("borderWidth") ?: 0f,
                borderColor = str("borderColor")?.let(::parseColor),
                opacity = num("opacity") ?: 1f,
                color = str("color")?.let(::parseColor),
                fontSize = num("fontSize"),
                fontWeight = str("fontWeight")?.toIntOrNull() ?: (s["fontWeight"] as? Number)?.toInt(),
                lineHeight = num("lineHeight"),
                textAlign = str("textAlign"),
            )
        }

        private fun size(v: Any?): XPSize? = when (v) {
            is Number -> XPSize.Dp(v.toFloat())
            is String -> v.trim().removeSuffix("%").toFloatOrNull()?.takeIf { v.trim().endsWith("%") }
                ?.let { XPSize.Percent((it / 100f).coerceIn(0f, 1f)) }
            else -> null
        }

        private val NAMED = mapOf(
            "transparent" to 0x00000000L, "black" to 0xFF000000L, "white" to 0xFFFFFFFFL,
            "red" to 0xFFFF0000L, "green" to 0xFF008000L, "blue" to 0xFF0000FFL, "gray" to 0xFF808080L,
        )

        /** "#RGB", "#RRGGBB", "#RRGGBBAA" (format web), "rgb()", "rgba()", nama dasar → ARGB. Tidak dikenal → null. */
        fun parseColor(raw: String): Long? {
            val c = raw.trim().lowercase()
            NAMED[c]?.let { return it }
            if (c.startsWith("#")) {
                val h = c.substring(1)
                val v = h.toLongOrNull(16) ?: return null
                return when (h.length) {
                    3 -> {
                        val r = (v shr 8) and 0xF; val g = (v shr 4) and 0xF; val b = v and 0xF
                        0xFF000000L or (r * 17 shl 16) or (g * 17 shl 8) or (b * 17)
                    }
                    6 -> 0xFF000000L or v
                    8 -> ((v and 0xFF) shl 24) or (v ushr 8) // RRGGBBAA → AARRGGBB
                    else -> null
                }
            }
            val m = Regex("""rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)""").matchEntire(c)
                ?: return null
            val (r, g, b) = (1..3).map { m.groupValues[it].toFloat().toInt().coerceIn(0, 255).toLong() }
            val a = m.groupValues[4].takeIf { it.isNotEmpty() }?.toFloat() ?: 1f
            val alpha = (a.coerceIn(0f, 1f) * 255 + 0.5f).toInt().toLong()
            return (alpha shl 24) or (r shl 16) or (g shl 8) or b
        }
    }
}
