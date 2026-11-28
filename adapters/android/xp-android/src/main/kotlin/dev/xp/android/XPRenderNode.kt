package dev.xp.android

import dev.xp.android.typed.XPHostNode
import dev.xp.android.typed.XPTypedRuntime

/**
 * Node yang dirender Compose. Sumbernya bisa XPTree (bundle JS / komponen dinamis, lewat operasi UI)
 * atau tree host dari runtime typed (komponen Kotlin bertipe, tanpa operasi). Renderer tidak perlu
 * tahu bedanya.
 */
interface XPRNode {
    val id: Int
    val type: String
    val props: Map<String, Any?>
    val createdAt: Int
    val children: List<XPRNode>

    /** Pemanggil handler event (onPress, onSwipe, ...), atau null kalau tidak ada. */
    fun handler(prop: String): ((List<Any?>) -> Unit)?
}

fun XPRNode.string(prop: String): String? = props[prop] as? String

fun XPRNode.bool(prop: String): Boolean = props[prop] == true

@Suppress("UNCHECKED_CAST")
fun XPRNode.style(): Map<String, Any?> = props["style"] as? Map<String, Any?> ?: emptyMap()

/** Style sesuai keadaan elemen: hoverStyle, focusStyle, lalu pressedStyle di atas style. */
@Suppress("UNCHECKED_CAST")
fun XPRNode.styleFor(pressed: Boolean = false, focused: Boolean = false, hovered: Boolean = false): Map<String, Any?> {
    val layers = listOfNotNull(
        "hoverStyle".takeIf { hovered },
        "focusStyle".takeIf { focused },
        "pressedStyle".takeIf { pressed },
    ).mapNotNull { props[it] as? Map<String, Any?> }
    if (layers.isEmpty()) return style()
    val out = LinkedHashMap(style())
    for (l in layers) out.putAll(l)
    return out
}

fun XPRNode.hasStateStyle(state: String): Boolean = props["${state}Style"] is Map<*, *>

@Suppress("UNCHECKED_CAST")
fun XPRNode.entering(): XPEntering? = (props["entering"] as? Map<String, Any?>)?.let { XPEntering.parse(it) }

/** Isi teks node Text: gabungan semua node teks di dalamnya. */
fun XPRNode.text(): String =
    if (type == "#text") props["value"]?.let { if (it is Double && it == Math.rint(it)) it.toLong().toString() else it.toString() } ?: ""
    else children.joinToString("") { it.text() }

/** Node dari XPTree. Handler dikirim ke engine lewat key ("5:onPress"). */
class XPTreeRNode(private val tree: XPTree, private val node: XPNode, private val dispatch: (String, List<Any?>) -> Unit) : XPRNode {
    override val id: Int get() = node.id
    override val type: String get() = node.type
    override val props: Map<String, Any?> get() = node.props
    override val createdAt: Int get() = node.createdAt
    override val children: List<XPRNode> get() = node.children.map { XPTreeRNode(tree, tree[it], dispatch) }
    override fun handler(prop: String): ((List<Any?>) -> Unit)? = node.handler(prop)?.let { key -> { args -> dispatch(key, args) } }
}

/** Node dari runtime typed. Handler langsung memanggil kode Kotlin komponen. */
class XPTypedRNode(private val rt: XPTypedRuntime, private val node: XPHostNode) : XPRNode {
    override val id: Int get() = node.id
    override val type: String get() = node.type
    override val props: Map<String, Any?> get() = node.props
    override val createdAt: Int get() = node.createdAt
    override val children: List<XPRNode> get() = node.children.map { XPTypedRNode(rt, it) }
    override fun handler(prop: String): ((List<Any?>) -> Unit)? = node.handler(prop)?.let { h -> { args -> rt.dispatch(h, args) } }
}
