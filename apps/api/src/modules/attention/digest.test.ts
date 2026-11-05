// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { AGENT_NOTICE_STORED_LINES } from "@liaison/shared"
import type { EmailMessage, EmailProvider } from "~/infra/email"
import { EmailRateLimitError } from "~/infra/email"
import {
  buildIdempotencyKey,
  groupByUser,
  hashFNV1a,
  type PendingAttentionRow,
  renderDigestEmail,
  shouldFireDailyDigest,
  windowLabel,
} from "./digest"

type JobsMod = typeof import("./digest-jobs")
let jobs: JobsMod
beforeAll(async () => {
  jobs = await import("./digest-jobs")
  // The fixtures' org and rows are not database rows, so the effect ledger
  // (which needs a real org) is replaced by a plain send here. The ledger's
  // own digest case is in digest-once.test.ts.
  jobs.DigestJobsTestAccess.setSendOnce(async (_orgId, provider, message) => {
    await provider.send(message)
    return "sent"
  })
})

afterAll(() => {
  jobs?.DigestJobsTestAccess.setSendOnce(null)
})

beforeEach(() => {
  // The rate-limit pause is process-global by design; tests share the module
  // so we reset between cases to keep them independent.
  if (jobs?.DigestJobsTestAccess.resetRateLimit) jobs.DigestJobsTestAccess.resetRateLimit()
})

const ORG = "00000000-0000-0000-0000-000000000111"
const USER_A = "00000000-0000-0000-0000-000000000aaa"
const USER_B = "00000000-0000-0000-0000-000000000bbb"

function row(over: Partial<PendingAttentionRow>): PendingAttentionRow {
  return {
    id: "r-1",
    orgId: ORG,
    userId: USER_A,
    app: "kernel",
    entityType: "thread",
    entityId: "t1",
    kind: "thread_reply",
    urgency: 30,
    summary: "summary",
    isUrgent: false,
    occurredAt: new Date("2026-05-12T12:00:00Z"),
    ...over,
  }
}

describe("hashFNV1a", () => {
  it("is deterministic", () => {
    expect(hashFNV1a("a,b")).toBe(hashFNV1a("a,b"))
    expect(hashFNV1a("a,b")).not.toBe(hashFNV1a("a,c"))
  })
})

describe("buildIdempotencyKey", () => {
  it("is order-independent", () => {
    const k1 = buildIdempotencyKey("urgent", USER_A, "2026-05-12T12:00", ["b", "a"])
    const k2 = buildIdempotencyKey("urgent", USER_A, "2026-05-12T12:00", ["a", "b"])
    expect(k1).toBe(k2)
  })

  it("differs across cadences", () => {
    const k1 = buildIdempotencyKey("urgent", USER_A, "w", ["a"])
    const k2 = buildIdempotencyKey("daily", USER_A, "w", ["a"])
    expect(k1).not.toBe(k2)
  })
})

describe("groupByUser", () => {
  it("collects rows per user", () => {
    const map = groupByUser([
      row({ id: "a", userId: USER_A }),
      row({ id: "b", userId: USER_B }),
      row({ id: "c", userId: USER_A }),
    ])
    expect(map.get(USER_A)?.length).toBe(2)
    expect(map.get(USER_B)?.length).toBe(1)
  })
})

describe("renderDigestEmail", () => {
  it("formats subject + html with item count", () => {
    const out = renderDigestEmail({
      rows: [row({ summary: "first" }), row({ id: "r-2", summary: "second" })],
      baseUrl: "https://app.test",
      now: new Date("2026-05-12T12:30:00Z"),
      toAddress: "u@example.com",
    })
    expect(out.to).toBe("u@example.com")
    expect(out.subject).toMatch(/2 things need your attention/)
    expect(out.html).toContain("first")
    expect(out.html).toContain("second")
  })

  it("escapes HTML in summaries", () => {
    const out = renderDigestEmail({
      rows: [row({ summary: "<script>alert(1)</script>" })],
      baseUrl: "https://app.test",
      now: new Date(),
      toAddress: "u@example.com",
    })
    expect(out.html).not.toContain("<script>")
    expect(out.html).toContain("&lt;script&gt;")
  })

  it("renders kernel copy in the recipient's language (I6)", () => {
    const args = {
      rows: [row({ summary: "bonjour" })],
      baseUrl: "https://app.test",
      now: new Date("2026-05-12T12:30:00Z"),
      toAddress: "u@example.com",
    }
    // fr recipient → French fixed copy.
    const fr = renderDigestEmail({ ...args, locale: "fr" })
    expect(fr.subject).toContain("votre attention")
    expect(fr.html).toContain("Ouvrir Liaison")
    expect(fr.html).not.toMatch(/things? need your attention/)

    // en recipient → English (unchanged).
    const en = renderDigestEmail({ ...args, locale: "en" })
    expect(en.subject).toMatch(/thing needs your attention/)
    expect(en.html).toContain("Open Liaison")

    // unset / unshipped → English (clamped).
    const unset = renderDigestEmail(args)
    expect(unset.subject).toMatch(/thing needs your attention/)
  })
})

