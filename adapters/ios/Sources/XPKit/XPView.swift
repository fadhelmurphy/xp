import os
import SwiftUI

private let logger = Logger(subsystem: "dev.xp", category: "XPKit")

/// Memuat komponen xp dari URL dan merendernya dengan SwiftUI (tanpa WebView).
///
///     XPView(base: URL(string: "https://cdn.kamu/xp")!, name: "promo-modal",
///            props: ["title": "Kelas IELTS", "price": 150000])
///
/// Props harus bisa di-JSON-kan: String, angka, Bool, NSNull, Array, Dictionary.
///
/// - `publicKey`: kunci publik dari `xp keygen`; manifest yang tidak ditandatangani kunci ini ditolak.
/// - `live`: development, sambung ke `xp dev` dan muat ulang setiap build baru (state dipertahankan).
public struct XPView: View {
    private let base: URL
    private let name: String
    private let propsJSON: String
    private let publicKey: String?
    private let live: Bool
    @StateObject private var model = XPModel()

    public init(base: URL, name: String, props: [String: Any] = [:], publicKey: String? = nil, live: Bool = false) {
        self.base = base
        self.name = name
        self.propsJSON = (try? XPJSON.stringify(props)) ?? "{}"
        self.publicKey = publicKey
        self.live = live
    }

    public var body: some View {
        content
            .task(id: "\(base.absoluteString)|\(name)") {
                await model.load(base: base, name: name, propsJSON: propsJSON, publicKey: publicKey)
            }
            .task(id: "\(base.absoluteString)|\(name)|\(live)") {
                guard live else { return }
                for await names in XPDevEvents.updates(base: base) where names.contains(name) {
                    await model.reload(base: base, name: name, publicKey: publicKey)
                }
            }
            .onChange(of: propsJSON) { newValue in
                model.update(newValue)
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .loading:
            ProgressView()
        case .failed(let message):
            Text("Gagal memuat \(name): \(message)")
                .font(.footnote)
                .foregroundColor(.red)
        case .ready:
            XPRenderer(model: model).root()
        }
    }
}

// MARK: - State

@MainActor
final class XPModel: ObservableObject {
    enum State {
        case loading
        case ready
        case failed(String)
    }

    @Published private(set) var state: State = .loading
    @Published private(set) var revision = 0
    /// Revisi setelah mount; node yang dibuat sesudahnya boleh menjalankan animasi `entering`.
    private(set) var mountRevision = 0
    private(set) var tree = XPTree()

    private var engine: XPEngine?
    private var file: String?
    private var loadedKey: String?
    private var mountedProps: String?
    private var latestProps = "{}"
    private var pending: Task<Void, Never>?

    func load(base: URL, name: String, propsJSON: String, publicKey: String? = nil) async {
        latestProps = propsJSON
        let key = "\(base.absoluteString)|\(name)"
        guard loadedKey != key else { return }
        loadedKey = key
        do {
            let bundle = try await XPLoader.shared.load(base: base, name: name, publicKey: publicKey)
            let engine = try await XPEngine.create(bundle: bundle.code, fileName: bundle.file)
            self.engine = engine
            self.file = bundle.file
            let props = latestProps
            let batches = try await engine.mount(props)
            mountedProps = props
            try apply(batches)
            mountRevision = tree.revision
            state = .ready
            if latestProps != props { update(latestProps) }
        } catch {
            logger.error("gagal memuat \(name, privacy: .public): \(error.localizedDescription, privacy: .public)")
            state = .failed(error.localizedDescription)
        }
    }

