// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The generated iOS project is committed, so the things a push, a deep link
// and an App Store review depend on are pinned here rather than re-derived
// from a regeneration: the bundle id, the `liaison` URL scheme, the push
// entitlement, the DELIBERATE absence of associated domains, the arm64 device
// requirement and the privacy manifest.
//
// No universal links: an association file has to be served from the
// operator's own host, every fork runs its own, and an entitlement naming one
// operator's domain is a customer name shipped in a binary every fork uses.
// Links into the app use the `liaison` scheme and push taps.

import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const ROOT = import.meta.dir
const APP_DIR = path.join(ROOT, "ios", "App")
const INFO_PLIST = path.join(APP_DIR, "App", "Info.plist")
const ENTITLEMENTS = path.join(APP_DIR, "App", "App.entitlements")
const PRIVACY = path.join(APP_DIR, "App", "PrivacyInfo.xcprivacy")
const PBXPROJ = path.join(APP_DIR, "App.xcodeproj", "project.pbxproj")

// plutil on a Mac; libplist's plistutil elsewhere (the gate's Linux runners install it).
const PLIST_TO_JSON =
  process.platform === "darwin"
    ? (file: string) => ["plutil", "-convert", "json", "-o", "-", file]
    : (file: string) => ["plistutil", "-i", file, "-f", "json"]

