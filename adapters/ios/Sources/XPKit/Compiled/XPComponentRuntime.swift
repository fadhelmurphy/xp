import Foundation

/// Elemen JSX (`<View ...>`) di komponen terkompilasi.
public final class XPElement {
    let type: JsValue
    let props: JsObject
    let key: String?
    init(_ type: JsValue, _ props: JsObject, _ key: String?) {
        self.type = type
        self.props = props
        self.key = key
    }
}

/// Komponen hasil `xp build` (padanan XPCompiledComponent di Android).
public protocol XPCompiledComponent {
    var name: String { get }
    /// Hash sumber komponen saat dikompilasi.
    var hash: String { get }
    /// Jalankan modul komponen dan kembalikan fungsi komponennya (export default).
    func create(_ scope: XPScope) throws -> JsFunction
}

/// Daftar komponen terkompilasi milik app (class `XPGeneratedComponents` hasil xp build).
public protocol XPComponentRegistry {
    static var components: [String: XPCompiledComponent] { get }
}

/// Akses kode komponen ke runtime: objek `__xp` (hooks, jsx) dan global (Math, setTimeout, ...).
public final class XPScope {
    private unowned let rt: XPComponentRuntime
    init(_ rt: XPComponentRuntime) { self.rt = rt }
    public func global(_ name: String) throws -> JsValue { try rt.global(name) }
}

/// Runtime untuk komponen xp yang dikompilasi ke Swift. Isinya sama dengan runtime JS
/// (runtime/reconciler.ts + hosts/native.ts + hosts/timers.ts) dan XPComponentRuntime.kt:
/// hooks, rekonsiliasi, dan operasi UI dengan bentuk yang sama, jadi renderer SwiftUI yang sama
/// bisa menampilkannya. Bedanya, kode komponen jalan sebagai kode Swift biasa, tanpa JavaScriptCore.
///
/// Tidak thread-safe: panggil semua method dari satu thread / actor.
public final class XPComponentRuntime {
    public static let protocolVersion = 1
    static let text = "#text"

    private let component: XPCompiledComponent

    public init(_ component: XPCompiledComponent) {
        self.component = component
    }

    // MARK: host (bentuk operasi sama dengan JSON dari runtime JS)

    private var ops: [Any] = []
    private var queue: [Any] = []
    private var handlers: [String: JsFunction] = [:]

    private func hostCreate(_ id: Int, _ type: String) {
        ops.append(["create", NSNumber(value: id), type] as [Any])
    }

    private func hostSetProps(_ id: Int, _ changed: JsObject) {
        var out: [String: Any] = [:]
        var any = false
        for (k, v) in changed.entries {
            let key = "\(id):\(k)"
            if case .fn(let f) = v {
                let known = handlers[key] != nil
                handlers[key] = f
                if known { continue } // hanya fungsinya yang berganti
                out[k] = ["$fn": key]
            } else {
                if handlers.removeValue(forKey: key) != nil && v.isNull {
                    out[k] = NSNull()
                    any = true
                    continue
                }
                out[k] = Js.toHost(v)
            }
            any = true
        }
        if any { ops.append(["props", NSNumber(value: id), out] as [Any]) }
    }

    private func hostSetChildren(_ id: Int, _ children: [Int]) {
        ops.append(["children", NSNumber(value: id), children.map { NSNumber(value: $0) }] as [Any])
    }

    private func hostRemove(_ id: Int) {
        let prefix = "\(id):"
        for k in handlers.keys where k.hasPrefix(prefix) { handlers.removeValue(forKey: k) }
        ops.append(["delete", NSNumber(value: id)] as [Any])
    }

    private func hostCommit() {
        if ops.isEmpty { return }
        queue.append(["v": NSNumber(value: XPComponentRuntime.protocolVersion), "ops": ops] as [String: Any])
        ops = []
    }

    private func drain() -> [Any] {
        let out = queue
        queue = []
        return out
    }

    // MARK: model instance

    private final class Hook {
        var hasValue = false
        var value: JsValue = .null
        var set: JsFunction?
        weak var owner: CompInst?
        var dispatch: ((JsValue) throws -> Void)?
        var ref: JsObject?
        var deps: [JsValue]?
        var hasDeps = false
        var pending: JsFunction?
        var cleanup: JsFunction?
    }

