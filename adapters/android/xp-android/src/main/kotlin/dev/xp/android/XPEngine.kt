package dev.xp.android

import app.cash.zipline.QuickJs
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import java.io.Closeable
import java.util.concurrent.Executors

/**
 * Satu instance QuickJS yang menjalankan satu bundle komponen.
 * QuickJS tidak thread-safe: semua panggilan lewat satu thread khusus.
 *
 * Kontrak dengan runtime xp (mode antrean): setiap XP.* mengembalikan string JSON
 * berisi daftar batch operasi UI, sinkron. Tidak perlu bridge maupun microtask.
 */
class XPEngine private constructor(
    private val quickJs: QuickJs,
    private val thread: ExecutorCoroutineDispatcher,
) : Closeable {

    companion object {
        suspend fun create(bundle: String, fileName: String): XPEngine {
            val thread = Executors.newSingleThreadExecutor { r -> Thread(r, "xp-quickjs").apply { isDaemon = true } }
                .asCoroutineDispatcher()
            return try {
                val qjs = withContext(thread) {
                    QuickJs.create().apply {
                        memoryLimit = 32L * 1024 * 1024
                        try {
                            evaluate(bundle, fileName)
                            val protocol = evaluate("typeof XP === 'object' ? XP.protocol : -1", "xp-check")
                            check((protocol as? Number)?.toInt() == XPTree.PROTOCOL) {
                                "bundle bukan bundle native xp (protokol: $protocol)"
                            }
                        } catch (t: Throwable) {
                            close()
                            throw t
                        }
                    }
                }
                XPEngine(qjs, thread)
            } catch (t: Throwable) {
                thread.close()
                throw t
            }
        }
    }

    private var closed = false

    suspend fun mount(propsJson: String): String = call("XP.mount(${XPJson.quote(propsJson)})")

    suspend fun update(propsJson: String): String = call("XP.update(${XPJson.quote(propsJson)})")

    suspend fun dispatch(handlerKey: String, args: List<Any?> = emptyList()): String =
        call("XP.dispatch(${XPJson.quote(handlerKey)}, ${XPJson.quote(XPJson.stringify(args))})")

    suspend fun unmount(): String = call("XP.unmount()")

    private suspend fun call(script: String): String = withContext(thread) {
        check(!closed) { "XPEngine sudah ditutup" }
        quickJs.evaluate(script, "xp-call") as? String ?: "[]"
    }

    override fun close() {
        thread.executor.execute {
            if (!closed) {
                closed = true
                quickJs.close()
            }
        }
        thread.close() // shutdown setelah tugas di atas selesai
    }
}
