package dev.xp.android

import android.util.Log
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.LinearGradientShader
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.Shader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.zIndex
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil3.compose.AsyncImage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private const val TAG = "XP"

/**
 * Memuat komponen xp dari URL dan merendernya dengan Jetpack Compose (tanpa WebView).
 *
 *     XPView(base = "https://cdn.kamu/xp", name = "promo-modal",
 *            props = mapOf("title" to "Kelas IELTS", "price" to 150000))
 *
 * Props harus bisa di-JSON-kan: String, Number, Boolean, null, List, Map.
 *
 * @param publicKey kunci publik dari `xp keygen`; manifest yang tidak ditandatangani kunci ini ditolak.
 * @param live development: sambung ke `xp dev` dan muat ulang setiap build baru (state dipertahankan).
 */
@Composable
fun XPView(
    base: String,
    name: String,
    props: Map<String, Any?> = emptyMap(),
    modifier: Modifier = Modifier,
    publicKey: String? = null,
    live: Boolean = false,
    loading: @Composable () -> Unit = { CircularProgressIndicator() },
    error: @Composable (Throwable) -> Unit = { Text("Gagal memuat $name: ${it.message}", color = Color(0xFFCF222E)) },
) {
    val propsJson = remember(props) { XPJson.stringify(props) }
    val scope = rememberCoroutineScope()
    val holder = remember(base, name) { XPHolder(scope) }
    // Lebar layar dan mode gelap untuk varian className (sm:, md:, dark:, ...).
    val widthDp = LocalConfiguration.current.screenWidthDp
    val heightDp = LocalConfiguration.current.screenHeightDp
    val dark = isSystemInDarkTheme()
    SideEffect {
        holder.latestProps = propsJson
        holder.latestEnv = XPEnv(widthDp, heightDp, dark)
    }

    // Unduh bundle → jalankan di QuickJS → mount.
    LaunchedEffect(holder) {
        try {
            val bundle = XPLoader.load(base, name, publicKey)
            val engine = XPEngine.create(bundle.code, bundle.file)
            if (holder.disposed) {
                engine.close()
                return@LaunchedEffect
            }
            holder.engine = engine
            holder.file = bundle.file
            holder.mutex.withLock {
                holder.mountedProps = holder.latestProps
                holder.sendEnvironment(engine)
                holder.apply(engine.mount(holder.latestProps))
                holder.mountRevision = holder.tree.revision
            }
            holder.state = XPState.Ready
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            Log.e(TAG, "gagal memuat $name dari $base", t)
            holder.state = XPState.Failed(t)
        }
    }

    // Props dari app host berubah → XP.update (tanpa remount, state komponen tetap).
    LaunchedEffect(holder, propsJson, holder.state) {
        val engine = holder.engine ?: return@LaunchedEffect
        holder.mutex.withLock {
            if (holder.mountedProps == propsJson) return@withLock
            holder.mountedProps = propsJson
            holder.apply(engine.update(propsJson))
        }
    }

    // Layar diputar / ukuran jendela berubah / mode gelap berganti.
    LaunchedEffect(holder, widthDp, heightDp, dark, holder.state) {
        val engine = holder.engine ?: return@LaunchedEffect
        holder.mutex.withLock { holder.sendEnvironment(engine) }
    }

    // xp dev: build baru → bundle baru, state lama dibawa lewat snapshot.
    LaunchedEffect(holder, live, holder.state) {
        if (!live || holder.state != XPState.Ready) return@LaunchedEffect
        XPLive.updates(base).collect { names ->
            if (name !in names) return@collect
            try {
                holder.reload(XPLoader.load(base, name, publicKey))
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                Log.e(TAG, "reload $name gagal", t)
            }
        }
    }

    DisposableEffect(holder) {
        onDispose {
            holder.disposed = true
            holder.engine?.close()
            holder.engine = null
        }
    }

    val dispatch: (String, List<Any?>) -> Unit = remember(holder) {
        { key, args ->
            scope.launch {
                val engine = holder.engine ?: return@launch
                try {
                    // Urutan event dijaga: satu per satu, sesuai urutan tap.
                    holder.mutex.withLock { holder.apply(engine.dispatch(key, args)) }
                } catch (c: CancellationException) {
                    throw c
                } catch (t: Throwable) {
                    Log.e(TAG, "event $key gagal di $name", t)
                }
            }
        }
    }

    Box(modifier) {
        when (val s = holder.state) {
            XPState.Loading -> loading()
            is XPState.Failed -> error(s.error)
            XPState.Ready -> {
                // ctx baru setiap revisi → Compose merender ulang node yang berubah.
                val ctx = XPRenderCtx(holder.tree, holder.revision, holder.mountRevision, dispatch)
                Column(Modifier.fillMaxWidth()) {
                    val slot = Slot.InColumn(this, stretch = true)
                    holder.tree.root.children.forEach { key(it) { XPNodeView(ctx, it, slot) } }
                }
            }
        }
    }
}

