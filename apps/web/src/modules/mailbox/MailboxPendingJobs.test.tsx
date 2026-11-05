// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The badge is the user-visible half of the contract change from "runs at
// 07:00" to "runs when you are next online", so its copy is tested like code:
// the count is real, a lapsed job is named rather than hidden, and there is no
// dash punctuation anywhere in what it says.

import { render, screen } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import type { ClientJobDrainer, ClientJobView } from "~/modules/mailbox/client-job-drainer"
import { jobAgeLabel, jobKindLabel, MailboxPendingJobs } from "~/modules/mailbox/MailboxPendingJobs"

const NOW = Date.parse("2026-08-20T12:00:00.000Z")

function job(overrides: Partial<ClientJobView> = {}): ClientJobView {
  return {
    id: "job-1",
    kind: "summarise",
    status: "pending",
    accountId: "acc-1",
    payload: { messageIds: ["m1"] },
    attempts: 0,
    claimedBySession: null,
    claimedAt: null,
    leaseExpiresAt: null,
    expiresAt: "2026-08-27T09:00:00.000Z",
    completedAt: null,
    createdAt: "2026-08-20T11:00:00.000Z",
    hasResult: false,
    ...overrides,
  }
}

function drainerWith(jobs: ClientJobView[], wake = vi.fn()): ClientJobDrainer {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    wake: wake as never,
    drainOnce: vi.fn() as never,
    jobs: () => jobs,
    pendingCount: () => jobs.filter((entry) => entry.status === "pending").length,
    needsAttention: () =>
      jobs.filter((entry) => entry.status === "failed" || entry.status === "expired"),
  }
}

describe("mailbox pending jobs badge", () => {
  it("renders nothing when the queue is empty", () => {
    render(() => <MailboxPendingJobs drainer={drainerWith([])} unlocked now={() => NOW} />)
    expect(screen.queryByTestId("mailbox-pending-jobs")).toBeNull()
  })

  it("shows the waiting count, each job's kind and its age", () => {
    render(() => (
      <MailboxPendingJobs
        drainer={drainerWith([job(), job({ id: "job-2", kind: "triage_label" })])}
        unlocked
        now={() => NOW}
      />
    ))
    expect(screen.getByTestId("mailbox-pending-jobs.count").textContent).toBe("2 waiting")
    expect(screen.getByTestId("mailbox-pending-jobs.item.job-1").textContent).toContain("Summarise")
    expect(screen.getByTestId("mailbox-pending-jobs.item.job-1").textContent).toContain("1 h ago")
    expect(screen.getByTestId("mailbox-pending-jobs.item.job-2").textContent).toContain(
      "Triage labels",
    )
  })

  it("names a job that lapsed instead of hiding it", () => {
    render(() => (
      <MailboxPendingJobs
        drainer={drainerWith([job({ id: "gone", status: "expired" })])}
        unlocked
        now={() => NOW}
      />
    ))
    expect(screen.getByTestId("mailbox-pending-jobs.note.gone").textContent).toContain("Lapsed")
    expect(screen.getByTestId("mailbox-pending-jobs.attention").textContent).toContain(
      "1 did not run",
    )
  })

  it("offers a manual run only while the mailbox is unlocked", async () => {
    const wake = vi.fn(async () => ({
      locked: false,
      drained: 1,
      skipped: 0,
      failed: 0,
      leaseLost: 0,
      stoppedBecauseLocked: false,
    }))
    const drainer = drainerWith([job()], wake)

    const locked = render(() => (
      <MailboxPendingJobs drainer={drainer} unlocked={false} now={() => NOW} />
    ))
    expect(screen.queryByTestId("mailbox-pending-jobs.run")).toBeNull()
    locked.unmount()

    render(() => <MailboxPendingJobs drainer={drainer} unlocked now={() => NOW} />)
    screen.getByTestId("mailbox-pending-jobs.run").click()
    expect(wake).toHaveBeenCalledTimes(1)
  })

  it("uses no dash punctuation anywhere", () => {
    render(() => (
      <MailboxPendingJobs
        drainer={drainerWith([job(), job({ id: "gone", status: "failed" })])}
        unlocked
        now={() => NOW}
      />
    ))
    const text = screen.getByTestId("mailbox-pending-jobs").textContent ?? ""
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toMatch(/[–—]/)
    expect(text).not.toMatch(/\s--\s/)
  })

  it("labels ages in plain words", () => {
    expect(jobAgeLabel("2026-08-20T11:59:40.000Z", NOW)).toBe("just now")
    expect(jobAgeLabel("2026-08-20T11:45:00.000Z", NOW)).toBe("15 min ago")
    expect(jobAgeLabel("2026-08-19T12:00:00.000Z", NOW)).toBe("1 day ago")
    expect(jobKindLabel("migration_verify")).toBe("Check mailbox")
    expect(jobKindLabel("something_new")).toBe("something_new")
  })
})
