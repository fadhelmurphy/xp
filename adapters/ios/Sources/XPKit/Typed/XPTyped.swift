import Foundation

// Runtime untuk komponen xp yang dikompilasi ke Swift bertipe (`xp build`, mode typed).
//
// Kode komponen hasil compiler adalah Swift biasa dengan tipe yang jelas: state `Double`, `String`,
// class, dan seterusnya. Runtime ini hanya mengurus identitas komponen (hooks per instance, key,
// urutan), effect, dan timer, dengan aturan yang sama dengan runtime/reconciler.ts dan XPTyped.kt.
// Hasilnya tree node host (View, Text, ...) yang langsung dirender SwiftUI: tanpa daftar operasi,
// tanpa JSON, tanpa XPTree.
//
// Tidak thread-safe: panggil dari satu thread (main thread di app).

/// Handler event dari renderer: argumen sesuai event (onSwipe → arah, onChangeText → teks, ...).
public typealias XPHandler = ([Any?]) -> Void

/// Elemen hasil render komponen (sama dengan VNode di JS).
public final class XPEl {
    public let type: String
    public let key: String?
    public let props: [String: Any?]
    public let handlers: [String: XPHandler]
    public let children: Any?
    /// Komponen buatan user: fungsi render-nya. Nil untuk primitive.
    let render: ((XPHooks) -> Any?)?

    init(_ type: String, _ key: String?, _ props: [String: Any?], _ handlers: [String: XPHandler], _ children: Any?, _ render: ((XPHooks) -> Any?)?) {
        self.type = type
        self.key = key
        self.props = props
        self.handlers = handlers
        self.children = children
        self.render = render
    }
}

/// `<View style={...} onPress={...}>...</View>`
public func el(_ type: String, props: [String: Any?] = [:], handlers: [String: XPHandler] = [:], key: String? = nil, children: Any? = nil) -> XPEl {
    XPEl(type, key, props, handlers, children, nil)
}

/// `<Card title="..."/>`: komponen user. Identitasnya nama komponen + key/posisi, seperti di JS.
public func comp<P>(_ name: String, _ key: String?, _ props: P, _ render: @escaping (P, XPHooks) -> Any?) -> XPEl {
    XPEl(name, key, [:], [:], nil) { h in render(props, h) }
}

/// Komponen terkompilasi (mode typed). Props dari app masih berupa dictionary; komponen mengubahnya ke class.
public protocol XPTypedComponent {
    var name: String { get }
    var hash: String { get }
    func render(_ props: [String: Any?], _ h: XPHooks) -> Any?
}

/// Daftar komponen mode typed milik app (class `XPGeneratedComponents` dari xp-components.swift).
public protocol XPTypedRegistry {
    static var typedComponents: [String: XPTypedComponent] { get }
}

/// Node host di tree hasil: yang dirender SwiftUI.
public final class XPHostNode {
    public let id: Int
    public let type: String
    public let key: String?
    /// Revisi saat node dibuat: animasi `entering` hanya untuk node yang baru muncul.
    public let createdAt: Int
    /// Props untuk renderer: tanpa nilai nil, bentuknya sama dengan props XPNode.
    public internal(set) var props: [String: Any] = [:]
    public internal(set) var handlers: [String: XPHandler] = [:]
    public internal(set) var children: [XPHostNode] = []

    init(_ id: Int, _ type: String, _ key: String?, _ createdAt: Int) {
        self.id = id
        self.type = type
        self.key = key
        self.createdAt = createdAt
    }

    public func handler(_ name: String) -> XPHandler? { handlers[name] }
}

/// Nilai `environment()`.
public struct XPEnv: Equatable {
    public let width: Double
    public let height: Double
    public let dark: Bool
}

public final class XPRef<T> {
    public var current: T
    init(_ current: T) { self.current = current }
}