private data class XPEnv(val widthDp: Int, val heightDp: Int, val dark: Boolean)

private sealed interface XPState {
    data object Loading : XPState
    data object Ready : XPState
    data class Failed(val error: Throwable) : XPState
}

private class XPHolder(private val scope: CoroutineScope) {
    var tree by mutableStateOf(XPTree())
    val mutex = Mutex()
    var engine: XPEngine? = null
    var file: String? = null
    var disposed = false
    var mountedProps: String? = null
    var mountRevision = 0
    var latestProps = "{}"
    var latestEnv = XPEnv(0, 0, false)
    private var sentEnv: Pair<XPEnv, XPEngine>? = null

    /** Dipanggil di dalam mutex: kirim ukuran layar/mode gelap kalau berubah sejak terakhir dikirim. */
    suspend fun sendEnvironment(engine: XPEngine) {
        val env = latestEnv
        if (sentEnv?.first == env && sentEnv?.second === engine) return
        sentEnv = env to engine
        apply(engine.environment(env.widthDp, env.heightDp, env.dark)) // sebelum mount: batch kosong
    }
    var state by mutableStateOf<XPState>(XPState.Loading)
    var revision by mutableIntStateOf(0)

    /** Ganti ke bundle baru (xp dev). State useState dibawa lewat snapshot. */
    suspend fun reload(bundle: XPBundle) {
        if (bundle.file == file) return
        val next = XPEngine.create(bundle.code, bundle.file)
        mutex.withLock {
            val old = engine
            if (disposed || old == null) {
                next.close()
                return
            }
            val snapshot = old.snapshot()
            val fresh = XPTree()
            next.environment(latestEnv.widthDp, latestEnv.heightDp, latestEnv.dark)
            fresh.applyBatches(next.mount(latestProps, snapshot))
            tree = fresh
            engine = next
            sentEnv = latestEnv to next
            file = bundle.file
            mountedProps = latestProps
            revision = fresh.revision
            mountRevision = fresh.revision
            old.close()
            armTimer()
        }
    }

    /** Dipanggil di dalam mutex. Setiap hasil XP.* bisa menjadwalkan timer baru. */
    fun apply(batchesJson: String) {
        tree.applyBatches(batchesJson)
        revision = tree.revision
        armTimer()
    }

    // Timer JS (setTimeout/setInterval): tunggu XP.nextTimer() ms, lalu XP.tick().
    // Tidak memakai cancel: hasil tick yang sedang berjalan tidak boleh hilang. Job lama
    // cukup berhenti sendiri kalau generasinya sudah lewat.
    private var timerGen = 0

    private fun armTimer() {
        val gen = ++timerGen
        scope.launch {
            try {
                val engine = engine ?: return@launch
                val wait = mutex.withLock { if (gen != timerGen || disposed) -1L else engine.nextTimer() }
                if (wait < 0) return@launch
                delay(wait)
                mutex.withLock { if (gen == timerGen && !disposed) apply(engine.tick()) }
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                Log.e(TAG, "timer gagal", t)
            }
        }
    }
}

private data class XPRenderCtx(
    val tree: XPTree,
    val revision: Int,
    /** Revisi setelah mount; node yang dibuat sesudahnya boleh menjalankan animasi `entering`. */
    val mountRevision: Int,
    val dispatch: (String, List<Any?>) -> Unit,
)

// --- tata letak: posisi anak di dalam parent (flex, alignSelf, stretch, margin auto) ---

private sealed interface Slot {
    class InColumn(val scope: ColumnScope, val stretch: Boolean) : Slot
    class InRow(val scope: RowScope) : Slot
    /** position: absolute → ditempatkan oleh XPAbsolute; atau sel grid (lebar diatur grid). */
    data object Free : Slot
}

