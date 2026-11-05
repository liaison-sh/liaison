// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The browser half of the client job queue (blueprint task 11.3, spec 5.3c).
//
// The drainer is the only thing in the product that turns "the server may not
// read this mail" back into "the work still happens". Its properties are all
// about restraint, so the tests are mostly about what it does NOT do:
//
//   * it does nothing at all while the mailbox is locked, poll or wake,
//   * it never runs an agent turn itself: it supplies plaintext to a
//     SERVER-SIDE turn and nothing else,
//   * it never posts plaintext back, only a blob it sealed,
//   * it does not post a result once its lease has gone, because another
//     device may already have redone the work.

import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildJobPrompt,
  type ClientJobView,
  createClientJobDrainer,
  DRAIN_POLL_INTERVAL_MS,
} from "~/modules/mailbox/client-job-drainer"

function job(overrides: Partial<ClientJobView> = {}): ClientJobView {
  return {
    id: "job-1",
    kind: "summarise",
    status: "pending",
    accountId: "acc-1",
    payload: {
      ruleId: "finance",
      messageIds: ["m1", "m2"],
      labels: ["INBOX"],
      fromEmail: "alice@example.test",
    },
    attempts: 0,
    claimedBySession: null,
    claimedAt: null,
    leaseExpiresAt: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
    completedAt: null,
    createdAt: "2026-08-20T09:00:00.000Z",
    hasResult: false,
    ...overrides,
  }
}

interface Harness {
  posts: Array<{ path: string; body: any }>
  gets: string[]
  deps: Parameters<typeof createClientJobDrainer>[0]
  turns: any[]
  setJobs: (jobs: ClientJobView[]) => void
  setUnlocked: (value: boolean) => void
  claimStatus: { code: number }
}

function harness(overrides: Partial<Parameters<typeof createClientJobDrainer>[0]> = {}): Harness {
  let jobs: ClientJobView[] = [job()]
  let unlocked = true
  const posts: Array<{ path: string; body: any }> = []
  const gets: string[] = []
  const turns: any[] = []
  const claimStatus = { code: 200 }
  const clock = 1_000_000

  const api = {
    get: async (path: string) => {
      gets.push(path)
      return jobs as never
    },
    post: async (path: string, body?: unknown) => {
      posts.push({ path, body })
      if (path.endsWith("/claim")) {
        if (claimStatus.code !== 200) throw new Error(`HTTP ${claimStatus.code}`)
        const target = jobs[0] as ClientJobView
        return {
          ...target,
          status: "claimed",
          claimedBySession: "session-1",
          leaseExpiresAt: new Date(clock + 5 * 60 * 1000).toISOString(),
        } as never
      }
      return {} as never
    },
    delete: async () => ({}) as never,
  }

  const deps = {
    api,
    sessionId: "session-1",
    isUnlocked: () => unlocked,
    openMessages: async (target: ClientJobView) =>
      ((target.payload.messageIds ?? []) as string[]).map((id) => ({
        id,
        subject: `subject of ${id}`,
        textBody: `the pangolin body of ${id}`,
        htmlBody: null,
        snippet: `snippet of ${id}`,
      })),
    runAgentTurn: async (request: any) => {
      turns.push(request)
      return { text: `summary for ${request.jobId}` }
    },
    sealResult: async (jobId: string, plaintext: string) =>
      btoa(`sealed(${jobId}):${plaintext.length}`),
    now: () => clock,
    ...overrides,
  }

  return {
    posts,
    gets,
    deps,
    turns,
    claimStatus,
    setJobs: (next) => {
      jobs = next
    },
    setUnlocked: (value) => {
      unlocked = value
    },
  }
}