describe("renderDigestEmail: computer session rows", () => {
  const rows = [
    row({ id: "s1", entityType: "node_session", kind: "node_session_needs_you" }),
    row({ id: "s2", entityType: "node_session", kind: "node_session_done" }),
    row({ id: "s3", entityType: "node_session", kind: "node_session_failed" }),
  ]
  const args = { rows, baseUrl: "https://app.test", now: new Date(), toAddress: "u@example.com" }

  it("S11: labels each session kind, never the kind id", () => {
    const en = renderDigestEmail({ ...args, locale: "en" })
    expect(en.text).toContain("[session needs you ·")
    expect(en.text).toContain("[session done ·")
    expect(en.text).toContain("[session failed ·")
    expect(en.text).not.toContain("node session")
    const fr = renderDigestEmail({ ...args, locale: "fr" })
    expect(fr.text).toContain("[session en attente ·")
    expect(fr.text).toContain("[session terminée ·")
    expect(fr.text).toContain("[session en échec ·")
    expect(fr.html).not.toContain("node session")
  })
})

describe("renderDigestEmail: an agent's failure line", () => {
  // A thread_reply summary quotes the message, and the runtime wrote a failed turn's message
  // as a fixed English line (with the provider's raw text, on rows written before the code).
  // The digest mailed it verbatim (third QA walk).
  const legacy =
    "⚠️ I couldn't complete that response — the AI provider returned an error:\n\nYour project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap."
  const args = {
    baseUrl: "https://app.test",
    now: new Date("2026-05-12T12:30:00Z"),
    toAddress: "u@example.com",
    locale: "fr",
  }

  it("renders a stored failure line in the recipient's language", () => {
    const out = renderDigestEmail({
      ...args,
      rows: [row({ summary: AGENT_NOTICE_STORED_LINES.provider_quota })],
    })
    expect(out.html).toContain("plafond de dépenses atteint")
    expect(out.text).toContain("plafond de dépenses atteint")
    expect(out.html).not.toContain("I couldn&#39;t complete")
    expect(out.text).not.toContain("I couldn't complete")
  })

  it("never mails the provider's raw text an older row carries", () => {
    const out = renderDigestEmail({ ...args, rows: [row({ summary: legacy })] })
    expect(out.html).not.toContain("ai.studio")
    expect(out.text).not.toContain("ai.studio")
    expect(out.text).toContain("plafond de dépenses atteint")
  })

  it("leaves a person's own reply as written", () => {
    const out = renderDigestEmail({ ...args, rows: [row({ summary: "Merci, c'est noté" })] })
    expect(out.text).toContain("Merci, c'est noté")
  })
})

// D14 for attention items: a row created from a tainted turn records the turn's
// read scopes, and the email (a third party, like a push) carries no text derived
// from it. The in-app row keeps its summary.
describe("renderDigestEmail: a row carrying requiredScopes", () => {
  const args = {
    baseUrl: "https://app.test",
    now: new Date("2026-05-12T12:30:00Z"),
    toAddress: "u@example.com",
  }

  it("mails a generic line, never the summary", () => {
    for (const [locale, generic] of [
      ["en", "New notification"],
      ["fr", "Nouvelle notification"],
    ] as const) {
      const out = renderDigestEmail({
        ...args,
        locale,
        rows: [row({ kind: "agent_notification", summary: "Deal 42 closes", redacted: true })],
      })
      expect(out.html).not.toContain("Deal 42")
      expect(out.text).not.toContain("Deal 42")
      expect(out.text).toContain(generic)
    }
  })

  it("the digest query's row maps a non-empty or unreadable requiredScopes to redacted", () => {
    const base = {
      id: "r",
      org_id: ORG,
      user_id: USER_A,
      app: "kernel",
      entity_type: "agent_notification",
      entity_id: "e",
      kind: "agent_notification",
      urgency: 40,
      summary: "s",
      is_urgent: false,
      occurred_at: "2026-05-12T12:00:00Z",
    }
    const map = jobs.DigestJobsTestAccess.rowToPending
    expect(map({ ...base, required_scopes: ["apv:deals:read"] }).redacted).toBe(true)
    expect(map({ ...base, required_scopes: "garbage" }).redacted).toBe(true)
    expect(map({ ...base, required_scopes: [] }).redacted).toBeUndefined()
    expect(map({ ...base, required_scopes: null }).redacted).toBeUndefined()
  })
})