private fun Slot.modifier(s: XPStyle): Modifier {
    var m: Modifier = if (s.zIndex != 0f) Modifier.zIndex(s.zIndex) else Modifier
    m = m.then(
        when (this) {
            is Slot.InColumn -> with(scope) {
                var c: Modifier = Modifier
                if (s.flex > 0f) c = c.weight(s.flex)
                val auto = s.autoMargin
                c = when {
                    // margin kiri/kanan auto di kolom: dorong ke kanan / ke tengah (seperti flexbox web)
                    "start" in auto && "end" in auto -> c.align(Alignment.CenterHorizontally)
                    "start" in auto -> c.align(Alignment.End)
                    "end" in auto -> c.align(Alignment.Start)
                    else -> when (s.alignSelf) {
                        "center" -> c.align(Alignment.CenterHorizontally)
                        "flex-end" -> c.align(Alignment.End)
                        "flex-start" -> c.align(Alignment.Start)
                        "stretch" -> c.fillMaxWidth()
                        // Default flexbox kolom: anak melebar penuh (seperti di web).
                        else -> if (stretch && s.width == null) c.fillMaxWidth() else c
                    }
                }
                c
            }
            is Slot.InRow -> with(scope) {
                var r: Modifier = Modifier
                if (s.flex > 0f) r = r.weight(s.flex)
                val auto = s.autoMargin
                when {
                    "top" in auto && "bottom" in auto -> r.align(Alignment.CenterVertically)
                    "top" in auto -> r.align(Alignment.Bottom)
                    "bottom" in auto -> r.align(Alignment.Top)
                    else -> when (s.alignSelf) {
                        "center" -> r.align(Alignment.CenterVertically)
                        "flex-end" -> r.align(Alignment.Bottom)
                        "flex-start" -> r.align(Alignment.Top)
                        else -> r
                    }
                }
            }
            Slot.Free -> Modifier
        },
    )
    return m
}

private fun XPStyle.shape(): Shape {
    if (!rounded) return RectangleShape
    val c = cornerRadii
    return RoundedCornerShape(topStart = c.topStart.dp, topEnd = c.topEnd.dp, bottomEnd = c.bottomEnd.dp, bottomStart = c.bottomStart.dp)
}

/** Gradien linear dengan sudut CSS, dihitung dari ukuran elemen. */
private fun XPGradient.brush(): Brush = object : ShaderBrush() {
    override fun createShader(size: Size): Shader {
        val rad = Math.toRadians(angle.toDouble())
        val dx = sin(rad).toFloat()
        val dy = -cos(rad).toFloat()
        // Panjang garis gradien CSS: proyeksi kotak ke arah sudut.
        val half = (abs(size.width * dx) + abs(size.height * dy)) / 2f
        val center = Offset(size.width / 2f, size.height / 2f)
        return LinearGradientShader(
            from = center - Offset(dx * half, dy * half),
            to = center + Offset(dx * half, dy * half),
            colors = colors.map { Color(it) },
        )
    }
}

/** Border per sisi, putus-putus/titik, dan ring (box-shadow tanpa blur) yang tidak bisa lewat Modifier.border. */
private fun Modifier.xpStrokes(s: XPStyle, shape: Shape): Modifier {
    val rings = s.shadows.filter { it.isRing }
    val custom = s.hasBorder && (!s.borderEdges.isUniform || s.borderStyle != "solid")
    if (rings.isEmpty() && !custom) return this
    return drawWithContent {
        drawContent()
        for (r in rings) {
            val w = r.spread.dp.toPx()
            val outline = shape.createOutline(Size(size.width + w, size.height + w), layoutDirection, this)
            translate(-w / 2f, -w / 2f) { drawOutline(outline, Color(r.color), style = Stroke(width = w)) }
        }
        if (!custom) return@drawWithContent
        val color = Color(s.borderColor ?: 0xFF000000L)
        val e = s.borderEdges
        val effect = when (s.borderStyle) {
            "dashed" -> PathEffect.dashPathEffect(floatArrayOf(3 * e.top.coerceAtLeast(1f).dp.toPx(), 2 * e.top.coerceAtLeast(1f).dp.toPx()))
            "dotted" -> PathEffect.dashPathEffect(floatArrayOf(e.top.coerceAtLeast(1f).dp.toPx(), e.top.coerceAtLeast(1f).dp.toPx()))
            else -> null
        }
        if (e.isUniform) {
            val w = e.top.dp.toPx()
            val outline = shape.createOutline(Size(size.width - w, size.height - w), layoutDirection, this)
            translate(w / 2f, w / 2f) { drawOutline(outline, color, style = Stroke(width = w, pathEffect = effect)) }
            return@drawWithContent
        }
        fun line(width: Float, from: Offset, to: Offset) {
            if (width > 0f) drawLine(color, from, to, strokeWidth = width.dp.toPx(), pathEffect = effect)
        }
        val (t, r, b, l) = listOf(e.top, e.end, e.bottom, e.start).map { it.dp.toPx() / 2f }
        line(e.top, Offset(0f, t), Offset(size.width, t))
        line(e.bottom, Offset(0f, size.height - b), Offset(size.width, size.height - b))
        line(e.start, Offset(l, 0f), Offset(l, size.height))
        line(e.end, Offset(size.width - r, 0f), Offset(size.width - r, size.height))
    }
}

/**
 * Box model: margin → ukuran → opacity → shadow → bentuk/latar/border → [interaction] → padding.
 * `withPadding = false` untuk container dengan anak absolute: padding dipasang di dalamnya.
 */