    /// xp dev: ganti ke bundle baru, state useState dibawa lewat snapshot.
    func reload(base: URL, name: String, publicKey: String?) async {
        guard case .ready = state else { return }
        do {
            let bundle = try await XPLoader.shared.load(base: base, name: name, publicKey: publicKey)
            guard bundle.file != file else { return }
            let next = try await XPEngine.create(bundle: bundle.code, fileName: bundle.file)
            enqueue { old in
                let snapshot = try await old.snapshot()
                let batches = try await next.mount(self.latestProps, snapshot: snapshot)
                self.engine = next
                self.file = bundle.file
                self.mountedProps = self.latestProps
                self.tree = XPTree()
                try self.apply(batches)
                self.mountRevision = self.tree.revision
                old.close()
            }
        } catch {
            logger.error("reload \(name, privacy: .public) gagal: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Props dari app host berubah → XP.update (tanpa remount, state komponen tetap).
    func update(_ propsJSON: String) {
        latestProps = propsJSON
        enqueue { engine in
            guard self.mountedProps != propsJSON else { return }
            self.mountedProps = propsJSON
            let batches = try await engine.update(propsJSON)
            try self.apply(batches)
        }
    }

    func dispatch(_ key: String, _ args: [Any] = []) {
        enqueue { engine in
            let batches = try await engine.dispatch(key, args: args)
            try self.apply(batches)
        }
    }

    /// Event diproses satu per satu sesuai urutan tap.
    private func enqueue(_ work: @escaping (XPEngine) async throws -> Void) {
        guard let engine else { return }
        let previous = pending
        pending = Task { @MainActor in
            await previous?.value
            do {
                try await work(engine)
            } catch {
                logger.error("event gagal: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func apply(_ json: String) throws {
        try tree.applyBatches(json)
        revision = tree.revision
        armTimer()
    }

    // Timer JS (setTimeout/setInterval): tunggu XP.nextTimer() ms, lalu XP.tick() lewat antrean event.
    // Task lama tidak dibatalkan; ia berhenti sendiri kalau generasinya sudah lewat.
    private var timerGen = 0

    private func armTimer() {
        guard let engine else { return }
        timerGen += 1
        let gen = timerGen
        Task { @MainActor in
            guard let wait = try? await engine.nextTimer(), wait >= 0, gen == self.timerGen else { return }
            try? await Task.sleep(nanoseconds: UInt64(wait) * 1_000_000)
            guard gen == self.timerGen else { return }
            self.enqueue { engine in
                guard gen == self.timerGen else { return }
                try self.apply(try await engine.tick())
            }
        }
    }
}

// MARK: - Rendering

@MainActor
struct XPRenderer {
    let model: XPModel

    private var tree: XPTree { model.tree }

    enum Slot {
        case column(stretch: Bool)
        case row
    }

    func root() -> AnyView {
        AnyView(container(tree.root.children, XPStyle()).frame(maxWidth: .infinity, alignment: .topLeading))
    }

    /// View/Pressable/ScrollView: VStack atau HStack sesuai flexDirection.
    /// Modal tidak ikut layout; dipasang sebagai sheet di background container.
    func container(_ children: [Int], _ s: XPStyle) -> AnyView {
        let regular = children.filter { tree.node($0)?.type != "Modal" }
        let modals = children.filter { tree.node($0)?.type == "Modal" }
        let isRow = s.direction == "row"
        let slot: Slot = isRow ? .row : .column(stretch: s.alignItems == "stretch")
        let between = s.justify == "space-between" || s.justify == "space-around"

        let items = ForEach(Array(regular.enumerated()), id: \.element) { index, child in
            if between && index > 0 {
                Spacer(minLength: 0)
            }
            node(child, slot: slot)
        }
        let stack: AnyView = isRow
            ? AnyView(HStack(alignment: verticalAlign(s.alignItems), spacing: CGFloat(s.gap)) { items })
            : AnyView(VStack(alignment: horizontalAlign(s.alignItems), spacing: CGFloat(s.gap)) { items })

        return AnyView(stack.background(
            ForEach(modals, id: \.self) { id in
                XPModalHost(model: model, id: id)
            }
        ))
    }

    func node(_ id: Int, slot: Slot) -> AnyView {
        guard let n = tree.node(id) else { return AnyView(EmptyView()) }
        let s = XPStyle.parse(n.style)

        var fillWidth = false
        var fillHeight = false
        switch slot {
        case .column(let stretch):
            // Default flexbox kolom: anak melebar penuh (seperti di web).
            fillWidth = s.alignSelf == "stretch" || (s.alignSelf == nil && stretch && s.width == nil)
            fillHeight = s.flex > 0
        case .row:
            fillWidth = s.flex > 0
            fillHeight = s.alignSelf == "stretch"
        }
        if case .percent = s.width { fillWidth = true }
        if case .percent = s.height { fillHeight = true }

        let view: AnyView
        switch n.type {
        case "View":
            view = swipe(n, box(container(n.children, s), s, fillWidth, fillHeight, align: containerAlign(s)))

        case "Pressable":
            let key = n.handler("onPress")
            let content = box(container(n.children, s), s, fillWidth, fillHeight, align: containerAlign(s))
            view = swipe(n, AnyView(
                Button {
                    if let key { model.dispatch(key) }
                } label: {
                    content.contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(key == nil || n.bool("disabled"))
            ))

        case "ScrollView":
            let horizontal = n.bool("horizontal")
            var inner = s
            if horizontal { inner.direction = "row" }
            let scroll = ScrollView(horizontal ? .horizontal : .vertical) {
                container(n.children, inner)
            }
            view = box(scroll, s, fillWidth, fillHeight, align: .topLeading)

        case "Text", "#text":
            view = box(text(n, s), s, fillWidth, fillHeight, align: textAlign(s))

        case "Image":
            let image = AsyncImage(url: URL(string: n.string("src") ?? "")) { phase in
                if let img = phase.image {
                    img.resizable().scaledToFill()
                } else {
                    Color.gray.opacity(0.15)
                }
            }
            view = box(image.accessibilityLabel(n.string("alt") ?? ""), s, fillWidth, fillHeight, align: .center, clip: true)

        case "TextInput":
            let key = n.handler("onChangeText")
            let onChange: ((String) -> Void)? = key.map { k in
                { (text: String) in model.dispatch(k, [text]) }
            }
            let input = XPTextInputView(
                value: n.string("value") ?? "",
                placeholder: n.string("placeholder") ?? "",
                secure: n.bool("secure"),
                fontSize: s.fontSize ?? 16,
                color: s.color.map { Color(argb: $0) },
                onChange: onChange
            )
            view = box(input, s, fillWidth, fillHeight, align: .leading)

        default:
            return AnyView(EmptyView())
        }

        var out = view
        if s.transition > 0 {
            out = AnyView(out.animation(animation(s), value: AnimatedValues(s)))
        }
        if let e = n.entering, n.createdAt > model.mountRevision {
            out = AnyView(out.modifier(XPEnteringModifier(entering: e)))
        }
        if case .column = slot, let a = s.alignSelf, a != "stretch" {
            out = AnyView(out.frame(maxWidth: .infinity, alignment: a == "center" ? .center : a == "flex-end" ? .trailing : .leading))
        }
        if let testID = n.testID {
            out = AnyView(out.accessibilityIdentifier(testID))
        }
        return AnyView(out.id(n.id))
    }

    private func text(_ n: XPNode, _ s: XPStyle) -> some View {
        var t = Text(tree.text(n)).font(.system(size: CGFloat(s.fontSize ?? 16), weight: fontWeight(s.fontWeight)))
        if let c = s.color {
            t = t.foregroundColor(Color(argb: c))
        }
        let lines = (n.props["numberOfLines"] as? NSNumber)?.intValue
        return t
            .multilineTextAlignment(s.textAlign == "center" ? .center : s.textAlign == "right" ? .trailing : .leading)
            .lineLimit(lines)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Box model: padding → ukuran → latar/border/sudut → opacity → margin.
    /// onSwipe dan dragAxis. Lihat XPDraggable.
    private func swipe(_ n: XPNode, _ v: AnyView) -> AnyView {
        let key = n.handler("onSwipe")
        let axis = n.string("dragAxis")
        guard key != nil || axis != nil else { return v }
        return AnyView(XPDraggable(content: v, axis: axis) { dir in
            if let key { model.dispatch(key, [dir]) }
        })
    }

    private func box<V: View>(_ v: V, _ s: XPStyle, _ fillWidth: Bool, _ fillHeight: Bool,
                              align: Alignment, clip: Bool = false) -> AnyView {
        var out = AnyView(v.padding(EdgeInsets(top: s.padding.top, leading: s.padding.leading,
                                               bottom: s.padding.bottom, trailing: s.padding.trailing)))
        if case .points(let w) = s.width { out = AnyView(out.frame(width: CGFloat(w), alignment: align)) }
        if case .points(let h) = s.height { out = AnyView(out.frame(height: CGFloat(h), alignment: align)) }
        if fillWidth || fillHeight || s.minWidth != nil || s.maxWidth != nil || s.minHeight != nil {
            let maxWidth = s.maxWidth.map { CGFloat($0) }
            out = AnyView(out.frame(
                minWidth: s.minWidth.map { CGFloat($0) },
                maxWidth: fillWidth ? (maxWidth ?? .infinity) : maxWidth,
                minHeight: s.minHeight.map { CGFloat($0) },
                maxHeight: fillHeight ? .infinity : nil,
                alignment: align
            ))
        }
        if clip { out = AnyView(out.clipped()) }

        let shape = RoundedRectangle(cornerRadius: s.radius, style: .continuous)
        if let bg = s.background {
            out = AnyView(out.background(shape.fill(Color(argb: bg))))
        }
        if s.borderWidth > 0 {
            out = AnyView(out.overlay(shape.strokeBorder(Color(argb: s.borderColor ?? 0xFF00_0000), lineWidth: s.borderWidth)))
        }
        if s.radius > 0 { out = AnyView(out.clipShape(shape)) }
        if s.opacity < 1 { out = AnyView(out.opacity(s.opacity)) }
        if !s.margin.isZero {
            out = AnyView(out.padding(EdgeInsets(top: s.margin.top, leading: s.margin.leading,
                                                 bottom: s.margin.bottom, trailing: s.margin.trailing)))
        }
        return out
    }

    private func animation(_ s: XPStyle) -> Animation {
        switch s.easing {
        case "linear": return .linear(duration: s.transition)
        case "ease-in": return .easeIn(duration: s.transition)
        case "ease-out": return .easeOut(duration: s.transition)
        default: return .easeInOut(duration: s.transition)
        }
    }

    private func horizontalAlign(_ v: String) -> HorizontalAlignment {
        switch v {
        case "center": return .center
        case "flex-end": return .trailing
        default: return .leading
        }
    }

    private func verticalAlign(_ v: String) -> VerticalAlignment {
        switch v {
        case "center": return .center
        case "flex-end": return .bottom
        default: return .top
        }
    }

    /// Posisi isi di dalam frame container: sumbu utama dari justifyContent, sumbu silang dari alignItems.
    private func containerAlign(_ s: XPStyle) -> Alignment {
        let mainH: HorizontalAlignment = s.justify == "center" ? .center : s.justify == "flex-end" ? .trailing : .leading
        let mainV: VerticalAlignment = s.justify == "center" ? .center : s.justify == "flex-end" ? .bottom : .top
        return s.direction == "row"
            ? Alignment(horizontal: mainH, vertical: verticalAlign(s.alignItems))
            : Alignment(horizontal: horizontalAlign(s.alignItems), vertical: mainV)
    }

    private func textAlign(_ s: XPStyle) -> Alignment {
        switch s.textAlign {
        case "center": return .center
        case "right": return .trailing
        default: return .leading
        }
    }

    private func fontWeight(_ w: Int?) -> Font.Weight {
        switch w ?? 400 {
        case ..<200: return .ultraLight
        case ..<300: return .thin
        case ..<400: return .light
        case ..<500: return .regular
        case ..<600: return .medium
        case ..<700: return .semibold
        case ..<800: return .bold
        case ..<900: return .heavy
        default: return .black
        }
    }
}

// MARK: - Animasi

/// Nilai style yang dianimasikan; perubahan salah satunya memicu `.animation`.
private struct AnimatedValues: Equatable {
    let background: UInt32?
    let borderColor: UInt32?
    let color: UInt32?
    let opacity: Double
    let width: XPSize?
    let height: XPSize?

    init(_ s: XPStyle) {
        background = s.background
        borderColor = s.borderColor
        color = s.color
        opacity = s.opacity
        width = s.width
        height = s.height
    }
}

/// Prop `entering`: node yang muncul setelah mount bergerak dari nilai awal ke posisi normal.
private struct XPEnteringModifier: ViewModifier {
    let entering: XPEntering
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : entering.opacity)
            .offset(x: shown ? 0 : CGFloat(entering.translateX), y: shown ? 0 : CGFloat(entering.translateY))
            .onAppear {
                withAnimation(.easeOut(duration: entering.duration)) { shown = true }
            }
    }
}

// MARK: - Modal & TextInput

/// Modal xp → sheet iOS. Swipe ke bawah = onRequestClose.
struct XPModalHost: View {
    @ObservedObject var model: XPModel
    let id: Int

    var body: some View {
        let close = model.tree.node(id)?.handler("onRequestClose")
        Color.clear
            .sheet(isPresented: Binding(
                get: { model.tree.node(id)?.bool("visible") ?? false },
                set: { presented in
                    if !presented, let close { model.dispatch(close) }
                }
            )) {
                XPSheet(model: model, id: id)
                    .presentationDetents([.medium, .large])
                    .interactiveDismissDisabled(close == nil)
            }
    }
}

struct XPSheet: View {
    @ObservedObject var model: XPModel
    let id: Int

    private static let style: XPStyle = {
        var s = XPStyle()
        s.alignItems = "center"
        return s
    }()

    var body: some View {
        let _ = model.revision
        ScrollView {
            XPRenderer(model: model)
                .container(model.tree.node(id)?.children ?? [], Self.style)
                .padding(16)
                .frame(maxWidth: .infinity)
        }
    }
}

struct XPTextInputView: View {
    let value: String
    let placeholder: String
    let secure: Bool
    let fontSize: Double
    let color: Color?
    let onChange: ((String) -> Void)?

    @State private var text = ""

    var body: some View {
        Group {
            if secure {
                SecureField(placeholder, text: $text)
            } else {
                TextField(placeholder, text: $text)
            }
        }
        .font(.system(size: CGFloat(fontSize)))
        .foregroundColor(color)
        .onAppear { text = value }
        .onChange(of: value) { newValue in
            if newValue != text { text = newValue } // nilai dari JS menang
        }
        .onChange(of: text) { newValue in
            if newValue != value { onChange?(newValue) }
        }
    }
}

extension Color {
    init(argb: UInt32) {
        self.init(
            .sRGB,
            red: Double((argb >> 16) & 0xFF) / 255,
            green: Double((argb >> 8) & 0xFF) / 255,
            blue: Double(argb & 0xFF) / 255,
            opacity: Double((argb >> 24) & 0xFF) / 255
        )
    }
}

/// onSwipe: geseran minimal XPGesture.threshold pt. dragAxis: selama digeser view ikut jari di
/// sumbu itu, lalu kembali saat dilepas. Gesture dipasang simultan supaya Button tetap menerima tap.
struct XPDraggable: View {
    let content: AnyView
    let axis: String?
    let onSwipe: (String) -> Void
    @GestureState private var drag: CGSize = .zero

    var body: some View {
        let follow = XPGesture.follow(axis: axis, dx: drag.width, dy: drag.height)
        content
            .offset(x: follow.x, y: follow.y)
            // Animasi hanya saat kembali; selama digeser view langsung mengikuti jari.
            .animation(drag == .zero ? .easeOut(duration: 0.2) : nil, value: drag)
            .simultaneousGesture(
                DragGesture(minimumDistance: 10)
                    .updating($drag) { value, state, _ in state = value.translation }
                    .onEnded { value in
                        if let dir = XPGesture.direction(dx: value.translation.width, dy: value.translation.height) {
                            onSwipe(dir)
                        }
                    }
            )
    }
}