    private class Inst {
        let key: String?
        let path: String
        var props: JsObject
        var children: [Inst] = []
        init(key: String?, path: String, props: JsObject) {
            self.key = key
            self.path = path
            self.props = props
        }
    }

    private final class HostInst: Inst {
        let type: String
        let id: Int
        var lastIds: [Int] = []
        init(type: String, id: Int, key: String?, path: String, props: JsObject) {
            self.type = type
            self.id = id
            super.init(key: key, path: path, props: props)
        }
    }

    private final class CompInst: Inst {
        let type: JsFunction
        unowned let hostParent: HostInst
        let depth: Int
        var hooks: [Hook] = []
        var unmounted = false
        var renderedIn = -1
        init(type: JsFunction, key: String?, path: String, props: JsObject, hostParent: HostInst, depth: Int) {
            self.type = type
            self.hostParent = hostParent
            self.depth = depth
            super.init(key: key, path: path, props: props)
        }
    }

    // MARK: state root

    private var nextId = 1
    private var dirty: [CompInst] = []
    private var scheduled = false
    private var flushId = 0
    private var effects: [Hook] = []
    private let container = HostInst(type: "#root", id: 0, key: nil, path: "", props: JsObject())
    private var lastElement: JsValue = .null

    private var current: CompInst?
    private var hookIndex = 0

    // MARK: JSX

    private lazy var fragment = JsFunction("Fragment") { a in
        if case .obj(let p) = Js.arg(a, 0) { return p["children"] ?? .null }
        return .null
    }

    private lazy var jsx = JsFunction("jsx") { a in
        let type = Js.arg(a, 0)
        if type.isNull { throw JsError("TypeError: jsx tanpa type") }
        var props = JsObject()
        if case .obj(let p) = Js.arg(a, 1) { props = p }
        let key = Js.arg(a, 2)
        return .elem(XPElement(type, props, key.isNull ? nil : Js.toStr(key)))
    }

    private lazy var createElement = JsFunction("createElement") { a in
        let type = Js.arg(a, 0)
        if type.isNull { throw JsError("TypeError: createElement tanpa type") }
        let props = JsObject()
        var key: String?
        if case .obj(let src) = Js.arg(a, 1) {
            for (k, v) in src.entries {
                if k == "key" { key = v.isNull ? nil : Js.toStr(v) } else { props[k] = v }
            }
        }
        let children = Array(a.dropFirst(2))
        if !children.isEmpty { props["children"] = children.count == 1 ? children[0] : .arr(JsArray(children)) }
        return .elem(XPElement(type, props, key))
    }

    private func normalize(_ node: JsValue, _ out: inout [XPElement]) throws {
        switch node {
        case .null, .bool: break
        case .arr(let l): for n in l.items { try normalize(n, &out) }
        case .str(let s): out.append(XPElement(.str(XPComponentRuntime.text), JsObject([("value", .str(s))]), nil))
        case .num: out.append(XPElement(.str(XPComponentRuntime.text), JsObject([("value", .str(Js.toStr(node)))]), nil))
        case .elem(let e): out.append(e)
        default: throw JsError("Child tidak didukung: \(Js.toStr(node))")
        }
    }

    private func normalize(_ node: JsValue) throws -> [XPElement] {
        var out: [XPElement] = []
        try normalize(node, &out)
        return out
    }

    // MARK: hooks

    private func nextHook() throws -> Hook {
        guard let comp = current else { throw JsError("Hooks hanya boleh dipanggil di dalam komponen") }
        let i = hookIndex
        hookIndex += 1
        if i < comp.hooks.count { return comp.hooks[i] }
        let h = Hook()
        comp.hooks.append(h)
        return h
    }

    private func depsChanged(_ a: [JsValue]?, _ b: [JsValue]?) -> Bool {
        guard let a = a, let b = b, a.count == b.count else { return true }
        return zip(a, b).contains { !Js.same($0, $1) }
    }

