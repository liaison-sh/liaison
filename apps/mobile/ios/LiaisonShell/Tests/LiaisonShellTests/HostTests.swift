// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The running app's side (review P7): lists read before the launch chooses and
// again while the app runs, a security leave of the running build, staging only
// on a document load, ready bound to its build and server, the foreground-only
// ready clock, key rotation of the fleet flags, streamed and capped downloads,
// name collisions, the router's folder.

import XCTest
@testable import LiaisonShell

final class HostTests: XCTestCase {
    let signer = Signer()
    var store: ShellStore!
    var root: URL!
    let http = FakeHTTP()
    var defaults: UserDefaults!
    var suite: String!

    override func setUp() {
        (store, root) = tempStore()
        suite = "liaison-shell-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        defaults.set(server, forKey: ServedShellHost.serverAddressDefaultsKey)
        let bundled = root.appendingPathComponent("public", isDirectory: true)
        try? FileManager.default.createDirectory(at: bundled, withIntermediateDirectories: true)
        try? overlay[MobilePage.bootScriptName]!.write(to: bundled.appendingPathComponent(MobilePage.bootScriptName))
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        removeTemp(root, store)
    }

    func host(keys: [PinnedKey]? = nil, floor: [RevocationEntry] = []) -> ServedShellHost {
        ServedShellHost(store: store, http: http, bundledPublic: root.appendingPathComponent("public", isDirectory: true),
                        defaults: defaults, keys: keys ?? [signer.pinned], floor: floor, bridgeVersion: 1,
                        downloads: URL(string: downloads)!)
    }

    var origin: String { ShellStore.origin(of: server)! }

    func publish(flagsSeq seq: Int64, native: Bool, by key: Signer? = nil) {
        let (doc, sig) = flagsDoc(key ?? signer, seq: seq, native: native)
        http.set("\(downloads)/shell/flags.json", doc)
        http.set("\(downloads)/shell/flags.json.sig", sig)
    }

    func publish(list seq: Int64, entries: [[String: Any]]) {
        let (doc, sig) = revocationList(signer, seq: seq, entries: entries)
        http.set("\(downloads)/apps/revocations.json", doc)
        http.set("\(downloads)/apps/revocations.json.sig", sig)
    }

    /// A host running `build` as served (staged, then launched).
    func running(_ build: Build = Build()) async -> ServedShellHost {
        serve(http, build, signer: signer)
        let h = host()
        _ = await h.refresh()
        XCTAssertEqual(h.launch(deadline: 0).buildId, build.buildId)
        return h
    }

    // MARK: HIGH 1: revocations and kill switches reach a running page

    func testARaisedFloorMakesTheRunningBuildLeaveAtOnce() async {
        let build = Build()
        let h = await running(build)
        publish(list: 2, entries: [["name": "shell:native", "below": String(build.seq + 1)]])
        let decision = await h.refresh()
        XCTAssertEqual(decision, .leave(.bundled(reason: .revoked), reason: .revoked))
        XCTAssertNil(h.current.buildId, "the running selection is already the bundled one")
        XCTAssertNil(h.stagedSelection)
    }

    func testTheFleetSwitchMakesTheRunningBuildLeave() async {
        let h = await running()
        publish(flagsSeq: 3, native: false)
        let decision = await h.refresh()
        XCTAssertEqual(decision, .leave(.bundled(reason: .fleetOff), reason: .fleetOff))
    }

    func testTheServerSwitchMakesTheRunningBuildLeave() async {
        let build = Build()
        let h = await running(build)
        serve(http, build, signer: signer, servedShell: false)
        let decision = await h.refresh()
        XCTAssertEqual(decision, .leave(.bundled(reason: .serverOff), reason: .serverOff))
    }

