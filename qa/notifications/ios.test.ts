// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The simulator session seed (lib/surfaces/ios.ts). Writing the app's
// Preferences plist from the host is silently overridden by the simulator's
// own cfprefsd cache (seen on demo: a reinstalled app still read a stale
// `http://localhost:18080` address), so the seed goes through `simctl spawn
// <sim> defaults write <bundle>`, which talks to that cfprefsd.
import { describe, expect, it } from "bun:test"
import {
  ALLOW_BUTTON,
  clearDefaultsCommand,
  grantNotificationsCommand,
  SIM_TAP_SCRIPT,
  seedSessionCommands,
} from "./lib/surfaces/ios"

describe("seedSessionCommands", () => {
  it("writes the session through the simulator's defaults, never the host plist", () => {
    const cmds = seedSessionCommands(
      "SIM-1",
      "sh.liaison.mobile",
      "rt.secret",
      "https://demo.example",
    )
    expect(cmds).toEqual([
      [
        "xcrun",
        "simctl",
        "spawn",
        "SIM-1",
        "defaults",
        "write",
        "sh.liaison.mobile",
        "CapacitorStorage.liaison.refreshToken",
        "rt.secret",
      ],
      [
        "xcrun",
        "simctl",
        "spawn",
        "SIM-1",
        "defaults",
        "write",
        "sh.liaison.mobile",
        "CapacitorStorage.liaison.serverAddress",
        "https://demo.example",
      ],
    ])
  })
})

describe("fresh install helpers", () => {
  it("empties the bundle's simulator defaults, which an uninstall keeps", () => {
    expect(clearDefaultsCommand("SIM-1", "sh.liaison.mobile")).toEqual([
      "xcrun",
      "simctl",
      "spawn",
      "SIM-1",
      "defaults",
      "delete",
      "sh.liaison.mobile",
    ])
  })

  it("taps Allow with the CoreGraphics helper that ships beside the controller", async () => {
    expect(grantNotificationsCommand()).toEqual([
      "swift",
      SIM_TAP_SCRIPT,
      String(ALLOW_BUTTON.x),
      String(ALLOW_BUTTON.y),
    ])
    expect(await Bun.file(SIM_TAP_SCRIPT).exists()).toBe(true)
  })
})
