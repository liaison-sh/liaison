// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The burst gate (burst.ts) against the real Redis of .env.test: the clock,
// the summary scheduler and the two live senders are the doubles.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import Redis from "ioredis"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { registerKernelJobs } from "~/infra/jobs/kernel-jobs"
import { env } from "~/lib/env"
import { REDIS_PREFIX } from "~/lib/redis"
import type { PushPayload } from "~/modules/push/types"
import {
  admitBurst,
  BURST_FLUSH_JOB,
  BURST_MAX_WAIT_MS,
  BURST_QUIET_MS,
  BURST_WINDOW_MS,
  type BurstFlushJob,
  type BurstItem,
  BurstTestAccess,
  burstCollapseId,
  burstKeys,
  burstSummaryText,
  runBurstFlush,
} from "./burst"
import type { DeliveryRecord } from "./delivery-log"
import type { DesktopNotifyPayload } from "./desktop-emitter"
import { burstSummaryDecision, type RouterDecision } from "./router"

const ORG = "00000000-0000-0000-0000-00000000b0a0"
const USER = "00000000-0000-0000-0000-00000000b0a1"
const r = new Redis(env.REDIS_URL, { keyPrefix: REDIS_PREFIX, maxRetriesPerRequest: null })

afterAll(async () => {
  await BurstTestAccess.reset(ORG, [USER], r)
  r.disconnect()
})

/** A decision whose push and desktop channels both deliver. */
function live(urgent = false): RouterDecision {
  const d = burstSummaryDecision({ orgId: ORG, userId: USER, push: true, desktop: true })
  return urgent ? { ...d, urgent: true } : d
}

let seq = 0
function item(overrides: Partial<BurstItem> = {}): BurstItem {
  seq += 1
  return {
    notifyId: `message:burst-${seq}`,
    actorKey: "agent:Ops Agent",
    actorName: "Ops Agent",
    conversation: `thread-${seq}`,
    conversationKind: "task",
    kind: "message",
    important: false,
    redacted: false,
    ...overrides,
  }
}

function harness(start = 1_000_000) {
  let now = start
  const armed: Array<{ job: BurstFlushJob; delayMs: number; armAt?: number }> = []
  const pushes: PushPayload[] = []
  const frames: DesktopNotifyPayload[] = []
  const logged: DeliveryRecord[] = []
  const deps = {
    redis: r,
    record: async (rows: DeliveryRecord[]) => {
      logged.push(...rows)
    },
    now: () => now,
    scheduleFlush: async (job: BurstFlushJob, delayMs: number, armAt?: number) => {
      armed.push({ job, delayMs, armAt })
    },
    locale: async () => "en" as const,
    push: async (_d: RouterDecision, _id: string, build: (badge: number) => PushPayload) => {
      pushes.push(build(7))
      return 1
    },
    desktop: async (_d: RouterDecision, payload: DesktopNotifyPayload) => {
      frames.push(payload)
    },
  }
  return {
    deps,
    armed,
    pushes,
    frames,
    logged,
    advance: (ms: number) => {
      now += ms
    },
  }
}

/** The gate let the item notify now (it was not held for the summary). */
const delivers = (held: boolean) => !held

