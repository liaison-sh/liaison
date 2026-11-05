// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T13: the two floating banners become the app's own toasts.

import { createRoot } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { englishT } from "~/modules/i18n/i18n-context"
import { activeThreadId, resetDockStore } from "~/modules/shell/dock-store"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"
import {
  installDesktopNotices,
  NOTICE_RECONNECT_DEVICE_CLIENT_NOT_ALLOWED,
  NOTICE_RECONNECT_GRANT_FAILED,
  NOTICE_RECONNECT_NOT_APPROVED,
  NOTICE_START_CONVERSATION_CLAIMED,
  NOTICE_START_FAILED,
  startRefusalCopyFor,
} from "./desktop-notices"
import { startLocalSession } from "./desktop-store"
import { installFakeBridge, liveSession, uninstallFakeBridge } from "./fake-bridge"
import { resetLocalPrompts } from "./LocalPermissionCard"

/** One microtask turn, which is all a Solid effect needs to run. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * Installs the notices in a root of their own and disposes it when the body
 * is DONE, not when the body returns: the body is async, and a root disposed
 * at the first await takes the effect with it.
 */
async function withNotices(run: () => Promise<void>): Promise<void> {
  let dispose = (): void => {}
  createRoot((d) => {
    dispose = d
    installDesktopNotices()
  })
  try {
    await settle()
    await run()
  } finally {
    dispose()
  }
}

describe("desktop-notices", () => {
  afterEach(() => {
    resetToastStore()
    uninstallFakeBridge()
  })

  it("a pending approval raises one info toast", async () => {
    const fake = installFakeBridge(liveSession("t1", "a1"))
    await withNotices(async () => {
      fake.push({ pendingApprovalRequestId: "req-9" })
      await settle()
      const raised = toasts()
      expect(raised).toHaveLength(1)
      expect(raised[0].type).toBe("info")
      expect(raised[0].message).toBe("Waiting for approval")

      // Still the same one waiting: one toast, not one per state push.
      fake.push({ pendingApprovalRequestId: "req-9" })
      await settle()
      expect(toasts()).toHaveLength(1)
    })
  })

  it("an unknown approval status raises a warning toast with different copy from pending", async () => {
    const fake = installFakeBridge(liveSession("t1", "a1"))
    await withNotices(async () => {
      fake.push({ pendingApprovalRequestId: "req-9", approvalStatus: "pending" })
      await settle()
      const pendingMessage = toasts()[0]?.message
      resetToastStore()

      fake.push({ pendingApprovalRequestId: "req-9", approvalStatus: "unknown" })
      await settle()
      const unknown = toasts()
      expect(unknown).toHaveLength(1)
      expect(unknown[0].type).toBe("warning")
      expect(unknown[0].message).not.toBe(pendingMessage)
    })
  })

  it("a reconnect reason raises a toast whose action calls the bridge", async () => {
    const fake = installFakeBridge(liveSession("t1", "a1"))
    await withNotices(async () => {
      fake.push({ reconnectReason: "TokenRefreshFailed" })
      await settle()
      const raised = toasts()
      expect(raised).toHaveLength(1)
      expect(raised[0].type).toBe("warning")
      expect(raised[0].message).toBe(
        "Your Liaison connection expired and could not be renewed. Reconnect to sign in again.",
      )
      expect(raised[0].action?.label).toBe("Reconnect")

      raised[0].action?.onClick()
      await settle()
      // No path crosses: the folder the lost session ran in is already on the
      // shell's state, and the shell chose it (P6d-FX2, SK-1).
      expect(fake.calls.started).toEqual([{ agentId: "a1", threadId: "t1", folderId: undefined }])
    })
  })

  it("a reason this build does not know still says something actionable", async () => {
    const fake = installFakeBridge(liveSession("t1", "a1"))
    await withNotices(async () => {
      fake.push({ reconnectReason: "SomethingNewerThanThisBuild" })
      await settle()
      expect(toasts()[0]?.message).toBe("Your Liaison connection needs to be renewed.")
    })
  })

  it("no toasts are raised in a browser", async () => {
    uninstallFakeBridge()
    await withNotices(async () => {
      await settle()
      expect(toasts()).toHaveLength(0)
    })
  })
})

// P6d-FX1 (SK-11): the toast keyed on the REASON and nothing cleared it, so a
// drop, a reconnect and the same drop again toasted only the first time. The
// second disjunct of the old guard was unreachable.
describe("desktop-notices reconnect lifecycle", () => {
  afterEach(() => {
    resetToastStore()
    uninstallFakeBridge()
  })

  it("the same reason after a reconnect raises the toast again", async () => {
    const fake = installFakeBridge(liveSession("t1", "a1"))
    await withNotices(async () => {
      fake.push({ reconnectReason: "TokenRefreshFailed" })
      await settle()
      expect(toasts()).toHaveLength(1)

      fake.push({ reconnectReason: null })
      await settle()
      // Reconnected: the toast carries an action, so nothing else takes it
      // down, and one telling a user to reconnect a live session is worse
      // than none.
      expect(toasts()).toHaveLength(0)

      fake.push({ reconnectReason: "TokenRefreshFailed" })
      await settle()
      expect(toasts()).toHaveLength(1)
    })
  })

  it("a second reason replaces the first rather than stacking", async () => {
    const fake = installFakeBridge(liveSession("t1", "a1"))
    await withNotices(async () => {
      fake.push({ reconnectReason: "TokenRefreshFailed" })
      await settle()
      fake.push({ reconnectReason: "ConversationLost" })
      await settle()
      const raised = toasts()
      expect(raised).toHaveLength(1)
      expect(raised[0].message).toContain("stopped holding the conversation")
    })
  })
})

