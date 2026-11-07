// SPDX-License-Identifier: FSL-1.1-ALv2
// The tickets `idSegment.get` / `idSegment.set` tools: the ticket-id prefix
// setting, reachable by an agent or an MCP client (before them, only the web
// settings page could write it). Admin-only, validated like PATCH /api/org,
// and the rest of settings.tickets is left alone.
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import { summarizeTicketIdSegmentSet } from "~/apps/tickets/summarizers"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { asOrgMember } from "~/tests/helpers/org-caller"
import manifest from "./app.manifest.json"

async function freshOrg(): Promise<string> {
  const slug = `idseg-tool-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug, settings)
      VALUES (gen_random_uuid(), 'IdSeg Org', ${slug},
              '{"tickets": {"sla": {"firstResponseMinutes": 30}}}'::jsonb)
      RETURNING id
    `),
  )
  await ensureAppsForOrg(org.id, {})
  return org.id
}

const admin = (scopes: string[]) => ({
  actorType: "user" as const,
  userId: "00000000-0000-0000-0000-000000000001",
  scopes,
})

const op = (orgId: string, name: string, params: Record<string, unknown>, scopes: string[]) =>
  asOrgMember(orgId, "00000000-0000-0000-0000-000000000001", (tx) =>
    runAdminOp(tx as never, orgId, name, params, admin(scopes)),
  ) as Promise<any>

const storedTickets = async (orgId: string) =>
  extractRows<{ t: any }>(
    await db.execute(
      drizzleSql`SELECT settings->'tickets' AS t FROM kernel.organizations WHERE id = ${orgId}`,
    ),
  )[0].t

describe("tickets idSegment tools", () => {
  // Ungated, a turn that had read any scoped data (idSegment.get itself) was
  // refused E_SCOPE_TAINT_BLOCKED: kernel.organizations is no enforcing sink.
  // Gated, it parks for a person holding the turn's scopes, which also fits a
  // change customers see in their email subjects.
  it("set is a gated, external approval with a summary; get is a read", async () => {
    const tools = (manifest as any).tools
    expect(tools["idSegment.set"].gated).toBe(true)
    expect(tools["idSegment.set"].approvalImpact).toBe("external")
    expect(tools["idSegment.get"].readOnly).toBe(true)
    const orgId = await freshOrg()
    const summary = await asOrgMember(orgId, "u", (tx) =>
      summarizeTicketIdSegmentSet(
        { by: "audience", codes: { b2b: "b2b", b2c: "B2C" } },
        { tx: tx as never, orgId, userId: "u" },
      ),
    )
    expect(summary.title).toBe("Ticket id prefix: audience (b2b → B2B, b2c → B2C)")
    expect(summary.impact).toBe("external")
    expect(summary.lines).toContain("Now: none")
    expect(summary.lines).toContain("b2b: ticket-B2B-123")
  })

  // Codes of an inbox (or category) segment are keyed by the row's id; the
  // approval card names the row instead, and the raw id only when it is gone.
  it("the summary names an inbox by its name, and by its id only when it is gone", async () => {
    const orgId = await freshOrg()
    const [inbox] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes (id, org_id, kind, connected_account_id, name, email_address, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}::uuid, 'api', NULL, 'Support desk', 'support@example.com', now(), now())
        RETURNING id::text AS id
      `),
    )
    const gone = "00000000-0000-0000-0000-00000000dead"
    const summary = await asOrgMember(orgId, "u", (tx) =>
      summarizeTicketIdSegmentSet(
        { by: "inbox", codes: { [inbox.id]: "sup", [gone]: "OLD" } },
        { tx: tx as never, orgId, userId: "u" },
      ),
    )
    expect(summary.title).toBe(`Ticket id prefix: inbox (Support desk → SUP, ${gone} → OLD)`)
    expect(summary.lines).toContain("Support desk: ticket-SUP-123")
    expect(summary.lines).toContain(`${gone}: ticket-OLD-123`)
    expect(JSON.stringify(summary)).not.toContain(inbox.id)
  })

  it("refuses a caller without tickets:settings:admin, and changes nothing", async () => {
    const orgId = await freshOrg()
    const set = await op(orgId, "idSegmentSet", { by: "audience", codes: { b2b: "B2B" } }, [
      "tickets:tickets:write",
      "kernel:org:admin",
    ])
    expect(set.error.code).toBe("forbidden")
    const get = await op(orgId, "idSegmentGet", {}, ["tickets:tickets:read"])
    expect(get.error.code).toBe("forbidden")
    expect((await storedTickets(orgId)).idSegment).toBeUndefined()
  })

  it("stores the prefix uppercased, keeps the other tickets settings, and reads it back", async () => {
    const orgId = await freshOrg()
    const set = await op(
      orgId,
      "idSegmentSet",
      { by: "audience", codes: { b2b: "b2b", b2c: " B2C " } },
      ["tickets:settings:admin"],
    )
    expect(set.idSegment).toEqual({ by: "audience", codes: { b2b: "B2B", b2c: "B2C" } })
    expect(set.examples).toEqual({
      b2b: "ticket-B2B-123",
      b2c: "ticket-B2C-123",
      withoutCode: "ticket-123",
    })
    expect(set.reindexed).toBe(0)
    const stored = await storedTickets(orgId)
    expect(stored.idSegment).toEqual({ by: "audience", codes: { b2b: "B2B", b2c: "B2C" } })
    expect(stored.sla).toEqual({ firstResponseMinutes: 30 })

    const get = await op(orgId, "idSegmentGet", {}, ["*"])
    expect(get.idSegment).toEqual({ by: "audience", codes: { b2b: "B2B", b2c: "B2C" } })

    const off = await op(orgId, "idSegmentSet", { by: "none" }, ["tickets:settings:admin"])
    expect(off.idSegment).toEqual({ by: "none", codes: {} })
    expect(off.examples).toEqual({ any: "ticket-123" })
  })

  it("refuses a bad or duplicate code with a readable message, and changes nothing", async () => {
    const orgId = await freshOrg()
    for (const params of [
      { by: "audience", codes: { b2b: "B2B!" } },
      { by: "audience", codes: { b2b: "SAME", b2c: "same" } },
      { by: "bogus", codes: {} },
    ]) {
      const r = await op(orgId, "idSegmentSet", params, ["tickets:settings:admin"])
      expect(r.error.code).toBe("invalid_id_segment")
      expect(r.error.message.length).toBeGreaterThan(0)
    }
    expect((await storedTickets(orgId)).idSegment).toBeUndefined()
  })

  it("the preflight refuses a bad code before an approval is parked, and passes a good one", async () => {
    const orgId = await freshOrg()
    const bad = await op(
      orgId,
      "idSegmentSetPreflight",
      { by: "audience", codes: { b2b: "B2B!" } },
      ["tickets:settings:admin"],
    )
    expect(bad.error.code).toBe("invalid_id_segment")
    const good = await op(
      orgId,
      "idSegmentSetPreflight",
      { by: "audience", codes: { b2b: "B2B", b2c: "B2C" } },
      ["tickets:settings:admin"],
    )
    expect(good).toEqual({ ok: true })
    expect((await storedTickets(orgId)).idSegment).toBeUndefined()
  })
})
