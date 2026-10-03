import XCTest
@testable import XPKit

private func fixture(_ name: String, _ ext: String) throws -> String {
    let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "Fixtures"))
    return try String(contentsOf: url, encoding: .utf8)
}

/// Memutar ulang sesi yang direkam dari bundle promo-modal di QuickJS
/// (tests/native-queue.test.ts di repo xp) ke tree iOS, lalu memeriksa hasilnya.
final class XPTreeTests: XCTestCase {
    private func session() throws -> [[String: Any]] {
        try XCTUnwrap(XPJSON.parse(fixture("promo-modal.session", "json")) as? [[String: Any]])
    }

    private func step(_ tree: XPTree, _ s: [String: Any]) throws {
        try tree.applyBatches(XPJSON.stringify(s["batches"] ?? []))
    }

    private func text(_ tree: XPTree, _ testID: String) -> String? {
        tree.byTestID(testID).map(tree.text)
    }

    private func modal(_ tree: XPTree) -> XPNode? {
        tree.walk().first { $0.type == "Modal" }
    }

    func testReplayPromoModalSession() throws {
        let steps = try session()
        let tree = XPTree()

        try step(tree, steps[0]) // mount
        XCTAssertEqual(text(tree, "title"), "Kelas IELTS")
        XCTAssertEqual(modal(tree)?.bool("visible"), false)
        XCTAssertEqual(tree.byTestID("open")?.handler("onPress"), "\(tree.byTestID("open")!.id):onPress")
        XCTAssertEqual(tree.byTestID("minus")?.bool("disabled"), true)

        try step(tree, steps[1]) // tekan "Lihat detail"
        XCTAssertEqual(modal(tree)?.bool("visible"), true)

        try step(tree, steps[2]) // +
        try step(tree, steps[3]) // +
        XCTAssertEqual(text(tree, "qty"), "Peserta: 3")
        XCTAssertEqual(text(tree, "total"), "Total: Rp450.000")
        XCTAssertEqual(text(tree, "full"), "Kuota penuh")

        try step(tree, steps[4]) // tutup
        XCTAssertEqual(modal(tree)?.bool("visible"), false)
        XCTAssertEqual(tree.orphans(), [])

        let before = tree.revision
        try step(tree, steps[5]) // event tanpa perubahan
        XCTAssertEqual(tree.revision, before, "batch kosong tidak memicu render ulang")
    }