describe("burst gate", () => {
  beforeEach(async () => {
    await BurstTestAccess.reset(ORG, [USER], r)
  })

  it("23 notes from one agent in 23 tasks: 3 notify, the rest become ONE summary", async () => {
    const h = harness()
    const verdicts: boolean[] = []
    for (let i = 0; i < 23; i++) {
      verdicts.push(delivers(await admitBurst(live(), item(), h.deps)))
      h.advance(2_000)
    }
    expect(verdicts.filter(Boolean)).toHaveLength(3)
    expect(verdicts.slice(0, 3)).toEqual([true, true, true])
    // The 4th item opened the burst and armed one summary.
    expect(h.armed).toHaveLength(1)
    expect(h.armed[0]?.delayMs).toBe(BURST_QUIET_MS)

    // Due: quiet for 10 s after the last item.
    h.advance(BURST_QUIET_MS)
    expect(await runBurstFlush({ orgId: ORG, userId: USER }, h.deps)).toBe("sent")
    expect(h.pushes).toHaveLength(1)
    expect(h.pushes[0]).toMatchObject({
      type: "attention",
      title: "Ops Agent",
      body: "23 new messages in 23 tasks",
      badgeCount: 7,
      collapseId: burstCollapseId(ORG),
      groupId: burstCollapseId(ORG),
      deepLink: "liaison://attention",
    })
    expect(h.frames).toHaveLength(1)
    expect(h.frames[0]).toMatchObject({
      title: "Ops Agent",
      body: "23 new messages in 23 tasks",
      tag: burstCollapseId(ORG),
    })
    // Nothing left: a second run sends nothing.
    expect(await runBurstFlush({ orgId: ORG, userId: USER }, h.deps)).toBe("none")
    expect(h.pushes).toHaveLength(1)
  })

  it("two messages a minute apart both notify", async () => {
    const h = harness()
    expect(delivers(await admitBurst(live(), item(), h.deps))).toBe(true)
    h.advance(BURST_WINDOW_MS + 1)
    expect(delivers(await admitBurst(live(), item(), h.deps))).toBe(true)
    expect(h.armed).toHaveLength(0)
  })

  it("a held item is logged as suppressed for the burst", async () => {
    const h = harness()
    for (let i = 0; i < 3; i++) await admitBurst(live(), item(), h.deps)
    expect(await admitBurst(live(), item(), h.deps)).toBe(true)
    // S1: the hold is in the delivery log, per live channel.
    expect(h.logged.map((x) => [x.channel, x.result, x.reason]).sort()).toEqual([
      ["desktop", "suppressed", "burst"],
      ["push", "suppressed", "burst"],
    ])
  })

  it("an item that was not going live is not counted", async () => {
    const h = harness()
    const quiet = burstSummaryDecision({ orgId: ORG, userId: USER, push: false, desktop: false })
    for (let i = 0; i < 10; i++) await admitBurst(quiet, item(), h.deps)
    expect(delivers(await admitBurst(live(), item(), h.deps))).toBe(true)
  })

  it("the summary waits while the burst is still going, then goes out at most 60 s after it opened", async () => {
    const h = harness()
    for (let i = 0; i < 4; i++) await admitBurst(live(), item(), h.deps)
    h.advance(5_000)
    await admitBurst(live(), item(), h.deps)
    h.advance(5_000)
    // 5 s since the last item: not quiet yet, re-armed for the rest.
    expect(await runBurstFlush({ orgId: ORG, userId: USER }, h.deps)).toBe("waiting")
    expect(h.armed.at(-1)?.delayMs).toBe(5_000)
    // A stream that never pauses still gets its summary at the cap.
    for (let t = 0; t < BURST_MAX_WAIT_MS; t += 3_000) {
      h.advance(3_000)
      await admitBurst(live(), item(), h.deps)
    }
    expect(await runBurstFlush({ orgId: ORG, userId: USER }, h.deps)).toBe("sent")
    expect(h.pushes).toHaveLength(1)
  })

  it("a stream that goes on after its summary is summarized again, not restarted with single banners", async () => {
    const h = harness()
    for (let i = 0; i < 5; i++) await admitBurst(live(), item(), h.deps)
    h.advance(BURST_QUIET_MS)
    await runBurstFlush({ orgId: ORG, userId: USER }, h.deps)
    h.advance(1_000)
    // One message after a summary is just that message (a burst of one would
    // arrive 10 s late as "1 new message", without its text)...
    expect(delivers(await admitBurst(live(), item(), h.deps))).toBe(true)
    // ...the second opens the next burst at once.
    expect(delivers(await admitBurst(live(), item(), h.deps))).toBe(false)
    expect(delivers(await admitBurst(live(), item(), h.deps))).toBe(false)
    h.advance(BURST_QUIET_MS)
    await runBurstFlush({ orgId: ORG, userId: USER }, h.deps)
    expect(h.pushes).toHaveLength(2)
    // Only the new items: the earlier ones were summarized already.
    expect(h.pushes[1]?.body).toBe("3 new messages in 3 tasks")
  })

  it("a burst of one is the item itself, never a text-less summary", async () => {
    const h = harness()
    for (let i = 0; i < 5; i++) await admitBurst(live(), item(), h.deps)
    h.advance(BURST_QUIET_MS)
    await runBurstFlush({ orgId: ORG, userId: USER }, h.deps)
    h.advance(1_000)
    expect(delivers(await admitBurst(live(), item(), h.deps))).toBe(true)
    h.advance(BURST_QUIET_MS)
    expect(await runBurstFlush({ orgId: ORG, userId: USER }, h.deps)).toBe("none")
    expect(h.pushes).toHaveLength(1)
  })

  it("a mention from someone else inside a burst notifies on its own; one from the burst's actor joins it", async () => {
    const h = harness()
    for (let i = 0; i < 4; i++) await admitBurst(live(), item(), h.deps)
    const colleague = await admitBurst(
      live(),
      item({ actorKey: "user:carol", actorName: "Carol", important: true }),
      h.deps,
    )
    expect(delivers(colleague)).toBe(true)
    const sameActor = await admitBurst(live(), item({ important: true }), h.deps)
    expect(delivers(sameActor)).toBe(false)
  })

  it("23 mentions from one agent are still one burst", async () => {
    const h = harness()
    let sent = 0
    for (let i = 0; i < 23; i++) {
      if (delivers(await admitBurst(live(), item({ important: true }), h.deps))) sent += 1
      h.advance(2_000)
    }
    expect(sent).toBe(3)
    h.advance(BURST_QUIET_MS)
    expect(await runBurstFlush({ orgId: ORG, userId: USER }, h.deps)).toBe("sent")
    expect(h.pushes[0]?.body).toBe("23 new messages in 23 tasks")
  })

  it("an urgent item (an approval the person decides) notifies on its own", async () => {
    const h = harness()
    for (let i = 0; i < 4; i++) await admitBurst(live(), item(), h.deps)
    const approval = await admitBurst(
      live(true),
      item({ actorKey: null, actorName: null, kind: "notification", important: true }),
      h.deps,
    )
    expect(delivers(approval)).toBe(true)
  })

  it("urgent items are never counted into a burst", async () => {
    const h = harness()
    for (let i = 0; i < 10; i++) {
      const urgent = await admitBurst(
        live(true),
        item({ actorKey: "agent:Ops Agent", kind: "notification", important: true }),
        h.deps,
      )
      expect(delivers(urgent)).toBe(true)
    }
    // Three ordinary items after ten approvals still notify one by one.
    for (let i = 0; i < 3; i++)
      expect(delivers(await admitBurst(live(), item(), h.deps))).toBe(true)
    expect(h.armed).toHaveLength(0)
  })

  it("a direct ask from someone else is not counted into the burst it interrupts", async () => {
    const h = harness()
    for (let i = 0; i < 2; i++) await admitBurst(live(), item(), h.deps)
    // A colleague's direct message: delivered, and the agent's stream is not
    // pushed over the threshold by it.
    expect(
      delivers(
        await admitBurst(
          live(),
          item({ actorKey: "user:carol", actorName: "Carol", important: true }),
          h.deps,
        ),
      ),
    ).toBe(true)
    expect(delivers(await admitBurst(live(), item(), h.deps))).toBe(true)
    expect(h.armed).toHaveLength(0)
  })

  it("arming the summary fails (queue backpressure): every item is delivered, nothing is held", async () => {
    const h = harness()
    const deps = {
      ...h.deps,
      scheduleFlush: async () => {
        throw new Error("queue backpressure")
      },
    }
    let delivered = 0
    for (let i = 0; i < 12; i++) {
      if (delivers(await admitBurst(live(), item(), deps))) delivered += 1
      h.advance(1_000)
    }
    expect(delivered).toBe(12)
    expect(h.logged).toHaveLength(0)
    expect(await r.exists(burstKeys(ORG, USER).held)).toBe(0)
  })

  it("a lost summary job is re-armed by the next item, and the summary still goes out", async () => {
    const h = harness()
    for (let i = 0; i < 5; i++) await admitBurst(live(), item(), h.deps)
    expect(h.armed).toHaveLength(1)
    // The job never runs (lost). Long after it was due, another item arrives.
    h.advance(BURST_QUIET_MS + 60_000)
    expect(delivers(await admitBurst(live(), item(), h.deps))).toBe(false)
    expect(h.armed).toHaveLength(2)
    // The re-armed job has its own id (the lost one may still hold the first).
    expect(h.armed[1]?.armAt).not.toBe(h.armed[0]?.armAt)
    h.advance(BURST_QUIET_MS)
    expect(await runBurstFlush(h.armed[1]?.job ?? { orgId: ORG, userId: USER }, h.deps)).toBe(
      "sent",
    )
    expect(h.pushes[0]?.body).toBe("6 new messages in 6 tasks")
  })

  it("the summary send throws: nothing is dropped, the retry sends it", async () => {
    const h = harness()
    for (let i = 0; i < 6; i++) await admitBurst(live(), item(), h.deps)
    h.advance(BURST_QUIET_MS)
    let fail = true
    const flaky = {
      ...h.deps,
      push: async (d: RouterDecision, id: string, build: (badge: number) => PushPayload) => {
        if (fail) throw new Error("provider down")
        return h.deps.push(d, id, build)
      },
    }
    await expect(runBurstFlush({ orgId: ORG, userId: USER }, flaky)).rejects.toThrow()
    fail = false
    // The job's retry (attempts with backoff) finds the burst intact.
    h.advance(2_000)
    expect(await runBurstFlush({ orgId: ORG, userId: USER }, flaky)).toBe("sent")
    expect(h.pushes.at(-1)?.body).toBe("6 new messages in 6 tasks")
    expect(h.frames).toHaveLength(1)
  })

  it("the desktop send or the locale lookup throwing does not lose the burst either", async () => {
    const h = harness()
    for (let i = 0; i < 5; i++) await admitBurst(live(), item(), h.deps)
    h.advance(BURST_QUIET_MS)
    const broken = {
      ...h.deps,
      locale: async (): Promise<"en"> => {
        throw new Error("db down")
      },
      desktop: async () => {
        throw new Error("socket gone")
      },
    }
    await expect(runBurstFlush({ orgId: ORG, userId: USER }, broken)).rejects.toThrow()
    expect(await runBurstFlush({ orgId: ORG, userId: USER }, h.deps)).toBe("sent")
    expect(h.frames).toHaveLength(1)
    expect(h.pushes.at(-1)?.body).toBe("5 new messages in 5 tasks")
  })

  it("re-arming a not-yet-due summary throws: the job fails (and is retried) instead of ending the chain", async () => {
    const h = harness()
    for (let i = 0; i < 5; i++) await admitBurst(live(), item(), h.deps)
    h.advance(2_000)
    const noQueue = {
      ...h.deps,
      scheduleFlush: async () => {
        throw new Error("queue backpressure")
      },
    }
    await expect(runBurstFlush({ orgId: ORG, userId: USER }, noQueue)).rejects.toThrow()
    h.advance(BURST_QUIET_MS)
    expect(await runBurstFlush({ orgId: ORG, userId: USER }, h.deps)).toBe("sent")
  })

  it("a queue minutes late still finds the burst and sends its summary", async () => {
    const h = harness()
    for (let i = 0; i < 5; i++) await admitBurst(live(), item(), h.deps)
    h.advance(5 * 60_000)
    expect(await runBurstFlush({ orgId: ORG, userId: USER }, h.deps)).toBe("sent")
    expect(h.pushes[0]?.body).toBe("5 new messages in 5 tasks")
  })

  it("all keys of one burst share one Redis Cluster hash slot", () => {
    const tags = Object.values(burstKeys(ORG, USER)).map((k) => k.match(/\{[^}]+\}/)?.[0])
    expect(tags.every((t) => t === `{${ORG}:${USER}}`)).toBe(true)
  })

  it("scripts run by EVALSHA, and load themselves on NOSCRIPT", async () => {
    const h = harness()
    const evalsha = spyOn(r, "evalsha")
    evalsha.mockImplementationOnce(() => Promise.reject(new Error("NOSCRIPT No matching script")))
    expect(delivers(await admitBurst(live(), item(), h.deps))).toBe(true)
    expect(delivers(await admitBurst(live(), item(), h.deps))).toBe(true)
    expect(evalsha).toHaveBeenCalledTimes(2)
    evalsha.mockRestore()
  })
})

