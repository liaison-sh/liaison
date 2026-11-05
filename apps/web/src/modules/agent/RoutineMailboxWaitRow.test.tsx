// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A routine run waiting for its owner's private mailbox, in their approvals
// list, in the list's own anatomy: Details opens the run's facts; Run now opens
// a turn scope in THIS browser and sends only its nonce, then the row leaves
// the list and a toast says it runs (or starts after the current run); a
// locked mailbox shows the unlock card right here (only when KNOWN locked) and
// the run starts once the mailbox opens; Dismiss declines it; a lapsed wait
// shows expired.
import type { AttentionItem } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"

type Status = "unknown" | "not-enrolled" | "locked" | "unlocked"
const mailbox = vi.hoisted(() => ({
  began: [] as string[],
  ended: [] as string[],
  // Set by the store mock: a real Solid signal, so the row sees the unlock.
  setUnlocked: (_v: boolean) => {},
  setStatus: (_v: Status) => {},
  /** What the startup restore settles an unknown state to. */
  restoreTo: "unlocked" as Status,
  restores: 0,
  handoffs: [] as Array<{ nonce: string; requestId: string; messageIds: string[] }>,
  unlockRequests: 0,
}))

vi.mock("~/modules/shell/entity-opener", () => ({
  openEntity: vi.fn(async () => {}),
  openAttentionLink: vi.fn(async () => {}),
  markAttentionRead: vi.fn(),
}))
vi.mock("~/modules/mailbox/mailbox-store", async () => {
  const { createSignal } = await import("solid-js")
  const [status, setStatus] = createSignal<Status>("unlocked")
  mailbox.setStatus = setStatus
  mailbox.setUnlocked = (v: boolean) => setStatus(v ? "unlocked" : "locked")
  return {
    isMailboxUnlocked: () => status() === "unlocked",
    mailboxStore: {
      get status() {
        return status()
      },
    },
    // The startup restore: an unknown state settles to what this device holds.
    loadMailboxKeyring: async () => {
      mailbox.restores += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      setStatus(mailbox.restoreTo)
      return {}
    },
  }
})
vi.mock("~/modules/mailbox/crypto-worker-boot", () => ({
  startMailboxCryptoWorker: async () => true,
}))
vi.mock("~/modules/mailbox/mailbox-unlock-bus", () => ({
  requestMailboxUnlock: () => {
    mailbox.unlockRequests += 1
  },
}))
vi.mock("~/modules/mailbox/mailbox-agent-runtime", () => ({
  beginMailboxAgentTurn: () => {
    const nonce = `nonce-${mailbox.began.length + 1}`
    mailbox.began.push(nonce)
    return nonce
  },
  endMailboxAgentTurn: (nonce: string) => {
    mailbox.ended.push(nonce)
  },
  answerMailboxHandoff: async (
    nonce: string,
    handoff: { requestId: string; messageIds: string[] },
  ) => {
    mailbox.handoffs.push({ nonce, requestId: handoff.requestId, messageIds: handoff.messageIds })
    return { accepted: true, released: handoff.messageIds.length }
  },
}))

import RoutineMailboxWaitRow, {
  type RoutineMailboxWait,
  routineMailboxWaitOf,
} from "~/modules/agent/RoutineMailboxWaitRow"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import { attentionStore } from "~/modules/shell/attention-store"
import { markAttentionRead } from "~/modules/shell/entity-opener"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"

function item(expiresAt: string): AttentionItem {
  return {
    id: "kernel:agent_notification:w-1",
    app: "kernel",
    entity: "agent_notification",
    entityId: "routine-mailbox-wait:run-1",
    kind: "routine_mailbox_wait",
    summary: 'Routine "Morning mail" is waiting for your private mailbox',
    urgency: 60,
    occurredAt: "2026-10-31T08:00:00Z",
    action: { type: "open_entity", tabType: "thread", entityId: "t-1" },
    metadata: {
      routineMailboxWait: {
        routineId: "r-1",
        routineName: "Morning mail",
        runId: "run-1",
        expiresAt,
        trigger: { app: "mail", entity: "message", action: "create" },
      },
    },
  } as AttentionItem
}

