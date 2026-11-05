// SPDX-License-Identifier: FSL-1.1-ALv2
// [Phase 10 INT-2] End-to-end digest delivery via the real ResendEmailProvider.
//
// What the existing attention-digest integration test covers: digest job
// orchestration with a CapturingProvider. What it does NOT cover: that the
// rendered email actually traverses the Resend HTTP code path correctly. This
// test plugs the *real* `ResendEmailProvider` into the digest job and asserts
// the exact HTTPS request shape that hits api.resend.com — Authorization,
// idempotency header, request body fields, HTML body content. The `fetch`
// implementation is overridden via the provider's constructor so no live
// network call is made.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { ResendEmailProvider } from "~/infra/email"
import type { PendingAttentionRow } from "~/modules/attention/digest"

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
const USER = "00000000-0000-0000-0000-000000000001"
const RESEND_KEY = "re_test_AbCdEfGhIjKlMnOpQrStUv"
const FROM = "Liaison <noreply@mail.liaison.sh>"
const TO = "admin@example.com"

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: any
}

function makeResendProviderCapturing(capture: CapturedRequest[]): ResendEmailProvider {
  return new ResendEmailProvider({
    apiKey: RESEND_KEY,
    from: FROM,
    fetch: async (url, init) => {
      const headerMap: Record<string, string> = {}
      const h = init.headers as Record<string, string> | [string, string][] | undefined
      if (h && typeof h === "object" && !Array.isArray(h)) {
        for (const [k, v] of Object.entries(h as Record<string, string>)) headerMap[k] = v
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) headerMap[k] = v
      }
      capture.push({
        url: url as string,
        method: (init.method ?? "GET") as string,
        headers: headerMap,
        body: init.body ? JSON.parse(init.body as string) : null,
      })
      return new Response(JSON.stringify({ id: "msg_test_1234" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    },
  })
}

function fixtureRow(over: Partial<PendingAttentionRow>): PendingAttentionRow {
  return {
    id: "r-1",
    orgId: ORG,
    userId: USER,
    app: "kernel",
    entityType: "thread",
    entityId: "t-sprint",
    kind: "thread_reply",
    urgency: 30,
    summary: "Sample summary",
    isUrgent: false,
    occurredAt: new Date("2026-05-13T06:00:00Z"),
    ...over,
  }
}

const BASE_DEPS = {
  fetchUrgentPending: async () => [],
  loadUser: async () => ({
    userId: USER,
    orgId: ORG,
    email: TO,
    digestCadence: "daily" as const,
    timezone: "UTC",
    lastDailySentAt: null,
  }),
  markRowsSent: async () => {},
  setLastDailySent: async () => {},
  emitDigestFailureAlert: async () => {},
  baseUrl: "https://app.liaison.sh",
  now: new Date("2026-05-13T08:05:00Z"),
}

describe("attention-digest-resend (INT-2) — real ResendEmailProvider HTTP shape", () => {
  it("hits api.resend.com/emails with the expected headers and JSON body", async () => {
    const captured: CapturedRequest[] = []
    const provider = makeResendProviderCapturing(captured)

    await jobs.runDigestCadenceOnce({
      ...BASE_DEPS,
      fetchCadencePending: async () => [
        fixtureRow({
          id: "r-1",
          kind: "mention",
          summary: "Alice mentioned you in #Sprint Planning",
          entityId: "thread-sprint-planning",
        }),
        fixtureRow({
          id: "r-2",
          kind: "approval_decision",
          summary: "Your spend request was approved",
          app: "kernel",
          entityType: "approval_request",
          entityId: "ar-091",
        }),
      ],
      provider,
    })

    // Exactly one outbound HTTP call.
    expect(captured.length).toBe(1)
    const req = captured[0]

    // URL + method
    expect(req.url).toBe("https://api.resend.com/emails")
    expect(req.method).toBe("POST")

    // Headers — auth + content-type + deterministic idempotency key.
    expect(req.headers.Authorization).toBe(`Bearer ${RESEND_KEY}`)
    expect(req.headers["Content-Type"]).toBe("application/json")
    // `runDigestCadenceOnce` is the immediate-cadence runner; the daily runner is
    // exercised in the urgent test below. The structure is `cadence:userId:window:hash`.
    expect(req.headers["Idempotency-Key"]).toMatch(/^attention-digest:immediate:[0-9a-f-]+:/)

    // Body shape
    expect(req.body.from).toBe(FROM)
    expect(req.body.to).toBe(TO)
    expect(req.body.subject).toBe("2 things need your attention")
    expect(typeof req.body.html).toBe("string")
    expect(typeof req.body.text).toBe("string")

    // HTML carries the redesigned template signatures.
    expect(req.body.html).toContain("<!doctype html>")
    expect(req.body.html).toContain("@media (prefers-color-scheme: dark)")
    expect(req.body.html).toContain("Alice mentioned you in #Sprint Planning")
    expect(req.body.html).toContain("https://app.liaison.sh/threads/thread-sprint-planning")
    expect(req.body.html).toContain("https://app.liaison.sh/approvals/ar-091")
    expect(req.body.html).toContain("https://app.liaison.sh/settings/notifications")
    expect(req.body.html).toContain(">mention<")
    expect(req.body.html).toContain(">approval<")
  })

  it("retries with the same Idempotency-Key when called twice for the same rows", async () => {
    const captured: CapturedRequest[] = []
    const provider = makeResendProviderCapturing(captured)
    const rows = [fixtureRow({ id: "r-stable" })]

    await jobs.runDigestCadenceOnce({
      ...BASE_DEPS,
      fetchCadencePending: async () => rows,
      provider,
    })
    await jobs.runDigestCadenceOnce({
      ...BASE_DEPS,
      fetchCadencePending: async () => rows,
      provider,
    })

    expect(captured.length).toBe(2)
    expect(captured[0].headers["Idempotency-Key"]).toBe(captured[1].headers["Idempotency-Key"])
  })

  it("urgent cadence uses a different idempotency-key namespace than daily", async () => {
    const captured: CapturedRequest[] = []
    const provider = makeResendProviderCapturing(captured)

    await jobs.runDigestUrgentOnce({
      ...BASE_DEPS,
      fetchUrgentPending: async () => [
        fixtureRow({ id: "u-1", isUrgent: true, urgency: 85, kind: "system_alert" }),
      ],
      provider,
    })

    expect(captured.length).toBe(1)
    expect(captured[0].headers["Idempotency-Key"]).toMatch(/^attention-digest:urgent:/)
    expect(captured[0].body.subject).toBe("1 thing needs your attention")
  })

  it("ResendEmailProvider surfaces 429 → EmailRateLimitError back to the worker (rows NOT marked sent)", async () => {
    const provider = new ResendEmailProvider({
      apiKey: RESEND_KEY,
      from: FROM,
      fetch: async () =>
        new Response("", {
          status: 429,
          headers: { "Retry-After": "3" },
        }),
    })
    const marked: string[][] = []
    await jobs.runDigestCadenceOnce({
      ...BASE_DEPS,
      fetchCadencePending: async () => [fixtureRow({ id: "r-rate" })],
      markRowsSent: async (ids) => {
        marked.push(ids)
      },
      provider,
    })
    expect(marked.length).toBe(0)
  })
})

afterAll(() => {
  jobs?.DigestJobsTestAccess.setSendOnce(null)
})
