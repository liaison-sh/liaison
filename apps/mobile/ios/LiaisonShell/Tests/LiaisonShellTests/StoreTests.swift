// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Fetch, store, launch selection and quarantine (S7, S8, D9, D16, D17).

import XCTest
@testable import LiaisonShell

final class StoreTests: XCTestCase {
    let signer = Signer()
    var store: ShellStore!
    var root: URL!
    let http = FakeHTTP()

    override func setUp() {
        (store, root) = tempStore()
    }

    override func tearDown() {
        removeTemp(root, store)
    }

    func updater(bridge: Int = 1, floor: [RevocationEntry] = []) -> ShellUpdater {
        ShellUpdater(store: store, http: http, keys: [signer.pinned], floor: floor, bridgeVersion: bridge,
                     overlay: overlay, downloads: URL(string: downloads)!)
    }

    func select(bridge: Int = 1, now: Date = Date()) -> Selection {
        store.select(address: server, keys: [signer.pinned], floor: [], bridgeVersion: bridge, overlay: overlay, now: now)
    }

    var origin: String { ShellStore.origin(of: server)! }

    // MARK: Fetch and store

    func testStagesAVerifiedBuildAndServesItAtTheNextLaunch() async throws {
        let build = Build()
        serve(http, build, signer: signer)
        XCTAssertEqual(select(), .bundled(reason: .revocationsStale))
        let outcome = await updater().refresh(address: server + "/some/route")
        XCTAssertEqual(outcome, .staged(build.buildId))
        XCTAssertEqual(store.pointer(for: origin).current, build.buildId)
        guard case let .served(id, dir) = select() else { return XCTFail("bundled") }
        XCTAssertEqual(id, build.buildId)
        XCTAssertEqual(dir.lastPathComponent, build.buildId)
        XCTAssertEqual(dir.deletingLastPathComponent().lastPathComponent, store.snapshots.lastPathComponent)
        // The page is the phone's: boot script first, under the CSP, no inline script.
        let html = try String(contentsOf: dir.appendingPathComponent("index.html"), encoding: .utf8)
        XCTAssertTrue(html.contains("<script src=\"/liaison-mobile-boot.js\"></script>"))
        XCTAssertTrue(html.contains("script-src 'self'"))
        XCTAssertFalse(html.contains("window.a=1"))
        XCTAssertEqual(try Data(contentsOf: dir.appendingPathComponent(MobilePage.bootScriptName)), overlay[MobilePage.bootScriptName])
        XCTAssertEqual(try Data(contentsOf: dir.appendingPathComponent("assets/app.js")), build.files["assets/app.js"])
        // Read-only once written.
        let perms = try FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent("assets/app.js").path)[.posixPermissions] as? Int
        XCTAssertEqual(perms, 0o444)
        // Files came from the server under /native/, the statement from downloads.
        XCTAssertTrue(http.requested.contains("\(server)/native/assets/app.js"))
        XCTAssertTrue(http.requested.contains("\(downloads)/shell/native/\(build.buildId)/statement.json"))
        // Same build again: nothing re-fetched.
        let again = await updater().refresh(address: server)
        XCTAssertEqual(again, .unchanged(build.buildId))
    }

    func refused(_ outcome: UpdateOutcome, _ expected: Refusal, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(outcome, .refused(expected), file: file, line: line)
        XCTAssertNil(store.pointer(for: origin).current, "pointer unchanged", file: file, line: line)
    }

    func testTamperedFileIsRefused() async {
        let build = Build()
        serve(http, build, signer: signer)
        http.set("\(server)/native/assets/app.js", "console.log('evil')")
        refused(await updater().refresh(address: server), .fileHash)
    }

    func testWrongKeyIsRefused() async {
        serve(http, Build(), signer: Signer("other-key"))
        refused(await updater().refresh(address: server), .unknownKey)
    }

    func testMissingStatementIsRefused() async {
        let build = Build()
        serve(http, build, signer: signer)
        http.responses["\(downloads)/shell/native/\(build.buildId)/statement.json"] = .failure(.notFound)
        refused(await updater().refresh(address: server), .noStatement)
    }

    func testRevokedBuildIsRefused() async {
        let build = Build()
        serve(http, build, signer: signer)
        let (list, sig) = revocationList(signer, seq: 2, entries: [["name": "shell:native", "below": "1764320001"]])
        http.set("\(downloads)/apps/revocations.json", list)
        http.set("\(downloads)/apps/revocations.json.sig", sig)
        refused(await updater().refresh(address: server), .revoked)
    }

    func testBelowTheFloorIsRefused() async {
        serve(http, Build(), signer: signer)
        refused(await updater(floor: [RevocationEntry(name: "shell:native", below: "1764320001")]).refresh(address: server),
                .belowFloor)
    }

    func testBridgeRangeUnsatisfiedIsRefused() async {
        var build = Build()
        build.ios = "^2"
        serve(http, build, signer: signer)
        refused(await updater().refresh(address: server), .bridge)
    }

    func testRedirectedFileIsRefused() async {
        serve(http, Build(), signer: signer)
        http.responses["\(server)/native/assets/app.js"] = .failure(.redirect)
        refused(await updater().refresh(address: server), .fetch)
    }

    func testOversizeBuildIsRefused() async {
        var build = Build()
        build.files["assets/big.bin"] = Data(count: ShellUpdater.maxBuildBytes + 1)
        serve(http, build, signer: signer)
        refused(await updater().refresh(address: server), .tooLarge)
    }

    func testAStatementNamingTheBootScriptIsRefused() async {
        var build = Build()
        build.files[MobilePage.bootScriptName] = Data("evil()".utf8)
        serve(http, build, signer: signer)
        refused(await updater().refresh(address: server), .overlayConflict)
    }

    func testServerKillSwitch() async {
        let build = Build()
        serve(http, build, signer: signer)
        _ = await updater().refresh(address: server)
        if case .bundled = select() { XCTFail("expected served") }
        serve(http, build, signer: signer, servedShell: false)
        let outcome = await updater().refresh(address: server)
        XCTAssertEqual(outcome, .serverOff)
        XCTAssertEqual(select(), .bundled(reason: .serverOff))
        serve(http, build, signer: signer, servedShell: true)
        _ = await updater().refresh(address: server)
        XCTAssertEqual(select().buildId, build.buildId)
    }

    func testFleetKillSwitchAndItsSeqNeverGoesBack() async {
        let build = Build()
        serve(http, build, signer: signer)
        let (off, offSig) = flagsDoc(signer, seq: 5, native: false)
        http.set("\(downloads)/shell/flags.json", off)
        http.set("\(downloads)/shell/flags.json.sig", offSig)
        _ = await updater().refresh(address: server)
        XCTAssertEqual(select(), .bundled(reason: .fleetOff))
        // A replayed older "on" is ignored.
        let (on, onSig) = flagsDoc(signer, seq: 4, native: true)
        http.set("\(downloads)/shell/flags.json", on)
        http.set("\(downloads)/shell/flags.json.sig", onSig)
        _ = await updater().refresh(address: server)
        XCTAssertEqual(select(), .bundled(reason: .fleetOff))
        let (newer, newerSig) = flagsDoc(signer, seq: 6, native: true)
        http.set("\(downloads)/shell/flags.json", newer)
        http.set("\(downloads)/shell/flags.json.sig", newerSig)
        _ = await updater().refresh(address: server)
        XCTAssertEqual(select().buildId, build.buildId)
    }

    func testStaleRevocationListMeansBundled() async {
        serve(http, Build(), signer: signer)
        _ = await updater().refresh(address: server)
        XCTAssertNotNil(select(now: Date().addingTimeInterval(71 * 3600)).buildId)
        XCTAssertEqual(select(now: Date().addingTimeInterval(73 * 3600)), .bundled(reason: .revocationsStale))
    }

    func testAReplayedOlderRevocationListIsRefused() {
        let (newer, newerSig) = revocationList(signer, seq: 9, entries: [["name": "shell:native", "below": "5"]])
        XCTAssertTrue(store.offerRevocations(newer, sig: newerSig, keys: [signer.pinned], now: Date()))
        let (older, olderSig) = revocationList(signer, seq: 3)
        XCTAssertFalse(store.offerRevocations(older, sig: olderSig, keys: [signer.pinned], now: Date()))
        XCTAssertEqual(store.revocations(keys: [signer.pinned])?.list.seq, 9)
    }

    // MARK: Launch re-verify (D17)

    func testABridgeVersionBumpLaunchesBundled() async {
        serve(http, Build(), signer: signer)
        _ = await updater().refresh(address: server)
        XCTAssertNotNil(select(bridge: 1).buildId)
        // A new binary with NATIVE_BRIDGE_VERSION 2 and the stored build declaring ^1.
        XCTAssertEqual(select(bridge: 2), .bundled(reason: .bridge))
    }

    func testATamperedStoredFileLaunchesBundled() async throws {
        let build = Build()
        serve(http, build, signer: signer)
        _ = await updater().refresh(address: server)
        let file = store.buildDir(build.buildId).appendingPathComponent("assets/app.js")
        store.unlock(store.buildDir(build.buildId))
        try Data("console.log('evil')".utf8).write(to: file)
        XCTAssertEqual(select(), .bundled(reason: .fileHash))
    }

    func testAnExtraStoredFileLaunchesBundled() async throws {
        let build = Build()
        serve(http, build, signer: signer)
        _ = await updater().refresh(address: server)
        store.unlock(store.buildDir(build.buildId))
        try Data("evil()".utf8).write(to: store.buildDir(build.buildId).appendingPathComponent("assets/extra.js"))
        XCTAssertEqual(select(), .bundled(reason: .extraFile))
    }

    func testANewBootBundleIsRewrittenIntoTheStoredBuild() async throws {
        let build = Build()
        serve(http, build, signer: signer)
        _ = await updater().refresh(address: server)
        let newBoot: [String: Data] = [MobilePage.bootScriptName: Data("/* boot v2 */".utf8)]
        let selection = store.select(address: server, keys: [signer.pinned], floor: [], bridgeVersion: 1, overlay: newBoot)
        XCTAssertEqual(selection.buildId, build.buildId)
        let boot = try Data(contentsOf: store.buildDir(build.buildId).appendingPathComponent(MobilePage.bootScriptName))
        XCTAssertEqual(boot, newBoot[MobilePage.bootScriptName])
    }

    func testNoServerMeansBundled() {
        XCTAssertEqual(store.select(address: nil, keys: [signer.pinned], floor: [], bridgeVersion: 1, overlay: overlay),
                       .bundled(reason: .noServer))
    }

    // MARK: Ready, last good, quarantine (S8)

    func testABuildThatNeverSignalsReadyIsQuarantinedAfterTwoMisses() async {
        let build = Build()
        serve(http, build, signer: signer)
        _ = await updater().refresh(address: server)
        XCTAssertEqual(select().buildId, build.buildId)
        XCTAssertEqual(store.noteMissed(address: server, buildId: build.buildId), .retry)
        XCTAssertEqual(store.noteMissed(address: server, buildId: build.buildId), .quarantined)
        XCTAssertEqual(select(), .bundled(reason: .quarantined))
        // Not retried while the server serves the same build id.
        let outcome = await updater().refresh(address: server)
        XCTAssertEqual(outcome, .refused(.quarantined))
        XCTAssertEqual(select(), .bundled(reason: .quarantined))
    }

    func testALaunchKilledBeforeReadyCountsAsAMiss() async {
        let build = Build()
        serve(http, build, signer: signer)
        _ = await updater().refresh(address: server)
        XCTAssertEqual(select().buildId, build.buildId)
        XCTAssertEqual(select().buildId, build.buildId) // first unconfirmed launch counted
        XCTAssertEqual(select(), .bundled(reason: .quarantined)) // second
    }

    func testAQuarantinedBuildFallsBackToTheLastGood() async {
        let good = Build()
        serve(http, good, signer: signer)
        _ = await updater().refresh(address: server)
        XCTAssertEqual(select().buildId, good.buildId)
        XCTAssertTrue(store.noteReady(address: server, buildId: good.buildId))
        XCTAssertEqual(store.pointer(for: origin).lastGood, good.buildId)

        var bad = Build()
        bad.buildId = "1111111111111111"
        bad.files["build-id.txt"] = Data(bad.buildId.utf8)
        serve(http, bad, signer: signer)
        let outcome = await updater().refresh(address: server)
        XCTAssertEqual(outcome, .staged(bad.buildId))
        XCTAssertEqual(select().buildId, bad.buildId)
        XCTAssertEqual(store.noteMissed(address: server, buildId: bad.buildId), .retry)
        XCTAssertEqual(store.noteMissed(address: server, buildId: bad.buildId), .quarantined)
        XCTAssertEqual(select().buildId, good.buildId)
        // The last good build needs no new ready.
        XCTAssertEqual(select().buildId, good.buildId)
    }

    func testBuildsAreKeptPerServer() async {
        let build = Build()
        serve(http, build, signer: signer)
        _ = await updater().refresh(address: server)
        XCTAssertNil(store.select(address: "https://other.example.org", keys: [signer.pinned], floor: [], bridgeVersion: 1,
                                  overlay: overlay).buildId)
        XCTAssertEqual(select().buildId, build.buildId)
    }
}