    private func depsOf(_ v: JsValue) -> [JsValue]? {
        if case .arr(let l) = v { return l.items }
        return nil
    }

    private lazy var useState = JsFunction("useState") { [unowned self] a in
        guard let comp = self.current else { throw JsError("Hooks hanya boleh dipanggil di dalam komponen") }
        let h = try self.nextHook()
        if !h.hasValue {
            let initial = Js.arg(a, 0)
            if case .fn(let f) = initial { h.value = try f.impl([]) } else { h.value = initial }
            h.hasValue = true
            h.set = JsFunction("setState") { [weak h] args in
                try h?.dispatch?(Js.arg(args, 0))
                return .null
            }
        }
        if h.owner !== comp {
            h.owner = comp
            h.dispatch = { [unowned self, unowned h] v in
                let next: JsValue
                if case .fn(let f) = v { next = try f.impl([h.value]) } else { next = v }
                if !Js.same(next, h.value) {
                    h.value = next
                    if let owner = h.owner { self.schedule(owner) }
                }
            }
        }
        return .arr(JsArray([h.value, .fn(h.set!)]))
    }

    private lazy var useRef = JsFunction("useRef") { [unowned self] a in
        let h = try self.nextHook()
        if h.ref == nil { h.ref = JsObject([("current", Js.arg(a, 0))]) }
        return .obj(h.ref!)
    }

    private func memo(_ fn: () throws -> JsValue, _ deps: [JsValue]?) throws -> JsValue {
        let h = try nextHook()
        if !h.hasValue || depsChanged(h.deps, deps) {
            h.value = try fn()
            h.hasValue = true
            h.deps = deps
        }
        return h.value
    }

    private lazy var useMemo = JsFunction("useMemo") { [unowned self] a in
        guard case .fn(let f) = Js.arg(a, 0) else { throw JsError("TypeError: useMemo butuh function") }
        return try self.memo({ try f.impl([]) }, self.depsOf(Js.arg(a, 1)))
    }

    private lazy var useCallback = JsFunction("useCallback") { [unowned self] a in
        let f = Js.arg(a, 0)
        return try self.memo({ f }, self.depsOf(Js.arg(a, 1)))
    }

    private lazy var useEffect = JsFunction("useEffect") { [unowned self] a in
        guard case .fn(let f) = Js.arg(a, 0) else { throw JsError("TypeError: useEffect butuh function") }
        let deps = self.depsOf(Js.arg(a, 1))
        let h = try self.nextHook()
        if a.count < 2 || a[1].isNull || !h.hasDeps || self.depsChanged(h.deps, deps) {
            h.pending = f
            h.deps = deps
            h.hasDeps = true
            self.effects.append(h)
        }
        return .null
    }

    // MARK: rekonsiliasi

    private func hostIds(_ inst: Inst) -> [Int] {
        if let h = inst as? HostInst { return [h.id] }
        return inst.children.flatMap(hostIds)
    }

    private func syncChildren(_ h: HostInst) {
        let ids = h.children.flatMap(hostIds)
        if ids != h.lastIds {
            hostSetChildren(h.id, ids)
            h.lastIds = ids
        }
    }

    private func plainEqual(_ a: JsValue?, _ b: JsValue) -> Bool {
        guard case .obj(let x)? = a, case .obj(let y) = b, x.count == y.count else { return false }
        for (k, v) in x.entries {
            guard let w = y[k], Js.same(v, w) else { return false }
        }
        return true
    }

    private func propsDiff(_ prev: JsObject, _ next: JsObject) -> JsObject? {
        let changed = JsObject()
        for (k, v) in next.entries {
            if k == "children" { continue }
            let p = prev[k]
            if v.isNull && p == nil { continue } // undefined baru: tidak ada yang dikirim
            if p == nil || (!Js.same(p!, v) && !plainEqual(p, v)) { changed[k] = v }
        }
        for k in prev.keys where k != "children" && !next.has(k) { changed[k] = .null }
        return changed.count == 0 ? nil : changed
    }

    private func segment(_ v: XPElement, _ index: Int) -> String {
        var t = "C"
        if case .str(let s) = v.type { t = s }
        return "\(t)#\(v.key ?? String(index))"
    }