/// Setter dari useState: `setX(v)` atau `setX.update { prev in ... }`.
public final class XPSetter<T> {
    private let slot: XPHooks.Slot
    init(_ slot: XPHooks.Slot) { self.slot = slot }

    public func callAsFunction(_ value: T) { slot.set(value) }

    public func update(_ f: (T) -> T) { slot.set(f(slot.value as! T)) }
}

/// Hooks satu instance komponen. Urutan pemanggilan harus tetap (aturan hooks yang sama dengan React).
public final class XPHooks {
    final class Slot {
        unowned let rt: XPTypedRuntime
        var hasValue = false
        var value: Any? = nil
        weak var owner: XPTypedRuntime.CompInst?
        var setter: AnyObject? = nil
        var deps: [Any?]? = nil
        var hasDeps = false
        var pending: (() -> (() -> Void)?)? = nil
        var cleanup: (() -> Void)? = nil

        init(_ rt: XPTypedRuntime) { self.rt = rt }

        func set(_ next: Any?) {
            if XPStd.same(next, value) { return }
            value = next
            if let o = owner { rt.schedule(o) }
        }
    }

    unowned let rt: XPTypedRuntime
    unowned let inst: XPTypedRuntime.CompInst
    var slots: [Slot] = []
    var index = 0

    init(_ rt: XPTypedRuntime, _ inst: XPTypedRuntime.CompInst) {
        self.rt = rt
        self.inst = inst
    }

    private func next() -> Slot {
        let i = index
        index += 1
        if i < slots.count { return slots[i] }
        let s = Slot(rt)
        slots.append(s)
        return s
    }

    public func state<T>(_ initial: () -> T) -> (T, XPSetter<T>) {
        let s = next()
        if !s.hasValue {
            s.value = initial()
            s.hasValue = true
            s.setter = XPSetter<T>(s)
        }
        s.owner = inst
        return (s.value as! T, s.setter as! XPSetter<T>)
    }

    public func ref<T>(_ initial: () -> T) -> XPRef<T> {
        let s = next()
        if !s.hasValue {
            s.value = XPRef(initial())
            s.hasValue = true
        }
        return s.value as! XPRef<T>
    }

    public func memo<T>(_ deps: [Any?], _ f: () -> T) -> T {
        let s = next()
        if !s.hasValue || XPTypedRuntime.depsChanged(s.deps, deps) {
            s.value = f()
            s.hasValue = true
            s.deps = deps
        }
        return s.value as! T
    }

    /// useEffect. deps nil = setiap render. Fungsi boleh mengembalikan cleanup.
    public func effect(_ deps: [Any?]?, _ f: @escaping () -> (() -> Void)?) {
        let s = next()
        if deps == nil || !s.hasDeps || XPTypedRuntime.depsChanged(s.deps, deps) {
            s.pending = f
            s.deps = deps
            s.hasDeps = true
            rt.effects.append(s)
        }
    }

    public var env: XPEnv { rt.env }

    @discardableResult public func setTimeout(_ ms: Double, _ f: @escaping () -> Void) -> Double { rt.addTimer(ms, f, repeating: false) }
    @discardableResult public func setInterval(_ ms: Double, _ f: @escaping () -> Void) -> Double { rt.addTimer(ms, f, repeating: true) }
    public func clearTimeout(_ id: Double?) { rt.removeTimer(id) }
    public func clearInterval(_ id: Double?) { rt.removeTimer(id) }
}

public final class XPTypedRuntime {
    static let TEXT = "#text"

    static func depsChanged(_ a: [Any?]?, _ b: [Any?]?) -> Bool {
        guard let a = a, let b = b, a.count == b.count else { return true }
        return a.indices.contains { !XPStd.same(a[$0], b[$0]) }
    }

    private let component: XPTypedComponent

    /// Dipanggil setiap ada state yang berubah di luar render (event, timer): host menjadwalkan flush().
    public var onInvalidate: () -> Void = {}

    /// Dipanggil setelah tree berubah (sesudah flush).
    public var onCommit: () -> Void = {}

