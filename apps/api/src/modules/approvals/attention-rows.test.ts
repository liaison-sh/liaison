// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A STORED ROW ABOUT A REQUEST FOLLOWS THE REQUEST. "Waiting more than 24 hours for a decision"
// asks for a decision: it leaves Home as soon as none can be made by this person, and never
// before. A decision's own line ("request-1 expired") says what it was about.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { getEventAttentionItems } from "~/modules/attention/event-provider"
import { processTranslationEvent } from "~/modules/attention/translator"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let ORG = ""
let THREAD = ""
const people: Record<string, string> = {}

interface Spec {
  status?: string
  notify?: string[]
  owner?: string | null
  metadata?: Record<string, unknown>
  requestedBy?: string
  proposingTurnScopes?: string[]
  title?: string
}

async function request(spec: Spec = {}): Promise<{ id: string; handle: string }> {
  const id = randomUUID()
  const handle = `request-${id.slice(0, 8)}`
  await sql.unsafe(
    insertSql("kernel.approval_requests", {
      id,
      org_id: ORG,
      handle,
      thread_id: THREAD,
      originating_thread_id: THREAD,
      tool_name: "projects:createTask",
      tool_params: "{}",
      current_payload: "{}",
      expires_at: { raw: "now() + INTERVAL '3 days'" },
      created_at: { raw: "now() - INTERVAL '25 hours'" },
      notify_user_ids: `{${(spec.notify ?? [people.ines, people.tom]).join(",")}}`,
      requested_by: spec.requestedBy ?? people.sara,
      status: spec.status ?? "pending",
      summary: JSON.stringify({ title: spec.title ?? "Email the November invoice" }),
      metadata: JSON.stringify(spec.metadata ?? {}),
      resource_owner_id: spec.owner ?? null,
      proposing_turn_scopes: spec.proposingTurnScopes
        ? `{${spec.proposingTurnScopes.join(",")}}`
        : "{}",
    }),
  )
  return { id, handle }
}

async function reminder(approvalId: string, userId: string): Promise<void> {
  await sql.unsafe(
    insertSql("kernel.attention_events", {
      org_id: ORG,
      user_id: userId,
      app: "kernel",
      entity_type: "agent_notification",
      entity_id: approvalId,
      kind: "agent_notification",
      urgency: 50,
      summary: "Waiting more than 24 hours for a decision: Email the November invoice",
      actor_type: "system",
      occurred_at: { raw: "now()" },
      digest_eligible_at: { raw: "now()" },
      metadata: JSON.stringify({ routedReminder: { approvalId, hours: 24 } }),
    }),
  )
}

/** The stored rows about this request on one person's feed. */
async function rowsOf(approvalId: string, userId: string, scopes = ["projects:approve"]) {
  const items = await withRlsContext(
    { actorType: "user", userId, orgId: ORG, scopes, dimensionGrants: {} },
    (tx) => getEventAttentionItems(tx, ORG, userId),
  )
  return items.filter((i) => i.entityId === approvalId)
}