private fun Modifier.xpBox(s: XPStyle, interaction: Modifier = Modifier, withPadding: Boolean = true): Modifier {
    var m = this
    if (!s.margin.isZero) m = m.padding(start = s.margin.start.dp, top = s.margin.top.dp, end = s.margin.end.dp, bottom = s.margin.bottom.dp)
    if (s.minWidth != null || s.maxWidth != null) {
        m = m.widthIn(min = s.minWidth?.dp ?: Dp.Unspecified, max = s.maxWidth?.dp ?: Dp.Unspecified)
    }
    if (s.minHeight != null || s.maxHeight != null) {
        m = m.heightIn(min = s.minHeight?.dp ?: Dp.Unspecified, max = s.maxHeight?.dp ?: Dp.Unspecified)
    }
    m = when (val w = s.width) {
        is XPSize.Dp -> m.width(w.value.dp)
        is XPSize.Percent -> m.fillMaxWidth(w.fraction)
        else -> m
    }
    m = when (val h = s.height) {
        is XPSize.Dp -> m.height(h.value.dp)
        is XPSize.Percent -> m.fillMaxHeight(h.fraction)
        else -> m
    }
    s.aspectRatio?.let { m = m.aspectRatio(it) }
    if (s.opacity < 1f) m = m.alpha(s.opacity)
    val shape = s.shape()
    // box-shadow: lapisan dengan blur terbesar → elevation dengan warna shadow-nya.
    s.shadows.filter { !it.isRing && it.blur > 0f }.maxByOrNull { it.blur }?.let { sh ->
        m = m.shadow((sh.blur / 2f).dp, shape, clip = false, ambientColor = Color(sh.color), spotColor = Color(sh.color))
    }
    m = m.xpStrokes(s, shape)
    if (s.rounded || s.clip) m = m.clip(shape)
    s.background?.let { m = m.background(Color(it), shape) }
    s.gradient?.let { m = m.background(it.brush(), shape) }
    if (s.hasBorder && s.borderEdges.isUniform && s.borderStyle == "solid") {
        m = m.border(s.borderEdges.top.dp, Color(s.borderColor ?: 0xFF000000), shape)
    }
    m = m.then(interaction)
    if (withPadding && !s.padding.isZero) m = m.xpPadding(s)
    return m
}

private fun Modifier.xpPadding(s: XPStyle): Modifier =
    if (s.padding.isZero) this else padding(start = s.padding.start.dp, top = s.padding.top.dp, end = s.padding.end.dp, bottom = s.padding.bottom.dp)


// --- animasi ---

private fun easingOf(name: String): Easing = when (name) {
    "linear" -> LinearEasing
    "ease-in" -> FastOutLinearInEasing
    "ease-out" -> LinearOutSlowInEasing
    else -> FastOutSlowInEasing
}

private fun Color.argb(): Long = toArgb().toLong() and 0xFFFFFFFFL

/** transitionDuration > 0 → nilai yang bisa dianimasikan bergerak halus ke target barunya. */
@Composable
private fun animated(s: XPStyle): XPStyle {
    val ms = s.transitionMs.coerceAtLeast(0)
    val easing = easingOf(s.easing)
    // Selalu dipanggil (urutan composable harus tetap), durasi 0 = langsung.
    val bg by animateColorAsState(Color(s.background ?: 0x00000000L), tween(ms, easing = easing), label = "xp-bg")
    val border by animateColorAsState(Color(s.borderColor ?: 0xFF000000L), tween(ms, easing = easing), label = "xp-border")
    val color by animateColorAsState(Color(s.color ?: 0xFF000000L), tween(ms, easing = easing), label = "xp-color")
    val opacity by animateFloatAsState(s.opacity, tween(ms, easing = easing), label = "xp-opacity")
    val width by animateFloatAsState((s.width as? XPSize.Dp)?.value ?: 0f, tween(ms, easing = easing), label = "xp-width")
    val height by animateFloatAsState((s.height as? XPSize.Dp)?.value ?: 0f, tween(ms, easing = easing), label = "xp-height")
    val scaleX by animateFloatAsState(s.scaleX, tween(ms, easing = easing), label = "xp-scale-x")
    val scaleY by animateFloatAsState(s.scaleY, tween(ms, easing = easing), label = "xp-scale-y")
    val rotate by animateFloatAsState(s.rotate, tween(ms, easing = easing), label = "xp-rotate")
    val tx by animateFloatAsState((s.translateX as? XPSize.Dp)?.value ?: 0f, tween(ms, easing = easing), label = "xp-tx")
    val ty by animateFloatAsState((s.translateY as? XPSize.Dp)?.value ?: 0f, tween(ms, easing = easing), label = "xp-ty")
    if (ms == 0) return s
    return s.copy(
        scaleX = scaleX,
        scaleY = scaleY,
        rotate = rotate,
        translateX = if (s.translateX is XPSize.Dp || s.translateX == null) XPSize.Dp(tx).takeIf { tx != 0f || s.translateX != null } else s.translateX,
        translateY = if (s.translateY is XPSize.Dp || s.translateY == null) XPSize.Dp(ty).takeIf { ty != 0f || s.translateY != null } else s.translateY,
        background = s.background?.let { bg.argb() },
        borderColor = s.borderColor?.let { border.argb() },
        color = s.color?.let { color.argb() },
        opacity = opacity,
        width = if (s.width is XPSize.Dp) XPSize.Dp(width) else s.width,
        height = if (s.height is XPSize.Dp) XPSize.Dp(height) else s.height,
    )
}