// P6d-FX5 (W8). `startSession` answered false on a dozen paths and the page
// rendered NOTHING: no toast, no line in the control, no change a user could
// see. The charter's "a refusal is stated" was not kept for the one action
// this slice exists for.
describe("a refused start is stated", () => {
  afterEach(() => {
    resetToastStore()
    uninstallFakeBridge()
  })

  /** Every reason the shell names, and the sentence each one gets. */
  const REFUSALS = [
    "AlreadyStarting",
    "PathNotAllowed",
    "UnknownFolder",
    "NoFolderChosen",
    "NoConversation",
    "NotSignedIn",
    "AgentDefinitionRefused",
    "AuditRefused",
    "ConversationClaimed",
    "ClaimHeldHere",
    "ClaimRefused",
    "UnknownPermissionMode",
    "CwdNotADirectory",
    "BypassDeclined",
    "ModeDeclined",
    "TokenRefreshFailed",
    "ConfigUnwritable",
    "SidecarSpawnFailed",
    "NotApproved",
    "SidecarExited",
    "StartFailed",
  ]

  it("every refusal the shell can name has a sentence of its own", () => {
    const said = REFUSALS.map((reason) => startRefusalCopyFor(reason))
    for (const sentence of said) {
      expect(sentence.length).toBeGreaterThan(0)
      // A reason code is not a sentence: a user can act on one of the two.
      expect(REFUSALS).not.toContain(sentence)
    }
    // Twenty reasons, twenty sentences: a refusal collapsed into another
    // one's words is a user told the wrong thing to do about it.
    expect(new Set(said).size).toBe(REFUSALS.length)
    // The four the shell shares with a reconnect keep the reconnect's own
    // sentence: the same thing has happened, and a second wording for one
    // state would be a second thing to learn.
    expect(startRefusalCopyFor("NotApproved")).toBe(englishT(NOTICE_RECONNECT_NOT_APPROVED))
  })

  // 2026-09-23: a sidecar that died before its first line used to be a start
  // that "worked". Its refusal says what the sidecar itself said.
  it("a sidecar that died on start is named, with what it said", async () => {
    const fake = installFakeBridge()
    await withNotices(async () => {
      fake.push({
        startError: "SidecarExited",
        startErrorDetail: "unknown permission mode: auto",
      })
      await settle()
      const raised = toasts().at(-1)
      expect(raised?.type).toBe("warning")
      expect(raised?.message).toBe(
        "The assistant on this computer stopped before it started: unknown permission mode: auto. " +
          "Your message was not sent. If this keeps happening, update the app, and send support " +
          "the file sidecar.log from the app's log folder.",
      )
    })
  })

  it("a refusal this build has never heard of still says something", () => {
    expect(startRefusalCopyFor("SomethingFromAnotherBuild")).toBe(englishT(NOTICE_START_FAILED))
    expect(startRefusalCopyFor(null)).toBe(englishT(NOTICE_START_FAILED))
  })

  it("each refusal the shell reports raises its own toast", async () => {
    const fake = installFakeBridge()
    await withNotices(async () => {
      for (const reason of REFUSALS) {
        // The store keeps the three most recent, so the newest is the one to
        // read rather than the count.
        const before = toasts().at(-1)?.id
        fake.push({ startError: reason })
        await settle()
        const raised = toasts().at(-1)
        expect(raised?.id).not.toBe(before)
        expect(raised?.type).toBe("warning")
        expect(raised?.message).toBe(startRefusalCopyFor(reason))
      }
    })
  })

  it("the same refusal twice is said twice, once the shell has cleared it", async () => {
    const fake = installFakeBridge()
    await withNotices(async () => {
      fake.push({ startError: "ConversationClaimed" })
      await settle()
      expect(toasts()).toHaveLength(1)
      expect(toasts()[0].message).toBe(englishT(NOTICE_START_CONVERSATION_CLAIMED))
      // The same snapshot pushed again is the same refusal, not a second one.
      fake.push({ startError: "ConversationClaimed" })
      await settle()
      expect(toasts()).toHaveLength(1)
      // A start that worked clears it, and the next refusal is a new one.
      fake.push({ startError: null })
      await settle()
      fake.push({ startError: "ConversationClaimed" })
      await settle()
      expect(toasts()).toHaveLength(2)
    })
  })

  it("a window with no refusal on the state says nothing at all", async () => {
    const fake = installFakeBridge()
    await withNotices(async () => {
      fake.push({ folderPath: "/Users/someone/code/one" })
      await settle()
      expect(toasts()).toHaveLength(0)
    })
  })
})