async function unread(approvalId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.attention_events
     WHERE org_id = ${ORG}::uuid AND entity_id = ${approvalId}
       AND kind = 'agent_notification' AND read_at IS NULL`
  return (row as { n: number }).n
}

async function changed(id: string, status: string): Promise<void> {
  await processTranslationEvent({
    app: "kernel",
    entity: "approval_request",
    action: "update",
    entityId: id,
    orgId: ORG,
    actorId: people.ines as string,
    actorType: "user",
    timestamp: new Date().toISOString(),
    data: { status, handle: "request-x", requestedBy: { id: people.ines } },
  })
}

beforeAll(async () => {
  await acquireTestLock()
  ORG = (await createTestOrg()).id
  for (const name of ["ines", "tom", "sara"]) {
    people[name] = (await minimal.person(ORG, { name: `Fixture ${name}` })).id
  }
  for (const name of ["ines", "tom"]) {
    await minimal.grantScope(people[name] as string, "projects:approve")
  }
  THREAD = await minimal.thread(ORG, people.sara as string, { title: "Attention row fixtures" })
}, 120_000)

afterAll(async () => {
  await sql`DELETE FROM kernel.attention_events WHERE org_id = ${ORG}::uuid`
  await releaseTestLock()
})

describe("a reminder of a waiting request", () => {
  it("stays while the request waits and is this person's to decide", async () => {
    const r = await request()
    await reminder(r.id, people.ines as string)
    expect(await rowsOf(r.id, people.ines as string)).toHaveLength(1)
  })

  it("stays on a request that stalled while it was being carried out", async () => {
    const r = await request({ status: "approving", metadata: { ambiguousAt: "2027-01-01" } })
    await reminder(r.id, people.ines as string)
    expect(await rowsOf(r.id, people.ines as string)).toHaveLength(1)
  })

  for (const status of ["approved", "denied", "expired", "cancelled", "withdrawn"]) {
    it(`is gone once the request is ${status}`, async () => {
      const r = await request({ status })
      await reminder(r.id, people.ines as string)
      expect(await rowsOf(r.id, people.ines as string)).toEqual([])
    })
  }

  it("is gone for a person the request is no longer for", async () => {
    const moved = await request({ notify: [people.tom as string] })
    await reminder(moved.id, people.ines as string)
    expect(await rowsOf(moved.id, people.ines as string)).toEqual([])
  })

  it("is gone for a person who may no longer decide it", async () => {
    const r = await request()
    await reminder(r.id, people.ines as string)
    expect(await rowsOf(r.id, people.ines as string, ["projects:projects:read"])).toEqual([])
  })

  it("is gone for the person who already signed a request that needs two", async () => {
    const r = await request({ metadata: { minApprovers: 2, approvedBy: [people.ines] } })
    await reminder(r.id, people.ines as string)
    await reminder(r.id, people.tom as string)
    expect(await rowsOf(r.id, people.ines as string)).toEqual([])
    expect(await rowsOf(r.id, people.tom as string)).toHaveLength(1)
  })

  for (const status of ["approved", "denied", "expired", "cancelled", "withdrawn"]) {
    it(`is read for everyone by the event that says the request is ${status}`, async () => {
      const r = await request()
      await reminder(r.id, people.ines as string)
      await reminder(r.id, people.tom as string)
      await changed(r.id, status)
      expect(await unread(r.id)).toBe(0)
    })
  }

  it("is left unread by an event of a request still waiting", async () => {
    const r = await request()
    await reminder(r.id, people.ines as string)
    await changed(r.id, "pending")
    await changed(r.id, "approving")
    expect(await unread(r.id)).toBe(1)
  })
})

describe("the line that says a request was decided", () => {
  async function decisionRow(spec: Spec, userId: string) {
    const r = await request(spec)
    await sql.unsafe(
      insertSql("kernel.attention_events", {
        org_id: ORG,
        user_id: userId,
        app: "kernel",
        entity_type: "approval_request",
        entity_id: r.id,
        kind: "approval_decision",
        urgency: 50,
        summary: `Approval ${r.handle} ${spec.status}`,
        actor_type: "system",
        occurred_at: { raw: "now()" },
        digest_eligible_at: { raw: "now()" },
      }),
    )
    return { r, rows: await rowsOf(r.id, userId, []) }
  }

  it("names what the request was about, for the person who asked", async () => {
    const { r, rows } = await decisionRow(
      { status: "expired", requestedBy: people.sara, title: "Email the November invoice" },
      people.sara as string,
    )
    expect(rows[0]?.summary).toBe(`Approval ${r.handle} expired`)
    expect(rows[0]?.metadata?.decisionTitle).toBe("Email the November invoice")
  })

  it("names nothing of a restricted record", async () => {
    const { rows } = await decisionRow(
      {
        status: "expired",
        requestedBy: people.sara,
        title: "Email the board minutes",
        proposingTurnScopes: [`restricted:${randomUUID()}`],
      },
      people.sara as string,
    )
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0])).not.toContain("board minutes")
  })
})