    public var clock: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }

    public init(_ component: XPTypedComponent) {
        self.component = component
    }

    // MARK: instance

    class Inst {
        var key: String? { nil }
        var children: [Inst] = []
    }

    final class HostInst: Inst {
        let node: XPHostNode
        init(_ node: XPHostNode) { self.node = node }
        override var key: String? { node.key }
    }

    final class CompInst: Inst {
        let name: String
        let ownKey: String?
        var render: (XPHooks) -> Any?
        unowned let hostParent: HostInst
        let depth: Int
        var hooks: XPHooks? = nil
        var unmounted = false
        var renderedIn = -1

        init(_ name: String, _ key: String?, _ render: @escaping (XPHooks) -> Any?, _ hostParent: HostInst, _ depth: Int) {
            self.name = name
            self.ownKey = key
            self.render = render
            self.hostParent = hostParent
            self.depth = depth
        }

        override var key: String? { ownKey }
    }

    private var nextId = 1
    private let container = HostInst(XPHostNode(0, "#root", nil, 0))
    private var dirty: [CompInst] = []
    private var scheduled = false
    private var flushId = 0
    var effects: [XPHooks.Slot] = []
    private var lastElement: XPEl? = nil
    private var rendering = false

    /// Node teratas yang dirender host.
    public var root: [XPHostNode] { container.node.children }

    /// Naik setiap kali tree berubah; host SwiftUI memakai ini untuk render ulang.
    public private(set) var revision = 0

    public private(set) var env = XPEnv(width: 0, height: 0, dark: false)

    private func normalize(_ node: Any?, _ out: inout [XPEl]) {
        guard let node = node else { return }
        switch node {
        case is Bool, is Void: return
        case let l as [Any?]: for n in l { normalize(XPStd.flat(n), &out) }
        case let s as String: out.append(el(XPTypedRuntime.TEXT, props: ["value": s]))
        case let d as Double: out.append(el(XPTypedRuntime.TEXT, props: ["value": XPStd.str(d)]))
        case let i as Int: out.append(el(XPTypedRuntime.TEXT, props: ["value": XPStd.str(Double(i))]))
        case let e as XPEl: out.append(e)
        default: preconditionFailure("child tidak didukung: \(node)")
        }
    }

    private func normalized(_ node: Any?) -> [XPEl] {
        var out: [XPEl] = []
        normalize(XPStd.flat(node), &out)
        return out
    }

    private func hostNodes(_ inst: Inst) -> [XPHostNode] {
        if let h = inst as? HostInst { return [h.node] }
        return inst.children.flatMap { hostNodes($0) }
    }

    private func syncChildren(_ h: HostInst) {
        let nodes = h.children.flatMap { hostNodes($0) }
        if !nodes.elementsEqual(h.node.children, by: ===) { h.node.children = nodes }
    }

    private func apply(_ node: XPHostNode, _ v: XPEl) {
        node.props = XPStd.hostProps(v.props)
        node.handlers = v.handlers
    }

    private func mount(_ v: XPEl, _ hostParent: HostInst, _ depth: Int) -> Inst {
        guard let render = v.render else {
            let inst = HostInst(XPHostNode(nextId, v.type, v.key, revision + 1))
            nextId += 1
            apply(inst.node, v)
            inst.children = reconcile([], normalized(v.children), inst, depth + 1)
            syncChildren(inst)
            return inst
        }
        let inst = CompInst(v.type, v.key, render, hostParent, depth)
        renderComp(inst)
        return inst
    }

    private func update(_ inst: Inst, _ v: XPEl, _ depth: Int) {
        if let h = inst as? HostInst {
            apply(h.node, v)
            h.children = reconcile(h.children, normalized(v.children), h, depth + 1)
            syncChildren(h)
        } else if let c = inst as? CompInst {
            c.render = v.render!
            renderComp(c)
        }
    }

    private func renderComp(_ inst: CompInst) {
        let h: XPHooks
        if let existing = inst.hooks { h = existing } else { h = XPHooks(self, inst); inst.hooks = h }
        h.index = 0
        let out = inst.render(h)
        inst.renderedIn = flushId
        inst.children = reconcile(inst.children, normalized(out), inst.hostParent, inst.depth + 1)
    }

    private func unmount(_ inst: Inst) {
        if let c = inst as? CompInst {
            c.unmounted = true
            c.hooks?.slots.forEach { $0.cleanup?() }
        }
        for child in inst.children { unmount(child) }
    }

    private func sameType(_ inst: Inst, _ v: XPEl) -> Bool {
        if let h = inst as? HostInst { return v.render == nil && h.node.type == v.type }
        if let c = inst as? CompInst { return v.render != nil && c.name == v.type }
        return false
    }

    private func reconcile(_ old: [Inst], _ next: [XPEl], _ hostParent: HostInst, _ depth: Int) -> [Inst] {
        var byKey: [String: Inst] = [:]
        var unkeyed: [Inst] = []
        for o in old {
            if let k = o.key { byKey[k] = o } else { unkeyed.append(o) }
        }
        var used = Set<ObjectIdentifier>()
        var u = 0
        let result = next.map { v -> Inst in
            var match: Inst? = nil
            if let k = v.key { match = byKey[k] } else if u < unkeyed.count { match = unkeyed[u]; u += 1 } else { u += 1 }
            if let m = match, !used.contains(ObjectIdentifier(m)), sameType(m, v) {
                used.insert(ObjectIdentifier(m))
                update(m, v, depth)
                return m
            }
            return mount(v, hostParent, depth)
        }
        for o in old where !used.contains(ObjectIdentifier(o)) { unmount(o) }
        return result
    }

    // MARK: penjadwalan

    func schedule(_ c: CompInst) {
        if !dirty.contains(where: { $0 === c }) { dirty.append(c) }
        if !scheduled {
            scheduled = true
            if !rendering { onInvalidate() }
        }
    }

    private func flushOnce() {
        scheduled = false
        flushId += 1
        // Urutan stabil: yang lebih dangkal dulu, sesama kedalaman sesuai urutan dijadwalkan.
        let list = dirty.enumerated().sorted { ($0.element.depth, $0.offset) < ($1.element.depth, $1.offset) }.map { $0.element }
        dirty.removeAll()
        var parents: [HostInst] = []
        for c in list {
            if c.unmounted || c.renderedIn == flushId { continue }
            renderComp(c)
            if !parents.contains(where: { $0 === c.hostParent }) { parents.append(c.hostParent) }
        }
        for p in parents { syncChildren(p) }
        commit()
    }

    private func commit() {
        revision += 1
        let run = effects
        effects = []
        for s in run {
            s.cleanup?()
            s.cleanup = s.pending?()
        }
    }

    /// Render ulang semua komponen yang state-nya berubah, sampai stabil.
    public func flush() {
        var i = 0
        rendering = true
        defer { rendering = false }
        while scheduled {
            precondition(i <= 50, "terlalu banyak update berantai (setState di dalam effect?)")
            i += 1
            flushOnce()
        }
        rendering = false
        onCommit()
    }

    private func renderRoot(_ element: XPEl) {
        lastElement = element
        rendering = true
        flushId += 1
        container.children = reconcile(container.children, [element], container, 0)
        syncChildren(container)
        commit()
        rendering = false
        flush()
    }

    // MARK: timer

    private final class Timer {
        var at: Int64
        let fn: () -> Void
        let every: Int64?
        init(_ at: Int64, _ fn: @escaping () -> Void, _ every: Int64?) {
            self.at = at
            self.fn = fn
            self.every = every
        }
    }

    private var timers: [Int: Timer] = [:]
    private var timerOrder: [Int] = []
    private var lastTimer = 0

    func addTimer(_ ms: Double, _ fn: @escaping () -> Void, repeating: Bool) -> Double {
        let delay: Int64 = ms.isNaN ? 0 : max(0, Int64(ms))
        lastTimer += 1
        timers[lastTimer] = Timer(clock() + delay, fn, repeating ? max(1, delay) : nil)
        timerOrder.append(lastTimer)
        return Double(lastTimer)
    }

    func removeTimer(_ id: Double?) {
        guard let id = id, !id.isNaN, id.isFinite else { return }
        let i = Int(id)
        timers[i] = nil
        timerOrder.removeAll { $0 == i }
    }

    /// Jalankan timer yang sudah jatuh tempo, lalu render ulang.
    public func tick() {
        let now = clock()
        for _ in 0..<1000 {
            var best: (Int, Timer)? = nil
            for id in timerOrder {
                guard let t = timers[id], t.at <= now else { continue }
                if best == nil || t.at < best!.1.at { best = (id, t) }
            }
            guard let (id, t) = best else { break }
            if let every = t.every {
                t.at += every
                if t.at <= now { t.at = now + every }
            } else {
                timers[id] = nil
                timerOrder.removeAll { $0 == id }
            }
            t.fn()
        }
        flush()
    }

    /// ms sampai timer berikutnya, atau -1 kalau tidak ada.
    public func nextTimer() -> Int64 {
        guard let at = timers.values.map({ $0.at }).min() else { return -1 }
        return max(0, at - clock())
    }

    // MARK: API untuk host (sama dengan XP.* di bundle JS)

    public func mount(_ props: [String: Any?]) {
        let c = component
        renderRoot(comp(c.name, nil, props) { p, h in c.render(p, h) })
    }

    public func update(_ props: [String: Any?]) { mount(props) }

    private var breakpoints: [Double] = []
    private var viewportUnits = false

    /// Dari className: lebar layar yang mengubah tampilan, dan apakah ada satuan vh/vw.
    func registerBreakpoints(_ list: [Double], _ viewport: Bool) {
        for w in list where !breakpoints.contains(w) { breakpoints.append(w) }
        if viewport { viewportUnits = true }
    }

    /// Ukuran layar / mode gelap. Render ulang hanya kalau tampilannya bisa berubah (sama dengan JS).
    public func environment(width: Double, height: Double, dark: Bool) {
        let prev = env
        let next = XPEnv(width: width, height: height, dark: dark)
        env = next
        let crossed = breakpoints.contains { (prev.width >= $0) != (next.width >= $0) }
        let resized = viewportUnits && (prev.width != next.width || prev.height != next.height)
        if (crossed || resized || prev.dark != next.dark), let last = lastElement { renderRoot(last) }
    }

    /// Panggil handler event milik node (dari renderer), lalu render ulang.
    public func dispatch(_ handler: XPHandler, _ args: [Any?]) {
        rendering = true
        handler(args)
        rendering = false
        flush()
    }

    public func unmount() {
        lastElement = nil
        for c in container.children { unmount(c) }
        container.children = []
        syncChildren(container)
        timers.removeAll()
        timerOrder.removeAll()
        revision += 1
        onCommit()
    }
}

/// Class hasil compiler (type alias / interface) yang bisa dikirim ke renderer sebagai dictionary.
public protocol XPHostValue: AnyObject {
    func toHost() -> [String: Any?]
}

/// Dictionary untuk style / object yang dikirim ke renderer.
public func xpMap(_ m: [String: Any?]) -> [String: Any?] { m }

/// Props primitive: nilai nil (undefined di JS) tidak dikirim.
public func xpProps(_ m: [String: Any?]) -> [String: Any?] { m.filter { XPStd.flat($0.value) != nil } }

/// `{ ...a, ...b, x: 1 }`
public func xpMerge(_ parts: [String: Any?]?...) -> [String: Any?] {
    var out: [String: Any?] = [:]
    for p in parts { if let p = p { out.merge(p) { _, new in new } } }
    return out
}
