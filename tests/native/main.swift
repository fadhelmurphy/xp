// Untuk tes diferensial: jalankan komponen terkompilasi (Swift) dengan skenario JSON, cetak tree
// setelah setiap langkah. Skenario yang sama dijalankan di bundle JS (tests/native-swift.test.ts).
import Foundation
import XPKit

func snapshot(_ tree: XPTree, _ n: XPNode) -> Any {
    if n.type == "#text" { return n.props["value"] ?? NSNull() }
    var props: [String: Any] = [:]
    for (k, v) in n.props {
        if let m = v as? [String: Any], m["$fn"] != nil { props[k] = "fn" } else { props[k] = v }
    }
    return ["type": n.type, "props": props, "children": n.children.compactMap { tree.node($0) }.map { snapshot(tree, $0) }] as [String: Any]
}

func number(_ v: JsValue?) -> Double {
    if case .num(let d)? = v { return d }
    return 0
}

let text = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
guard case .obj(let script) = try JsJSON.parse(text), case .str(let name)? = script["component"] else { fatalError("skenario tidak valid") }
guard let component = generatedComponents[name] else { fatalError("komponen \(name) tidak ada") }
let rt = XPComponentRuntime(component)
var now: Int64 = 1_000_000
rt.clock = { now }
JsBuiltins.clock = { Double(now) }
let tree = XPTree()

func environment(_ v: JsValue?) throws {
    guard case .obj(let e)? = v else { return }
    var dark = false
    if case .bool(let b)? = e["dark"] { dark = b }
    try tree.applyBatches(rt.environment(width: number(e["width"]), height: number(e["height"]), dark: dark))
}

var out: [Any] = []
func record() { out.append(tree.root.children.compactMap { tree.node($0) }.map { snapshot(tree, $0) }) }

try environment(script["env"])
try tree.applyBatches(rt.mount(script["props"] ?? .null))
record()
if case .arr(let steps)? = script["steps"] {
    for case .obj(let step) in steps.items {
        if case .arr(let ev)? = step["event"] {
            guard case .str(let testID) = ev.items[0], case .str(let prop) = ev.items[1], case .arr(let args) = ev.items[2] else { fatalError("event tidak valid") }
            guard let node = tree.byTestID(testID) else { fatalError("testID \(testID) tidak ada") }
            guard let key = node.handler(prop) else { fatalError("\(testID) tidak punya \(prop)") }
            try tree.applyBatches(rt.dispatch(key, args.items))
        } else if let adv = step["advance"] {
            now += Int64(number(adv))
            try tree.applyBatches(rt.tick())
        } else if let props = step["props"] {
            try tree.applyBatches(rt.update(props))
        } else if let env = step["env"] {
            try environment(env)
        } else if step["unmount"] != nil {
            try tree.applyBatches(rt.unmount())
        }
        record()
    }
}
let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