    func testANewerBuildIsOnlyStaged() async {
        let h = await running()
        var newer = Build()
        newer.buildId = "2222222222222222"
        newer.files["build-id.txt"] = Data(newer.buildId.utf8)
        serve(http, newer, signer: signer)
        let decision = await h.refresh()
        guard case let .staged(next) = decision else { return XCTFail("\(String(describing: decision))") }
        XCTAssertEqual(next.buildId, newer.buildId)
        XCTAssertEqual(h.current.buildId, Build().buildId, "the running page keeps its build")
        XCTAssertEqual(h.promote()?.buildId, newer.buildId, "the next document load takes it")
        XCTAssertEqual(h.current.buildId, newer.buildId)
    }

    func testTheLaunchReadsTheListsBeforeChoosing() async {
        let h = await running()
        // Published after the app last ran: the cold launch must see it.
        publish(flagsSeq: 9, native: false)
        XCTAssertEqual(h.launch(), .bundled(reason: .fleetOff))
    }

    func testTheLaunchWaitsAtMostItsDeadline() async {
        let h = await running()
        http.delay = 5
        let started = Date()
        XCTAssertNotNil(h.launch(deadline: 0.3).buildId, "offline: the kept lists decide")
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
    }

    func testRefreshIsDueAfterItsInterval() async {
        let h = host()
        XCTAssertTrue(h.refreshDue(after: 60))
        _ = await h.refresh()
        XCTAssertFalse(h.refreshDue(after: 60))
        XCTAssertTrue(h.refreshDue(now: Date().addingTimeInterval(61), after: 60))
    }

    // MARK: MED 4: a reselect never moves the running page

    func testReselectOnlyStages() async {
        let h = await running()
        defaults.set("https://other.example.org", forKey: ServedShellHost.serverAddressDefaultsKey)
        XCTAssertTrue(h.reselect())
        XCTAssertEqual(h.current.buildId, Build().buildId, "still the running build until the reload")
        let staged = try! XCTUnwrap(h.stagedSelection)
        XCTAssertNil(staged.buildId, "the other server has no build here")
        XCTAssertEqual(h.promote(), staged)
        XCTAssertNil(h.current.buildId)
        XCTAssertNil(h.stagedSelection)
        XCTAssertFalse(h.reselect(), "nothing more to change")
    }

    // MARK: LOW 9: ready only for the running build, on its own server

    func testReadyNeedsTheRunningBuildsOwnId() async {
        let build = Build()
        let h = await running(build)
        h.ready(buildId: nil)
        XCTAssertNil(store.pointer(for: origin).lastGood)
        h.ready(buildId: "ffffffffffffffff")
        XCTAssertNil(store.pointer(for: origin).lastGood)
        XCTAssertNotNil(h.awaitingReady)
        // A server switch staged meanwhile does not move the confirmation.
        defaults.set("https://other.example.org", forKey: ServedShellHost.serverAddressDefaultsKey)
        h.ready(buildId: build.buildId)
        XCTAssertEqual(store.pointer(for: origin).lastGood, build.buildId)
    }

    func testAMissIsChargedToTheServerItWasArmedFor() async {
        let build = Build()
        let h = await running(build)
        let armed = try! XCTUnwrap(h.awaitingReady)
        defaults.set("https://other.example.org", forKey: ServedShellHost.serverAddressDefaultsKey)
        XCTAssertEqual(h.missed(buildId: armed.buildId, origin: armed.origin), .retry)
        XCTAssertEqual(store.pointer(for: origin).misses, 1)
    }

    // MARK: MED 3: the ready clock counts foreground time only

    func testTheReadyClockPausesInTheBackground() {
        let t0 = Date()
        var clock = ReadyClock(window: 45, now: t0, running: true)
        clock.pause(now: t0.addingTimeInterval(10))
        XCTAssertEqual(clock.elapsed(now: t0.addingTimeInterval(3600)), 10, "a day in the background counts nothing")
        clock.resume(now: t0.addingTimeInterval(3600))
        XCTAssertEqual(clock.remaining(now: t0.addingTimeInterval(3620)), 15)
        XCTAssertFalse(clock.expired(now: t0.addingTimeInterval(3634)))
        XCTAssertTrue(clock.expired(now: t0.addingTimeInterval(3635)))
        let notYet = ReadyClock(window: 45, now: t0, running: false)
        XCTAssertEqual(notYet.elapsed(now: t0.addingTimeInterval(100)), 0, "armed in the background: not started")
    }

