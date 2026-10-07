package dev.xp.android

/**
 * Style xp (subset flexbox ala React Native) yang sudah di-parse jadi nilai bertipe.
 * Murni Kotlin; pemetaan ke Compose ada di XPView.kt.
 * Satuan: angka = dp (fontSize = sp), sama seperti px di web.
 */
sealed interface XPSize {
    data class Dp(val value: Float) : XPSize
    data class Percent(val fraction: Float) : XPSize
    /** "50vh" / "100vw": bagian dari tinggi/lebar layar. */
    data class Screen(val fraction: Float, val vertical: Boolean) : XPSize
}

data class XPEdges(val start: Float = 0f, val top: Float = 0f, val end: Float = 0f, val bottom: Float = 0f) {
    val isZero get() = start == 0f && top == 0f && end == 0f && bottom == 0f
    val isUniform get() = start == top && top == end && end == bottom
}

data class XPCorners(val topStart: Float = 0f, val topEnd: Float = 0f, val bottomEnd: Float = 0f, val bottomStart: Float = 0f) {
    val isZero get() = topStart == 0f && topEnd == 0f && bottomEnd == 0f && bottomStart == 0f
}

/** Satu lapisan box-shadow. blur 0 + spread > 0 = garis luar (ring). */
data class XPShadow(val x: Float, val y: Float, val blur: Float, val spread: Float, val color: Long) {
    val isRing get() = blur == 0f && x == 0f && y == 0f && spread > 0f
}

/** Gradien linear: sudut CSS (0 = ke atas, 90 = ke kanan) dan warna ARGB yang tersebar rata. */
data class XPGradient(val angle: Float, val colors: List<Long>)