describe("shouldFireDailyDigest", () => {
  it("returns true at 08:05 UTC when lastSentAt null", () => {
    expect(shouldFireDailyDigest(new Date("2026-05-12T08:05:00Z"), "UTC", null)).toBe(true)
  })

  it("returns false before 08:00 local", () => {
    expect(shouldFireDailyDigest(new Date("2026-05-12T07:00:00Z"), "UTC", null)).toBe(false)
  })

  it("returns false on the same local day after sending", () => {
    expect(
      shouldFireDailyDigest(
        new Date("2026-05-12T12:00:00Z"),
        "UTC",
        new Date("2026-05-12T08:05:00Z"),
      ),
    ).toBe(false)
  })

  it("returns true on the next local day after sending", () => {
    expect(
      shouldFireDailyDigest(
        new Date("2026-05-13T08:10:00Z"),
        "UTC",
        new Date("2026-05-12T08:05:00Z"),
      ),
    ).toBe(true)
  })

  it("respects tz: 12:05 UTC is 08:05 EDT", () => {
    // 2026-05-12 12:05Z = 08:05 EDT (UTC-4 in May)
    expect(shouldFireDailyDigest(new Date("2026-05-12T12:05:00Z"), "America/New_York", null)).toBe(
      true,
    )
  })
})

describe("windowLabel", () => {
  it("daily uses ISO date", () => {
    expect(windowLabel("daily", new Date("2026-05-12T08:05:00Z"))).toBe("2026-05-12")
  })
  it("hourly uses ISO hour", () => {
    expect(windowLabel("hourly", new Date("2026-05-12T08:05:00Z"))).toBe("2026-05-12T08")
  })
  it("urgent uses ISO minute", () => {
    expect(windowLabel("urgent", new Date("2026-05-12T08:05:00Z"))).toBe("2026-05-12T08:05")
  })
})

class CapturingProvider implements EmailProvider {
  readonly sent: EmailMessage[] = []
  async send(m: EmailMessage): Promise<void> {
    this.sent.push(m)
  }
  async verify(): Promise<boolean> {
    return true
  }
}

class RateLimitedProvider implements EmailProvider {
  constructor(public readonly retryAfterMs: number) {}
  async send(): Promise<void> {
    throw new EmailRateLimitError(this.retryAfterMs)
  }
  async verify(): Promise<boolean> {
    return true
  }
}

class FailingProvider implements EmailProvider {
  async send(): Promise<void> {
    throw new Error("smtp down")
  }
  async verify(): Promise<boolean> {
    return false
  }
}

describe("runDigestUrgentOnce", () => {
  it("sends one email per user with all pending urgent rows, marks them sent", async () => {
    const provider = new CapturingProvider()
    const markedSent: string[][] = []
    await jobs.runDigestUrgentOnce({
      fetchUrgentPending: async () => [
        row({ id: "r-1", userId: USER_A, isUrgent: true, urgency: 80, summary: "SLA breach" }),
        row({ id: "r-2", userId: USER_A, isUrgent: true, urgency: 75, summary: "Approval" }),
      ],
      loadUser: async () => ({
        userId: USER_A,
        orgId: ORG,
        email: "a@example.com",
        digestCadence: "daily",
        timezone: "UTC",
        lastDailySentAt: null,
      }),
      markRowsSent: async (ids) => {
        markedSent.push(ids)
      },
      setLastDailySent: async () => {},
      emitDigestFailureAlert: async () => {},
      provider,
      baseUrl: "https://app.test",
      now: new Date("2026-05-12T12:00:00Z"),
    })
    expect(provider.sent.length).toBe(1)
    expect(provider.sent[0].to).toBe("a@example.com")
    expect(provider.sent[0].idempotencyKey).toContain("attention-digest:urgent:")
    expect(markedSent[0].sort()).toEqual(["r-1", "r-2"].sort())
  })

  it("rate-limit leaves rows pending and does not mark sent", async () => {
    const markedSent: string[][] = []
    await jobs.runDigestUrgentOnce({
      fetchUrgentPending: async () => [row({ userId: USER_A, isUrgent: true })],
      loadUser: async () => ({
        userId: USER_A,
        orgId: ORG,
        email: "a@example.com",
        digestCadence: "daily",
        timezone: "UTC",
        lastDailySentAt: null,
      }),
      markRowsSent: async (ids) => {
        markedSent.push(ids)
      },
      setLastDailySent: async () => {},
      emitDigestFailureAlert: async () => {},
      provider: new RateLimitedProvider(2000),
      baseUrl: "https://app.test",
      now: new Date(),
    })
    expect(markedSent.length).toBe(0)
  })

  it("final-attempt failure emits a digest-failure system_alert", async () => {
    const alerts: any[] = []
    await jobs.runDigestUrgentOnce(
      {
        fetchUrgentPending: async () => [row({ userId: USER_A, isUrgent: true })],
        loadUser: async () => ({
          userId: USER_A,
          orgId: ORG,
          email: "a@example.com",
          digestCadence: "daily",
          timezone: "UTC",
          lastDailySentAt: null,
        }),
        markRowsSent: async () => {},
        setLastDailySent: async () => {},
        emitDigestFailureAlert: async (a) => {
          alerts.push(a)
        },
        provider: new FailingProvider(),
        baseUrl: "https://app.test",
        now: new Date(),
      },
      { attempt: "final" },
    )
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ orgId: ORG, userId: USER_A, cadence: "urgent" })
  })
})