    // MARK: Fleet flags across a key rotation (desktop parity)

    func testFlagsNoPinnedKeyVerifiesMeanOffAndTheirSeqStillHolds() {
        let old = Signer("old-key")
        let (on, onSig) = flagsDoc(old, seq: 5, native: true)
        XCTAssertEqual(store.offerFlags(on, sig: onSig, keys: [old.pinned])?.native, true)
        XCTAssertTrue(store.fleetEnabled(keys: [old.pinned]))
        // The rotation dropped the old key: the kept flags no longer verify.
        XCTAssertEqual(store.storedFlags(keys: [signer.pinned]), .unverifiable(seq: 5))
        XCTAssertFalse(store.fleetEnabled(keys: [signer.pinned]))
        XCTAssertEqual(store.choose(address: server, keys: [signer.pinned], floor: [], bridgeVersion: 1, overlay: overlay),
                       .bundled(reason: .fleetOff))
        // A lower seq from the new key is refused, a higher one accepted.
        let (low, lowSig) = flagsDoc(signer, seq: 4, native: true)
        XCTAssertNil(store.offerFlags(low, sig: lowSig, keys: [signer.pinned]))
        XCTAssertFalse(store.fleetEnabled(keys: [signer.pinned]))
        let (high, highSig) = flagsDoc(signer, seq: 6, native: true)
        XCTAssertEqual(store.offerFlags(high, sig: highSig, keys: [signer.pinned])?.seq, 6)
        XCTAssertTrue(store.fleetEnabled(keys: [signer.pinned]))
    }

    func testARevocationListBehindAnUnverifiableOneIsRefused() {
        let old = Signer("old-key")
        let (kept, keptSig) = revocationList(old, seq: 9)
        XCTAssertTrue(store.offerRevocations(kept, sig: keptSig, keys: [old.pinned], now: Date()))
        let (low, lowSig) = revocationList(signer, seq: 3)
        XCTAssertFalse(store.offerRevocations(low, sig: lowSig, keys: [signer.pinned], now: Date()))
        let (high, highSig) = revocationList(signer, seq: 10)
        XCTAssertTrue(store.offerRevocations(high, sig: highSig, keys: [signer.pinned], now: Date()))
    }

    // MARK: MED 2: bounded downloads

    func testTheWholeBuildSharesOneBudget() async {
        var build = Build()
        // Each under the per-file cap, together over the build cap.
        for i in 0..<3 { build.files["assets/part\(i).bin"] = Data(count: 11 * 1024 * 1024) }
        serve(http, build, signer: signer)
        let outcome = await ShellUpdater(store: store, http: http, keys: [signer.pinned], floor: [], bridgeVersion: 1,
                                         overlay: overlay, downloads: URL(string: downloads)!).refresh(address: server)
        XCTAssertEqual(outcome, .refused(.tooLarge))
        XCTAssertLessThanOrEqual(http.maxInFlight, ShellUpdater.concurrency)
    }

    func testABuildFetchPastItsDeadlineIsRefused() async {
        let build = Build()
        serve(http, build, signer: signer)
        let updater = ShellUpdater(store: store, http: http, keys: [signer.pinned], floor: [], bridgeVersion: 1,
                                   overlay: overlay, downloads: URL(string: downloads)!, deadline: 0.3)
        let statement = try! XCTUnwrap(ShellStatementParser.parse(build.signed(by: signer).bytes))
        http.delay = 5
        let started = Date()
        let result = await updater.fetchFiles(origin: origin, statement: statement)
        XCTAssertEqual(try? result.get(), nil)
        if case let .failure(refusal) = result { XCTAssertEqual(refusal, .fetch) }
        XCTAssertLessThan(Date().timeIntervalSince(started), 3, "cancelled at the deadline")
    }