/** Prop `entering`: node yang muncul setelah mount bergerak dari nilai awal ke posisi normal. */
@Composable
private fun Modifier.entering(node: XPNode, ctx: XPRenderCtx): Modifier {
    val e = node.entering()
    val play = e != null && node.createdAt > ctx.mountRevision
    val progress = remember(node.id) { Animatable(if (play) 0f else 1f) }
    LaunchedEffect(node.id, play) {
        if (play) progress.animateTo(1f, tween(e!!.durationMs, easing = LinearOutSlowInEasing))
    }
    if (e == null) return this
    return graphicsLayer {
        val p = progress.value
        alpha = e.opacity + (1f - e.opacity) * p
        translationX = (e.translateX * (1f - p)).dp.toPx()
        translationY = (e.translateY * (1f - p)).dp.toPx()
    }
}

/**
 * onSwipe: geseran minimal XPGesture.THRESHOLD dp. Tap biasa tetap sampai ke clickable.
 * dragAxis: selama digeser elemen ikut jari di sumbu itu, lalu kembali saat dilepas.
 */
@Composable
private fun Modifier.swipe(node: XPNode, ctx: XPRenderCtx): Modifier {
    val key = node.handler("onSwipe")
    val axis = node.string("dragAxis")
    if (key == null && axis == null) return this
    val offset = remember(node.id) { Animatable(Offset.Zero, Offset.VectorConverter) }
    val scope = rememberCoroutineScope()
    val dispatch = ctx.dispatch
    val back = { scope.launch { offset.animateTo(Offset.Zero, tween(200)) } }
    return this
        .graphicsLayer {
            translationX = offset.value.x
            translationY = offset.value.y
        }
        .pointerInput(key, axis) {
            var total = Offset.Zero
            detectDragGestures(
                onDragStart = { total = Offset.Zero },
                onDragEnd = {
                    if (key != null) {
                        XPGesture.direction(total.x.toDp().value, total.y.toDp().value)?.let { dispatch(key, listOf(it)) }
                    }
                    back()
                },
                onDragCancel = { back() },
            ) { change, amount ->
                change.consume()
                total += amount
                if (axis != null) {
                    val (x, y) = XPGesture.follow(axis, total.x, total.y)
                    scope.launch { offset.snapTo(Offset(x, y)) }
                }
            }
        }
}

private fun Modifier.testTagOf(node: XPNode): Modifier = node.string("testID")?.let { this.testTag(it) } ?: this

/** scale/translate/rotate dan animate-spin/pulse/bounce/ping. */
@Composable
private fun Modifier.xpTransform(s: XPStyle): Modifier {
    val anim = s.animation
    val loop = rememberInfiniteTransition(label = "xp-anim")
    val t by loop.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            tween(if (anim == "pulse") 2000 else 1000, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "xp-anim-t",
    )
    val moved = s.scaleX != 1f || s.scaleY != 1f || s.rotate != 0f || s.translateX != null || s.translateY != null
    if (!moved && anim == null) return this
    return graphicsLayer {
        fun len(v: XPSize?, full: Float) = when (v) {
            is XPSize.Dp -> v.value.dp.toPx()
            is XPSize.Percent -> v.fraction * full
            else -> 0f
        }
        scaleX = s.scaleX
        scaleY = s.scaleY
        rotationZ = s.rotate
        translationX = len(s.translateX, size.width)
        translationY = len(s.translateY, size.height)
        when (anim) {
            "spin" -> rotationZ += 360f * t
            "pulse" -> alpha = 1f - 0.5f * (1f - abs(1f - 2f * t)) // 1 → 0.5 → 1
            "bounce" -> {
                // naik 25% tinggi lalu turun, seperti keyframes Tailwind
                val k = abs(1f - 2f * t)
                translationY += -0.25f * size.height * (k * k)
            }
            "ping" -> {
                val p = (t / 0.75f).coerceAtMost(1f)
                scaleX *= 1f + p
                scaleY *= 1f + p
                alpha = 1f - p
            }
        }
    }
}