    private func mount(_ v: XPElement, _ hostParent: HostInst, _ depth: Int, _ path: String) throws -> Inst {
        if case .str(let type) = v.type {
            let inst = HostInst(type: type, id: nextId, key: v.key, path: path, props: v.props)
            nextId += 1
            hostCreate(inst.id, type)
            if let d = propsDiff(JsObject(), v.props) { hostSetProps(inst.id, d) }
            inst.children = try reconcile([], try normalize(v.props["children"] ?? .null), inst, depth + 1, path)
            syncChildren(inst)
            return inst
        }
        guard case .fn(let fn) = v.type else { throw JsError("TypeError: type elemen bukan komponen: \(Js.toStr(v.type))") }
        let inst = CompInst(type: fn, key: v.key, path: path, props: v.props, hostParent: hostParent, depth: depth)
        try renderComp(inst)
        return inst
    }

    private func update(_ inst: Inst, _ v: XPElement, _ depth: Int) throws {
        if let h = inst as? HostInst {
            if let d = propsDiff(h.props, v.props) { hostSetProps(h.id, d) }
            h.props = v.props
            h.children = try reconcile(h.children, try normalize(v.props["children"] ?? .null), h, depth + 1, h.path)
            syncChildren(h)
        } else if let c = inst as? CompInst {
            c.props = v.props
            try renderComp(c)
        }
    }

    private func renderComp(_ inst: CompInst) throws {
        let prev = current
        let prevIndex = hookIndex
        current = inst
        hookIndex = 0
        defer {
            current = prev
            hookIndex = prevIndex
        }
        let out = inst.type === fragment ? (inst.props["children"] ?? .null) : try inst.type.impl([.obj(inst.props)])
        inst.renderedIn = flushId
        inst.children = try reconcile(inst.children, try normalize(out), inst.hostParent, inst.depth + 1, inst.path)
    }

    private func unmount(_ inst: Inst) throws {
        if let c = inst as? CompInst {
            c.unmounted = true
            for h in c.hooks { if let cl = h.cleanup { _ = try cl.impl([]) } }
            for ch in c.children { try unmount(ch) }
        } else if let h = inst as? HostInst {
            for ch in h.children { try unmount(ch) }
            hostRemove(h.id)
        }
    }

    private func sameType(_ inst: Inst, _ v: XPElement) -> Bool {
        if let h = inst as? HostInst {
            if case .str(let t) = v.type { return t == h.type }
            return false
        }
        if let c = inst as? CompInst, case .fn(let f) = v.type { return c.type === f }
        return false
    }

    private func reconcile(_ old: [Inst], _ next: [XPElement], _ hostParent: HostInst, _ depth: Int, _ path: String) throws -> [Inst] {
        var byKey: [String: Inst] = [:]
        var unkeyed: [Inst] = []
        for o in old { if let k = o.key { byKey[k] = o } else { unkeyed.append(o) } }
        var used = Set<ObjectIdentifier>()
        var u = 0
        var result: [Inst] = []
        for (i, v) in next.enumerated() {
            var match: Inst?
            if let k = v.key { match = byKey[k] } else {
                if u < unkeyed.count { match = unkeyed[u] }
                u += 1
            }
            if let m = match, !used.contains(ObjectIdentifier(m)), sameType(m, v) {
                used.insert(ObjectIdentifier(m))
                try update(m, v, depth)
                result.append(m)
            } else {
                result.append(try mount(v, hostParent, depth, "\(path)/\(segment(v, i))"))
            }
        }
        for o in old where !used.contains(ObjectIdentifier(o)) { try unmount(o) }
        return result
    }

    // MARK: penjadwalan

    private func schedule(_ comp: CompInst) {
        if !dirty.contains(where: { $0 === comp }) { dirty.append(comp) }
        scheduled = true
    }

    private func flush() throws {
        scheduled = false
        flushId += 1
        // urut kedalaman, stabil (sama dengan sortedBy di Kotlin)
        let list = dirty.enumerated().sorted { ($0.element.depth, $0.offset) < ($1.element.depth, $1.offset) }.map(\.element)
        dirty = []
        var parents: [HostInst] = []
        for c in list {
            if c.unmounted || c.renderedIn == flushId { continue }
            try renderComp(c)
            if !parents.contains(where: { $0 === c.hostParent }) { parents.append(c.hostParent) }
        }
        for p in parents { syncChildren(p) }
        try commit()
    }