describe("mailbox client job drainer", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it("drains a pending job: claim, decrypt, server-side turn, sealed result", async () => {
    const h = harness()
    const drainer = createClientJobDrainer(h.deps)
    const summary = await drainer.drainOnce()

    // Non-vacuity: the drain really did a job rather than finding nothing.
    expect(summary.drained).toBe(1)
    expect(summary.skipped).toBe(0)

    expect(h.posts[0]?.path).toBe("/mailbox/client-jobs/job-1/claim")
    expect(h.posts[0]?.body).toEqual({ sessionId: "session-1" })

    // The turn ran SERVER SIDE, with the plaintext supplied by this tab.
    expect(h.turns.length).toBe(1)
    expect(h.turns[0].jobId).toBe("job-1")
    expect(h.turns[0].turnNonce).toMatch(/[0-9a-f-]{16,}/)
    expect(h.turns[0].plaintext.map((entry: any) => entry.id)).toEqual(["m1", "m2"])
    expect(h.turns[0].plaintext[0].textBody).toBe("the pangolin body of m1")

    const completion = h.posts[1]
    expect(completion?.path).toBe("/mailbox/client-jobs/job-1")
    expect(completion?.body.status).toBe("done")
    expect(completion?.body.sessionId).toBe("session-1")
    expect(typeof completion?.body.resultCiphertext).toBe("string")
  })

  it("posts no plaintext back: the completion body carries the sealed blob and nothing else", async () => {
    const h = harness()
    await createClientJobDrainer(h.deps).drainOnce()
    const body = JSON.stringify(h.posts[1]?.body)
    expect(body).not.toContain("pangolin")
    expect(body).not.toContain("subject of m1")
    expect(body).not.toContain("summary for job-1")
    expect(Object.keys(h.posts[1]?.body ?? {}).sort()).toEqual([
      "resultCiphertext",
      "sessionId",
      "status",
    ])
  })

  it("the prompt is built from envelope fields only", () => {
    const prompt = buildJobPrompt(job())
    expect(prompt).toContain("summarise")
    expect(prompt).toContain("alice@example.test")
    expect(prompt).toContain("m1")
    expect(prompt.toLowerCase()).not.toContain("pangolin")
  })

  it("does nothing at all while the mailbox is locked", async () => {
    const h = harness()
    h.setUnlocked(false)
    const drainer = createClientJobDrainer(h.deps)
    const summary = await drainer.drainOnce()
    expect(summary.locked).toBe(true)
    expect(summary.drained).toBe(0)
    // Not even a listing: a locked tab has no business polling the queue.
    expect(h.gets.length).toBe(0)
    expect(h.posts.length).toBe(0)
  })

  it("a wake while locked is a no-op", async () => {
    const h = harness()
    h.setUnlocked(false)
    const drainer = createClientJobDrainer(h.deps)
    await drainer.wake()
    expect(h.gets.length).toBe(0)
  })

  it("with no turn runner it lists the queue and claims nothing", async () => {
    // Phase 9 has not landed. Claiming a job this build cannot run would burn an
    // attempt and, three times over, mark real work failed for no reason.
    const h = harness({ runAgentTurn: undefined })
    const drainer = createClientJobDrainer(h.deps)
    const summary = await drainer.drainOnce()
    expect(summary.noRunner).toBe(true)
    expect(summary.drained).toBe(0)
    expect(h.posts.length).toBe(0)
    // The badge still has something to show.
    expect(drainer.pendingCount()).toBe(1)
  })

  it("a job claimed by another device is skipped, and the drain continues", async () => {
    const h = harness()
    h.claimStatus.code = 409
    const drainer = createClientJobDrainer(h.deps)
    const summary = await drainer.drainOnce()
    expect(summary.drained).toBe(0)
    expect(summary.skipped).toBe(1)
    expect(h.turns.length).toBe(0)
    // No completion post: this tab never held the lease.
    expect(h.posts.filter((p) => !p.path.endsWith("/claim")).length).toBe(0)
  })

  it("never claims a job that is not pending", async () => {
    const h = harness()
    h.setJobs([
      job({ id: "expired-1", status: "expired" }),
      job({ id: "failed-1", status: "failed" }),
      job({ id: "claimed-1", status: "claimed" }),
    ])
    const drainer = createClientJobDrainer(h.deps)
    const summary = await drainer.drainOnce()
    expect(summary.drained).toBe(0)
    expect(h.posts.length).toBe(0)
    // Still surfaced, because a job that lapsed unseen is a silent failure.
    expect(drainer.jobs().map((entry) => entry.id)).toEqual(["expired-1", "failed-1", "claimed-1"])
    expect(drainer.pendingCount()).toBe(0)
    expect(drainer.needsAttention().map((entry) => entry.id)).toEqual(["expired-1", "failed-1"])
  })

  it("does not post a result once its lease has gone", async () => {
    let clock = 1_000_000
    const h = harness({
      now: () => clock,
      runAgentTurn: async (request: any) => {
        // The turn took longer than the lease, which is what happens when a
        // laptop sleeps mid-drain.
        clock += 6 * 60 * 1000
        return { text: `late summary for ${request.jobId}` }
      },
    })
    const drainer = createClientJobDrainer(h.deps)
    const summary = await drainer.drainOnce()
    expect(summary.leaseLost).toBe(1)
    expect(summary.drained).toBe(0)
    const completions = h.posts.filter((p) => !p.path.endsWith("/claim"))
    expect(completions.length).toBe(0)
  })

  it("a turn that throws marks the job failed, with no error text posted", async () => {
    const h = harness({
      runAgentTurn: async () => {
        throw new Error("the model refused: pangolin")
      },
    })
    const drainer = createClientJobDrainer(h.deps)
    const summary = await drainer.drainOnce()
    expect(summary.failed).toBe(1)
    const completion = h.posts[1]
    expect(completion?.body.status).toBe("failed")
    expect(completion?.body.resultCiphertext).toBeUndefined()
    expect(JSON.stringify(completion?.body)).not.toContain("pangolin")
  })

  it("stops mid-drain when the mailbox locks between jobs", async () => {
    const h = harness()
    h.setJobs([job({ id: "job-1" }), job({ id: "job-2" })])
    let seen = 0
    const drainer = createClientJobDrainer({
      ...h.deps,
      runAgentTurn: async (request: any) => {
        seen++
        h.setUnlocked(false)
        return { text: `summary for ${request.jobId}` }
      },
    })
    const summary = await drainer.drainOnce()
    expect(seen).toBe(1)
    expect(summary.drained).toBe(1)
    expect(summary.stoppedBecauseLocked).toBe(true)
  })

  it("two overlapping drains run once, not twice", async () => {
    const h = harness()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const drainer = createClientJobDrainer({
      ...h.deps,
      runAgentTurn: async (request: any) => {
        await gate
        return { text: `summary for ${request.jobId}` }
      },
    })
    const first = drainer.drainOnce()
    const second = drainer.drainOnce()
    release()
    const [a, b] = await Promise.all([first, second])
    // The second call joins the first rather than starting a second drain.
    expect(a).toBe(b)
    expect(a.drained).toBe(1)
    expect(h.posts.filter((p) => p.path.endsWith("/claim")).length).toBe(1)
  })

  it("start polls on the interval and stop ends it", async () => {
    vi.useFakeTimers()
    const h = harness()
    h.setJobs([])
    const drainer = createClientJobDrainer(h.deps)
    drainer.start()
    await vi.advanceTimersByTimeAsync(DRAIN_POLL_INTERVAL_MS * 2 + 10)
    const polled = h.gets.length
    expect(polled).toBeGreaterThanOrEqual(2)
    drainer.stop()
    await vi.advanceTimersByTimeAsync(DRAIN_POLL_INTERVAL_MS * 3)
    expect(h.gets.length).toBe(polled)
    vi.useRealTimers()
  })
})