// --- pemetaan primitive → Compose ---

@Composable
private fun XPNodeView(ctx: XPRenderCtx, id: Int, slot: Slot) {
    val node = ctx.tree[id]
    // Keadaan elemen untuk pressedStyle / focusStyle / hoverStyle (varian className active:, focus:, hover:).
    val interaction = remember(node.id) { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val focused by interaction.collectIsFocusedAsState()
    val hovered by interaction.collectIsHoveredAsState()
    val config = LocalConfiguration.current
    val parsed = remember(node.props["style"], node.props["pressedStyle"], node.props["focusStyle"], node.props["hoverStyle"], pressed, focused, hovered, config.screenWidthDp, config.screenHeightDp) {
        XPStyle.parse(node.styleFor(pressed = pressed, focused = focused, hovered = hovered))
            .resolveScreen(config.screenWidthDp.toFloat(), config.screenHeightDp.toFloat())
    }
    if (parsed.hidden) return // display: none (className hidden)
    val style = animated(parsed)
    val hover = if (node.hasStateStyle("hover")) Modifier.hoverable(interaction) else Modifier
    val base = slot.modifier(style).testTagOf(node).entering(node, ctx).xpTransform(style).then(hover)

    when (node.type) {
        "View" -> XPContainer(ctx, node, style, base.swipe(node, ctx))
        "Pressable" -> {
            val key = node.handler("onPress")
            val click = if (key != null) {
                Modifier.clickable(
                    interactionSource = interaction,
                    indication = LocalIndication.current,
                    enabled = !node.bool("disabled"),
                ) { ctx.dispatch(key, emptyList()) }
            } else {
                Modifier
            }
            XPContainer(ctx, node, style, base.swipe(node, ctx), click)
        }
        "ScrollView" -> {
            val horizontal = node.bool("horizontal")
            val scroll = rememberScrollState()
            val scrollMod = if (horizontal) Modifier.horizontalScroll(scroll) else Modifier.verticalScroll(scroll)
            XPContainer(ctx, node, if (horizontal) style.copy(direction = "row") else style, base, scrollMod)
        }
        "Text", "#text" -> XPText(ctx, node, style, base)
        "Image" -> AsyncImage(
            model = node.string("src"),
            contentDescription = node.string("alt"),
            contentScale = when (style.objectFit) {
                "contain" -> ContentScale.Fit
                "fill" -> ContentScale.FillBounds
                else -> ContentScale.Crop
            },
            modifier = base.xpBox(style),
        )
        "TextInput" -> XPTextInput(ctx, node, style, base, interaction)
        "Modal" -> XPModal(ctx, node)
        else -> Log.w(TAG, "primitive tidak dikenal: ${node.type}")
    }
}

/**
 * View/Pressable/ScrollView. Anak dengan position: absolute ditempatkan di atas isi (relatif ke
 * kotak container, di luar padding), sisanya mengalir sebagai flex/grid.
 */
@Composable
private fun XPContainer(ctx: XPRenderCtx, node: XPNode, style: XPStyle, modifier: Modifier, interaction: Modifier = Modifier) {
    val all = node.children
    val absolute = all.filter { XPStyle.parse(ctx.tree[it].style()).absolute }
    val flow = if (absolute.isEmpty()) all else all - absolute.toSet()
    if (absolute.isEmpty()) {
        XPFlow(ctx, style, if (style.reverse) flow.reversed() else flow, modifier.xpBox(style, interaction))
        return
    }
    Box(modifier.xpBox(style, interaction, withPadding = false)) {
        XPFlow(ctx, style, if (style.reverse) flow.reversed() else flow, Modifier.xpPadding(style))
        for (child in absolute) key(child) { XPAbsolute(ctx, child, Modifier.matchParentSize()) }
    }
}

/** Isi container: kolom, baris, atau grid; garis pemisah (divide-*) dan margin auto di antaranya. */
@Composable
private fun XPFlow(ctx: XPRenderCtx, style: XPStyle, children: List<Int>, modifier: Modifier) {
    if (style.display == "grid") {
        XPGrid(ctx, style, children, modifier)
        return
    }
    val divider = style.dividerWidth > 0f
    val dividerColor = Color(style.dividerColor ?: style.color ?: 0xFFE5E7EBL)
    val autos = children.map { XPStyle.parse(ctx.tree[it].style()).autoMargin }
    if (style.isRow) {
        Row(
            if (divider) modifier.height(IntrinsicSize.Min) else modifier,
            horizontalArrangement = rowArrangement(style),
            verticalAlignment = rowAlign(style.alignItems),
        ) {
            val slot = Slot.InRow(this)
            children.forEachIndexed { i, c ->
                if ("start" in autos[i] && "end" !in autos[i]) Spacer(Modifier.weight(1f))
                key(c) { XPNodeView(ctx, c, slot) }
                if ("end" in autos[i] && "start" !in autos[i]) Spacer(Modifier.weight(1f))
                if (divider && i < children.size - 1) Box(Modifier.width(style.dividerWidth.dp).fillMaxHeight().background(dividerColor))
            }
        }
    } else {
        Column(modifier, verticalArrangement = columnArrangement(style), horizontalAlignment = columnAlign(style.alignItems)) {
            val slot = Slot.InColumn(this, stretch = style.alignItems == "stretch")
            children.forEachIndexed { i, c ->
                if ("top" in autos[i] && "bottom" !in autos[i]) Spacer(Modifier.weight(1f))
                key(c) { XPNodeView(ctx, c, slot) }
                if ("bottom" in autos[i] && "top" !in autos[i]) Spacer(Modifier.weight(1f))
                if (divider && i < children.size - 1) Box(Modifier.fillMaxWidth().height(style.dividerWidth.dp).background(dividerColor))
            }
        }
    }
}

/** display: grid → baris-baris berisi `gridColumns` sel sama lebar; gridColumnSpan memakai beberapa sel. */
@Composable
private fun XPGrid(ctx: XPRenderCtx, style: XPStyle, children: List<Int>, modifier: Modifier) {
    val cols = style.gridColumns
    val rows = ArrayList<MutableList<Pair<Int, Int>>>()
    var used = cols
    for (c in children) {
        val span = XPStyle.parse(ctx.tree[c].style()).gridColumnSpan.let { if (it < 0) cols else it.coerceIn(1, cols) }
        if (used + span > cols) {
            rows.add(ArrayList())
            used = 0
        }
        rows.last().add(c to span)
        used += span
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy((style.rowGap ?: style.gap).dp)) {
        for (row in rows) {
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy((style.columnGap ?: style.gap).dp)) {
                for ((c, span) in row) {
                    Box(Modifier.weight(span.toFloat()).fillMaxHeight(), propagateMinConstraints = true) {
                        key(c) { XPNodeView(ctx, c, Slot.Free) }
                    }
                }
                val rest = cols - row.sumOf { it.second }
                if (rest > 0) Spacer(Modifier.weight(rest.toFloat()))
            }
        }
    }
}

