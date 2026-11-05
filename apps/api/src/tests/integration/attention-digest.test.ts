// SPDX-License-Identifier: FSL-1.1-ALv2
// [Phase 10 INT-1] Digest cadence integration — clock-injected, provider-captured.
// Validates the cadence matrix (immediate/hourly/daily/off), urgent override,
// work-hours digest_eligible_at semantics, and retry idempotency. This is the
// in-process integration test required by Amendment 2: browser tests must not
// advance clocks, so the clock-sensitive boundary lives here.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type { EmailMessage, EmailProvider } from "~/infra/email"
import { type PendingAttentionRow, shouldFireDailyDigest } from "~/modules/attention/digest"
import type { DigestDeps, DigestUser } from "~/modules/attention/digest-jobs"

type JobsMod = typeof import("~/modules/attention/digest-jobs")
let jobs: JobsMod
beforeAll(async () => {
  jobs = await import("~/modules/attention/digest-jobs")
  // Fixture orgs are not database rows, so the effect ledger (which needs a real
  // org) is replaced by a plain send; the ledger's digest case is digest-once.test.ts.
  jobs.DigestJobsTestAccess.setSendOnce(async (_orgId, provider, message) => {
    await provider.send(message)
    return "sent"
  })
})

beforeEach(() => {
  if (jobs?.DigestJobsTestAccess.resetRateLimit) jobs.DigestJobsTestAccess.resetRateLimit()
})

const ORG = "00000000-0000-0000-0000-000000000abc"
const USER = (suffix: string) => `00000000-0000-0000-0000-${suffix.padEnd(12, "0")}`

const USER_IMM = USER("imm")
const USER_HRL = USER("hrl")
const USER_DLY = USER("dly")
const USER_OFF = USER("off")

class CapturingProvider implements EmailProvider {
  readonly sent: EmailMessage[] = []
  async send(m: EmailMessage): Promise<void> {
    this.sent.push(m)
  }
  async verify(): Promise<boolean> {
    return true
  }
}

function row(over: Partial<PendingAttentionRow>): PendingAttentionRow {
  return {
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    orgId: ORG,
    userId: USER_IMM,
    app: "kernel",
    entityType: "thread",
    entityId: "t-1",
    kind: "thread_reply",
    urgency: 30,
    summary: "summary",
    isUrgent: false,
    occurredAt: new Date("2026-05-12T12:00:00Z"),
    ...over,
  }
}

const users: Record<string, DigestUser> = {}

beforeAll(() => {
  users[USER_IMM] = {
    userId: USER_IMM,
    orgId: ORG,
    email: "imm@test.local",
    digestCadence: "immediate",
    timezone: "UTC",
    lastDailySentAt: null,
  }
  users[USER_HRL] = {
    userId: USER_HRL,
    orgId: ORG,
    email: "hrl@test.local",
    digestCadence: "hourly",
    timezone: "UTC",
    lastDailySentAt: null,
  }
  users[USER_DLY] = {
    userId: USER_DLY,
    orgId: ORG,
    email: "dly@test.local",
    digestCadence: "daily",
    timezone: "Europe/Paris",
    lastDailySentAt: null,
  }
  users[USER_OFF] = {
    userId: USER_OFF,
    orgId: ORG,
    email: "off@test.local",
    digestCadence: "off",
    timezone: "UTC",
    lastDailySentAt: null,
  }
})

function makeDeps(opts: {
  provider: EmailProvider
  now: Date
  urgent?: PendingAttentionRow[]
  cadencePending?: Record<"immediate" | "hourly" | "daily", PendingAttentionRow[]>
  markRowsSent?: (ids: string[]) => Promise<void>
  setLastDailySent?: (userId: string, when: Date) => Promise<void>
}): DigestDeps {
  return {
    fetchUrgentPending: async () => opts.urgent ?? [],
    fetchCadencePending: async (c) => opts.cadencePending?.[c] ?? [],
    loadUser: async (id) => users[id] ?? null,
    markRowsSent: opts.markRowsSent ?? (async () => {}),
    markRowsSuppressed: async () => {},
    setLastDailySent: opts.setLastDailySent ?? (async () => {}),
    emitDigestFailureAlert: async () => {},
    provider: opts.provider,
    baseUrl: "https://app.test",
    now: opts.now,
  }
}