data class XPStyle(
    val display: String = "flex",
    val direction: String = "column",
    val reverse: Boolean = false,
    val justify: String = "flex-start",
    val alignItems: String = "stretch",
    val alignSelf: String? = null,
    val gap: Float = 0f,
    val columnGap: Float? = null,
    val rowGap: Float? = null,
    val gridColumns: Int = 1,
    val gridColumnSpan: Int = 1,
    val flex: Float = 0f,
    val width: XPSize? = null,
    val height: XPSize? = null,
    val minWidth: Float? = null,
    val maxWidth: Float? = null,
    val minHeight: Float? = null,
    val maxHeight: Float? = null,
    val aspectRatio: Float? = null,
    val absolute: Boolean = false,
    val top: XPSize? = null,
    val right: XPSize? = null,
    val bottom: XPSize? = null,
    val left: XPSize? = null,
    val zIndex: Float = 0f,
    val clip: Boolean = false,
    val padding: XPEdges = XPEdges(),
    val margin: XPEdges = XPEdges(),
    /** Sisi margin bernilai "auto": "start", "end", "top", "bottom". */
    val autoMargin: Set<String> = emptySet(),
    val background: Long? = null, // ARGB
    val gradient: XPGradient? = null,
    val radius: Float = 0f,
    val corners: XPCorners = XPCorners(),
    val borderWidth: Float = 0f,
    val borders: XPEdges = XPEdges(),
    val borderColor: Long? = null,
    val borderStyle: String = "solid",
    val shadows: List<XPShadow> = emptyList(),
    val dividerWidth: Float = 0f,
    val dividerColor: Long? = null,
    val opacity: Float = 1f,
    val scaleX: Float = 1f,
    val scaleY: Float = 1f,
    val translateX: XPSize? = null,
    val translateY: XPSize? = null,
    val rotate: Float = 0f,
    val animation: String? = null,
    // teks
    val color: Long? = null,
    val fontSize: Float? = null,
    val fontWeight: Int? = null,
    val italic: Boolean = false,
    val fontFamily: String? = null,
    val lineHeight: Float? = null,
    val letterSpacing: Float? = null,
    val textAlign: String? = null,
    val textDecoration: String? = null,
    val textTransform: String? = null,
    val noWrap: Boolean = false,
    val ellipsis: Boolean = false,
    val lineClamp: Int? = null,
    // gambar
    val objectFit: String? = null,
    // animasi perubahan style
    val transitionMs: Int = 0,
    val easing: String = "ease",
) {
    val hidden get() = display == "none"
    val isRow get() = direction == "row"
    val hasBorder get() = borderWidth > 0f || !borders.isZero
    /** Lebar border per sisi (border-t dll menimpa borderWidth). */
    val borderEdges get() = if (borders.isZero) XPEdges(borderWidth, borderWidth, borderWidth, borderWidth) else borders
    /** Jarak antar anak di sumbu utama. */
    val mainGap get() = (if (isRow) columnGap else rowGap) ?: gap
    /** Sudut per pojok (rounded-t-lg dll menimpa borderRadius). */
    val cornerRadii get() = if (corners.isZero) XPCorners(radius, radius, radius, radius) else corners
    val rounded get() = radius > 0f || !corners.isZero

    /** Ukuran "vh"/"vw" → dp sesuai layar saat ini. */
    fun resolveScreen(widthDp: Float, heightDp: Float): XPStyle {
        fun r(v: XPSize?) = if (v is XPSize.Screen) XPSize.Dp(v.fraction * if (v.vertical) heightDp else widthDp) else v
        if (listOf(width, height, top, right, bottom, left, translateX, translateY).none { it is XPSize.Screen }) return this
        return copy(width = r(width), height = r(height), top = r(top), right = r(right), bottom = r(bottom), left = r(left),
            translateX = r(translateX), translateY = r(translateY))
    }

    /** Teks setelah text-transform (uppercase dll). */
    fun transform(text: String): String = when (textTransform) {
        "uppercase" -> text.uppercase()
        "lowercase" -> text.lowercase()
        "capitalize" -> text.split(" ").joinToString(" ") { w -> w.replaceFirstChar { it.uppercaseChar() } }
        else -> text
    }

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
            fun auto(k: String) = s[k] == "auto"
            val autoMargin = buildSet {
                if (auto("marginLeft") || auto("marginHorizontal") || auto("margin")) add("start")
                if (auto("marginRight") || auto("marginHorizontal") || auto("margin")) add("end")
                if (auto("marginTop") || auto("marginVertical") || auto("margin")) add("top")
                if (auto("marginBottom") || auto("marginVertical") || auto("margin")) add("bottom")
            }
            val direction = str("flexDirection") ?: "column"
            val textOverflow = str("textOverflow")
            return XPStyle(
                display = str("display") ?: "flex",
                direction = direction.removeSuffix("-reverse"),
                reverse = direction.endsWith("-reverse"),
                justify = str("justifyContent") ?: "flex-start",
                alignItems = str("alignItems") ?: "stretch",
                alignSelf = str("alignSelf")?.takeIf { it != "auto" },
                gap = num("gap") ?: 0f,
                columnGap = num("columnGap"),
                rowGap = num("rowGap"),
                gridColumns = num("gridColumns")?.toInt()?.coerceAtLeast(1) ?: 1,
                gridColumnSpan = num("gridColumnSpan")?.toInt() ?: 1,
                flex = num("flex") ?: num("flexGrow") ?: 0f,
                width = size(s["width"]),
                height = size(s["height"]),
                minWidth = num("minWidth"),
                maxWidth = num("maxWidth"),
                minHeight = num("minHeight"),
                maxHeight = num("maxHeight"),
                aspectRatio = num("aspectRatio")?.takeIf { it > 0f },
                absolute = str("position") == "absolute",
                top = size(s["top"]),
                right = size(s["right"]),
                bottom = size(s["bottom"]),
                left = size(s["left"]),
                zIndex = num("zIndex") ?: 0f,
                clip = str("overflow") == "hidden",
                padding = edges("padding", "paddingHorizontal", "paddingVertical"),
                margin = edges("margin", "marginHorizontal", "marginVertical"),
                autoMargin = autoMargin,
                background = str("backgroundColor")?.let(::parseColor),
                gradient = str("backgroundImage")?.let(::parseGradient),
                radius = num("borderRadius") ?: 0f,
                corners = (num("borderRadius") ?: 0f).let { r ->
                    XPCorners(
                        topStart = num("borderTopLeftRadius") ?: r,
                        topEnd = num("borderTopRightRadius") ?: r,
                        bottomEnd = num("borderBottomRightRadius") ?: r,
                        bottomStart = num("borderBottomLeftRadius") ?: r,
                    ).takeIf { listOf("borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius").any { it in s } }
                        ?: XPCorners()
                },
                borderWidth = num("borderWidth") ?: 0f,
                borders = (num("borderWidth") ?: 0f).let { w ->
                    XPEdges(
                        start = num("borderLeftWidth") ?: w,
                        top = num("borderTopWidth") ?: w,
                        end = num("borderRightWidth") ?: w,
                        bottom = num("borderBottomWidth") ?: w,
                    ).takeIf { listOf("borderLeftWidth", "borderTopWidth", "borderRightWidth", "borderBottomWidth").any { it in s } }
                        ?: XPEdges()
                },
                borderColor = str("borderColor")?.let(::parseColor),
                borderStyle = str("borderStyle") ?: "solid",
                shadows = str("boxShadow")?.let(::parseShadows) ?: emptyList(),
                dividerWidth = num("dividerWidth") ?: if ("dividerColor" in s) 1f else 0f,
                dividerColor = str("dividerColor")?.let(::parseColor),
                opacity = num("opacity") ?: 1f,
                scaleX = num("scaleX") ?: 1f,
                scaleY = num("scaleY") ?: 1f,
                translateX = size(s["translateX"]),
                translateY = size(s["translateY"]),
                rotate = num("rotate") ?: 0f,
                animation = str("animation")?.takeIf { it != "none" },
                color = str("color")?.let(::parseColor),
                fontSize = num("fontSize"),
                fontWeight = str("fontWeight")?.toIntOrNull() ?: (s["fontWeight"] as? Number)?.toInt(),
                italic = str("fontStyle") == "italic",
                fontFamily = str("fontFamily"),
                lineHeight = num("lineHeight"),
                letterSpacing = num("letterSpacing"),
                textAlign = str("textAlign"),
                textDecoration = str("textDecorationLine")?.takeIf { it != "none" },
                textTransform = str("textTransform")?.takeIf { it != "none" },
                noWrap = str("whiteSpace") == "nowrap",
                ellipsis = textOverflow == "ellipsis",
                lineClamp = num("lineClamp")?.toInt()?.takeIf { it > 0 },
                objectFit = str("objectFit"),
                transitionMs = num("transitionDuration")?.toInt() ?: 0,
                easing = str("transitionTimingFunction") ?: "ease",
            )
        }

        private fun size(v: Any?): XPSize? = when (v) {
            is Number -> XPSize.Dp(v.toFloat())
            is String -> {
                val t = v.trim()
                val n = t.dropLastWhile { it.isLetter() || it == '%' }.toFloatOrNull()
                when {
                    n == null -> null
                    t.endsWith("%") -> XPSize.Percent(n / 100f)
                    t.endsWith("vh") -> XPSize.Screen(n / 100f, vertical = true)
                    t.endsWith("vw") -> XPSize.Screen(n / 100f, vertical = false)
                    t.endsWith("px") -> XPSize.Dp(n)
                    else -> null
                }
            }
            else -> null
        }

        /** "0px 4px 6px -1px #0000001a, 0 0 0 2px rgba(0,0,0,.5)" → lapisan. Lapisan inset dilewati. */
        fun parseShadows(raw: String): List<XPShadow> = splitTop(raw).mapNotNull { layer ->
            val parts = splitSpaces(layer.trim())
            if (parts.isEmpty() || "inset" in parts || parts == listOf("none")) return@mapNotNull null
            val nums = parts.mapNotNull { p -> p.removeSuffix("px").toFloatOrNull() }
            val color = parts.firstNotNullOfOrNull { p -> if (p.removeSuffix("px").toFloatOrNull() == null) parseColor(p) else null } ?: 0xFF000000L
            if (nums.size < 2) return@mapNotNull null
            XPShadow(nums[0], nums[1], nums.getOrElse(2) { 0f }, nums.getOrElse(3) { 0f }, color)
        }

        /** "linear-gradient(to right, #fff, #000)" / "linear-gradient(45deg, ...)" → XPGradient. */
        fun parseGradient(raw: String): XPGradient? {
            val m = Regex("""^\s*linear-gradient\((.*)\)\s*$""").matchEntire(raw) ?: return null
            val parts = splitTop(m.groupValues[1]).map { it.trim() }.toMutableList()
            var angle = 180f
            val first = parts.firstOrNull() ?: return null
            if (first.startsWith("to ")) {
                val dir = first.removePrefix("to ").split(" ").toSet()
                val x = if ("right" in dir) 1 else if ("left" in dir) -1 else 0
                val y = if ("top" in dir) 1 else if ("bottom" in dir) -1 else 0
                angle = when {
                    x == 0 && y == 1 -> 0f
                    x == 1 && y == 0 -> 90f
                    x == 0 && y == -1 -> 180f
                    x == -1 && y == 0 -> 270f
                    x == 1 && y == 1 -> 45f
                    x == 1 && y == -1 -> 135f
                    x == -1 && y == -1 -> 225f
                    else -> 315f
                }
                parts.removeAt(0)
            } else if (first.endsWith("deg")) {
                angle = first.removeSuffix("deg").toFloatOrNull() ?: return null
                parts.removeAt(0)
            }
            val colors = parts.map { parseColor(it.split(" ")[0]) ?: return null }
            return if (colors.size >= 2) XPGradient(angle, colors) else null
        }

        private fun splitTop(s: String): List<String> {
            val out = ArrayList<String>()
            var depth = 0
            val cur = StringBuilder()
            for (ch in s) {
                when {
                    ch == '(' -> { depth++; cur.append(ch) }
                    ch == ')' -> { depth--; cur.append(ch) }
                    ch == ',' && depth == 0 -> { out.add(cur.toString()); cur.clear() }
                    else -> cur.append(ch)
                }
            }
            out.add(cur.toString())
            return out
        }

        private fun splitSpaces(s: String): List<String> {
            val out = ArrayList<String>()
            var depth = 0
            val cur = StringBuilder()
            for (ch in s) {
                if (ch == '(') depth++
                if (ch == ')') depth--
                if (ch.isWhitespace() && depth == 0) {
                    if (cur.isNotEmpty()) out.add(cur.toString())
                    cur.clear()
                } else cur.append(ch)
            }
            if (cur.isNotEmpty()) out.add(cur.toString())
            return out
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
