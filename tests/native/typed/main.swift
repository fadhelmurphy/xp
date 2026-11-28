// Tes diferensial mode typed (Swift): komponen yang dikompilasi ke Swift bertipe dijalankan dengan
// skenario JSON yang sama dengan bundle JS, tree host-nya dicetak setelah setiap langkah.
import Foundation
import XPKit

func snapshot(_ n: XPHostNode) -> Any {
    if n.type == "#text" { return n.props["value"] ?? NSNull() }
    var props: [String: Any] = n.props
    for k in n.handlers.keys { props[k] = "fn" }
    return ["type": n.type, "props": props, "children": n.children.map(snapshot)] as [String: Any]
}

/// Tree yang sama setelah disalin ke XPTree (yang dibaca renderer SwiftUI).
func snapshot(_ tree: XPTree, _ n: XPNode) -> Any {
    if n.type == "#text" { return n.props["value"] ?? NSNull() }
    var props: [String: Any] = [:]
    for (k, v) in n.props {
        if let m = v as? [String: Any], m["$fn"] != nil { props[k] = "fn" } else { props[k] = v }
    }
    return ["type": n.type, "props": props, "children": n.children.compactMap { tree.node($0) }.map { snapshot(tree, $0) }] as [String: Any]
}

func json(_ v: Any) -> String {
    String(decoding: try! JSONSerialization.data(withJSONObject: v, options: [.sortedKeys]), as: UTF8.self)
}

func find(_ nodes: [XPHostNode], _ testID: String) -> XPHostNode? {
    for n in nodes {
        if n.props["testID"] as? String == testID { return n }
        if let hit = find(n.children, testID) { return hit }
    }
    return nil
}

func number(_ v: Any?) -> Double { XPStd.num(v) }

/// JSON skenario → nilai Swift (Double, String, Bool, [Any?], [String: Any?]).
func native(_ v: JsValue) -> Any? {
    switch v {
    case .null: return nil
    case .bool(let b): return b
    case .num(let d): return d
    case .str(let s): return s
    case .arr(let a): return a.items.map(native)
    case .obj(let o):
        var m: [String: Any?] = [:]
        for (k, x) in o.entries { m[k] = native(x) }
        return m
    default: return nil
    }
}

let text = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
guard let script = native(try JsJSON.parse(text)) as? [String: Any?], let name = script["component"] as? String else { fatalError("skenario tidak valid") }
guard let component = typedComponents[name] else { fatalError("komponen \(name) tidak ada") }
let rt = XPTypedRuntime(component)
var now: Int64 = 1_000_000
rt.clock = { now }
JsBuiltins.clock = { Double(now) }

func environment(_ v: Any?) {
    guard let e = XPStd.flat(v) as? [String: Any?] else { return }
    rt.environment(width: number(e["width"] ?? nil), height: number(e["height"] ?? nil), dark: (XPStd.flat(e["dark"] ?? nil) as? Bool) ?? false)
}

var out: [Any] = []
let tree = XPTree()
func record() {
    let host = rt.root.map(snapshot)
    tree.sync(rt.root)
    let mirrored = tree.root.children.compactMap { tree.node($0) }.map { snapshot(tree, $0) }
    guard json(host) == json(mirrored), tree.orphans().isEmpty else { fatalError("XPTree.sync berbeda dengan tree host") }
    out.append(host)
}

environment(script["env"] ?? nil)
rt.mount(XPStd.map(script["props"] ?? nil))
record()
for case let step as [String: Any?] in (XPStd.flat(script["steps"] ?? nil) as? [Any?]) ?? [] {
    if let ev = XPStd.flat(step["event"] ?? nil) as? [Any?] {
        guard let testID = ev[0] as? String, let prop = ev[1] as? String, let args = ev[2] as? [Any?] else { fatalError("event tidak valid") }
        guard let node = find(rt.root, testID) else { fatalError("testID \(testID) tidak ada") }
        guard let handler = node.handler(prop) else { fatalError("\(testID) tidak punya \(prop)") }
        rt.dispatch(handler, args)
    } else if let adv = XPStd.flat(step["advance"] ?? nil) {
        now += Int64(number(adv))
        rt.tick()
    } else if let props = XPStd.flat(step["props"] ?? nil) {
        rt.update(XPStd.map(props))
    } else if let env = XPStd.flat(step["env"] ?? nil) {
        environment(env)
    } else if step["unmount"] != nil {
        rt.unmount()
    }
    record()
}
let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