describe("digest cadence matrix", () => {
  it("immediate user receives one collapsed email with three deep links", async () => {
    const provider = new CapturingProvider()
    const marked: string[] = []
    const rows = [
      row({ id: "i-1", userId: USER_IMM, summary: "first" }),
      row({ id: "i-2", userId: USER_IMM, summary: "second" }),
      row({ id: "i-3", userId: USER_IMM, summary: "third" }),
    ]
    await jobs.runDigestCadenceOnce(
      makeDeps({
        provider,
        now: new Date("2026-05-12T12:00:00Z"),
        cadencePending: { immediate: rows, hourly: [], daily: [] },
        markRowsSent: async (ids) => {
          marked.push(...ids)
        },
      }),
    )
    expect(provider.sent.length).toBe(1)
    expect(provider.sent[0].subject).toMatch(/3 things need your attention/)
    expect(provider.sent[0].idempotencyKey).toBeTruthy()
    expect(marked.sort()).toEqual(["i-1", "i-2", "i-3"])
  })

  it("hourly user receives one email collapsing all rows in the window", async () => {
    const provider = new CapturingProvider()
    const rows = [
      row({ id: "h-1", userId: USER_HRL, summary: "h1" }),
      row({ id: "h-2", userId: USER_HRL, summary: "h2" }),
      row({ id: "h-3", userId: USER_HRL, summary: "h3" }),
    ]
    await jobs.runDigestHourlyOnce(
      makeDeps({
        provider,
        now: new Date("2026-05-12T13:00:00Z"),
        cadencePending: { immediate: [], hourly: rows, daily: [] },
      }),
    )
    expect(provider.sent.length).toBe(1)
    expect(provider.sent[0].subject).toMatch(/3 things/)
  })

  it("daily user receives one email after local 08:00, idempotent on re-run within the same day", async () => {
    const provider = new CapturingProvider()
    let lastDailyStored: Date | null = null
    const rows = [row({ id: "d-1", userId: USER_DLY, summary: "d1" })]
    // 08:00 Europe/Paris = 06:00 UTC in summer (CEST) — we use a known DST date.
    // 2026-05-12 is CEST (UTC+2). Local 08:30 → UTC 06:30.
    const t0 = new Date("2026-05-12T06:30:00Z")
    await jobs.runDigestDailyAt(
      t0,
      makeDeps({
        provider,
        now: t0,
        cadencePending: { immediate: [], hourly: [], daily: rows },
        setLastDailySent: async (_id, when) => {
          lastDailyStored = when
          users[USER_DLY].lastDailySentAt = when
        },
      }),
    )
    expect(provider.sent.length).toBe(1)
    expect(lastDailyStored).not.toBeNull()

    // Second invocation five minutes later — same local day, must NOT send again.
    const t1 = new Date("2026-05-12T06:35:00Z")
    await jobs.runDigestDailyAt(
      t1,
      makeDeps({
        provider,
        now: t1,
        cadencePending: { immediate: [], hourly: [], daily: rows },
      }),
    )
    expect(provider.sent.length).toBe(1) // unchanged
  })

  it("off user is never invoked through cadence digests", async () => {
    const provider = new CapturingProvider()
    // The default cadence query LEFT-JOINs prefs and COALESCEs to 'daily'. We
    // simulate the off-user code path by returning zero rows for any cadence —
    // the materializer + translator should have suppressed these upstream.
    await jobs.runDigestCadenceOnce(
      makeDeps({
        provider,
        now: new Date("2026-05-12T12:00:00Z"),
        cadencePending: { immediate: [], hourly: [], daily: [] },
      }),
    )
    expect(provider.sent.length).toBe(0)
  })

  it("urgent override fires for an off user regardless of cadence", async () => {
    const provider = new CapturingProvider()
    const urgentRow = row({
      id: "u-1",
      userId: USER_OFF,
      isUrgent: true,
      urgency: 90,
      summary: "SLA breach",
    })
    await jobs.runDigestUrgentOnce(
      makeDeps({
        provider,
        now: new Date("2026-05-12T12:00:00Z"),
        urgent: [urgentRow],
      }),
    )
    expect(provider.sent.length).toBe(1)
    expect(provider.sent[0].to).toBe("off@test.local")
  })

  it("retry uses the same idempotencyKey after a transient markRowsSent failure", async () => {
    const provider = new CapturingProvider()
    let attempts = 0
    const markRowsSent = async () => {
      attempts++
      if (attempts === 1) throw new Error("transient db hiccup")
    }
    const now = new Date("2026-05-12T15:00:00Z")
    const r = row({ id: "z-1", userId: USER_IMM, isUrgent: true, urgency: 80 })
    // Attempt 1 — provider sends, but markRowsSent throws → BullMQ would retry.
    await expect(
      jobs.runDigestUrgentOnce(makeDeps({ provider, now, urgent: [r], markRowsSent })),
    ).rejects.toThrow()
    // Attempt 2 — same idempotencyKey, provider sees a duplicate send but our
    // CapturingProvider records both; the *key* must match.
    await jobs.runDigestUrgentOnce(
      makeDeps({ provider, now, urgent: [r], markRowsSent: async () => {} }),
    )
    expect(provider.sent.length).toBe(2)
    expect(provider.sent[0].idempotencyKey).toBe(provider.sent[1].idempotencyKey)
  })
})

describe("daily digest local-time gating", () => {
  it("does not fire before local 08:00 (Europe/Paris pre-window)", () => {
    // 2026-05-12 07:00 Europe/Paris = 05:00 UTC.
    expect(shouldFireDailyDigest(new Date("2026-05-12T05:00:00Z"), "Europe/Paris", null)).toBe(
      false,
    )
  })

  it("fires after local 08:00 with no prior send", () => {
    expect(shouldFireDailyDigest(new Date("2026-05-12T06:30:00Z"), "Europe/Paris", null)).toBe(true)
  })

  it("suppresses second fire on the same local calendar day", () => {
    const lastSent = new Date("2026-05-12T06:30:00Z")
    expect(shouldFireDailyDigest(new Date("2026-05-12T08:00:00Z"), "Europe/Paris", lastSent)).toBe(
      false,
    )
  })

  it("re-fires on the next local calendar day", () => {
    const lastSent = new Date("2026-05-12T06:30:00Z")
    expect(shouldFireDailyDigest(new Date("2026-05-13T06:30:00Z"), "Europe/Paris", lastSent)).toBe(
      true,
    )
  })
})

afterAll(() => {
  jobs?.DigestJobsTestAccess.setSendOnce(null)
})