function plistJson<T>(file: string): T {
  const result = Bun.spawnSync(PLIST_TO_JSON(file), {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return JSON.parse(result.stdout.toString()) as T
}

interface InfoPlist {
  CFBundleURLTypes?: { CFBundleURLName?: string; CFBundleURLSchemes?: string[] }[]
  CFBundleDisplayName?: string
  UIRequiredDeviceCapabilities?: string[]
  NSMicrophoneUsageDescription?: string
}

interface PrivacyManifest {
  NSPrivacyTracking?: boolean
  NSPrivacyTrackingDomains?: string[]
  NSPrivacyAccessedAPITypes?: {
    NSPrivacyAccessedAPIType: string
    NSPrivacyAccessedAPITypeReasons: string[]
  }[]
  NSPrivacyCollectedDataTypes?: {
    NSPrivacyCollectedDataType: string
    NSPrivacyCollectedDataTypeLinked: boolean
    NSPrivacyCollectedDataTypeTracking: boolean
    NSPrivacyCollectedDataTypePurposes: string[]
  }[]
}

const readPlist = (): InfoPlist => plistJson<InfoPlist>(INFO_PLIST)

describe("ios platform config", () => {
  it("generated the native project", () => {
    expect(existsSync(INFO_PLIST)).toBe(true)
    expect(existsSync(PBXPROJ)).toBe(true)
  })

  it("declares the liaison URL scheme", () => {
    const plist = readPlist()
    const schemes = (plist.CFBundleURLTypes ?? []).flatMap((t) => t.CFBundleURLSchemes ?? [])
    expect(schemes).toContain("liaison")
  })

  it("carries the mobile bundle id and display name", () => {
    const pbxproj = readFileSync(PBXPROJ, "utf8")
    expect(pbxproj).toContain("PRODUCT_BUNDLE_IDENTIFIER = sh.liaison.mobile;")
    expect(readPlist().CFBundleDisplayName).toBe("Liaison")
  })

  it("signs the app and its notification extension with the one team in both build configs", () => {
    const pbxproj = readFileSync(PBXPROJ, "utf8")
    const teams = [...pbxproj.matchAll(/DEVELOPMENT_TEAM = (\w+);/g)].map((x) => x[1])
    expect(teams).toEqual(["W8NVNW4TTL", "W8NVNW4TTL", "W8NVNW4TTL", "W8NVNW4TTL"])
  })

  it("embeds the Notification Service Extension, sharing the app's App Group", () => {
    // The extension runs for every `mutable-content: 1` alert, even with the
    // app killed: it is where delivery receipts come from. Built but not
    // embedded, it silently never runs.
    const pbxproj = readFileSync(PBXPROJ, "utf8")
    expect(pbxproj).toContain("PRODUCT_BUNDLE_IDENTIFIER = sh.liaison.mobile.nse;")
    expect(pbxproj).toContain("NotificationService.appex in Embed Foundation Extensions")
    expect(
      pbxproj.split(
        "CODE_SIGN_ENTITLEMENTS = NotificationService/NotificationService.entitlements;",
      ).length - 1,
    ).toBe(2)
    const nseDir = path.join(APP_DIR, "NotificationService")
    const nsePlist = plistJson<{ NSExtension?: { NSExtensionPointIdentifier?: string } }>(
      path.join(nseDir, "Info.plist"),
    )
    expect(nsePlist.NSExtension?.NSExtensionPointIdentifier).toBe(
      "com.apple.usernotifications.service",
    )
    const group = "com.apple.security.application-groups"
    const app = plistJson<Record<string, unknown>>(ENTITLEMENTS)
    const nse = plistJson<Record<string, unknown>>(
      path.join(nseDir, "NotificationService.entitlements"),
    )
    expect(app[group]).toEqual(["group.sh.liaison.mobile"])
    expect(nse[group]).toEqual(app[group])
  })

  it("claims the push entitlement, and signs the entitlements into BOTH build configs", () => {
    // Without aps-environment, registerForRemoteNotifications fails on a
    // device and App Store Connect flags the upload. `development` in the
    // file: Xcode rewrites it to `production` when it exports for
    // distribution. Wired into Debug AND Release, or a release build ships
    // without push and nobody finds out until it is in the store.
    const entitlements = plistJson<Record<string, unknown>>(ENTITLEMENTS)
    expect(entitlements["aps-environment"]).toBe("development")
    const pbxproj = readFileSync(PBXPROJ, "utf8")
    expect(pbxproj.split("CODE_SIGN_ENTITLEMENTS = App/App.entitlements;").length - 1).toBe(2)
  })

  it("associates no domain: no universal links", () => {
    const entitlements = plistJson<Record<string, unknown>>(ENTITLEMENTS)
    expect(entitlements["com.apple.developer.associated-domains"]).toBeUndefined()
    expect(readFileSync(ENTITLEMENTS, "utf8")).not.toContain("applinks:")
  })

  it("ships no association file for anyone to serve", () => {
    expect(existsSync(path.join(ROOT, "well-known"))).toBe(false)
    const found = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.name === "node_modules" || e.name === "public" || e.name === "build") return []
        const full = path.join(dir, e.name)
        if (e.isDirectory()) return found(full)
        return e.name === "apple-app-site-association" || e.name === "assetlinks.json" ? [full] : []
      })
    expect(found(ROOT)).toEqual([])
  })

  it("refuses a Release build whose web bundle lacks the mobile boot layer", () => {
    // `bun run build:web` + `cap sync` ships a page without liaison-mobile-boot.js:
    // no native bridge, and the app never leaves the splash (TestFlight builds 1
    // and 2, 2026-09-28). The build phase fails the archive instead.
    const pbxproj = readFileSync(PBXPROJ, "utf8")
    expect(pbxproj).toContain("/* Check mobile boot layer */,")
    expect(pbxproj).toContain("grep -q liaison-mobile-boot.js")
  })

  it("explains the microphone, which dictation records through (S9)", () => {
    // Without the key iOS kills the app the moment the web view calls
    // getUserMedia. The text is what the permission prompt shows.
    const text = readPlist().NSMicrophoneUsageDescription ?? ""
    expect(text.length).toBeGreaterThan(20)
    expect(text.toLowerCase()).toContain("dictat")
  })

  it("requires arm64, not the 32 bit armv7 the template names", () => {
    expect(readPlist().UIRequiredDeviceCapabilities).toEqual(["arm64"])
  })

  it("declares encryption exempt: ITSAppUsesNonExemptEncryption is false, no compliance code", () => {
    // The app uses only the encryption the operating system provides: WebCrypto
    // in WebKit, TLS, CommonCrypto (STORE_CHECKLIST.md, "Export compliance").
    // That is Apple's first row, which needs no documentation, so the key is
    // false and App Store Connect asks nothing per build. It is only true while
    // the bundle carries no Argon2id, which the next test pins.
    const plist = plistJson<Record<string, unknown>>(INFO_PLIST)
    expect(plist.ITSAppUsesNonExemptEncryption).toBe(false)
    expect(plist.ITSEncryptionExportComplianceCode).toBeUndefined()
  })

  it("ships a web bundle with no Argon2id: the synced iOS assets, else the native build", () => {
    // The legacy mailbox passphrase KDF (Argon2id, hash-wasm WASM) was the only
    // primitive not provided by Apple. The native build leaves it out by
    // aliasing its one module to a stand-in (apps/web/vite.config.ts), and the
    // mobile app wraps that build. Scanned where it lands: ios/App/App/public
    // after `bun run build:mobile`, or apps/web/dist-native. A checkout with
    // neither built fails here rather than passing on nothing.
    const trees = [
      path.join(APP_DIR, "App", "public"),
      path.resolve(ROOT, "..", "web", "dist-native"),
    ].filter((dir) => existsSync(dir))
    expect(trees.length, "run `bun run build:mobile` in apps/mobile first").toBeGreaterThan(0)
    const tree = trees[0]
    const scanned: string[] = []
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith(".wasm")) offenders.push(`${full}: a WebAssembly module`)
        else if (/\.(?:js|mjs|html)$/.test(entry.name)) {
          scanned.push(full)
          const found = readFileSync(full, "utf8").match(/hash-wasm|argon2/i)
          if (found) offenders.push(`${full}: ${found[0]}`)
        }
      }
    }
    walk(tree)
    // Non-vacuity: this is a real build, crypto worker included.
    expect(scanned.some((file) => /crypto-worker-(?!boot)[^/]*\.js$/.test(file))).toBe(true)
    expect(offenders).toEqual([])
  })

  it("keeps the mechanism that makes the bundle Argon2id free in place", () => {
    // hash-wasm is reached from exactly one module, the one the native build
    // swaps out; the swap is wired; and the mobile app wraps the native build.
    const cryptoSrc = path.join(ROOT, "..", "..", "packages", "mailbox-crypto", "src")
    const importers = readdirSync(cryptoSrc).filter(
      (name) =>
        name.endsWith(".ts") &&
        !name.endsWith(".test.ts") &&
        readFileSync(path.join(cryptoSrc, name), "utf8").includes('import("hash-wasm")'),
    )
    expect(importers).toEqual(["legacy-passphrase-kdf.ts"])
    const vite = readFileSync(path.join(ROOT, "..", "web", "vite.config.ts"), "utf8")
    expect(vite).toContain("legacy-passphrase-kdf.native.ts")
    expect(vite).toContain('NATIVE_OUT_DIR = "dist-native"')
    expect(readFileSync(path.join(ROOT, "capacitor.config.ts"), "utf8")).toContain(
      'webDir: "../web/dist-native"',
    )
  })
})

