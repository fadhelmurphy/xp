package dev.xp.android

import android.util.Log
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
import androidx.compose.foundation.clickable
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
    SideEffect { holder.latestProps = propsJson }

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
            fresh.applyBatches(next.mount(latestProps, snapshot))
            tree = fresh
            engine = next
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

// --- tata letak: posisi anak di dalam parent (flex, alignSelf, stretch) ---

private sealed interface Slot {
    class InColumn(val scope: ColumnScope, val stretch: Boolean) : Slot
    class InRow(val scope: RowScope) : Slot
}

private fun Slot.modifier(s: XPStyle): Modifier = when (this) {
    is Slot.InColumn -> with(scope) {
        var m: Modifier = Modifier
        if (s.flex > 0f) m = m.weight(s.flex)
        m = when (s.alignSelf) {
            "center" -> m.align(Alignment.CenterHorizontally)
            "flex-end" -> m.align(Alignment.End)
            "flex-start" -> m.align(Alignment.Start)
            "stretch" -> m.fillMaxWidth()
            // Default flexbox kolom: anak melebar penuh (seperti di web).
            else -> if (stretch && s.width == null) m.fillMaxWidth() else m
        }
        m
    }
    is Slot.InRow -> with(scope) {
        var m: Modifier = Modifier
        if (s.flex > 0f) m = m.weight(s.flex)
        when (s.alignSelf) {
            "center" -> m.align(Alignment.CenterVertically)
            "flex-end" -> m.align(Alignment.Bottom)
            "flex-start" -> m.align(Alignment.Top)
            else -> m
        }
    }
}

