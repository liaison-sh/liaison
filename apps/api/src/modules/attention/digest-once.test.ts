// SPDX-License-Identifier: FSL-1.1-ALv2
// A digest job run twice with the same rows (a crash after the send and before
// the rows were marked sent, or a job handed back and re-run elsewhere) mails
// once (S11, P3 T16). On the base the second run sends again: the Idempotency-
// Key header is honoured by Resend only, and this provider ignores it as SMTP
// does. In a load org the same digest is counted in the effect sink, once.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import type { EmailMessage, EmailProvider } from "~/infra/email"
import { sinkCount } from "~/lib/effect-sink"
import { LoadHarnessTestAccess } from "~/lib/load-harness"
import { buildIdempotencyKey, type PendingAttentionRow, windowLabel } from "./digest"
import { DigestJobsTestAccess, runDigestUrgentOnce } from "./digest-jobs"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()

class SmtpLike implements EmailProvider {
  sent: EmailMessage[] = []
  async send(m: EmailMessage): Promise<void> {
    this.sent.push(m)
  }
  async verify(): Promise<boolean> {
    return true
  }
}

function rows(): PendingAttentionRow[] {
  return [
    {
      id: crypto.randomUUID(),
      orgId: ORG,
      userId: USER,
      app: "kernel",
      entityType: "thread",
      entityId: "t1",
      kind: "thread_reply",
      urgency: 80,
      summary: "SLA breach",
      isUrgent: true,
      occurredAt: new Date(),
    },
  ]
}

function deps(provider: EmailProvider, pending: PendingAttentionRow[], now: Date) {
  return {
    fetchUrgentPending: async () => pending,
    loadUser: async () => ({
      userId: USER,
      orgId: ORG,
      email: "a@example.com",
      digestCadence: "daily" as const,
      timezone: "UTC",
      lastDailySentAt: null,
    }),
    // The crash window: the rows are never marked sent, so the re-run sees them.
    markRowsSent: async () => {},
    markRowsSuppressed: async () => {},
    setLastDailySent: async () => {},
    emitDigestFailureAlert: async () => {},
    provider,
    baseUrl: "https://app.test",
    now,
  }
}

beforeAll(async () => {
  DigestJobsTestAccess.setSendOnce(null)
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'Digest once', ${`digest-once-${ORG.slice(0, 8)}`})`
})

afterEach(() => {
  LoadHarnessTestAccess.setKey(undefined)
  DigestJobsTestAccess.resetRateLimit()
})

afterAll(async () => {
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("digest effect once", () => {
  it("effect runs once when its job is run twice with the same rows", async () => {
    const provider = new SmtpLike()
    const pending = rows()
    const now = new Date()
    await runDigestUrgentOnce(deps(provider, pending, now))
    await runDigestUrgentOnce(deps(provider, pending, now))
    expect(provider.sent.length).toBe(1)
  })

  it("a load org's digest goes to the sink once and never to the provider", async () => {
    LoadHarnessTestAccess.setKey(crypto.randomBytes(32).toString("hex"))
    await sql`UPDATE kernel.organizations SET settings = '{"loadHarness": true}'::jsonb WHERE id = ${ORG}`
    const provider = new SmtpLike()
    const pending = rows()
    const now = new Date()
    await runDigestUrgentOnce(deps(provider, pending, now))
    expect(provider.sent.length).toBe(0)
    const key = buildIdempotencyKey(
      "urgent",
      USER,
      windowLabel("urgent", now),
      pending.map((r) => r.id),
    )
    expect(await sinkCount(ORG, "mail", key)).toBe(1)
    // The sink stands in for the provider inside the ledger's claim: the job
    // run again sinks nothing more, so the sink's count measures doubles.
    await runDigestUrgentOnce(deps(provider, pending, now))
    expect(await sinkCount(ORG, "mail", key)).toBe(1)
  })
})

//
// Rule 5, read once, read everywhere: the digest carries only what is still
// unread when it is sent. A row read on any device after it was queued is
// retired from the digest, never mailed.

const UNREAD_ORG = "00000000-0000-0000-0000-0000000009e0"
const UNREAD_USER = "00000000-0000-0000-0000-0000000009e1"

async function digestRow(entityId: string, urgent: boolean, read: boolean): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO kernel.attention_events
      (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary, actor_type,
       occurred_at, read_at, is_urgent, digest_state, digest_eligible_at)
    VALUES (${UNREAD_ORG}, ${UNREAD_USER}, 'kernel', 'thread', ${entityId}, 'mention', ${urgent ? 80 : 40}, 'x',
      'user', now(), ${read ? new Date().toISOString() : null}::timestamptz, ${urgent},
      'pending', now() - interval '1 minute')
    RETURNING id`
  return r!.id
}

describe("the digest carries only what is still unread (rule 5)", () => {
  let unreadUrgent = ""
  let readUrgent = ""
  let unreadDaily = ""
  let readDaily = ""

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${UNREAD_ORG}, 'DigestReadOrg', 'digest-read-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${UNREAD_USER}, ${UNREAD_ORG}, 'digest-read@t.com', 'Reader', 'x') ON CONFLICT (id) DO NOTHING`
    unreadUrgent = await digestRow("t-1", true, false)
    readUrgent = await digestRow("t-2", true, true)
    unreadDaily = await digestRow("t-3", false, false)
    readDaily = await digestRow("t-4", false, true)
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.attention_events WHERE org_id = ${UNREAD_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${UNREAD_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${UNREAD_ORG}`
  })

  it("an urgent row read before the send is not mailed", async () => {
    const ids = (await DigestJobsTestAccess.fetchUrgent()).map((r) => r.id)
    expect(ids).toContain(unreadUrgent)
    expect(ids).not.toContain(readUrgent)
  })

  it("a daily row read before the send is not mailed, and leaves the queue", async () => {
    const ids = (await DigestJobsTestAccess.fetchCadencePending("daily")).map((r) => r.id)
    expect(ids).toContain(unreadDaily)
    expect(ids).not.toContain(readDaily)
    const states = await sql<{ id: string; digest_state: string }[]>`
      SELECT id, digest_state FROM kernel.attention_events WHERE org_id = ${UNREAD_ORG}`
    const state = new Map(states.map((s) => [s.id, s.digest_state]))
    expect(state.get(readDaily)).toBe("suppressed")
    expect(state.get(readUrgent)).toBe("suppressed")
    expect(state.get(unreadDaily)).toBe("pending")
  })
})