/** Anak position: absolute: top/right/bottom/left (dp atau % dari ukuran container). */
@Composable
private fun XPAbsolute(ctx: XPRenderCtx, id: Int, modifier: Modifier) {
    val s = XPStyle.parse(ctx.tree[id].style())
    Layout(content = { XPNodeView(ctx, id, Slot.Free) }, modifier = modifier) { measurables, constraints ->
        val w = constraints.maxWidth
        val h = constraints.maxHeight
        fun px(v: XPSize?, full: Int): Int? = when (v) {
            is XPSize.Dp -> v.value.dp.roundToPx()
            is XPSize.Percent -> (v.fraction * full).roundToInt()
            else -> null
        }
        val l = px(s.left, w)
        val r = px(s.right, w)
        val t = px(s.top, h)
        val b = px(s.bottom, h)
        // left + right (atau top + bottom) = lebar (tinggi) ikut container, seperti inset-x-0.
        val cw = if (l != null && r != null && s.width == null) (w - l - r).coerceAtLeast(0) else null
        val ch = if (t != null && b != null && s.height == null) (h - t - b).coerceAtLeast(0) else null
        if (measurables.isEmpty()) return@Layout layout(w, h) {} // display: none
        val placeable = measurables.first().measure(
            Constraints(
                minWidth = cw ?: 0, maxWidth = cw ?: w,
                minHeight = ch ?: 0, maxHeight = ch ?: h,
            ),
        )
        layout(w, h) {
            val x = l ?: r?.let { w - it - placeable.width } ?: 0
            val y = t ?: b?.let { h - it - placeable.height } ?: 0
            placeable.place(x, y)
        }
    }
}

private fun columnArrangement(s: XPStyle): Arrangement.Vertical {
    val gap = s.mainGap
    return when (s.justify) {
        "center" -> if (gap > 0f) Arrangement.spacedBy(gap.dp, Alignment.CenterVertically) else Arrangement.Center
        "flex-end" -> if (gap > 0f) Arrangement.spacedBy(gap.dp, Alignment.Bottom) else Arrangement.Bottom
        "space-between" -> Arrangement.SpaceBetween
        "space-around" -> Arrangement.SpaceAround
        "space-evenly" -> Arrangement.SpaceEvenly
        else -> if (gap > 0f) Arrangement.spacedBy(gap.dp, Alignment.Top) else Arrangement.Top
    }
}