// The summary through the REAL job path: the gate enqueues the kernel job
// (BullMQ, the kernel queue), the registered `notify-burst-flush` handler runs
// it and calls runBurstFlush. Only the clock and the two senders are doubles.
describe("burst summary, real job path", () => {
  const JOB_ORG = "00000000-0000-0000-0000-00000000b0b0"
  const JOB_USER = "00000000-0000-0000-0000-00000000b0b1"

  beforeAll(async () => {
    await withSystemDb("burst-job-org", (db) =>
      db
        .insert(organizations)
        .values({ id: JOB_ORG, name: "BurstJobOrg", slug: "burst-job-org" })
        .onConflictDoNothing(),
    )
    await registerKernelJobs()
  })

  afterAll(async () => {
    BurstTestAccess.setFlushDeps(null)
    await BurstTestAccess.reset(JOB_ORG, [JOB_USER], r)
    await sql`DELETE FROM kernel.organizations WHERE id = ${JOB_ORG}`
  })

  it("enqueue -> kernel job handler -> runBurstFlush sends the summary, re-arming while not due", async () => {
    await BurstTestAccess.reset(JOB_ORG, [JOB_USER], r)
    let now = Date.now()
    const pushes: PushPayload[] = []
    const deps = {
      redis: r,
      now: () => now,
      record: async () => {},
      locale: async () => "en" as const,
      push: async (_d: RouterDecision, _id: string, build: (badge: number) => PushPayload) => {
        pushes.push(build(1))
        return 1
      },
      desktop: async () => {},
    }
    BurstTestAccess.setFlushDeps(deps)
    const decision = burstSummaryDecision({
      orgId: JOB_ORG,
      userId: JOB_USER,
      push: true,
      desktop: true,
    })
    // No scheduleFlush double: the real enqueue.
    const gate = { redis: r, now: () => now, record: async () => {} }
    for (let i = 0; i < 5; i++) {
      await admitBurst(decision, item(), gate)
      now += 1_000
    }
    const runArmed = async () => {
      const id = await BurstTestAccess.armedJobId(JOB_ORG, JOB_USER, r)
      expect(id).toBeString()
      const job = await JobsTestAccess.findJob("kernel", BURST_FLUSH_JOB, id ?? "")
      expect(job).toBeDefined()
      // Retried with backoff: a lost or failed run is not the end of it.
      expect(job?.opts.attempts ?? 0).toBeGreaterThanOrEqual(3)
      expect(job?.opts.backoff).toBeDefined()
      await job?.remove()
      await JobsTestAccess.processJob("kernel", BURST_FLUSH_JOB, job?.data)
    }
    // Not quiet yet: the handler re-arms through the queue again.
    await runArmed()
    expect(pushes).toHaveLength(0)
    now += BURST_QUIET_MS
    await runArmed()
    expect(pushes).toHaveLength(1)
    expect(pushes[0]?.body).toBe("5 new messages in 5 tasks")
  })
})

