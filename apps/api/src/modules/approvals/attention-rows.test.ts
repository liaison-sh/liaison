// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A STORED ROW ABOUT A REQUEST FOLLOWS THE REQUEST. "Waiting more than 24 hours for a decision"
// asks for a decision: it leaves Home as soon as none can be made by this person, and never
// before. A decision's own line ("request-1 expired") says what it was about.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import type { AttentionItem } from "@liaison/shared"
import { sql } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { recordToken } from "~/modules/apps/approval-record-token"
import { attentionSourceApp } from "~/modules/attention/attention-source-app"
import { getEventAttentionItems } from "~/modules/attention/event-provider"
import { processTranslationEvent } from "~/modules/attention/translator"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestCompany } from "~/tests/helpers/company"
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
  title?: string | number | null
  summary?: Record<string, unknown>
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
      summary: JSON.stringify(
        spec.summary ?? { title: spec.title ?? "Email the November invoice" },
      ),
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

/** Every unread row of one person's feed, as the feed lists them. */
async function feedOf(userId: string, scopes = ["projects:approve"]) {
  return withRlsContext(
    { actorType: "user", userId, orgId: ORG, scopes, dimensionGrants: {} },
    (tx) => getEventAttentionItems(tx, ORG, userId),
  )
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

  it("is read by the event of its own request alone, and no other row of that request is", async () => {
    const [ended, waits] = [await request(), await request()]
    await reminder(ended.id, people.ines as string)
    await reminder(waits.id, people.ines as string)
    await sql.unsafe(
      insertSql("kernel.attention_events", {
        org_id: ORG,
        user_id: people.ines as string,
        app: "kernel",
        entity_type: "agent_notification",
        entity_id: ended.id,
        kind: "note",
        urgency: 10,
        summary: "Another row about it",
        actor_type: "system",
        occurred_at: { raw: "now()" },
        digest_eligible_at: { raw: "now()" },
      }),
    )
    await changed(ended.id, "approved")
    expect(await unread(ended.id)).toBe(0)
    expect(await unread(waits.id)).toBe(1)
    const [note] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.attention_events
       WHERE entity_id = ${ended.id} AND kind = 'note' AND read_at IS NULL`
    expect(note?.n).toBe(1)
  })

  it("says which app it is about", async () => {
    const r = await request()
    await reminder(r.id, people.ines as string)
    const [row] = await rowsOf(r.id, people.ines as string)
    expect(row?.metadata?.toolName).toBe("projects:createTask")
    expect(attentionSourceApp(row as AttentionItem)).toBe("projects")
  })

  it("that names no request at all is left out, and the rest of the feed stays", async () => {
    const r = await request()
    await reminder("not-a-request", people.ines as string)
    await reminder(r.id, people.ines as string)
    expect(await rowsOf("not-a-request", people.ines as string)).toEqual([])
    expect(await rowsOf(r.id, people.ines as string)).toHaveLength(1)
  })

  it("is left unread by an event of a request still waiting", async () => {
    const r = await request()
    await reminder(r.id, people.ines as string)
    await changed(r.id, "pending")
    await changed(r.id, "approving")
    expect(await unread(r.id)).toBe(1)
  })
})

describe("a feed full of reminders nothing is left of", () => {
  let reader = ""

  /** Many unread notifications, each saying only what makes it its own. */
  async function rows(count: number, own: (n: number) => Record<string, unknown>) {
    for (let n = 1; n <= count; n++) {
      await sql.unsafe(
        insertSql("kernel.attention_events", {
          org_id: ORG,
          app: "kernel",
          entity_type: "agent_notification",
          kind: "agent_notification",
          summary: "Row",
          actor_type: "system",
          digest_eligible_at: { raw: "now()" },
          ...own(n),
        } as Parameters<typeof insertSql>[1]),
      )
    }
  }

  async function dead(count: number, spec: Spec): Promise<void> {
    const r = await request({ ...spec, notify: [reader] })
    await rows(count, (n) => ({
      user_id: reader,
      entity_id: randomUUID(),
      urgency: 50,
      occurred_at: { raw: `now() - INTERVAL '2 days' - INTERVAL '${n} minutes'` },
      metadata: JSON.stringify({ routedReminder: { approvalId: r.id, hours: 24 } }),
    }))
  }

  it("hides no live row: the limit counts what the person sees", async () => {
    reader = (await minimal.person(ORG, { name: "Fixture reader" })).id
    await minimal.grantScope(reader, "projects:approve")
    await dead(120, { status: "approved" })
    await dead(120, { status: "cancelled" })
    // Waiting, and no longer this person's: signed, and for someone else.
    await dead(120, { metadata: { minApprovers: 2, approvedBy: [reader] } })
    const live = await request({ notify: [reader] })
    await reminder(live.id, reader)
    await sql.unsafe(
      insertSql("kernel.attention_events", {
        org_id: ORG,
        user_id: reader,
        app: "kernel",
        entity_type: "agent_notification",
        entity_id: "a-notification",
        kind: "agent_notification",
        urgency: 50,
        summary: "The report is ready",
        actor_type: "agent",
        occurred_at: { raw: "now()" },
        digest_eligible_at: { raw: "now()" },
      }),
    )
    expect((await feedOf(reader)).map((i) => i.entityId).sort()).toEqual(
      [live.id, "a-notification"].sort(),
    )
  })

  it("still lists at most its limit, the most urgent and the oldest first", async () => {
    const many = (await minimal.person(ORG, { name: "Fixture many" })).id
    await rows(230, (n) => ({
      user_id: many,
      entity_id: `n${n}`,
      urgency: 40,
      occurred_at: { raw: `now() - INTERVAL '${n} minutes'` },
    }))
    const r = await request({ notify: [many] })
    await reminder(r.id, many)
    await minimal.grantScope(many, "projects:approve")
    const items = await feedOf(many)
    expect(items).toHaveLength(200)
    expect(items[0]?.entityId).toBe(r.id)
    expect(items[1]?.entityId).toBe("n230")
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

  it("names a record only to who may read it", async () => {
    const company = await createTestCompany(ORG, "Harbour works")
    const summary = {
      title: "Projects: move",
      lines: [],
      names: [
        {
          shown: "Projects: move",
          named: `Projects: move: ${recordToken({ app: "kernel", entityType: "company", id: company })}`,
        },
      ],
    }
    const spec = { status: "expired", requestedBy: people.sara, summary }
    const { r, rows } = await decisionRow(spec, people.sara as string)
    expect(rows[0]?.metadata?.decisionTitle).toBe("Projects: move")
    const [seen] = await rowsOf(r.id, people.sara as string, ["kernel:companies:read"])
    expect(seen?.metadata?.decisionTitle).toBe("Projects: move: Harbour works")
  })

  it("a card with no title of its own, or one that is not words, is named by its handle", async () => {
    for (const summary of [{ title: "projects:createTask" }, { title: 7 }, { title: " " }, {}]) {
      const { rows } = await decisionRow(
        { status: "expired", requestedBy: people.sara, summary },
        people.sara as string,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.metadata?.decisionTitle).toBeUndefined()
    }
  })

  it("that names no request keeps its line, and the rest of the feed stays", async () => {
    await sql.unsafe(
      insertSql("kernel.attention_events", {
        org_id: ORG,
        user_id: people.sara as string,
        app: "kernel",
        entity_type: "approval_request",
        entity_id: "not-a-request",
        kind: "approval_decision",
        urgency: 50,
        summary: "Approval request-9 expired",
        actor_type: "system",
        occurred_at: { raw: "now()" },
        digest_eligible_at: { raw: "now()" },
      }),
    )
    expect(await rowsOf("not-a-request", people.sara as string, [])).toHaveLength(1)
  })

  it("is not given a title of a request it does not name, nor a reminder one", async () => {
    const r = await request({ status: "expired", requestedBy: people.sara })
    const row = (over: Record<string, unknown>) =>
      sql.unsafe(
        insertSql("kernel.attention_events", {
          org_id: ORG,
          user_id: people.sara as string,
          app: "kernel",
          entity_type: "approval_request",
          entity_id: r.id,
          kind: "approval_decision",
          urgency: 50,
          summary: "Approval request-9 expired",
          actor_type: "system",
          occurred_at: { raw: "now()" },
          digest_eligible_at: { raw: "now()" },
          ...over,
        }),
      )
    // An app's own row, and a kernel row of another kind of record, with the same id.
    await row({ app: "projects" })
    await row({ entity_type: "ticket" })
    const rows = await rowsOf(r.id, people.sara as string, [])
    expect(rows).toHaveLength(2)
    expect(rows.every((i) => i.metadata?.decisionTitle === undefined)).toBe(true)
    const waits = await request()
    await reminder(waits.id, people.ines as string)
    const [told] = await rowsOf(waits.id, people.ines as string)
    expect(told?.metadata?.decisionTitle).toBeUndefined()
  })

  it("says who and how much of one that expired undone, and marks it left undone", async () => {
    const summary = {
      title: "Issue the retainer invoice, 2027-03",
      lines: [
        "Customer: Harbour Press",
        "Total: 5,940.00 EUR",
        "Due date: 30 days",
        "Issued by: X",
      ],
    }
    const { rows } = await decisionRow(
      { status: "expired", requestedBy: people.sara, summary },
      people.sara as string,
    )
    expect(rows[0]?.metadata?.leftUndone).toBe(true)
    expect(rows[0]?.metadata?.summaryLines).toEqual(summary.lines.slice(0, 3))
  })

  it("leaves an internal expiry, and a decided request, as news", async () => {
    const internal = await decisionRow(
      {
        status: "expired",
        requestedBy: people.sara,
        summary: { title: "Set a label", lines: ["Label: idea"], impact: "internal" },
      },
      people.sara as string,
    )
    expect(internal.rows[0]?.metadata?.leftUndone).toBeUndefined()
    expect(internal.rows[0]?.metadata?.summaryLines).toBeUndefined()
    const approved = await decisionRow(
      { status: "approved", requestedBy: people.sara, summary: { title: "Issue", lines: ["A"] } },
      people.sara as string,
    )
    expect(approved.rows[0]?.metadata?.leftUndone).toBeUndefined()
  })

  it("names nothing of a restricted record", async () => {
    const { rows } = await decisionRow(
      {
        status: "expired",
        requestedBy: people.sara,
        summary: { title: "Email the board minutes", lines: ["To: the board minutes list"] },
        proposingTurnScopes: [`restricted:${randomUUID()}`],
      },
      people.sara as string,
    )
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0])).not.toContain("board minutes")
  })
})
