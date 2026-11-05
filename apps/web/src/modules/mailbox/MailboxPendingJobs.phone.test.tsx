// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M2-2 T16. The mailbox module's own surfaces at phone width: the pending jobs
// list (its rows stack instead of running off the side, and Run now becomes a
// row a thumb can hit) and the unlock screen's controls.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ClientJobDrainer, ClientJobView } from "~/modules/mailbox/client-job-drainer"
import { MailboxPendingJobs } from "~/modules/mailbox/MailboxPendingJobs"
import { PHONE_QUERY, syncShellTier } from "~/modules/shell/shell-tier"

function setTier(tier: "phone" | "desktop"): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: tier === "phone" ? query === PHONE_QUERY : query === "(min-width: 1024px)",
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
  syncShellTier()
}

const wake = vi.fn(async () => {})

function drainer(jobs: ClientJobView[]): ClientJobDrainer {
  return {
    jobs: () => jobs,
    needsAttention: () => jobs.filter((j) => j.status === "expired" || j.status === "failed"),
    wake,
  } as unknown as ClientJobDrainer
}

const JOBS = [
  {
    id: "job-1",
    kind: "summarise",
    status: "pending",
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
  {
    id: "job-2",
    kind: "index_backfill",
    status: "expired",
    createdAt: new Date(Date.now() - 9 * 24 * 3_600_000).toISOString(),
  },
] as unknown as ClientJobView[]

beforeEach(() => {
  wake.mockClear()
  setTier("phone")
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setTier("desktop")
})

describe("MailboxPendingJobs at phone tier", () => {
  it("lists every job with its kind, its age and its lapse note", () => {
    render(() => <MailboxPendingJobs drainer={drainer(JOBS)} unlocked={true} />)
    const list = screen.getByTestId("mailbox-pending-jobs.list")
    expect(list.querySelectorAll("li")).toHaveLength(2)
    expect(screen.getByTestId("mailbox-pending-jobs.item.job-1").textContent).toContain("Summarise")
    expect(screen.getByTestId("mailbox-pending-jobs.item.job-1").textContent).toContain("5 min ago")
    expect(screen.getByTestId("mailbox-pending-jobs.note.job-2").textContent).toContain("Lapsed")
  })

  it("lifts Run now out of the sentence and still drains through the drainer", async () => {
    render(() => <MailboxPendingJobs drainer={drainer(JOBS)} unlocked={true} />)
    const run = screen.getByTestId("mailbox-pending-jobs.run")
    expect(run.dataset.phone).toBe("true")
    // Out of the header paragraph, so it is a row of its own rather than a
    // word between two sentences: its parent is the section itself.
    expect(run.parentElement?.dataset.testid).toBe("mailbox-pending-jobs")

    fireEvent.click(run)
    await waitFor(() => expect(wake).toHaveBeenCalledTimes(1))
  })

  it("keeps Run now inline at desktop tier", () => {
    setTier("desktop")
    render(() => <MailboxPendingJobs drainer={drainer(JOBS)} unlocked={true} />)
    const run = screen.getByTestId("mailbox-pending-jobs.run")
    expect(run.dataset.phone).toBe("false")
    expect(run.parentElement?.dataset.testid).toBeUndefined()
    expect(run.parentElement?.textContent).toContain("These run in this browser")
  })

  it("offers no run control while the mailbox is locked", () => {
    render(() => <MailboxPendingJobs drainer={drainer(JOBS)} unlocked={false} />)
    expect(screen.queryByTestId("mailbox-pending-jobs.run")).toBeNull()
  })
})