describe("burst summary text", () => {
  const e = (
    a: string | null,
    c: string,
    extra: Partial<{ k: "message" | "notification"; ck: "task" | "conversation"; r: boolean }> = {},
  ) => ({
    a,
    an: a ? (a.split(":")[1] ?? null) : null,
    c,
    ck: extra.ck ?? ("conversation" as const),
    k: extra.k ?? ("message" as const),
    r: extra.r ?? false,
  })

  it("names the actor who dominates, else Liaison", () => {
    const mostlyAda = [
      e("agent:Ada", "t1"),
      e("agent:Ada", "t2"),
      e("agent:Ada", "t3"),
      e("user:Bo", "t4"),
    ]
    expect(burstSummaryText("en", 4, mostlyAda)).toMatchObject({
      title: "Ada",
      body: "4 new messages in 4 conversations",
    })
    const mixed = [e("agent:Ada", "t1"), e("user:Bo", "t2"), e("user:Cy", "t3"), e("user:Di", "t4")]
    expect(burstSummaryText("en", 4, mixed).title).toBe("Liaison")
  })

  it("names nobody when an item is redacted", () => {
    const entries = [e("agent:Ada", "t1"), e("agent:Ada", "t2", { r: true })]
    expect(burstSummaryText("en", 2, entries).title).toBe("Liaison")
  })

  it("one conversation, tasks, and non-message items each read their own way", () => {
    expect(burstSummaryText("en", 5, [e("agent:Ada", "t1")])).toMatchObject({
      body: "5 new messages",
      conversation: "t1",
    })
    expect(
      burstSummaryText("en", 6, [e(null, "t1", { k: "notification" }), e(null, "t2")]).body,
    ).toBe("6 new notifications")
  })

  it("is in the recipient's language", () => {
    const tasks = [e("agent:Ada", "t1", { ck: "task" }), e("agent:Ada", "t2", { ck: "task" })]
    expect(burstSummaryText("fr", 23, tasks).body).toBe("23 nouveaux messages dans 2 tâches")
    expect(burstSummaryText("fr", 4, [e(null, "a", { k: "notification" })]).body).toBe(
      "4 nouvelles notifications",
    )
  })
})
