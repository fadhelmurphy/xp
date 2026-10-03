package dev.xp.demo

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
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
import dev.xp.android.XPView

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
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    Text("App native (Jetpack Compose)", fontSize = 20.sp)
                    Text("Komponen di bawah dimuat dari ${BuildConfig.XP_URL}", fontSize = 12.sp, color = Color.Gray)

                    // Komponen yang sama dengan yang dipakai app Next.js.
                    key(reload) {
                        XPView(
                            base = BuildConfig.XP_URL,
                            name = "promo-modal",
                            props = mapOf("title" to "Kelas IELTS", "price" to 150000, "seats" to 3),
                        )
                    }

                    // Ubah komponen di laptop → `npm run build` → tekan ini. Tanpa rebuild app.
                    OutlinedButton(onClick = { reload++ }) { Text("Muat ulang dari URL") }
                }
            }
        }
    }
}
