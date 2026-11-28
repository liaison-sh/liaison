// swift-tools-version: 5.9
import PackageDescription

// The served shell's verification and storage (apps/mobile/ios/LiaisonShell/README.md).
// Foundation and CryptoKit only, so its tests run on a simulator with no app around them:
//   xcodebuild test -scheme LiaisonShell -destination 'platform=iOS Simulator,name=<device>'
let package = Package(
    name: "LiaisonShell",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "LiaisonShell", targets: ["LiaisonShell"])
    ],
    targets: [
        .target(name: "LiaisonShell"),
        .testTarget(name: "LiaisonShellTests", dependencies: ["LiaisonShell"])
    ]
)
