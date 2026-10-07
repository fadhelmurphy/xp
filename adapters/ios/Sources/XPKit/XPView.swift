import os
import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

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
    @Environment(\.colorScheme) private var colorScheme

    public init(base: URL, name: String, props: [String: Any] = [:], publicKey: String? = nil, live: Bool = false) {
        self.base = base
        self.name = name
        self.propsJSON = (try? XPJSON.stringify(props)) ?? "{}"
        self.publicKey = publicKey
        self.live = live
    }

    public var body: some View {
        content
            // Lebar layar dan mode gelap untuk varian className (sm:, md:, dark:, ...).
            .onAppear { model.setEnvironment(screen: screenSize, dark: colorScheme == .dark) }
            .onChange(of: colorScheme) { scheme in model.setEnvironment(screen: screenSize, dark: scheme == .dark) }
            .onReceive(NotificationCenter.default.publisher(for: screenChange)) { _ in
                model.setEnvironment(screen: screenSize, dark: colorScheme == .dark)
            }
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

    /// Ukuran jendela (bukan ukuran komponen), sama seperti breakpoint Tailwind dan vh/vw di web.
    private var screenSize: CGSize {
        #if os(iOS)
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first {
            return window.bounds.size
        }
        return UIScreen.main.bounds.size
        #else
        return NSApplication.shared.keyWindow?.frame.size ?? NSScreen.main?.frame.size ?? .zero
        #endif
    }

    /// Layar diputar (iOS) atau jendela diubah ukurannya (macOS).
    private var screenChange: Notification.Name {
        #if os(iOS)
        UIDevice.orientationDidChangeNotification
        #else
        NSWindow.didResizeNotification
        #endif
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
    private var environment = (screen: CGSize.zero, dark: false)
    /// Ukuran layar untuk satuan vh/vw di style.
    @Published private(set) var screen = CGSize.zero

    /// Ukuran layar / mode gelap berubah. Sebelum mount cukup disimpan; dikirim tepat sebelum XP.mount.
    func setEnvironment(screen: CGSize, dark: Bool) {
        guard environment.screen != screen || environment.dark != dark else { return }
        environment = (screen, dark)
        self.screen = screen
        enqueue { engine in
            try self.apply(try await engine.environment(screen: screen, dark: dark))
        }
    }

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
            _ = try await engine.environment(screen: environment.screen, dark: environment.dark)
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
                _ = try await next.environment(screen: self.environment.screen, dark: self.environment.dark)
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
        /// position: absolute (ditempatkan oleh `absolutes`)
        case absolute
    }

    func root() -> AnyView {
        AnyView(container(tree.root.children, XPStyle()).frame(maxWidth: .infinity, alignment: .topLeading))
    }

    private var screen: CGSize { model.screen }

    /// View/Pressable/ScrollView: VStack, HStack, atau Grid sesuai style.
    /// Modal tidak ikut layout; dipasang sebagai sheet di background container.
    /// Anak position: absolute dipasang terpisah (lihat `absolutes`).
    func container(_ children: [Int], _ s: XPStyle) -> AnyView {
        let visible = children.filter { tree.node($0).map { !XPStyle.parse($0.style).absolute } ?? false }
        var regular = visible.filter { tree.node($0)?.type != "Modal" }
        if s.reverse { regular.reverse() }
        let modals = children.filter { tree.node($0)?.type == "Modal" }
        let modalLayer = ForEach(modals, id: \.self) { id in XPModalHost(model: model, id: id) }

        if s.display == "grid" {
            return AnyView(grid(regular, s).background(modalLayer))
        }

        let isRow = s.isRow
        let slot: Slot = isRow ? .row : .column(stretch: s.alignItems == "stretch")
        let between = s.justify == "space-between" || s.justify == "space-around" || s.justify == "space-evenly"
        let evenly = s.justify == "space-evenly" || s.justify == "space-around"
        let divider = s.dividerWidth > 0
        let dividerColor = Color(argb: s.dividerColor ?? s.color ?? 0xFFE5_E7EB)
        let autos = regular.map { tree.node($0).map { XPStyle.parse($0.style).autoMargin } ?? [] }
        let (before, after) = isRow ? ("leading", "trailing") : ("top", "bottom")

        let items = ForEach(Array(regular.enumerated()), id: \.element) { index, child in
            if (between && index > 0) || (evenly && index == 0) {
                Spacer(minLength: 0)
            }
            if autos[index].contains(before) && !autos[index].contains(after) { Spacer(minLength: 0) }
            node(child, slot: slot)
            if autos[index].contains(after) && !autos[index].contains(before) { Spacer(minLength: 0) }
            if divider && index < regular.count - 1 {
                if isRow {
                    dividerColor.frame(width: CGFloat(s.dividerWidth))
                } else {
                    dividerColor.frame(height: CGFloat(s.dividerWidth))
                }
            }
            if evenly && index == regular.count - 1 {
                Spacer(minLength: 0)
            }
        }
        let stack: AnyView = isRow
            ? AnyView(HStack(alignment: verticalAlign(s.alignItems), spacing: CGFloat(s.mainGap)) { items }
                .fixedSize(horizontal: false, vertical: divider)) // garis pemisah setinggi isi, tidak memanjang
            : AnyView(VStack(alignment: horizontalAlign(s.alignItems), spacing: CGFloat(s.mainGap)) { items })

        return AnyView(stack.background(modalLayer))
    }

    /// display: grid → `gridColumns` kolom sama lebar; gridColumnSpan memakai beberapa kolom.
    private func grid(_ children: [Int], _ s: XPStyle) -> some View {
        let cols = s.gridColumns
        var rows: [[XPGridCell]] = []
        var used = cols
        for c in children {
            let raw = tree.node(c).map { XPStyle.parse($0.style).gridColumnSpan } ?? 1
            let span = raw < 0 ? cols : min(max(raw, 1), cols)
            if used + span > cols {
                rows.append([])
                used = 0
            }
            rows[rows.count - 1].append(XPGridCell(id: c, span: span))
            used += span
        }
        return Grid(alignment: .topLeading, horizontalSpacing: CGFloat(s.columnGap ?? s.gap), verticalSpacing: CGFloat(s.rowGap ?? s.gap)) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    ForEach(row, id: \.id) { cell in
                        node(cell.id, slot: .column(stretch: true))
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                            .gridCellColumns(cell.span)
                    }
                    let rest = cols - row.reduce(0) { $0 + $1.span }
                    if rest > 0 {
                        Color.clear.frame(maxWidth: .infinity, maxHeight: 0).gridCellColumns(rest)
                    }
                }
            }
        }
    }

    /// Anak position: absolute di atas container (relatif ke kotaknya, di luar padding).
    private func absolutes(_ children: [Int]) -> AnyView? {
        let list = children.compactMap { id -> XPAbsoluteChild? in
            guard let n = tree.node(id) else { return nil }
            let s = XPStyle.parse(n.style)
            return s.absolute ? XPAbsoluteChild(id: id, style: s) : nil
        }
        guard !list.isEmpty else { return nil }
        let screen = self.screen
        return AnyView(GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                ForEach(list, id: \.id) { child in
                    let id = child.id, s = child.style
                    let w = Double(geo.size.width), h = Double(geo.size.height)
                    let l = s.left?.points(of: w, screen: screen), r = s.right?.points(of: w, screen: screen)
                    let t = s.top?.points(of: h, screen: screen), b = s.bottom?.points(of: h, screen: screen)
                    node(id, slot: .absolute)
                        // left + right (atau top + bottom) = lebar (tinggi) ikut container, seperti inset-x-0.
                        .frame(width: l != nil && r != nil && s.width == nil ? CGFloat(max(w - l! - r!, 0)) : nil,
                               height: t != nil && b != nil && s.height == nil ? CGFloat(max(h - t! - b!, 0)) : nil)
                        .frame(maxWidth: .infinity, maxHeight: .infinity,
                               alignment: Alignment(horizontal: l == nil && r != nil ? .trailing : .leading,
                                                    vertical: t == nil && b != nil ? .bottom : .top))
                        .offset(x: CGFloat(l ?? -(r ?? 0)), y: CGFloat(t ?? -(b ?? 0)))
                        .zIndex(s.zIndex)
                }
            }
        })
    }

    func node(_ id: Int, slot: Slot) -> AnyView {
        guard let n = tree.node(id) else { return AnyView(EmptyView()) }
        // pressedStyle / focusStyle / hoverStyle butuh state per elemen: dirender lewat View sendiri.
        if n.hasStateStyle {
            return AnyView(XPStatefulNode(renderer: self, revision: model.revision, id: id, slot: slot).id(n.id))
        }
        return build(n, slot: slot, interaction: nil)
    }

    func build(_ n: XPNode, slot: Slot, interaction: Binding<XPInteraction>?) -> AnyView {
        let state = interaction?.wrappedValue ?? XPInteraction()
        let s = XPStyle.parse(n.styleFor(pressed: state.pressed, focused: state.focused, hovered: state.hovered))
        if s.hidden { return AnyView(EmptyView()) } // display: none (className hidden)

        var fillWidth = false
        var fillHeight = false
        switch slot {
        case .column(let stretch):
            // Default flexbox kolom: anak melebar penuh (seperti di web).
            fillWidth = s.alignSelf == "stretch" || (s.alignSelf == nil && s.autoMargin.isDisjoint(with: ["leading", "trailing"]) && stretch && s.width == nil)
            fillHeight = s.flex > 0
        case .row:
            fillWidth = s.flex > 0
            fillHeight = s.alignSelf == "stretch"
        case .absolute:
            break
        }
        if case .percent = s.width { fillWidth = true }
        if case .percent = s.height { fillHeight = true }
        let overlay = absolutes(n.children)

        let view: AnyView
        switch n.type {
        case "View":
            view = swipe(n, box(container(n.children, s), s, fillWidth, fillHeight, align: containerAlign(s), overlay: overlay))

        case "Pressable":
            let key = n.handler("onPress")
            let content = box(container(n.children, s), s, fillWidth, fillHeight, align: containerAlign(s), overlay: overlay)
            let button = Button {
                if let key { model.dispatch(key) }
            } label: {
                content.contentShape(Rectangle())
            }
            let styled: AnyView
            if let interaction, n.props["pressedStyle"] != nil {
                styled = AnyView(button.buttonStyle(XPPressStyle { interaction.wrappedValue.pressed = $0 }))
            } else {
                styled = AnyView(button.buttonStyle(.plain))
            }
            view = swipe(n, AnyView(styled.disabled(key == nil || n.bool("disabled"))))

        case "ScrollView":
            let horizontal = n.bool("horizontal")
            var inner = s
            if horizontal { inner.direction = "row" }
            let scroll = ScrollView(horizontal ? .horizontal : .vertical) {
                container(n.children, inner)
            }
            view = box(scroll, s, fillWidth, fillHeight, align: .topLeading, overlay: overlay)

        case "Text", "#text":
            view = box(text(n, s), s, fillWidth, fillHeight, align: textAlign(s))

        case "Image":
            let fit = s.objectFit
            let image = AsyncImage(url: URL(string: n.string("src") ?? "")) { phase in
                if let img = phase.image {
                    switch fit {
                    case "contain": img.resizable().scaledToFit()
                    case "fill": img.resizable()
                    default: img.resizable().scaledToFill()
                    }
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
                onChange: onChange,
                onFocus: n.props["focusStyle"] == nil ? nil : interaction.map { binding in { binding.wrappedValue.focused = $0 } }
            )
            view = box(input, s, fillWidth, fillHeight, align: .leading)

        default:
            return AnyView(EmptyView())
        }

        var out = view
        if let interaction, n.props["hoverStyle"] != nil {
            out = AnyView(out.onHover { interaction.wrappedValue.hovered = $0 })
        }
        if s.transformed {
            out = AnyView(out
                .scaleEffect(x: CGFloat(s.scaleX), y: CGFloat(s.scaleY))
                .rotationEffect(.degrees(s.rotate))
                .modifier(XPTranslate(x: s.translateX, y: s.translateY, screen: screen)))
        }
        if let a = s.animation {
            out = AnyView(out.modifier(XPLoopAnimation(kind: a)))
        }
        if s.transition > 0 {
            out = AnyView(out.animation(animation(s), value: AnimatedValues(s)))
        }
        if let e = n.entering, n.createdAt > model.mountRevision {
            out = AnyView(out.modifier(XPEnteringModifier(entering: e)))
        }
        if case .column = slot {
            // alignSelf / margin auto (ml-auto, mx-auto) di kolom
            let auto = s.autoMargin
            let a: HorizontalAlignment? = auto.contains("leading") && auto.contains("trailing") ? .center
                : auto.contains("leading") ? .trailing
                : auto.contains("trailing") ? .leading
                : s.alignSelf.flatMap { $0 == "stretch" ? nil : $0 == "center" ? .center : $0 == "flex-end" ? .trailing : .leading }
            if let a { out = AnyView(out.frame(maxWidth: .infinity, alignment: Alignment(horizontal: a, vertical: .center))) }
        }
        if s.zIndex != 0 { out = AnyView(out.zIndex(s.zIndex)) }
        if s.pointerEventsNone { out = AnyView(out.allowsHitTesting(false)) }
        if let testID = n.testID {
            out = AnyView(out.accessibilityIdentifier(testID))
        }
        return AnyView(out.id(n.id))
    }

    private func text(_ n: XPNode, _ s: XPStyle) -> some View {
        let size = CGFloat(s.fontSize ?? 16)
        let font: Font
        switch s.fontFamily {
        case nil, "sans-serif"?: font = .system(size: size, weight: fontWeight(s.fontWeight))
        case "monospace"?: font = .system(size: size, weight: fontWeight(s.fontWeight), design: .monospaced)
        case "serif"?: font = .system(size: size, weight: fontWeight(s.fontWeight), design: .serif)
        case let name?: font = .custom(name, size: size).weight(fontWeight(s.fontWeight))
        }
        var t = Text(s.transform(tree.text(n))).font(font)
        if s.italic { t = t.italic() }
        if let c = s.color { t = t.foregroundColor(Color(argb: c)) }
        if let ls = s.letterSpacing { t = t.tracking(CGFloat(ls)) }
        if s.textDecoration == "underline" { t = t.underline() }
        if s.textDecoration == "line-through" { t = t.strikethrough() }
        let lines = (n.props["numberOfLines"] as? NSNumber)?.intValue ?? s.lineClamp ?? (s.noWrap ? 1 : nil)
        // lineHeight → jarak antar baris (lineHeight - tinggi font)
        let spacing = s.lineHeight.map { max(CGFloat($0) - size * 1.2, 0) } ?? 0
        return t
            .multilineTextAlignment(s.textAlign == "center" ? .center : s.textAlign == "right" ? .trailing : .leading)
            .lineLimit(lines)
            .lineSpacing(spacing)
            .truncationMode(.tail)
            .fixedSize(horizontal: s.noWrap && !s.ellipsis, vertical: true)
    }

    /// onSwipe dan dragAxis. Lihat XPDraggable.
    private func swipe(_ n: XPNode, _ v: AnyView) -> AnyView {
        let key = n.handler("onSwipe")
        let axis = n.string("dragAxis")
        guard key != nil || axis != nil else { return v }
        return AnyView(XPDraggable(content: v, axis: axis) { dir in
            if let key { model.dispatch(key, [dir]) }
        })
    }

    /// Box model: padding → ukuran → anak absolute → latar/gradien/border → sudut → shadow → opacity → margin.
    private func box<V: View>(_ v: V, _ s: XPStyle, _ fillWidth: Bool, _ fillHeight: Bool,
                              align: Alignment, clip: Bool = false, overlay: AnyView? = nil) -> AnyView {
        let screen = self.screen
        var out = AnyView(v.padding(EdgeInsets(top: s.padding.top, leading: s.padding.leading,
                                               bottom: s.padding.bottom, trailing: s.padding.trailing)))
        if let w = s.width, w.isFixed { out = AnyView(out.frame(width: CGFloat(w.points(of: 0, screen: screen)), alignment: align)) }
        if let h = s.height, h.isFixed { out = AnyView(out.frame(height: CGFloat(h.points(of: 0, screen: screen)), alignment: align)) }
        if fillWidth || fillHeight || s.minWidth != nil || s.maxWidth != nil || s.minHeight != nil || s.maxHeight != nil {
            let maxWidth = s.maxWidth.map { CGFloat($0) }
            let maxHeight = s.maxHeight.map { CGFloat($0) }
            out = AnyView(out.frame(
                minWidth: s.minWidth.map { CGFloat($0) },
                maxWidth: fillWidth ? (maxWidth ?? .infinity) : maxWidth,
                minHeight: s.minHeight.map { CGFloat($0) },
                maxHeight: fillHeight ? (maxHeight ?? .infinity) : maxHeight,
                alignment: align
            ))
        }
        if let ratio = s.aspectRatio { out = AnyView(out.aspectRatio(CGFloat(ratio), contentMode: .fit)) }
        if let overlay { out = AnyView(out.overlay(overlay)) }
        if clip { out = AnyView(out.clipped()) }

        let shape = XPCornerShape(corners: s.cornerRadii)
        if let bg = s.background {
            out = AnyView(out.background(shape.fill(Color(argb: bg))))
        }
        if let g = s.gradient {
            out = AnyView(out.background(shape.fill(g.linear)))
        }
        if s.hasBorder {
            let color = Color(argb: s.borderColor ?? 0xFF00_0000)
            let e = s.borderEdges
            let dash: [CGFloat] = s.borderStyle == "dashed" ? [CGFloat(max(e.top, 1) * 3), CGFloat(max(e.top, 1) * 2)]
                : s.borderStyle == "dotted" ? [CGFloat(max(e.top, 1)), CGFloat(max(e.top, 1))] : []
            if e.isUniform {
                out = AnyView(out.overlay(shape.inset(by: CGFloat(e.top) / 2).stroke(color, style: StrokeStyle(lineWidth: CGFloat(e.top), dash: dash))))
            } else {
                out = AnyView(out.overlay(XPSideBorders(edges: e, color: color, dash: dash)))
            }
        }
        if s.rounded || s.clip { out = AnyView(out.clipShape(shape)) }
        for ring in s.shadows where ring.isRing {
            out = AnyView(out.overlay(shape.inset(by: -CGFloat(ring.spread) / 2).stroke(Color(argb: ring.color), lineWidth: CGFloat(ring.spread))))
        }
        if let sh = s.shadows.filter({ !$0.isRing && $0.blur > 0 }).max(by: { $0.blur < $1.blur }) {
            out = AnyView(out.shadow(color: Color(argb: sh.color), radius: CGFloat(sh.blur / 2), x: CGFloat(sh.x), y: CGFloat(sh.y)))
        }
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

// MARK: - Bentuk dan efek

struct XPGridCell: Hashable {
    let id: Int
    let span: Int
}

struct XPAbsoluteChild {
    let id: Int
    let style: XPStyle
}

extension XPSize {
    /// Ukuran tetap (point atau satuan layar), bukan persen dari parent.
    var isFixed: Bool {
        if case .percent = self { return false }
        return true
    }
}

extension XPGradient {
    /// Sudut CSS → titik awal/akhir SwiftUI (0° = ke atas, 90° = ke kanan).
    var linear: LinearGradient {
        let rad = angle * .pi / 180
        let dx = sin(rad) / 2, dy = -cos(rad) / 2
        return LinearGradient(
            colors: colors.map { Color(argb: $0) },
            startPoint: UnitPoint(x: 0.5 - dx, y: 0.5 - dy),
            endPoint: UnitPoint(x: 0.5 + dx, y: 0.5 + dy)
        )
    }
}

/// Persegi dengan radius per pojok (rounded-t-lg dll). Bisa di-inset untuk border.
struct XPCornerShape: InsettableShape {
    var corners: XPCorners
    var insetAmount: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let r = rect.insetBy(dx: insetAmount, dy: insetAmount)
        guard r.width > 0, r.height > 0 else { return Path() }
        let limit = min(r.width, r.height) / 2
        func c(_ v: Double) -> CGFloat { min(max(CGFloat(v) - insetAmount, 0), limit) }
        let tl = c(corners.topLeading), tr = c(corners.topTrailing), br = c(corners.bottomTrailing), bl = c(corners.bottomLeading)
        var p = Path()
        p.move(to: CGPoint(x: r.minX + tl, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX - tr, y: r.minY))
        p.addArc(center: CGPoint(x: r.maxX - tr, y: r.minY + tr), radius: tr, startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false)
        p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - br))
        p.addArc(center: CGPoint(x: r.maxX - br, y: r.maxY - br), radius: br, startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        p.addLine(to: CGPoint(x: r.minX + bl, y: r.maxY))
        p.addArc(center: CGPoint(x: r.minX + bl, y: r.maxY - bl), radius: bl, startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        p.addLine(to: CGPoint(x: r.minX, y: r.minY + tl))
        p.addArc(center: CGPoint(x: r.minX + tl, y: r.minY + tl), radius: tl, startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        p.closeSubpath()
        return p
    }

    func inset(by amount: CGFloat) -> XPCornerShape {
        var s = self
        s.insetAmount += amount
        return s
    }
}

/// Border dengan lebar berbeda per sisi (border-t, border-b-2, ...).
struct XPSideBorders: View {
    let edges: XPEdges
    let color: Color
    let dash: [CGFloat]

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            ZStack {
                side(edges.top) { $0.move(to: CGPoint(x: 0, y: CGFloat(edges.top) / 2)); $0.addLine(to: CGPoint(x: w, y: CGFloat(edges.top) / 2)) }
                side(edges.bottom) { $0.move(to: CGPoint(x: 0, y: h - CGFloat(edges.bottom) / 2)); $0.addLine(to: CGPoint(x: w, y: h - CGFloat(edges.bottom) / 2)) }
                side(edges.leading) { $0.move(to: CGPoint(x: CGFloat(edges.leading) / 2, y: 0)); $0.addLine(to: CGPoint(x: CGFloat(edges.leading) / 2, y: h)) }
                side(edges.trailing) { $0.move(to: CGPoint(x: w - CGFloat(edges.trailing) / 2, y: 0)); $0.addLine(to: CGPoint(x: w - CGFloat(edges.trailing) / 2, y: h)) }
            }
        }
        .allowsHitTesting(false)
    }

    private func side(_ width: Double, _ build: @escaping (inout Path) -> Void) -> some View {
        Path(build).stroke(color, style: StrokeStyle(lineWidth: CGFloat(width), dash: dash)).opacity(width > 0 ? 1 : 0)
    }
}