describe("ios privacy manifest", () => {
  it("exists and is copied into the app bundle by the App target", () => {
    expect(existsSync(PRIVACY)).toBe(true)
    const pbxproj = readFileSync(PBXPROJ, "utf8")
    const fileRef = pbxproj.match(
      /(\w{24}) \/\* PrivacyInfo\.xcprivacy \*\/ = \{isa = PBXFileReference;/,
    )
    expect(fileRef).not.toBeNull()
    const buildFile = pbxproj.match(
      new RegExp(
        `(\\w{24}) /\\* PrivacyInfo\\.xcprivacy in Resources \\*/ = \\{isa = PBXBuildFile; fileRef = ${fileRef?.[1]} `,
      ),
    )
    expect(buildFile).not.toBeNull()
    const resources = pbxproj.match(/isa = PBXResourcesBuildPhase;[\s\S]*?files = \(([\s\S]*?)\);/)
    expect(resources?.[1]).toContain(`${buildFile?.[1]} /* PrivacyInfo.xcprivacy in Resources */`)
  })

  it("declares no tracking and the required reason APIs the app uses", () => {
    const manifest = plistJson<PrivacyManifest>(PRIVACY)
    expect(manifest.NSPrivacyTracking).toBe(false)
    expect(manifest.NSPrivacyTrackingDomains).toEqual([])
    const apis = Object.fromEntries(
      (manifest.NSPrivacyAccessedAPITypes ?? []).map((a) => [
        a.NSPrivacyAccessedAPIType,
        a.NSPrivacyAccessedAPITypeReasons,
      ]),
    )
    // @capacitor/preferences keeps its values in UserDefaults and ships no
    // manifest of its own, so the app declares it: CA92.1, the app's own data.
    expect(apis.NSPrivacyAccessedAPICategoryUserDefaults).toEqual(["CA92.1"])
  })

  it("declares the data the app collects: never tracking, app functionality", () => {
    const manifest = plistJson<PrivacyManifest>(PRIVACY)
    const collected = manifest.NSPrivacyCollectedDataTypes ?? []
    expect(collected.map((c) => c.NSPrivacyCollectedDataType).sort()).toEqual(
      [
        "NSPrivacyCollectedDataTypeAudioData",
        "NSPrivacyCollectedDataTypeDeviceID",
        "NSPrivacyCollectedDataTypeEmailAddress",
        "NSPrivacyCollectedDataTypeName",
        "NSPrivacyCollectedDataTypeOtherUserContent",
      ].sort(),
    )
    // Dictation audio is transcribed in memory and never stored, so it is
    // the one type not linked to the account; everything else is.
    const linked = Object.fromEntries(
      collected.map((c) => [c.NSPrivacyCollectedDataType, c.NSPrivacyCollectedDataTypeLinked]),
    )
    expect(linked.NSPrivacyCollectedDataTypeAudioData).toBe(false)
    for (const c of collected) {
      if (c.NSPrivacyCollectedDataType !== "NSPrivacyCollectedDataTypeAudioData") {
        expect(c.NSPrivacyCollectedDataTypeLinked).toBe(true)
      }
      expect(c.NSPrivacyCollectedDataTypeTracking).toBe(false)
      expect(c.NSPrivacyCollectedDataTypePurposes).toEqual([
        "NSPrivacyCollectedDataTypePurposeAppFunctionality",
      ])
    }
  })
})

describe("ios native plugin and push forwarding", () => {
  const appDir = path.join(APP_DIR, "App")
  const pbxproj = (): string => readFileSync(PBXPROJ, "utf8")

  it("compiles the local LiaisonNative plugin and the bridge controller that registers it", () => {
    for (const file of ["LiaisonNativePlugin.swift", "MainViewController.swift"]) {
      expect(existsSync(path.join(appDir, file))).toBe(true)
      expect(pbxproj()).toContain(`/* ${file} in Sources */`)
    }
    const controller = readFileSync(path.join(appDir, "MainViewController.swift"), "utf8")
    expect(controller).toContain("CAPBridgeViewController")
    expect(controller).toContain("capacitorDidLoad")
    expect(controller).toContain("registerPluginInstance(LiaisonNativePlugin())")
    const plugin = readFileSync(path.join(appDir, "LiaisonNativePlugin.swift"), "utf8")
    expect(plugin).toContain('jsName = "LiaisonNative"')
    expect(plugin).toContain('"apsEnvironment"')
    expect(plugin).toContain('"authenticate"')
    expect(plugin).toContain("ASWebAuthenticationSession")
    expect(plugin).toContain("prefersEphemeralWebBrowserSession = false")
    expect(plugin).toContain("embedded.mobileprovision")
  })

  it("presents a foreground push with the system banner, never for the conversation on screen", () => {
    // TestFlight build 17 (2026-10-12): no presenter, so iOS drew nothing for
    // a push with the app open and only the web app's own strip appeared.
    expect(existsSync(path.join(appDir, "ForegroundPushPresenter.swift"))).toBe(true)
    expect(pbxproj()).toContain("/* ForegroundPushPresenter.swift in Sources */")
    const presenter = readFileSync(path.join(appDir, "ForegroundPushPresenter.swift"), "utf8")
    expect(presenter).toContain("NotificationHandlerProtocol")
    expect(presenter).toContain('return ([.banner, .list, .sound], "shown", nil)')
    expect(presenter).toContain('return ([], "suppressed", "on_screen")')
    // It wraps Capacitor's handler (the JS `pushNotificationReceived` keeps
    // firing) rather than replacing it, and reports every decision.
    expect(presenter).toContain("inner?.willPresent(notification: notification)")
    expect(presenter).toContain("inner?.didReceive(response: response)")
    const plugin = readFileSync(path.join(appDir, "LiaisonNativePlugin.swift"), "utf8")
    expect(plugin).toContain("router.pushNotificationHandler = presenter")
    expect(plugin).toContain('notifyListeners("pushPresentation"')
    expect(plugin).toContain('"setThreadOnScreen"')
  })

  it("answers native calls from the main frame only: an installed app's frame reaches no plugin", () => {
    // WKWebView offers a script message handler to every frame, and Capacitor's
    // own handler does not ask which frame posted. An installed app's UI runs
    // in a sandboxed frame (web isolated-app.tsx), which must not reach the
    // secure storage holding the session.
    const controller = readFileSync(path.join(appDir, "MainViewController.swift"), "utf8")
    expect(controller).toContain("message.frameInfo.isMainFrame")
    expect(controller).toContain('removeScriptMessageHandler(forName: "bridge")')
    expect(controller).toMatch(
      /\.add\(MainFrameOnlyMessageHandler\(inner: [a-z]+\), name: "bridge"\)/,
    )
    // Swapped as soon as the bridge is up, before any page script runs.
    const load = controller.indexOf("override func capacitorDidLoad()")
    expect(controller.indexOf("MainFrameOnlyMessageHandler(inner:")).toBeGreaterThan(load)
  })

  it("roots the window in the controller that registers the plugin", () => {
    const scene = readFileSync(path.join(appDir, "SceneDelegate.swift"), "utf8")
    expect(scene).toContain("MainViewController()")
    expect(scene).not.toContain("= CAPBridgeViewController()")
    const storyboard = readFileSync(path.join(appDir, "Base.lproj", "Main.storyboard"), "utf8")
    expect(storyboard).toContain('customClass="MainViewController" customModule="App"')
  })

  it("forwards the APNs token and its failure to Capacitor", () => {
    // Without these two callbacks @capacitor/push-notifications never hears
    // the token: `register()` resolves and no `registration` event follows.
    const delegate = readFileSync(path.join(appDir, "AppDelegate.swift"), "utf8")
    expect(delegate).toContain("didRegisterForRemoteNotificationsWithDeviceToken")
    expect(delegate).toContain(".capacitorDidRegisterForRemoteNotifications")
    expect(delegate).toContain("didFailToRegisterForRemoteNotificationsWithError")
    expect(delegate).toContain(".capacitorDidFailToRegisterForRemoteNotifications")
  })

  it("shares one keychain access group between the app and the NSE (A7)", () => {
    // The app writes the receipt credential, the extension reads it: a group
    // only one of them claims is an item the other can never find.
    const key = "keychain-access-groups"
    const app = plistJson<Record<string, unknown>>(ENTITLEMENTS)
    const nse = plistJson<Record<string, unknown>>(
      path.join(APP_DIR, "NotificationService", "NotificationService.entitlements"),
    )
    const shared = "$(AppIdentifierPrefix)sh.liaison.mobile.shared"
    expect(app[key]).toContain(shared)
    expect(nse[key]).toEqual([shared])
  })

  it("files what names no keychain group in the app's own group, not the shared one", () => {
    // Keychain items written without an access group (the refresh token, in
    // the secure-storage plugin) go to the FIRST group listed. That must be
    // the app's own: the extension holds only the receipt credential.
    const app = plistJson<Record<string, unknown>>(ENTITLEMENTS)
    expect((app["keychain-access-groups"] as string[])[0]).toBe(
      "$(AppIdentifierPrefix)sh.liaison.mobile",
    )
  })

  it("compiles the receipt store into BOTH the app and the extension", () => {
    const pbx = pbxproj()
    const ref = pbx.match(/(\w{24}) \/\* ReceiptStore\.swift \*\/ = \{isa = PBXFileReference/)
    expect(ref).not.toBeNull()
    const builds = [
      ...pbx.matchAll(/(\w{24}) \/\* ReceiptStore\.swift in Sources \*\/ = \{isa = PBXBuildFile/g),
    ]
    expect(builds).toHaveLength(2)
    const phases = [
      ...pbx.matchAll(/isa = PBXSourcesBuildPhase;[\s\S]*?files = \(([\s\S]*?)\);/g),
    ].map((m) => m[1] ?? "")
    expect(phases).toHaveLength(2)
    for (const phase of phases) expect(phase).toContain("ReceiptStore.swift in Sources")
    const store = readFileSync(
      path.join(APP_DIR, "NotificationService", "ReceiptStore.swift"),
      "utf8",
    )
    expect(store).toContain("sh.liaison.mobile.shared")
    expect(store).toContain("kSecAttrAccessibleAfterFirstUnlock")
    expect(store).toContain("group.sh.liaison.mobile")
    expect(store).toContain("/api/notifications/receipts")
  })

  it("posts `received` from the extension, queueing it when the post cannot land (S2)", () => {
    const nse = readFileSync(
      path.join(APP_DIR, "NotificationService", "NotificationService.swift"),
      "utf8",
    )
    expect(nse).toContain('outcome: "received"')
    expect(nse).toContain("ReceiptStore.enqueue")
    const plugin = readFileSync(path.join(appDir, "LiaisonNativePlugin.swift"), "utf8")
    for (const method of [
      "receiptCredentialGet",
      "receiptCredentialSet",
      "receiptCredentialDelete",
      "receiptQueueList",
      "receiptQueueRemove",
      "receiptQueueAppend",
      "debugConsumeForcedRegisterFailure",
    ]) {
      expect(plugin).toContain(`"${method}"`)
    }
    // The forced failure is a debug build's tool only (M5).
    expect(plugin).toMatch(/#if DEBUG[\s\S]*LIAISON_DEBUG_FAIL_NEXT_REGISTER[\s\S]*#endif/)
  })

  it("opens a thread at launch from LIAISON_DEBUG_OPEN_ROUTE in debug builds only (matrix M2 same thread)", () => {
    const scene = readFileSync(path.join(appDir, "SceneDelegate.swift"), "utf8")
    // Every mention of the variable sits inside a DEBUG block: a release build
    // never reads it.
    const outsideDebug = scene.replace(/#if DEBUG[\s\S]*?#endif/g, "")
    expect(scene).toContain("LIAISON_DEBUG_OPEN_ROUTE")
    expect(outsideDebug).not.toContain("LIAISON_DEBUG_OPEN_ROUTE")
    // The route goes through the app's own fail-closed `liaison://thread/<id>`
    // link, dispatched as an ordinary URL open, never straight into the webview.
    const debugBlocks = (scene.match(/#if DEBUG[\s\S]*?#endif/g) ?? []).join("\n")
    expect(debugBlocks).toContain("liaison://thread/")
    expect(debugBlocks).toContain("ApplicationDelegateProxy.shared.application(")
  })
})