    private func commit() throws {
        hostCommit()
        let run = effects
        effects = []
        for h in run {
            if let cl = h.cleanup { _ = try cl.impl([]) }
            let c = try h.pending?.impl([]) ?? .null
            if case .fn(let f) = c { h.cleanup = f } else { h.cleanup = nil }
        }
    }

    private func flushSync() throws {
        var i = 0
        while scheduled {
            i += 1
            if i > 51 { throw JsError("Terlalu banyak update berantai (setState di dalam effect?)") }
            try flush()
        }
    }

    private func render(_ element: JsValue) throws {
        lastElement = element
        flushId += 1
        container.children = try reconcile(container.children, try normalize(element), container, 0, "")
        syncChildren(container)
        try commit()
    }

    // MARK: timer (setTimeout / setInterval)

    private final class Timer {
        var at: Int64
        let fn: JsFunction
        let args: [JsValue]
        let every: Int64?
        init(at: Int64, fn: JsFunction, args: [JsValue], every: Int64?) {
            self.at = at
            self.fn = fn
            self.args = args
            self.every = every
        }
    }

    private var timers: [Int: Timer] = [:]
    private var timerOrder: [Int] = []
    private var lastTimer = 0

    /// Jam (ms) untuk timer; bisa diganti di tes.
    public var clock: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }

    private func addTimer(_ a: [JsValue], repeating: Bool) throws -> JsValue {
        guard case .fn(let f) = Js.arg(a, 0) else { throw JsError("TypeError: setTimeout/setInterval butuh function") }
        let raw = Js.toNum(Js.arg(a, 1))
        let delay = max(0, raw.isNaN ? 0 : Int64(raw))
        lastTimer += 1
        timers[lastTimer] = Timer(at: clock() + delay, fn: f, args: Array(a.dropFirst(2)), every: repeating ? max(1, delay) : nil)
        timerOrder.append(lastTimer)
        return .num(Double(lastTimer))
    }

    private func removeTimer(_ id: Int) {
        if timers.removeValue(forKey: id) != nil { timerOrder.removeAll { $0 == id } }
    }

    private lazy var clearTimer = JsFunction("clearTimeout") { [unowned self] a in
        let n = Js.toNum(Js.arg(a, 0))
        if !n.isNaN { self.removeTimer(Int(n)) }
        return .null
    }

    private func runDueTimers() throws {
        let now = clock()
        var firstError: Error?
        for _ in 0..<1000 {
            // yang paling awal jatuh tempo; kalau sama, yang dibuat lebih dulu
            var due: (Int, Timer)?
            for id in timerOrder {
                guard let t = timers[id], t.at <= now else { continue }
                if due == nil || t.at < due!.1.at { due = (id, t) }
            }
            guard let (id, t) = due else { break }
            if let every = t.every {
                t.at += every
                if t.at <= now { t.at = now + every }
            } else {
                removeTimer(id)
            }
            do { _ = try t.fn.impl(t.args) } catch { if firstError == nil { firstError = error } }
        }
        if let e = firstError { throw e }
    }

    // MARK: environment (lebar layar & mode gelap)

    private var env = JsObject([("width", .num(0)), ("height", .num(0)), ("dark", .bool(false))])
    private var breakpoints: [Double] = []
    private var viewportUnits = false

    private func setEnvironment(_ next: [(String, JsValue)]) throws {
        let prev = env
        let e = JsObject(prev)
        for (k, v) in next { e[k] = v }
        env = e
        let pw = Js.toNum(prev["width"] ?? .null), w = Js.toNum(e["width"] ?? .null)
        let crossed = breakpoints.contains { (pw >= $0) != (w >= $0) }
        let resized = viewportUnits && (pw != w || Js.toNum(prev["height"] ?? .null) != Js.toNum(e["height"] ?? .null))
        let darkChanged = !Js.seq(prev["dark"] ?? .null, e["dark"] ?? .null)
        if (crossed || resized || darkChanged) && !lastElement.isNull {
            flushId += 1
            container.children = try reconcile(container.children, try normalize(lastElement), container, 0, "")
            syncChildren(container)
            try commit()
        }
    }

    // MARK: objek yang dilihat kode komponen

    private lazy var api: JsValue = .obj(JsObject([
        ("jsx", .fn(jsx)),
        ("jsxs", .fn(jsx)),
        ("jsxDEV", .fn(jsx)),
        ("Fragment", .fn(fragment)),
        ("createElement", .fn(createElement)),
        ("useState", .fn(useState)),
        ("useEffect", .fn(useEffect)),
        ("useMemo", .fn(useMemo)),
        ("useCallback", .fn(useCallback)),
        ("useRef", .fn(useRef)),
        ("environment", .fn(JsFunction("environment") { [unowned self] _ in .obj(self.env) })),
        ("registerBreakpoints", .fn(JsFunction("registerBreakpoints") { [unowned self] a in
            let list = Js.arg(a, 0)
            for w in try Js.iter(list.isNull ? .arr(JsArray()) : list) {
                let d = Js.toNum(w)
                if !self.breakpoints.contains(d) { self.breakpoints.append(d) }
            }
            if Js.truthy(Js.arg(a, 1)) { self.viewportUnits = true }
            return .null
        })),
    ]))

    private lazy var setTimeoutFn = JsFunction("setTimeout") { [unowned self] a in try self.addTimer(a, repeating: false) }
    private lazy var setIntervalFn = JsFunction("setInterval") { [unowned self] a in try self.addTimer(a, repeating: true) }

    func global(_ name: String) throws -> JsValue {
        switch name {
        case "__xp": return api
        case "setTimeout": return .fn(setTimeoutFn)
        case "setInterval": return .fn(setIntervalFn)
        case "clearTimeout", "clearInterval": return .fn(clearTimer)
        default: return try JsBuiltins.global(name)
        }
    }

    private var componentFn: JsFunction?

    private func componentFunction() throws -> JsFunction {
        if let f = componentFn { return f }
        let f = try component.create(XPScope(self))
        componentFn = f
        return f
    }

    private func done() throws -> [Any] {
        try flushSync()
        return drain()
    }

    // MARK: API untuk SDK (sama dengan XP.* di bundle JS)

    public func mount(_ props: JsValue) throws -> [Any] {
        var p = JsObject()
        if case .obj(let o) = props { p = o }
        try render(.elem(XPElement(.fn(try componentFunction()), p, nil)))
        return try done()
    }

    /// Props dalam bentuk JSON (sama dengan yang dikirim ke XPEngine).
    public func mount(json: String) throws -> [Any] { try mount(try JsJSON.parse(json)) }

    public func update(_ props: JsValue) throws -> [Any] { try mount(props) }

    public func update(json: String) throws -> [Any] { try mount(json: json) }

    public func dispatch(_ handlerKey: String, _ args: [JsValue]) throws -> [Any] {
        // node sudah dihapus: abaikan event basi
        if let h = handlers[handlerKey] { _ = try h.impl(args) }
        return try done()
    }

    public func dispatch(_ handlerKey: String, args: [Any]) throws -> [Any] {
        try dispatch(handlerKey, args.map { Js.fromHost($0) })
    }

    public func tick() throws -> [Any] {
        try runDueTimers()
        return try done()
    }

    /// ms sampai timer berikutnya, atau -1 kalau tidak ada.
    public func nextTimer() -> Int64 {
        guard let min = timers.values.map(\.at).min() else { return -1 }
        return max(0, min - clock())
    }

    public func environment(width: Double, height: Double, dark: Bool) throws -> [Any] {
        try setEnvironment([("width", .num(width)), ("height", .num(height)), ("dark", .bool(dark))])
        return try done()
    }

    public func unmount() throws -> [Any] {
        lastElement = .null
        for c in container.children { try unmount(c) }
        container.children = []
        syncChildren(container)
        hostCommit()
        timers = [:]
        timerOrder = []
        return drain()
    }
}