/// translateX/Y: point, satuan layar, atau persen dari ukuran elemen sendiri.
struct XPTranslate: GeometryEffect {
    let x: XPSize?
    let y: XPSize?
    let screen: CGSize

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(
            translationX: CGFloat(x?.points(of: Double(size.width), screen: screen) ?? 0),
            y: CGFloat(y?.points(of: Double(size.height), screen: screen) ?? 0)
        ))
    }
}

/// Geser vertikal sebesar bagian dari tinggi elemen (untuk animate-bounce).
struct XPFractionOffset: GeometryEffect {
    var fraction: Double

    var animatableData: Double {
        get { fraction }
        set { fraction = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: 0, y: CGFloat(fraction) * size.height))
    }
}

/// animate-spin / animate-pulse / animate-bounce / animate-ping, sama seperti keyframes Tailwind.
struct XPLoopAnimation: ViewModifier {
    let kind: String
    @State private var on = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(kind == "ping" && on ? 2 : 1)
            .rotationEffect(.degrees(kind == "spin" && on ? 360 : 0))
            .opacity(kind == "pulse" && on ? 0.5 : kind == "ping" && on ? 0 : 1)
            .modifier(XPFractionOffset(fraction: kind == "bounce" ? (on ? 0 : -0.25) : 0))
            .onAppear {
                let animation: Animation
                switch kind {
                case "spin": animation = .linear(duration: 1).repeatForever(autoreverses: false)
                case "pulse": animation = .easeInOut(duration: 1).repeatForever(autoreverses: true)
                case "ping": animation = .easeOut(duration: 1).repeatForever(autoreverses: false)
                default: animation = .easeInOut(duration: 0.5).repeatForever(autoreverses: true)
                }
                withAnimation(animation) { on = true }
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
    let transform: [Double]
    let translate: [XPSize?]

    init(_ s: XPStyle) {
        background = s.background
        borderColor = s.borderColor
        color = s.color
        opacity = s.opacity
        width = s.width
        height = s.height
        transform = [s.scaleX, s.scaleY, s.rotate]
        translate = [s.translateX, s.translateY]
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

/// Keadaan elemen untuk pressedStyle / focusStyle / hoverStyle.
struct XPInteraction: Equatable {
    var pressed = false
    var focused = false
    var hovered = false
}

/// Node dengan style keadaan. `revision` ikut supaya SwiftUI merender ulang saat tree berubah.
struct XPStatefulNode: View {
    let renderer: XPRenderer
    let revision: Int
    let id: Int
    let slot: XPRenderer.Slot
    @State private var interaction = XPInteraction()

    var body: some View {
        if let n = renderer.model.tree.node(id) {
            renderer.build(n, slot: slot, interaction: $interaction)
        }
    }
}

/// ButtonStyle yang melaporkan saat tombol ditekan (untuk pressedStyle). Tampilan tetap dari style xp.
struct XPPressStyle: ButtonStyle {
    let onPress: (Bool) -> Void

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .onChange(of: configuration.isPressed) { onPress($0) }
    }
}

struct XPTextInputView: View {
    let value: String
    let placeholder: String
    let secure: Bool
    let fontSize: Double
    let color: Color?
    let onChange: ((String) -> Void)?
    var onFocus: ((Bool) -> Void)? = nil

    @State private var text = ""
    @FocusState private var focused: Bool

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
        .focused($focused)
        .onChange(of: focused) { onFocus?($0) }
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
