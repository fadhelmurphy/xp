package dev.xp.android

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/** Bundle native yang sudah diunduh & diverifikasi. */
class XPBundle(val name: String, val file: String, val code: String, val primitives: List<String>)

class XPLoadException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Mengambil komponen dari remote hasil `xp build`:
 *   <base>/manifest.json → components[name].native.file → <base>/<file>
 * File ber-hash di-cache di memori; manifest selalu diambil ulang (versi terbaru).
 * Dengan `publicKey`, manifest harus ditandatangani (`xp build --sign`): manifest.sig dicek dulu.
 */
object XPLoader {
    private val cache = ConcurrentHashMap<String, String>() // url bundle → kode

    suspend fun load(base: String, name: String, publicKey: String? = null): XPBundle = withContext(Dispatchers.IO) {
        val root = base.trimEnd('/')
        val text = get("$root/manifest.json")
        if (publicKey != null) {
            val signature = try {
                get("$root/manifest.sig")
            } catch (e: XPLoadException) {
                throw XPLoadException("manifest belum ditandatangani (${e.message})", e)
            }
            if (!XPSignature.verify(text, signature, publicKey)) {
                throw XPLoadException("tanda tangan manifest tidak valid, remote ditolak")
            }
        }
        val manifest = XPJson.parse(text) as? Map<*, *>
            ?: throw XPLoadException("manifest.json tidak valid")

        val protocol = (manifest["protocol"] as? Number)?.toInt()
        if (protocol != XPTree.PROTOCOL) {
            throw XPLoadException("remote memakai protokol $protocol, SDK ini ${XPTree.PROTOCOL}. Perbarui app.")
        }
        val entry = (manifest["components"] as? Map<*, *>)?.get(name) as? Map<*, *>
            ?: throw XPLoadException("komponen '$name' tidak ada di $root/manifest.json")
        val native = entry["native"] as? Map<*, *> ?: throw XPLoadException("'$name' tidak punya bundle native")
        val file = native["file"] as String
        val sha = native["sha256"] as? String

        // Cek kapabilitas: primitive yang dipakai komponen harus dikenal SDK ini.
        val primitives = (entry["primitives"] as? List<*>)?.map { it.toString() } ?: emptyList()
        val unknown = primitives.filter { it !in XPTree.PRIMITIVES }
        if (unknown.isNotEmpty()) throw XPLoadException("'$name' memakai primitive yang belum didukung app ini: $unknown")

        val url = "$root/$file"
        val code = cache[url] ?: get(url).also { body ->
            if (sha != null && sha256(body) != sha) throw XPLoadException("hash $file tidak cocok dengan manifest, bundle ditolak")
            cache[url] = body
        }
        XPBundle(name, file, code, primitives)
    }

    private fun get(url: String): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 5_000
        conn.readTimeout = 10_000
        try {
            val code = conn.responseCode
            if (code !in 200..299) throw XPLoadException("$url → HTTP $code")
            return conn.inputStream.bufferedReader().use { it.readText() }
        } catch (e: XPLoadException) {
            throw e
        } catch (e: Exception) {
            throw XPLoadException("$url tidak bisa diakses: ${e.message}", e)
        } finally {
            conn.disconnect()
        }
    }

    private fun sha256(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
