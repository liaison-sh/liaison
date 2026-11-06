// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Several routine runs waiting for a private mailbox are one row: Run all starts
// every one of them from this window, oldest first, each with its own turn
// scope; a locked mailbox asks once and the batch starts when it opens; one that
// cannot start stays listed; one waiting run keeps its own row.
import type { AttentionItem } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"

type Status = "unknown" | "not-enrolled" | "locked" | "unlocked"
const mailbox = vi.hoisted(() => ({
  began: [] as string[],
  ended: [] as string[],
  handoffs: [] as string[],
  setStatus: (_v: Status) => {},
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
  return {
    isMailboxUnlocked: () => status() === "unlocked",
    mailboxStore: {
      get status() {
        return status()
      },
    },
    loadMailboxKeyring: async () => ({}),
  }
})
vi.mock("~/modules/mailbox/crypto-worker-boot", () => ({
  startMailboxCryptoWorker: async () => true,
}))
vi.mock("~/modules/mailbox/MailboxLockedPanel", () => ({
  MailboxLockedPanel: (props: { body?: string }) => <p data-testid="locked-panel">{props.body}</p>,
}))
vi.mock("~/modules/mailbox/mailbox-agent-runtime", () => ({
  beginMailboxAgentTurn: () => {
    const nonce = `nonce-${mailbox.began.length + 1}`
    mailbox.began.push(nonce)
    return nonce
  },
  endMailboxAgentTurn: (nonce: string | null) => {
    if (nonce) mailbox.ended.push(nonce)
  },
  answerMailboxHandoff: async (_nonce: string, handoff: { requestId: string }) => {
    mailbox.handoffs.push(handoff.requestId)
    return { accepted: true }
  },
}))

import RoutineMailboxWaitsRow, {
  resetMailboxWaitsBatchForTest,
} from "~/modules/agent/RoutineMailboxWaitsRow"
import {
  collapseMailboxWaits,
  type RoutineMailboxWait,
  routineMailboxWaitOf,
} from "~/modules/agent/routine-mailbox-wait-item"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import { attentionStore } from "~/modules/shell/attention-store"
import { homeApprovalItems } from "~/modules/shell/home-action-count"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"

function waitItem(n: number, routine = "qualify-prospects"): AttentionItem {
  return {
    id: `att-${n}`,
    app: "kernel",
    entity: "agent_notification",
    entityId: `routine-mailbox-wait:run-${n}`,
    kind: "routine_mailbox_wait",
    summary: "waiting",
    urgency: 60,
    occurredAt: new Date(Date.now() - (10 - n) * 3600 * 1000).toISOString(),
    action: { type: "open_entity", tabType: "thread", entityId: "t-1" },
    metadata: {
      routineMailboxWait: {
        routineId: `r-${routine}`,
        routineName: routine,
        runId: `run-${n}`,
        expiresAt: new Date(Date.now() + n * 3600 * 1000).toISOString(),
        trigger: { app: "mail", entity: "message", action: "create" },
      },
    },
  } as unknown as AttentionItem
}

function renderRow(post: ReturnType<typeof vi.fn>, items: AttentionItem[]) {
  attentionStore._setForTest({ items, errors: [] })
  const api = { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() } as never
  const first = items[0] as AttentionItem
  return render(() => (
    <I18nProvider initialLocale="en">
      <ApiContext.Provider value={api}>
        <ul>
          <RoutineMailboxWaitsRow
            item={first}
            wait={routineMailboxWaitOf(first) as RoutineMailboxWait}
          />
        </ul>
      </ApiContext.Provider>
    </I18nProvider>
  ))
}

const answered = (handoff: string | null = "req") =>
  vi.fn(async () => ({
    started: true,
    queued: false,
    handoff: handoff
      ? { requestId: handoff, messageIds: ["m"], expiresAt: new Date().toISOString() }
      : null,
  }))

beforeEach(() => {
  mailbox.setStatus("unlocked")
  mailbox.began = []
  mailbox.ended = []
  mailbox.handoffs = []
})

afterEach(() => {
  resetToastStore()
  resetMailboxWaitsBatchForTest()
  attentionStore._setForTest({ items: [], errors: [] })
  vi.clearAllMocks()
})

describe("several routine runs waiting for a private mailbox", () => {
  it("collapses to the oldest in a list, leaving every other item alone", () => {
    const other = { ...waitItem(9), id: "other", kind: "scope_request" } as AttentionItem
    const out = collapseMailboxWaits([waitItem(3), other, waitItem(1), waitItem(2)])
    expect(out.map((i) => i.id)).toEqual(["other", "att-1"])
  })

  it("counts as one row in Home's approvals list", () => {
    const items = homeApprovalItems([waitItem(1), waitItem(2), waitItem(3)], true)
    expect(items.map((i) => i.id)).toEqual(["att-1"])
  })

  it("shows one row naming the count, not one row per run", () => {
    renderRow(answered(), [waitItem(1), waitItem(2), waitItem(3)])
    expect(screen.getByTestId("routine-mailbox-waits-row-title").textContent).toContain(
      "qualify-prospects: 3 runs wait for you",
    )
    expect(screen.queryByTestId("routine-mailbox-wait-row")).toBeNull()
  })

  it("names each routine when several wait", () => {
    renderRow(answered(), [waitItem(1), waitItem(2), waitItem(3, "morning-brief")])
    expect(screen.getByTestId("routine-mailbox-waits-row-title").textContent).toContain(
      "3 routine runs wait for you",
    )
    expect(screen.getByTestId("routine-mailbox-waits-row-lines").textContent).toContain(
      "qualify-prospects (2), morning-brief (1)",
    )
  })

  it("Run all starts every run, oldest first, each in its own turn scope", async () => {
    const post = answered()
    renderRow(post, [waitItem(3), waitItem(1), waitItem(2)])
    fireEvent.click(screen.getByTestId("routine-mailbox-waits-run-all"))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3))
    expect(post.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual([
      "/agent/routines/r-qualify-prospects/mailbox-waits/run-1/run",
      "/agent/routines/r-qualify-prospects/mailbox-waits/run-2/run",
      "/agent/routines/r-qualify-prospects/mailbox-waits/run-3/run",
    ])
    expect(new Set(mailbox.began).size).toBe(3)
    await waitFor(() => expect(mailbox.handoffs).toHaveLength(3))
    await waitFor(() => expect(attentionStore.items).toHaveLength(0))
    await waitFor(() =>
      expect(
        toasts()
          .map((toast) => toast.message)
          .join(),
      ).toContain("3 routine runs started"),
    )
  })

  it("asks to unlock once, and the batch starts when the mailbox opens", async () => {
    mailbox.setStatus("locked")
    const post = answered()
    renderRow(post, [waitItem(1), waitItem(2)])
    fireEvent.click(screen.getByTestId("routine-mailbox-waits-run-all"))
    await screen.findByTestId("routine-mailbox-waits-locked")
    expect(post).not.toHaveBeenCalled()
    mailbox.setStatus("unlocked")
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  })

  it("keeps a run that could not start listed, and says how many did", async () => {
    let calls = 0
    const post = vi.fn(async () => {
      calls += 1
      if (calls === 2) throw new ApiError("Someone else changed this routine", 403, "refused")
      return { started: true, queued: false, handoff: null }
    })
    renderRow(post, [waitItem(1), waitItem(2), waitItem(3)])
    fireEvent.click(screen.getByTestId("routine-mailbox-waits-run-all"))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(attentionStore.items.map((i) => i.id)).toEqual(["att-2"]))
    await waitFor(() =>
      expect(
        toasts()
          .map((toast) => toast.message)
          .join(),
      ).toContain("2 of 3 runs started"),
    )
    // The opened turn of a refused run is closed again.
    expect(mailbox.ended).toContain("nonce-2")
  })

  it("treats a run already running or lapsed as gone, not as a failure", async () => {
    let calls = 0
    const post = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new ApiError("This run is already running.", 409, "claimed")
      return { started: true, queued: false, handoff: null }
    })
    renderRow(post, [waitItem(1), waitItem(2), waitItem(3)])
    fireEvent.click(screen.getByTestId("routine-mailbox-waits-run-all"))
    await waitFor(() => expect(attentionStore.items).toHaveLength(0))
    await waitFor(() =>
      expect(
        toasts()
          .map((toast) => toast.message)
          .join(),
      ).toContain("2 routine runs started"),
    )
  })

  it("Dismiss all asks first, then dismisses every run", async () => {
    const post = vi.fn(async () => ({ dismissed: true }))
    renderRow(post, [waitItem(1), waitItem(2)])
    fireEvent.click(screen.getByTestId("routine-mailbox-waits-dismiss-all"))
    expect(post).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByTestId("routine-mailbox-waits-dismiss-confirm-btn"))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect((post.mock.calls[0] as unknown as [string])[0]).toBe(
      "/agent/routines/r-qualify-prospects/mailbox-waits/run-1/dismiss",
    )
    await waitFor(() => expect(attentionStore.items).toHaveLength(0))
  })

  it("Details lists each run with its own Run now", async () => {
    renderRow(answered(), [waitItem(1), waitItem(2)])
    fireEvent.click(screen.getByTestId("routine-mailbox-waits-row-details"))
    const rows = await screen.findAllByTestId("routine-mailbox-wait-row")
    expect(rows).toHaveLength(2)
    expect(screen.getAllByTestId("routine-mailbox-wait-run")).toHaveLength(2)
  })

  it("one waiting run keeps its own row", () => {
    renderRow(answered(), [waitItem(1)])
    expect(screen.getByTestId("routine-mailbox-wait-row")).toBeTruthy()
    expect(screen.queryByTestId("routine-mailbox-waits-row")).toBeNull()
  })
})