describe("a local session whose device grant was refused (2026-09-23)", () => {
  afterEach(() => {
    resetToastStore()
    uninstallFakeBridge()
  })

  // THE REPORTED LOOP: the start never ran, so the state names no
  // conversation, and the toast's Reconnect read only the state: clicking it
  // did nothing at all.
  it("Reconnect restarts the conversation the refused start was for", async () => {
    const fake = installFakeBridge(
      { runtimeLocation: "local", folderPath: "/Users/me/Rapports Liaison" },
      { refuseStart: "GrantFailed", refuseStartAsReconnect: true },
    )
    await withNotices(async () => {
      await startLocalSession("t-dm", "a-data")
      await settle()
      const raised = toasts()
      expect(raised).toHaveLength(1)
      expect(raised[0].message).toBe(englishT(NOTICE_RECONNECT_GRANT_FAILED))
      expect(raised[0].action).toBeDefined()
      raised[0].action?.onClick()
      await vi.waitFor(() => expect(fake.calls.started).toHaveLength(2))
      expect(fake.calls.started[1]).toMatchObject({ threadId: "t-dm", agentId: "a-data" })
    })
  })

  it("a server that refuses the desktop is named, once, with no Reconnect that cannot work", async () => {
    const fake = installFakeBridge({ runtimeLocation: "local", folderPath: "/Users/me/x" })
    await withNotices(async () => {
      fake.push({ reconnectReason: "DeviceClientNotAllowed", startError: "DeviceClientNotAllowed" })
      await settle()
      const raised = toasts()
      expect(raised).toHaveLength(1)
      expect(raised[0].message).toBe(englishT(NOTICE_RECONNECT_DEVICE_CLIENT_NOT_ALLOWED))
      expect(raised[0].message).toContain("administrator")
      expect(raised[0].action).toBeUndefined()
    })
  })

  it("a second refusal of the same kind is said again", async () => {
    const fake = installFakeBridge({ runtimeLocation: "local", folderPath: "/Users/me/x" })
    await withNotices(async () => {
      fake.push({ reconnectReason: "GrantFailed", startError: "GrantFailed" })
      await settle()
      expect(toasts()).toHaveLength(1)
      // The next attempt: the shell clears the refusal while it starts, then
      // refuses again with the same reason.
      fake.push({ startError: null, sessionStatus: "starting" })
      await settle()
      fake.push({ startError: "GrantFailed", sessionStatus: "idle" })
      await settle()
      // Still ONE toast on screen (the old one is replaced), but a new one.
      const raised = toasts()
      expect(raised).toHaveLength(1)
      expect(raised[0].message).toBe(englishT(NOTICE_RECONNECT_GRANT_FAILED))
    })
  })
})

/** One animation frame, which is when the prompt toast decides. */
async function frame(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  await settle()
}

// A LOCAL TURN WAITING ON A QUESTION NOBODY CAN SEE (2026-09-23): a command sat
// on an Allow for ten minutes, its card below the fold of a conversation the
// reader was not looking at.
describe("desktop-notices, a local permission prompt", () => {
  const PROMPT = {
    requestId: "perm-1",
    toolName: "Bash",
    summary: "command: python3 report_pipeline.py",
    toolUseId: "toolu_1",
  }

  afterEach(() => {
    resetToastStore()
    resetLocalPrompts()
    resetDockStore()
    uninstallFakeBridge()
    document.body.innerHTML = ""
  })

  it("raises one warning toast whose action opens the conversation, and takes it down when answered", async () => {
    const fake = installFakeBridge(liveSession("t-local", "a1"))
    await withNotices(async () => {
      fake.push({ pendingPermissions: [PROMPT] })
      await frame()
      const raised = toasts()
      expect(raised).toHaveLength(1)
      expect(raised[0].type).toBe("warning")
      expect(raised[0].message).toBe(
        englishT("kernel.desktopUi.permissionCard.waiting", { tool: "Bash" }),
      )
      expect(raised[0].action?.label).toBe("Show")
      raised[0].action?.onClick()
      expect(activeThreadId()).toBe("t-local")

      // The same snapshot again raises nothing new.
      fake.push({ turnActive: true })
      await frame()
      expect(toasts()).toHaveLength(1)

      fake.push({ pendingPermissions: [] })
      await frame()
      expect(toasts()).toHaveLength(0)
    })
  })

  it("stays quiet when the card is already on the reader's screen", async () => {
    const card = document.createElement("div")
    // The window is focused: jsdom answers hasFocus() false otherwise.
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true)
    card.setAttribute("data-testid", "local-permission-card")
    card.dataset.requestId = PROMPT.requestId
    card.getBoundingClientRect = () =>
      ({ top: 100, bottom: 200, height: 100, left: 0, right: 10, width: 10 }) as DOMRect
    document.body.appendChild(card)
    const fake = installFakeBridge(liveSession("t-local", "a1"))
    await withNotices(async () => {
      fake.push({ pendingPermissions: [PROMPT] })
      await frame()
      expect(toasts()).toHaveLength(0)
    })
    focused.mockRestore()
  })
})
