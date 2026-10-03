package dev.xp.android

/** Event dari `xp dev` (/__xp/events). Dipisah dari XPLive supaya bisa dites tanpa Android. */
object XPDevEvents {
    /** Satu baris SSE → daftar komponen yang baru di-build, atau null untuk event lain. */
    fun parse(line: String): List<String>? {
        if (!line.startsWith("data:")) return null
        val event = try {
            XPJson.parse(line.removePrefix("data:").trim()) as? Map<*, *>
        } catch (e: Exception) {
            null
        } ?: return null
        if (event["type"] != "update") return null
        return (event["components"] as? List<*>)?.map { it.toString() }
    }
}
