// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "XPKit",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "XPKit", targets: ["XPKit"]),
    ],
    targets: [
        .target(name: "XPKit"),
        .testTarget(
            name: "XPKitTests",
            dependencies: ["XPKit"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