describe("runDigestDailyAt", () => {
  it("fires on first 08:00 crossing and sets last_daily_sent_at", async () => {
    const provider = new CapturingProvider()
    const lastSentRecorded: { current: { userId: string; when: Date } | null } = { current: null }
    await jobs.runDigestDailyAt(new Date("2026-05-12T12:05:00Z"), {
      fetchCadencePending: async () => [
        row({ userId: USER_A, isUrgent: false, summary: "non-urgent" }),
      ],
      loadUser: async () => ({
        userId: USER_A,
        orgId: ORG,
        email: "a@example.com",
        digestCadence: "daily",
        timezone: "America/New_York",
        lastDailySentAt: null,
      }),
      markRowsSent: async () => {},
      setLastDailySent: async (userId, when) => {
        lastSentRecorded.current = { userId, when }
      },
      emitDigestFailureAlert: async () => {},
      provider,
      baseUrl: "https://app.test",
    })
    expect(provider.sent.length).toBe(1)
    expect(lastSentRecorded.current).not.toBeNull()
    if (!lastSentRecorded.current) throw new Error("lastDailySent was not recorded")
    const recorded = lastSentRecorded.current
    expect(recorded.userId).toBe(USER_A)
    expect(recorded.when.toISOString().slice(0, 10)).toBe("2026-05-12")
  })

  it("only first 08:00 crossing per local day fires", async () => {
    const provider = new CapturingProvider()
    const baseDeps = {
      fetchCadencePending: async () => [row({ userId: USER_A })],
      loadUser: async () => ({
        userId: USER_A,
        orgId: ORG,
        email: "a@example.com",
        digestCadence: "daily" as const,
        timezone: "America/New_York",
        lastDailySentAt: new Date("2026-05-12T12:05:00Z"),
      }),
      markRowsSent: async () => {},
      setLastDailySent: async () => {},
      emitDigestFailureAlert: async () => {},
      provider,
      baseUrl: "https://app.test",
    }
    await jobs.runDigestDailyAt(new Date("2026-05-12T12:10:00Z"), baseDeps)
    expect(provider.sent.length).toBe(0)
  })
})

describe("runDigestCadenceOnce (immediate)", () => {
  it("processes immediate cadence rows and marks sent", async () => {
    const provider = new CapturingProvider()
    const marked: string[][] = []
    await jobs.runDigestCadenceOnce({
      fetchCadencePending: async (cadence) => {
        expect(cadence).toBe("immediate")
        return [row({ id: "i-1", userId: USER_A })]
      },
      loadUser: async () => ({
        userId: USER_A,
        orgId: ORG,
        email: "a@example.com",
        digestCadence: "immediate",
        timezone: "UTC",
        lastDailySentAt: null,
      }),
      markRowsSent: async (ids) => {
        marked.push(ids)
      },
      setLastDailySent: async () => {},
      emitDigestFailureAlert: async () => {},
      provider,
      baseUrl: "https://app.test",
      now: new Date(),
    })
    expect(provider.sent.length).toBe(1)
    expect(marked[0]).toEqual(["i-1"])
  })
})
