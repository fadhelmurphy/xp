package dev.xp.demo

import android.os.Bundle
import android.widget.CalendarView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import dev.xp.android.XPNativeView
import dev.xp.android.XPView

/**
 * View native milik app yang boleh dipakai komponen xp lewat <NativeView name="...">.
 * Contoh: kalender bawaan Android untuk komponen `jadwal-kelas`.
 */
private val calendar: XPNativeView = {
    val minDate = (props["minDate"] as? Number)?.toLong()
    AndroidView(
        factory = { context -> CalendarView(context) },
        update = { view ->
            if (minDate != null) view.minDate = minDate
            // Pasang ulang setiap update supaya selalu memakai `emit` terbaru.
            view.setOnDateChangeListener { _, year, month, day ->
                emit("select", "%04d-%02d-%02d".format(year, month + 1, day))
            }
        },
        modifier = modifier,
    )
}

private val nativeViews = mapOf("calendar" to calendar)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                var reload by remember { mutableIntStateOf(0) }
                Column(
                    Modifier
                        .fillMaxSize()
                        .background(Color(0xFFF6F8FA))
                        .safeDrawingPadding()
                        .verticalScroll(rememberScrollState())
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    Text("App native (Jetpack Compose)", fontSize = 20.sp)
                    Text("Komponen di bawah dimuat dari ${BuildConfig.XP_URL}", fontSize = 12.sp, color = Color.Gray)

                    // Komponen yang sama dengan yang dipakai app Next.js.
                    key(reload) {
                        XPView(base = BuildConfig.XP_URL, name = "promo-slider")
                    }
                    key(reload) {
                        XPView(
                            base = BuildConfig.XP_URL,
                            name = "promo-modal",
                            props = mapOf("title" to "Kelas IELTS", "price" to 150000, "seats" to 3),
                        )
                    }

                    // Komponen yang memakai view native milik app (CalendarView).
                    key(reload) {
                        XPView(base = BuildConfig.XP_URL, name = "jadwal-kelas", nativeViews = nativeViews)
                    }

                    // Ubah komponen di laptop → `npm run build` → tekan ini. Tanpa rebuild app.
                    OutlinedButton(onClick = { reload++ }) { Text("Muat ulang dari URL") }
                }
            }
        }
    }
}
