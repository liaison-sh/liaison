// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The device wiring of the push client. Both hooks are optional in the
// client's own type (the tests of push-client.ts run without them), so only
// this file notices when the shell stops passing them.

import { describe, expect, it } from "bun:test"
import { type AppStateSource, capacitorPushDeps } from "./main"
import { apsEnvironment, onPushPresentation } from "./native/liaison-native"
import { setThreadOnScreen } from "./native/thread-on-screen"

describe("capacitorPushDeps", () => {
  it("asks liaison-native for the build's APNs environment", () => {
    expect(capacitorPushDeps().apsEnvironment).toBe(apsEnvironment)
  })

  it("subscribes onForeground to appStateChange and fires only on becoming active", () => {
    const subscribed: Array<{ event: string; listener: (s: { isActive: boolean }) => void }> = []
    const app: AppStateSource = {
      addListener: (event, listener) => {
        subscribed.push({ event, listener })
      },
    }
    const deps = capacitorPushDeps(app)
    expect(deps.onForeground).toBeDefined()

    let fired = 0
    deps.onForeground?.(() => {
      fired += 1
    })
    expect(subscribed.map((s) => s.event)).toEqual(["appStateChange"])

    subscribed[0]!.listener({ isActive: false })
    expect(fired).toBe(0)
    subscribed[0]!.listener({ isActive: true })
    expect(fired).toBe(1)
  })

  it("reads the conversation on screen from the page's bridge report", () => {
    // Without it every push that lands for the conversation the user is
    // reading raises a notice over that very conversation.
    const deps = capacitorPushDeps()
    try {
      setThreadOnScreen("thread-on-screen")
      expect(deps.threadOnScreen?.()).toBe("thread-on-screen")
      setThreadOnScreen(null)
      expect(deps.threadOnScreen?.()).toBeNull()
      setThreadOnScreen(42)
      expect(deps.threadOnScreen?.()).toBeNull()
    } finally {
      setThreadOnScreen(null)
    }
  })

  it("leaves the foreground presentation to the native presenter on iOS only", () => {
    // Where the LiaisonNative plugin is compiled in (iOS) the system banner
    // presents a foreground push; anywhere else the client keeps its notice.
    expect(capacitorPushDeps().onPresentation).toBeUndefined()
    expect(capacitorPushDeps(undefined, () => true).onPresentation).toBe(onPushPresentation)
  })

  it("wires the receipt client, the retry timer and the debug register toggle (S2, S3, M5)", () => {
    // Without `receipts` the app posts no final outcome and stores no
    // credential, so the NSE has nothing to sign its `received` with.
    const deps = capacitorPushDeps()
    expect(deps.receipts).toBeDefined()
    expect(deps.forceRegisterFailure).toBeDefined()
    expect(deps.schedule).toBeDefined()
  })
})
