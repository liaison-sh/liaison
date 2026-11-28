// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The DEBUG-only walk seam (WalkOverrides): a simulator walk points the host
// at a test key, a local downloads host and another bridge version through
// the launch environment. Compiled out of Release builds.

#if DEBUG
import XCTest
@testable import LiaisonShell

final class WalkOverridesTests: XCTestCase {
    func testNoVariablesMeansNoOverride() {
        XCTAssertNil(WalkOverrides(environment: ["PATH": "/usr/bin"]))
    }

    func testParsesKeysDownloadsAndBridge() throws {
        let signer = Signer()
        let b64 = signer.pinned.publicKey.rawRepresentation.base64EncodedString()
        let walk = try XCTUnwrap(WalkOverrides(environment: [
            "LIAISON_DEBUG_SHELL_KEYS": "walk-key=\(b64)",
            "LIAISON_DEBUG_SHELL_DOWNLOADS": "http://127.0.0.1:8787",
            "LIAISON_DEBUG_SHELL_BRIDGE": "2",
        ]))
        XCTAssertEqual(walk.keys?.map(\.keyId), ["walk-key"])
        XCTAssertEqual(walk.keys?.first?.publicKey.rawRepresentation, signer.pinned.publicKey.rawRepresentation)
        XCTAssertEqual(walk.downloads?.absoluteString, "http://127.0.0.1:8787")
        XCTAssertEqual(walk.bridgeVersion, 2)
    }

    func testOnlyOneVariableLeavesTheOthersDefault() throws {
        let walk = try XCTUnwrap(WalkOverrides(environment: ["LIAISON_DEBUG_SHELL_BRIDGE": "3"]))
        XCTAssertNil(walk.keys)
        XCTAssertNil(walk.downloads)
        XCTAssertEqual(walk.bridgeVersion, 3)
    }

    func testMalformedValuesChangeNothing() {
        XCTAssertNil(WalkOverrides(environment: ["LIAISON_DEBUG_SHELL_KEYS": "no-equals-sign"]))
        XCTAssertNil(WalkOverrides(environment: ["LIAISON_DEBUG_SHELL_KEYS": "k=not-a-key"]))
        XCTAssertNil(WalkOverrides(environment: ["LIAISON_DEBUG_SHELL_DOWNLOADS": "file:///etc"]))
        XCTAssertNil(WalkOverrides(environment: ["LIAISON_DEBUG_SHELL_BRIDGE": "0"]))
    }
}
#endif
