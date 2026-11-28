package dev.xp.android

import android.util.Log
import dev.xp.android.compiled.JsConsole
import dev.xp.android.compiled.XPCompiledComponent
import dev.xp.android.compiled.XPComponentRegistry
import dev.xp.android.compiled.XPComponentRuntime
import dev.xp.android.typed.XPTypedComponent
import dev.xp.android.typed.XPTypedRegistry
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import java.io.Closeable
import java.util.concurrent.Executors

/**
 * Yang dijalankan XPView: bundle JS di QuickJS (development / dimuat dari URL),
 * atau komponen yang sudah dikompilasi ke Kotlin (release).
 * Setiap pemanggilan mengembalikan daftar batch operasi UI untuk [XPTree].
 */
internal interface XPRuntime : Closeable {
    suspend fun mount(propsJson: String): List<*>
    suspend fun update(propsJson: String): List<*>
    suspend fun dispatch(handlerKey: String, args: List<Any?>): List<*>
    suspend fun environment(widthDp: Int, heightDp: Int, dark: Boolean): List<*>
    suspend fun tick(): List<*>
    suspend fun nextTimer(): Long
}

private fun batches(json: String): List<*> = XPJson.parse(json) as? List<*> ?: error("hasil runtime bukan array batch")

internal class XPEngineRuntime(val engine: XPEngine) : XPRuntime {
    override suspend fun mount(propsJson: String) = batches(engine.mount(propsJson))
    override suspend fun update(propsJson: String) = batches(engine.update(propsJson))
    override suspend fun dispatch(handlerKey: String, args: List<Any?>) = batches(engine.dispatch(handlerKey, args))
    override suspend fun environment(widthDp: Int, heightDp: Int, dark: Boolean) = batches(engine.environment(widthDp, heightDp, dark))
    override suspend fun tick() = batches(engine.tick())
    override suspend fun nextTimer() = engine.nextTimer()
    override fun close() = engine.close()
}

/**
 * Komponen terkompilasi. Tetap satu thread khusus per komponen supaya render
 * tidak membebani main thread, sama seperti QuickJS.
 */
internal class XPCompiledRuntime(component: XPCompiledComponent) : XPRuntime {
    private val thread: ExecutorCoroutineDispatcher =
        Executors.newSingleThreadExecutor { r -> Thread(r, "xp-${component.name}").apply { isDaemon = true } }
            .asCoroutineDispatcher()
    private val rt = XPComponentRuntime(component)
    private var closed = false

    private suspend fun <T> on(block: () -> T): T = withContext(thread) {
        check(!closed) { "komponen sudah ditutup" }
        block()
    }

    @Suppress("UNCHECKED_CAST")
    private fun props(json: String) = XPJson.parse(json) as? Map<String, Any?> ?: emptyMap()

    override suspend fun mount(propsJson: String) = on { rt.mount(props(propsJson)) }
    override suspend fun update(propsJson: String) = on { rt.update(props(propsJson)) }
    override suspend fun dispatch(handlerKey: String, args: List<Any?>) = on { rt.dispatch(handlerKey, args) }
    override suspend fun environment(widthDp: Int, heightDp: Int, dark: Boolean) =
        on { rt.environment(widthDp.toDouble(), heightDp.toDouble(), dark) }
    override suspend fun tick() = on { rt.tick() }
    override suspend fun nextTimer() = on { rt.nextTimer() }

    override fun close() {
        thread.executor.execute { closed = true }
        thread.close()
    }
}

/**
 * Komponen yang ikut dikompilasi ke dalam app (dihasilkan `xp build`, diunduh
 * oleh task Gradle `xpComponents`). Dicari sekali lewat refleksi supaya app yang
 * tidak memakainya tidak perlu konfigurasi apa pun.
 */
object XPCompiled {
    private const val REGISTRY = "dev.xp.generated.XPComponents"

    val registry: XPComponentRegistry? by lazy {
        JsConsole.sink = { level, message ->
            when (level) {
                "error" -> Log.e("XP", message)
                "warn" -> Log.w("XP", message)
                else -> Log.i("XP", message)
            }
        }
        try {
            Class.forName(REGISTRY).getField("INSTANCE").get(null) as? XPComponentRegistry
        } catch (_: ClassNotFoundException) {
            null
        }
    }

    fun component(name: String): XPCompiledComponent? = registry?.components?.get(name)

    /** Komponen mode typed (Kotlin bertipe), dari `dev.xp.generated.XPTypedComponents`. */
    val typedRegistry: XPTypedRegistry? by lazy {
        try {
            Class.forName("dev.xp.generated.XPTypedComponents").getField("INSTANCE").get(null) as? XPTypedRegistry
        } catch (_: ClassNotFoundException) {
            null
        }
    }

    fun typed(name: String): XPTypedComponent? = typedRegistry?.components?.get(name)
}