function renderRow(post: ReturnType<typeof vi.fn>, expiresAt: string) {
  const api = { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() } as never
  const it = item(expiresAt)
  return render(() => (
    <I18nProvider initialLocale="en">
      <ApiContext.Provider value={api}>
        <ul>
          <RoutineMailboxWaitRow item={it} wait={routineMailboxWaitOf(it) as RoutineMailboxWait} />
        </ul>
      </ApiContext.Provider>
    </I18nProvider>
  ))
}

const later = () => new Date(Date.now() + 5 * 3600 * 1000).toISOString()

afterEach(() => {
  resetToastStore()
  vi.clearAllMocks()
  mailbox.setUnlocked(true)
  mailbox.unlockRequests = 0
  mailbox.began = []
  mailbox.ended = []
  mailbox.restoreTo = "unlocked"
  mailbox.restores = 0
  mailbox.handoffs = []
})

describe("a routine run waiting for a private mailbox", () => {
  it("reads only rows that carry a waiting run", () => {
    expect(routineMailboxWaitOf(item(later()))?.runId).toBe("run-1")
    expect(routineMailboxWaitOf({ ...item(later()), metadata: {} } as AttentionItem)).toBeNull()
    // Only its own kind: an ordinary agent notification is not a waiting run.
    expect(
      routineMailboxWaitOf({ ...item(later()), kind: "agent_notification" } as AttentionItem),
    ).toBeNull()
  })

  it("reads as an approval row: pill, short title, why, deadline, Run now then Dismiss", () => {
    renderRow(vi.fn(), later())
    expect(screen.getByTestId("routine-mailbox-wait-row-pill").textContent).toBe("Private mailbox")
    expect(screen.getByTestId("routine-mailbox-wait-row-title").textContent).toContain(
      "Morning mail waits for you",
    )
    const lines = screen.getByTestId("routine-mailbox-wait-row-lines").textContent ?? ""
    expect(lines).toContain("Started by a new email")
    expect(lines).toContain("Routines can't read private mail while you're offline.")
    expect(screen.getByTestId("routine-mailbox-wait-row-meta").textContent).toContain(
      "Your routine",
    )
    expect(screen.getByTestId("routine-mailbox-wait-row-metric").textContent).toBe("5h left")
    expect(screen.getByTestId("routine-mailbox-wait-run")).toBeTruthy()
    expect(screen.getByTestId("routine-mailbox-wait-dismiss")).toBeTruthy()
    // Calm: no unlock card until Run now finds the mailbox locked.
    expect(screen.queryByTestId("routine-mailbox-wait-locked")).toBeNull()
  })

  it("Details expands the run's facts: routine, trigger, since when, expiry, queueing", () => {
    renderRow(vi.fn(), later())
    expect(screen.queryByTestId("routine-mailbox-wait-card")).toBeNull()
    fireEvent.click(screen.getByTestId("routine-mailbox-wait-row-details"))
    expect(screen.getByTestId("routine-mailbox-wait-card")).toBeTruthy()
    expect(screen.getByTestId("routine-mailbox-wait-fact-routine").textContent).toContain(
      "Morning mail",
    )
    expect(screen.getByTestId("routine-mailbox-wait-fact-trigger").textContent).toContain(
      "Started by a new email",
    )
    expect(screen.getByTestId("routine-mailbox-wait-fact-since").textContent).toContain(
      "Waiting since",
    )
    expect(screen.getByTestId("routine-mailbox-wait-fact-expires").textContent).toContain("5h left")
    expect(screen.getByTestId("routine-mailbox-wait-fact-state").textContent).toContain(
      "Waiting for you to run it",
    )
    expect(screen.getByTestId("routine-mailbox-wait-fact-busy").textContent).toContain(
      "right after the current run",
    )
    // The card carries the decisions; the row's own pair stands down.
    expect(screen.queryByTestId("routine-mailbox-wait-run")).toBeNull()
    expect(screen.getByTestId("routine-mailbox-wait-run-in-card")).toBeTruthy()
    fireEvent.click(screen.getByTestId("routine-mailbox-wait-row-details"))
    expect(screen.queryByTestId("routine-mailbox-wait-card")).toBeNull()
  })

  it("Run now sends this browser's turn nonce and nothing else", async () => {
    const post = vi.fn(async () => ({ data: { started: true } }))
    renderRow(post, later())
    fireEvent.click(screen.getByTestId("routine-mailbox-wait-run"))
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post).toHaveBeenCalledWith("/agent/routines/r-1/mailbox-waits/run-1/run", {
      turnNonce: "nonce-1",
    })
    await waitFor(() => expect(markAttentionRead).toHaveBeenCalled())
    // The turn scope stays open for the run: not closed at once.
    expect(mailbox.ended).toEqual([])
  })

  it("once it starts, the row leaves the list at once and a toast says it is running", async () => {
    const resolve = vi.spyOn(attentionStore, "resolveLocally")
    const post = vi.fn(async () => ({
      started: true,
      runId: "run-1",
      queued: false,
      handoff: null,
    }))
    renderRow(post, later())
    fireEvent.click(screen.getByTestId("routine-mailbox-wait-run"))
    await waitFor(() => expect(screen.queryByTestId("routine-mailbox-wait-row")).toBeNull())
    expect(resolve).toHaveBeenCalledWith("kernel:agent_notification:w-1")
    expect(toasts().map((t) => t.message)).toEqual([
      "Morning mail is running. Keep this window open while it reads your private mail.",
    ])
    resolve.mockRestore()
  })

  it("Run now while locked shows the unlock card here, then runs once it is unlocked", async () => {
    mailbox.setUnlocked(false)
    const post = vi.fn(async () => ({ data: { started: true } }))
    renderRow(post, later())
    fireEvent.click(screen.getByTestId("routine-mailbox-wait-run"))
    // The mailbox's own unlock card, in the row: nothing sent, no dead end.
    await waitFor(() => expect(screen.getByTestId("routine-mailbox-wait-locked")).toBeTruthy())
    expect(screen.getByTestId("mailbox-locked-notice")).toBeTruthy()
    expect(post).not.toHaveBeenCalled()
    expect(mailbox.began).toEqual([])
    expect(toasts()).toHaveLength(0)
    fireEvent.click(screen.getByTestId("routine-mailbox-wait-unlock"))
    expect(mailbox.unlockRequests).toBe(1)
    // The mailbox opens: the run starts by itself through the same browser path.
    mailbox.setUnlocked(true)
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/agent/routines/r-1/mailbox-waits/run-1/run", {
        turnNonce: "nonce-1",
      }),
    )
    expect(post).toHaveBeenCalledTimes(1)
    // It started: the row (and its card) left the list.
    await waitFor(() => expect(screen.queryByTestId("routine-mailbox-wait-row")).toBeNull())
    expect(screen.queryByTestId("routine-mailbox-wait-locked")).toBeNull()
  })

  it("an unknown lock state restored to unlocked shows no card, and the run starts", async () => {
    mailbox.setStatus("unknown")
    mailbox.restoreTo = "unlocked"
    const post = vi.fn(async () => ({ started: true, queued: false, handoff: null }))
    renderRow(post, later())
    fireEvent.click(screen.getByTestId("routine-mailbox-wait-run"))
    // Never the card while the state is unknown: the restore is waited out.
    expect(screen.queryByTestId("routine-mailbox-wait-locked")).toBeNull()
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/agent/routines/r-1/mailbox-waits/run-1/run", {
        turnNonce: "nonce-1",
      }),
    )
    expect(mailbox.restores).toBe(1)
    expect(screen.queryByTestId("routine-mailbox-wait-locked")).toBeNull()
    await waitFor(() => expect(screen.queryByTestId("routine-mailbox-wait-row")).toBeNull())
  })

  it("an unknown lock state restored to locked shows the card", async () => {
    mailbox.setStatus("unknown")
    mailbox.restoreTo = "locked"
    const post = vi.fn()
    renderRow(post, later())
    fireEvent.click(screen.getByTestId("routine-mailbox-wait-run"))
    await waitFor(() => expect(screen.getByTestId("routine-mailbox-wait-locked")).toBeTruthy())
    expect(post).not.toHaveBeenCalled()
    // The row's pair gives way to a status chip while the card is open.
    expect(screen.getByTestId("routine-mailbox-wait-row-status").textContent).toBe(
      "Waiting for unlock",
    )
    expect(screen.queryByTestId("routine-mailbox-wait-run")).toBeNull()
  })

  it("answers the run's handoff in the click: the window may close at once", async () => {
    const handoff = {
      requestId: "inst:req-1",
      messageIds: ["msg-1"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const post = vi.fn(async () => ({ started: true, runId: "run-1", queued: false, handoff }))
    renderRow(post, later())
    fireEvent.click(screen.getByTestId("routine-mailbox-wait-run"))
    await waitFor(() => expect(screen.queryByTestId("routine-mailbox-wait-row")).toBeNull())
    // The same nonce the run was started with, the ids the server named.
    expect(mailbox.handoffs).toEqual([
      { nonce: "nonce-1", requestId: "inst:req-1", messageIds: ["msg-1"] },
    ])
    expect(toasts().map((t) => t.message)).toEqual([
      "Morning mail is running. You can close this window: the email that started it was opened for this run.",
    ])
  })

  it("a second run of a busy routine is queued: the row leaves, the toast says it starts after", async () => {
    const post = vi.fn(async () => ({ started: true, runId: "run-1", queued: true, handoff: null }))
    renderRow(post, later())
    fireEvent.click(screen.getByTestId("routine-mailbox-wait-run"))
    await waitFor(() => expect(screen.queryByTestId("routine-mailbox-wait-row")).toBeNull())
    // No in-list queued row: only the toast, for a few seconds.
    expect(screen.queryByTestId("routine-mailbox-wait-queued")).toBeNull()
    expect(toasts().map((t) => t.message)).toEqual([
      "Morning mail starts right after its current run.",
    ])
  })

  it("a refusal shows the server's named reason", async () => {
    const post = vi.fn(async () => {
      throw new ApiError("This run is already running.", 409)
    })
    renderRow(post, later())
    fireEvent.click(screen.getByTestId("routine-mailbox-wait-run"))
    await waitFor(() =>
      expect(toasts().map((t) => t.message)).toContain("This run is already running."),
    )
    expect(mailbox.ended).toEqual(["nonce-1"])
  })

  it("Dismiss declines it and takes the row out of the list", async () => {
    const post = vi.fn(async () => ({ data: { dismissed: true } }))
    renderRow(post, later())
    fireEvent.click(screen.getByTestId("routine-mailbox-wait-dismiss"))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/agent/routines/r-1/mailbox-waits/run-1/dismiss", {}),
    )
    await waitFor(() => expect(markAttentionRead).toHaveBeenCalled())
    expect(screen.queryByTestId("routine-mailbox-wait-row")).toBeNull()
    expect(mailbox.began).toEqual([])
  })

  it("a lapsed wait shows expired, with no Run now", () => {
    renderRow(vi.fn(), new Date(Date.now() - 1000).toISOString())
    expect(screen.getByTestId("routine-mailbox-wait-row").getAttribute("data-expired")).toBe("true")
    expect(screen.getByTestId("routine-mailbox-wait-row-status").textContent).toBe("Expired")
    expect(screen.getByTestId("routine-mailbox-wait-row-lines").textContent).toContain(
      "it waited 24 hours",
    )
    expect(screen.queryByTestId("routine-mailbox-wait-run")).toBeNull()
  })

  it("the server saying expired closes the scope and shows expired", async () => {
    const post = vi.fn(async () => {
      throw new ApiError("expired", 410)
    })
    renderRow(post, later())
    fireEvent.click(screen.getByTestId("routine-mailbox-wait-run"))
    await waitFor(() =>
      expect(screen.getByTestId("routine-mailbox-wait-row").getAttribute("data-expired")).toBe(
        "true",
      ),
    )
    expect(mailbox.ended).toEqual(["nonce-1"])
  })
})
