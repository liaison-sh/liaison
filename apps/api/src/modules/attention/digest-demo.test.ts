// SPDX-License-Identifier: FSL-1.1-ALv2
//
// On an instance whose system mail cannot leave (a demo box), the digest jobs
// skip: no send attempt, no throw (a throw is a BullMQ retry and an error log
// per attempt), and the rows stay as they are. A regular instance still sends.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import type { EmailMessage, EmailProvider } from "~/infra/email"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import type { PendingAttentionRow } from "./digest"
import type { DigestDeps, DigestUser } from "./digest-jobs"
import {
  DigestJobsTestAccess,
  runDigestCadenceOnce,
  runDigestDailyAt,
  runDigestHourlyOnce,
  runDigestUrgentOnce,
} from "./digest-jobs"

// Fixture orgs are not database rows, so the effect ledger (which needs a real
// org) is replaced by a plain send; the ledger's digest case is digest-once.test.ts.
beforeAll(() => {
  DigestJobsTestAccess.setSendOnce(async (_orgId, provider, message) => {
    await provider.send(message)
    return "sent"
  })
})
afterAll(() => DigestJobsTestAccess.setSendOnce(null))

const ORG = "00000000-0000-0000-0000-000000000d11"
const USER = "00000000-0000-0000-0000-000000000d12"

const ROW: PendingAttentionRow = {
  id: "r-demo-1",
  orgId: ORG,
  userId: USER,
  app: "kernel",
  entityType: "thread",
  entityId: "t1",
  kind: "thread_reply",
  urgency: 90,
  summary: "summary",
  isUrgent: true,
  occurredAt: new Date("2026-10-23T08:00:00Z"),
}

const USER_ROW: DigestUser = {
  userId: USER,
  orgId: ORG,
  email: "person@example.com",
  digestCadence: "immediate",
  timezone: "Europe/Paris",
  lastDailySentAt: null,
}

function deps(sent: EmailMessage[], fetched: string[]): Partial<DigestDeps> {
  const provider: EmailProvider = {
    async send(m) {
      sent.push(m)
    },
    async verify() {
      return true
    },
  }
  return {
    fetchUrgentPending: async () => {
      fetched.push("urgent")
      return [ROW]
    },
    fetchCadencePending: async (c) => {
      fetched.push(c)
      return [ROW]
    },
    loadUser: async () => USER_ROW,
    markRowsSent: async () => {},
    markRowsSuppressed: async () => {},
    setLastDailySent: async () => {},
    emitDigestFailureAlert: async () => {},
    provider,
    baseUrl: "http://localhost",
  }
}

afterEach(() => {
  DemoModeTestAccess.set(null)
  DigestJobsTestAccess.resetRateLimit()
})

describe("the attention digest on an instance whose system mail cannot leave", () => {
  it("skips every cadence without reading, sending or throwing", async () => {
    DemoModeTestAccess.set(true)
    const fetched: string[] = []
    // The instance's own provider (the demo one, which refuses and throws).
    const { provider: _own, ...rest } = deps([], fetched)
    await runDigestUrgentOnce(rest)
    await runDigestCadenceOnce(rest)
    await runDigestHourlyOnce(rest)
    await runDigestDailyAt(new Date("2026-10-23T07:00:00Z"), rest)
    expect(fetched).toEqual([])
  })

  it("still sends on a regular instance", async () => {
    DemoModeTestAccess.set(false)
    const sent: EmailMessage[] = []
    const fetched: string[] = []
    await runDigestUrgentOnce(deps(sent, fetched))
    expect(fetched).toEqual(["urgent"])
    expect(sent.map((m) => m.to)).toEqual(["person@example.com"])
  })
})
