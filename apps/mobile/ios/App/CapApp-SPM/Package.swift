// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.2"),
        .package(name: "AparajitaCapacitorBiometricAuth", path: "../../../../../node_modules/.bun/@aparajita+capacitor-biometric-auth@10.0.0/node_modules/@aparajita/capacitor-biometric-auth"),
        .package(name: "AparajitaCapacitorSecureStorage", path: "../../../../../node_modules/.bun/@aparajita+capacitor-secure-storage@8.0.1/node_modules/@aparajita/capacitor-secure-storage"),
        .package(name: "CapacitorApp", path: "../../../../../node_modules/.bun/@capacitor+app@8.1.1+8c735c3c6e2ff3c1/node_modules/@capacitor/app"),
        .package(name: "CapacitorHaptics", path: "../../../../../node_modules/.bun/@capacitor+haptics@8.0.2+8c735c3c6e2ff3c1/node_modules/@capacitor/haptics"),
        .package(name: "CapacitorKeyboard", path: "../../../../../node_modules/.bun/@capacitor+keyboard@8.0.5+8c735c3c6e2ff3c1/node_modules/@capacitor/keyboard"),
        .package(name: "CapacitorNetwork", path: "../../../../../node_modules/.bun/@capacitor+network@8.0.1+8c735c3c6e2ff3c1/node_modules/@capacitor/network"),
        .package(name: "CapacitorPreferences", path: "../../../../../node_modules/.bun/@capacitor+preferences@8.0.1+8c735c3c6e2ff3c1/node_modules/@capacitor/preferences"),
        .package(name: "CapacitorPushNotifications", path: "../../../../../node_modules/.bun/@capacitor+push-notifications@8.1.2+8c735c3c6e2ff3c1/node_modules/@capacitor/push-notifications"),
        .package(name: "CapacitorShare", path: "../../../../../node_modules/.bun/@capacitor+share@8.0.2+8c735c3c6e2ff3c1/node_modules/@capacitor/share"),
        .package(name: "CapacitorSplashScreen", path: "../../../../../node_modules/.bun/@capacitor+splash-screen@8.0.2+8c735c3c6e2ff3c1/node_modules/@capacitor/splash-screen"),
        .package(name: "CapacitorStatusBar", path: "../../../../../node_modules/.bun/@capacitor+status-bar@8.0.3+8c735c3c6e2ff3c1/node_modules/@capacitor/status-bar")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "AparajitaCapacitorBiometricAuth", package: "AparajitaCapacitorBiometricAuth"),
                .product(name: "AparajitaCapacitorSecureStorage", package: "AparajitaCapacitorSecureStorage"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorHaptics", package: "CapacitorHaptics"),
                .product(name: "CapacitorKeyboard", package: "CapacitorKeyboard"),
                .product(name: "CapacitorNetwork", package: "CapacitorNetwork"),
                .product(name: "CapacitorPreferences", package: "CapacitorPreferences"),
                .product(name: "CapacitorPushNotifications", package: "CapacitorPushNotifications"),
                .product(name: "CapacitorShare", package: "CapacitorShare"),
                .product(name: "CapacitorSplashScreen", package: "CapacitorSplashScreen"),
                .product(name: "CapacitorStatusBar", package: "CapacitorStatusBar")
            ]
        )
    ]
)