/** Box model: margin → ukuran → opacity → bentuk/latar/border → [interaction] → padding. */
private fun Modifier.xpBox(s: XPStyle, interaction: Modifier = Modifier): Modifier {
    var m = this
    if (!s.margin.isZero) m = m.padding(start = s.margin.start.dp, top = s.margin.top.dp, end = s.margin.end.dp, bottom = s.margin.bottom.dp)
    if (s.minWidth != null || s.maxWidth != null) {
        m = m.widthIn(min = s.minWidth?.dp ?: Dp.Unspecified, max = s.maxWidth?.dp ?: Dp.Unspecified)
    }
    s.minHeight?.let { m = m.heightIn(min = it.dp) }
    m = when (val w = s.width) {
        is XPSize.Dp -> m.width(w.value.dp)
        is XPSize.Percent -> m.fillMaxWidth(w.fraction)
        null -> m
    }
    m = when (val h = s.height) {
        is XPSize.Dp -> m.height(h.value.dp)
        is XPSize.Percent -> m.fillMaxHeight(h.fraction)
        null -> m
    }
    if (s.opacity < 1f) m = m.alpha(s.opacity)
    val shape = if (s.radius > 0f) RoundedCornerShape(s.radius.dp) else RectangleShape
    if (s.radius > 0f) m = m.clip(shape)
    s.background?.let { m = m.background(Color(it), shape) }
    if (s.borderWidth > 0f) m = m.border(s.borderWidth.dp, Color(s.borderColor ?: 0xFF000000), shape)
    m = m.then(interaction)
    if (!s.padding.isZero) m = m.padding(start = s.padding.start.dp, top = s.padding.top.dp, end = s.padding.end.dp, bottom = s.padding.bottom.dp)
    return m
}

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
    if (ms == 0) return s
    return s.copy(
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

// --- pemetaan primitive → Compose ---

@Composable
private fun XPNodeView(ctx: XPRenderCtx, id: Int, slot: Slot) {
    val node = ctx.tree[id]
    val parsed = remember(node.props["style"]) { XPStyle.parse(node.style()) }
    val style = animated(parsed)
    val base = slot.modifier(style).testTagOf(node).entering(node, ctx)

    when (node.type) {
        "View" -> XPContainer(ctx, node, style, base.swipe(node, ctx).xpBox(style))
        "Pressable" -> {
            val key = node.handler("onPress")
            val click = if (key != null) {
                Modifier.clickable(enabled = !node.bool("disabled")) { ctx.dispatch(key, emptyList()) }
            } else {
                Modifier
            }
            XPContainer(ctx, node, style, base.swipe(node, ctx).xpBox(style, click))
        }
        "ScrollView" -> {
            val horizontal = node.bool("horizontal")
            val scroll = rememberScrollState()
            val scrollMod = if (horizontal) Modifier.horizontalScroll(scroll) else Modifier.verticalScroll(scroll)
            XPContainer(ctx, node, if (horizontal) style.copy(direction = "row") else style, base.xpBox(style, scrollMod))
        }
        "Text", "#text" -> XPText(ctx, node, style, base)
        "Image" -> AsyncImage(
            model = node.string("src"),
            contentDescription = node.string("alt"),
            contentScale = ContentScale.Crop,
            modifier = base.xpBox(style),
        )
        "TextInput" -> XPTextInput(ctx, node, style, base)
        "Modal" -> XPModal(ctx, node)
        else -> Log.w(TAG, "primitive tidak dikenal: ${node.type}")
    }
}

@Composable
private fun XPContainer(ctx: XPRenderCtx, node: XPNode, style: XPStyle, modifier: Modifier) {
    if (style.direction == "row") {
        Row(modifier, horizontalArrangement = rowArrangement(style), verticalAlignment = rowAlign(style.alignItems)) {
            val slot = Slot.InRow(this)
            node.children.forEach { key(it) { XPNodeView(ctx, it, slot) } }
        }
    } else {
        Column(modifier, verticalArrangement = columnArrangement(style), horizontalAlignment = columnAlign(style.alignItems)) {
            val slot = Slot.InColumn(this, stretch = style.alignItems == "stretch")
            node.children.forEach { key(it) { XPNodeView(ctx, it, slot) } }
        }
    }
}

private fun columnArrangement(s: XPStyle): Arrangement.Vertical {
    val gap = s.gap.dp
    return when (s.justify) {
        "center" -> if (s.gap > 0f) Arrangement.spacedBy(gap, Alignment.CenterVertically) else Arrangement.Center
        "flex-end" -> if (s.gap > 0f) Arrangement.spacedBy(gap, Alignment.Bottom) else Arrangement.Bottom
        "space-between" -> Arrangement.SpaceBetween
        "space-around" -> Arrangement.SpaceAround
        else -> if (s.gap > 0f) Arrangement.spacedBy(gap, Alignment.Top) else Arrangement.Top
    }
}

private fun rowArrangement(s: XPStyle): Arrangement.Horizontal {
    val gap = s.gap.dp
    return when (s.justify) {
        "center" -> if (s.gap > 0f) Arrangement.spacedBy(gap, Alignment.CenterHorizontally) else Arrangement.Center
        "flex-end" -> if (s.gap > 0f) Arrangement.spacedBy(gap, Alignment.End) else Arrangement.End
        "space-between" -> Arrangement.SpaceBetween
        "space-around" -> Arrangement.SpaceAround
        else -> if (s.gap > 0f) Arrangement.spacedBy(gap, Alignment.Start) else Arrangement.Start
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

@Composable
private fun XPText(ctx: XPRenderCtx, node: XPNode, style: XPStyle, base: Modifier) {
    val lines = (node.props["numberOfLines"] as? Number)?.toInt()
    Text(
        text = ctx.tree.text(node),
        modifier = base.xpBox(style),
        color = style.color?.let { Color(it) } ?: Color.Unspecified,
        fontSize = (style.fontSize ?: 16f).sp,
        fontWeight = style.fontWeight?.let { FontWeight(it.coerceIn(1, 1000)) },
        lineHeight = style.lineHeight?.sp ?: TextUnit.Unspecified,
        textAlign = when (style.textAlign) {
            "center" -> TextAlign.Center
            "right" -> TextAlign.End
            "left" -> TextAlign.Start
            else -> null
        },
        maxLines = lines ?: Int.MAX_VALUE,
        overflow = if (lines != null) TextOverflow.Ellipsis else TextOverflow.Clip,
    )
}

@Composable
private fun XPTextInput(ctx: XPRenderCtx, node: XPNode, style: XPStyle, base: Modifier) {
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