private fun rowArrangement(s: XPStyle): Arrangement.Horizontal {
    val gap = s.mainGap
    return when (s.justify) {
        "center" -> if (gap > 0f) Arrangement.spacedBy(gap.dp, Alignment.CenterHorizontally) else Arrangement.Center
        "flex-end" -> if (gap > 0f) Arrangement.spacedBy(gap.dp, Alignment.End) else Arrangement.End
        "space-between" -> Arrangement.SpaceBetween
        "space-around" -> Arrangement.SpaceAround
        "space-evenly" -> Arrangement.SpaceEvenly
        else -> if (gap > 0f) Arrangement.spacedBy(gap.dp, Alignment.Start) else Arrangement.Start
    }
}

private fun columnAlign(v: String): Alignment.Horizontal = when (v) {
    "center" -> Alignment.CenterHorizontally
    "flex-end" -> Alignment.End
    else -> Alignment.Start
}

private fun rowAlign(v: String): Alignment.Vertical = when (v) {
    "center" -> Alignment.CenterVertically
    "flex-end" -> Alignment.Bottom
    else -> Alignment.Top
}

private fun fontFamilyOf(name: String?): FontFamily? = when (name) {
    null -> null
    "monospace" -> FontFamily.Monospace
    "serif" -> FontFamily.Serif
    "sans-serif" -> FontFamily.SansSerif
    // font yang terpasang di perangkat, mis. "Roboto Condensed"
    else -> FontFamily(android.graphics.Typeface.create(name, android.graphics.Typeface.NORMAL))
}

@Composable
private fun XPText(ctx: XPRenderCtx, node: XPNode, style: XPStyle, base: Modifier) {
    val lines = (node.props["numberOfLines"] as? Number)?.toInt() ?: style.lineClamp ?: if (style.noWrap) 1 else null
    Text(
        text = style.transform(ctx.tree.text(node)),
        modifier = base.xpBox(style),
        color = style.color?.let { Color(it) } ?: Color.Unspecified,
        fontSize = (style.fontSize ?: 16f).sp,
        fontWeight = style.fontWeight?.let { FontWeight(it.coerceIn(1, 1000)) },
        fontStyle = if (style.italic) FontStyle.Italic else null,
        fontFamily = fontFamilyOf(style.fontFamily),
        letterSpacing = style.letterSpacing?.sp ?: TextUnit.Unspecified,
        textDecoration = when (style.textDecoration) {
            "underline" -> TextDecoration.Underline
            "line-through" -> TextDecoration.LineThrough
            else -> null
        },
        lineHeight = style.lineHeight?.sp ?: TextUnit.Unspecified,
        textAlign = when (style.textAlign) {
            "center" -> TextAlign.Center
            "right" -> TextAlign.End
            "left" -> TextAlign.Start
            else -> null
        },
        softWrap = !style.noWrap,
        maxLines = lines ?: Int.MAX_VALUE,
        overflow = if (style.ellipsis || (lines != null && !style.noWrap)) TextOverflow.Ellipsis else TextOverflow.Clip,
    )
}

@Composable
private fun XPTextInput(ctx: XPRenderCtx, node: XPNode, style: XPStyle, base: Modifier, interaction: MutableInteractionSource) {
    val external = node.string("value") ?: ""
    var local by remember(node.id) { mutableStateOf(external) }
    LaunchedEffect(external) { if (external != local) local = external } // nilai dari JS menang
    val key = node.handler("onChangeText")
    val textColor = style.color?.let { Color(it) } ?: Color(0xFF1F2328)
    val fontSize = (style.fontSize ?: 16f).sp
    BasicTextField(
        value = local,
        onValueChange = { text ->
            local = text
            key?.let { ctx.dispatch(it, listOf(text)) }
        },
        modifier = base.xpBox(style),
        textStyle = TextStyle(color = textColor, fontSize = fontSize),
        singleLine = true,
        interactionSource = interaction,
        visualTransformation = if (node.bool("secure")) PasswordVisualTransformation() else VisualTransformation.None,
        decorationBox = { inner ->
            Box {
                if (local.isEmpty()) node.string("placeholder")?.let { Text(it, color = Color(0xFF8C959F), fontSize = fontSize) }
                inner()
            }
        },
    )
}

@Composable
private fun XPModal(ctx: XPRenderCtx, node: XPNode) {
    if (!node.bool("visible")) return
    val close = node.handler("onRequestClose")
    // Dialog Android: backdrop gelap + tombol back/klik luar → onRequestClose.
    Dialog(
        onDismissRequest = { close?.let { ctx.dispatch(it, emptyList()) } },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(Modifier.fillMaxWidth().padding(16.dp).testTagOf(node), contentAlignment = Alignment.Center) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                val slot = Slot.InColumn(this, stretch = false)
                node.children.forEach { key(it) { XPNodeView(ctx, it, slot) } }
            }
        }
    }
}
