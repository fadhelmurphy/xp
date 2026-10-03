package dev.xp.android

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.job
import java.net.HttpURLConnection
import java.net.URL

/**
 * Berlangganan build baru dari `xp dev` (Server-Sent Events di <base>/__xp/events).
 * Hanya untuk development: XPView(live = true).
 */
object XPLive {
    /** Nama komponen yang baru di-build, setiap kali `xp dev` selesai build. Tersambung ulang otomatis. */
    fun updates(base: String): Flow<List<String>> = flow {
        val url = URL("${base.trimEnd('/')}/__xp/events")
        while (true) {
            val conn = url.openConnection() as HttpURLConnection
            val stop = currentCoroutineContext().job.invokeOnCompletion { conn.disconnect() }
            try {
                conn.connectTimeout = 5_000
                conn.readTimeout = 0 // koneksi dibiarkan terbuka; server mengirim ping tiap 15 detik
                conn.setRequestProperty("Accept", "text/event-stream")
                conn.inputStream.bufferedReader().use { reader ->
                    while (true) {
                        val line = reader.readLine() ?: break
                        XPDevEvents.parse(line)?.let { emit(it) }
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w("XP", "xp dev tidak tersambung (${e.message}), mencoba lagi")
            } finally {
                stop.dispose()
                conn.disconnect()
            }
            delay(1_000)
        }
    }.flowOn(Dispatchers.IO)
}