    func testAStreamedBodyIsCutOffAtItsCap() async {
        let http = URLSessionShellHTTP(protocolClasses: [EndlessProtocol.self])
        EndlessProtocol.reset()
        let result = await http.get(URL(string: "https://work.example.org/native/huge.js")!, limit: 1024 * 1024)
        XCTAssertEqual(result, .failure(.tooLarge))
        XCTAssertLessThan(EndlessProtocol.sent, 8 * 1024 * 1024, "stopped soon after the cap, never buffered whole")
    }

    func testAnAnnouncedLengthOverTheCapIsRefusedBeforeTheBody() async {
        let http = URLSessionShellHTTP(protocolClasses: [EndlessProtocol.self])
        EndlessProtocol.reset(announce: 50 * 1024 * 1024)
        let result = await http.get(URL(string: "https://work.example.org/native/huge.js")!, limit: 1024 * 1024)
        XCTAssertEqual(result, .failure(.tooLarge))
        XCTAssertLessThanOrEqual(EndlessProtocol.sent, 1024)
    }

    func testTheStreamingClientReturnsASmallBodyAndRefusesRedirects() async {
        let http = URLSessionShellHTTP(protocolClasses: [EndlessProtocol.self])
        EndlessProtocol.reset(total: 3000)
        let result = await http.get(URL(string: "https://work.example.org/native/a.js")!, limit: 1024 * 1024)
        XCTAssertEqual(try? result.get().count, 3000)
        EndlessProtocol.reset(status: 302)
        let redirected = await http.get(URL(string: "https://work.example.org/native/a.js")!, limit: 1024)
        XCTAssertEqual(redirected, .failure(.redirect))
    }

    // MARK: LOW 10: a stored copy that verifies is reused, not rewritten

    func testAStoredCopyThatVerifiesIsPointedToWithoutRefetching() async {
        let build = Build()
        serve(http, build, signer: signer)
        let updater = ShellUpdater(store: store, http: http, keys: [signer.pinned], floor: [], bridgeVersion: 1,
                                   overlay: overlay, downloads: URL(string: downloads)!)
        _ = await updater.refresh(address: server)
        let other = "https://second.example.org"
        http.set("\(other)/api/shell/info", http.responses["\(server)/api/shell/info"].flatMap { try? $0.get() } ?? Data())
        let before = http.requestedCount
        let outcome = await updater.refresh(address: other)
        XCTAssertEqual(outcome, .staged(build.buildId))
        let fetched = http.requested[before...].filter { $0.contains("/native/") }
        XCTAssertEqual(fetched, [], "no file fetched again")
        XCTAssertEqual(store.pointer(for: other).current, build.buildId)
    }

    // MARK: LOW 7: names a case-insensitive volume would merge

    func testPathsThatCollideOnceFoldedAreRefused() async {
        for extra in ["ASSETS/app.js", "assets/APP.JS", "LIAISON-MOBILE-BOOT.JS", "cordova.js", "Cordova_Plugins.js",
                      "Liaison-Inline-000000000000.js"] {
            var build = Build()
            build.files[extra] = Data("x()".utf8)
            serve(http, build, signer: signer)
            let outcome = await ShellUpdater(store: store, http: http, keys: [signer.pinned], floor: [], bridgeVersion: 1,
                                             overlay: overlay, downloads: URL(string: downloads)!).refresh(address: server)
            XCTAssertEqual(outcome, .refused(.overlayConflict), extra)
        }
        // NFC and NFD twins (one key in a Swift dictionary): never two files read as one.
        var twins = Build()
        twins.files["assets/XA.js"] = Data("a()".utf8)
        twins.files["assets/XB.js"] = Data("b()".utf8)
        let text = String(data: twins.signed(by: signer).bytes, encoding: .utf8)!
            .replacingOccurrences(of: "assets/XA.js", with: "assets/caf\u{E9}.js")
            .replacingOccurrences(of: "assets/XB.js", with: "assets/cafe\u{301}.js")
        if let statement = ShellStatementParser.parse(Data(text.utf8)) {
            XCTAssertEqual(statement.files.count, 4, "both twins kept apart")
            if case .success = store.checkNames(statement, overlay: overlay) { XCTFail("NFC/NFD twins accepted") }
        }
    }