    func testDeleteAndPropRemoval() throws {
        let tree = XPTree()
        try tree.applyBatches("""
        [{"v":1,"ops":[["create",1,"View"],["create",2,"Text"],["create",3,"#text"],
          ["props",3,{"value":"hai"}],["props",1,{"testID":"a","onPress":{"$fn":"1:onPress"}}],
          ["children",2,[3]],["children",1,[2]],["children",0,[1]]]}]
        """)
        XCTAssertEqual(text(tree, "a"), "hai")
        try tree.applyBatches(#"[{"v":1,"ops":[["props",1,{"onPress":null}],["children",1,[]],["delete",3],["delete",2]]}]"#)
        XCTAssertNil(tree.byTestID("a")?.handler("onPress"))
        XCTAssertEqual(tree.count, 2)
        XCTAssertEqual(tree.orphans(), [])
    }

    func testSignatureFromNode() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "signed-manifest", withExtension: "json", subdirectory: "Fixtures"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: String])
        let manifest = Data(try XCTUnwrap(fixture["manifest"]).utf8)
        let signature = try XCTUnwrap(fixture["signature"])
        let key = try XCTUnwrap(fixture["publicKey"])
        XCTAssertTrue(XPSignature.verify(manifest: manifest, signatureBase64: signature, publicKeyBase64: key))
        let changed = Data(String(decoding: manifest, as: UTF8.self).replacingOccurrences(of: "promo-modal", with: "promo-modaI").utf8)
        XCTAssertFalse(XPSignature.verify(manifest: changed, signatureBase64: signature, publicKeyBase64: key))
    }

    func testDevEvents() {
        XCTAssertEqual(XPDevEvents.parse(#"data: {"type":"update","components":["promo-slider"]}"#), ["promo-slider"])
        XCTAssertNil(XPDevEvents.parse(#"data: {"type":"hello"}"#))
        XCTAssertNil(XPDevEvents.parse(": ping"))
    }

    func testSwipeDirection() {
        XCTAssertEqual(XPGesture.direction(dx: -60, dy: 10), "left")
        XCTAssertEqual(XPGesture.direction(dx: 60, dy: -20), "right")
        XCTAssertEqual(XPGesture.direction(dx: 5, dy: -80), "up")
        XCTAssertEqual(XPGesture.direction(dx: 0, dy: 45), "down")
        XCTAssertNil(XPGesture.direction(dx: 30, dy: 30))
    }

    func testNumericTextHasNoDecimal() throws {
        let tree = XPTree()
        try tree.applyBatches(#"[{"v":1,"ops":[["create",1,"#text"],["props",1,{"value":3}],["children",0,[1]]]}]"#)
        XCTAssertEqual(tree.text(tree.root), "3")
    }

    func testCreatedAtAndEntering() throws {
        let tree = XPTree()
        try tree.applyBatches(#"[{"v":1,"ops":[["create",1,"View"],["children",0,[1]]]}]"#)
        try tree.applyBatches(#"[{"v":1,"ops":[["create",2,"Text"],["props",2,{"entering":{"opacity":0,"translateX":24,"duration":280}}],["children",1,[2]]]}]"#)
        XCTAssertEqual(tree.node(1)?.createdAt, 1)
        XCTAssertEqual(tree.node(2)?.createdAt, 2)
        XCTAssertEqual(tree.node(2)?.entering?.translateX, 24)
        XCTAssertEqual(tree.node(2)?.entering?.duration ?? 0, 0.28, accuracy: 0.0001)
        XCTAssertNil(tree.node(1)?.entering)
    }

    func testRejectsUnknownProtocolAndPrimitive() {
        XCTAssertThrowsError(try XPTree().applyBatches(#"[{"v":2,"ops":[]}]"#))
        XCTAssertThrowsError(try XPTree().applyBatches(#"[{"v":1,"ops":[["create",1,"Video"]]}]"#))
    }
}

final class XPStyleTests: XCTestCase {
    func testButtonStyleFromPromoModal() {
        let s = XPStyle.parse([
            "backgroundColor": "#1F6FEB", "paddingVertical": 10, "paddingHorizontal": 16,
            "borderRadius": 8, "alignItems": "center",
        ])
        XCTAssertEqual(s.background, 0xFF1F_6FEB)
        XCTAssertEqual(s.padding, XPEdges(top: 10, leading: 16, bottom: 10, trailing: 16))
        XCTAssertEqual(s.radius, 8)
        XCTAssertEqual(s.alignItems, "center")
        XCTAssertEqual(s.direction, "column")
    }

    func testSpecificPaddingWinsOverShorthand() {
        let s = XPStyle.parse(["padding": 4, "paddingHorizontal": 8, "paddingLeft": 12])
        XCTAssertEqual(s.padding, XPEdges(top: 4, leading: 12, bottom: 4, trailing: 8))
    }

    func testSizes() {
        let s = XPStyle.parse(["width": "100%", "height": 160, "maxWidth": 360])
        XCTAssertEqual(s.width, .percent(1))
        XCTAssertEqual(s.height, .points(160))
        XCTAssertEqual(s.maxWidth, 360)
        XCTAssertNil(XPStyle.parse(["width": "auto"]).width)
    }

    func testColors() {
        XCTAssertEqual(XPStyle.parseColor("#fff"), 0xFFFF_FFFF)
        XCTAssertEqual(XPStyle.parseColor("#57606A"), 0xFF57_606A)
        XCTAssertEqual(XPStyle.parseColor("#1F6FEB80"), 0x801F_6FEB) // format web RRGGBBAA
        XCTAssertEqual(XPStyle.parseColor("rgba(0,0,0,.45)"), 0x7300_0000)
        XCTAssertEqual(XPStyle.parseColor("transparent"), 0)
        XCTAssertNil(XPStyle.parseColor("hsl(0, 0%, 0%)"))
    }

    func testTransition() {
        let s = XPStyle.parse(["transitionDuration": 300, "transitionTimingFunction": "ease-out"])
        XCTAssertEqual(s.transition, 0.3, accuracy: 0.0001)
        XCTAssertEqual(s.easing, "ease-out")
        XCTAssertEqual(XPStyle.parse([:]).transition, 0)
    }

    func testQuoteIsSafeJSLiteral() {
        XCTAssertEqual(XPJSON.quote("a\u{2028}b\\\"c\n"), #""a b\\\"c\n""#)
    }
}

/// Bundle native promo-modal asli dijalankan di JavaScriptCore, persis seperti di app iOS.
final class XPEngineTests: XCTestCase {
    func testRunsRealBundleInJavaScriptCore() async throws {
        let engine = try await XPEngine.create(bundle: fixture("promo-modal.native", "js"), fileName: "promo-modal.native.js")
        let tree = XPTree()
        let props = #"{"title":"Kelas IELTS","price":150000,"seats":3}"#

        try tree.applyBatches(try await engine.mount(props))
        XCTAssertEqual(tree.byTestID("title").map(tree.text), "Kelas IELTS")

        func press(_ id: String) async throws {
            let key = try XCTUnwrap(tree.byTestID(id)?.handler("onPress"))
            try tree.applyBatches(try await engine.dispatch(key))
        }

        try await press("open")
        XCTAssertEqual(tree.walk().first { $0.type == "Modal" }?.bool("visible"), true)

        try await press("plus")
        try await press("plus")
        XCTAssertEqual(tree.byTestID("total").map(tree.text), "Total: Rp450.000")
        XCTAssertEqual(tree.byTestID("plus")?.bool("disabled"), true)

        // Update props dari app host: node yang sama, tanpa remount.
        let titleID = tree.byTestID("title")?.id
        try tree.applyBatches(try await engine.update(#"{"title":"Kelas TOEFL","price":100000,"seats":3}"#))
        XCTAssertEqual(tree.byTestID("title").map(tree.text), "Kelas TOEFL")
        XCTAssertEqual(tree.byTestID("title")?.id, titleID)

        try tree.applyBatches(try await engine.unmount())
        XCTAssertEqual(tree.count, 1)
        engine.close()
    }

    func testRejectsNonXPBundle() async {
        do {
            _ = try await XPEngine.create(bundle: "var x = 1;", fileName: "bukan-xp.js")
            XCTFail("harus gagal")
        } catch {}
    }

    func testJSErrorsSurfaceAsSwiftErrors() async throws {
        let engine = try await XPEngine.create(bundle: fixture("promo-modal.native", "js"), fileName: "promo-modal.native.js")
        do {
            _ = try await engine.mount("{bukan json")
            XCTFail("harus gagal")
        } catch XPError.script {
            // ok
        }
    }
}