    // MARK: MED 5, LOW 8: the router's folder

    func testTheRouterStaysInItsFolderAndIgnoresOutsideMoves() {
        let base = ShellBasePath("/data/builds/abc")
        XCTAssertEqual(base.route(for: "/assets/app.js"), "/data/builds/abc/assets/app.js")
        XCTAssertEqual(base.route(for: "/settings/security"), "/data/builds/abc/index.html")
        XCTAssertFalse(base.route(for: "/../../../etc/passwd.txt").hasPrefix("/etc"))
        XCTAssertTrue(base.route(for: "/../other/x.js").hasPrefix("/data/builds/abc/"))
        XCTAssertFalse(base.offer("/tmp/evil"))
        XCTAssertEqual(base.current, "/data/builds/abc")
        XCTAssertTrue(base.offer("/data/builds/abc/"))
        base.move(to: "/data/builds/def")
        XCTAssertEqual(base.current, "/data/builds/def")
    }

    func testAFragmentChangeIsTheSameDocument() {
        let now = URL(string: "capacitor://localhost/threads/1")!
        XCTAssertTrue(ShellNavigation.sameDocument(now, URL(string: "capacitor://localhost/threads/1#m4")!))
        XCTAssertFalse(ShellNavigation.sameDocument(now, URL(string: "capacitor://localhost/threads/2#m4")!))
    }
}

/// A server that streams a body forever (or `total` bytes), optionally
/// announcing a length, or answers another status.
final class EndlessProtocol: URLProtocol {
    static let lock = NSLock()
    static var announce: Int64?
    static var total: Int?
    static var status = 200
    private static var sentBytes = 0
    static var sent: Int { lock.locked { sentBytes } }
    private var stopped = false

    static func reset(announce: Int64? = nil, total: Int? = nil, status: Int = 200) {
        lock.locked {
            self.announce = announce
            self.total = total
            self.status = status
            sentBytes = 0
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var headers: [String: String] = [:]
        if let length = EndlessProtocol.announce { headers["Content-Length"] = String(length) }
        if EndlessProtocol.status == 302 { headers["Location"] = "https://elsewhere.example/x" }
        let response = HTTPURLResponse(url: request.url!, statusCode: EndlessProtocol.status, httpVersion: "HTTP/1.1",
                                       headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if EndlessProtocol.status != 200 {
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        if EndlessProtocol.announce != nil {
            // A first piece (URLSession sniffs before it reports the response), then nothing.
            client?.urlProtocol(self, didLoad: Data(count: 1024))
            EndlessProtocol.lock.locked { EndlessProtocol.sentBytes = 1024 }
            return
        }
        let chunk = Data(count: 64 * 1024)
        DispatchQueue.global().async {
            var sent = 0
            while !self.stopped && sent < 64 * 1024 * 1024 {
                if let total = EndlessProtocol.total, sent >= total { break }
                let piece = EndlessProtocol.total.map { chunk.prefix(min(chunk.count, $0 - sent)) } ?? chunk
                self.client?.urlProtocol(self, didLoad: Data(piece))
                sent += piece.count
                EndlessProtocol.lock.locked { EndlessProtocol.sentBytes = sent }
                usleep(500)
            }
            if !self.stopped { self.client?.urlProtocolDidFinishLoading(self) }
        }
    }

    override func stopLoading() { stopped = true }
}
