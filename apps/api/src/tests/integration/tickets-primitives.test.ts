// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it } from "bun:test"
import { ticketsSettingsDefaults } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { getTicket } from "~/apps/tickets/search"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext, UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { testBridgeAManifest } from "../../../test-support/apps/test-bridge-a/manifest-descriptor"
import { testBridgeBManifest } from "../../../test-support/apps/test-bridge-b/manifest-descriptor"

// Payload shapes the tickets tools return in `result.data` (the API success-envelope `data`), typed
// at the callsite so each read is checked instead of `as any`-cast off `unknown`.
interface TicketCreateData {
  ticketId: string
  ticketHandle: string
}
interface TicketSearchData {
  items: Array<{ id: string }>
}

let orgId: string
let userId: string
let actor: ActorContext

beforeAll(async () => {
  const slug = `tickets-primitives-org-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Tickets Primitives Org', ${slug}) RETURNING id
    `),
  )
  orgId = org.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`tickets-prim-${Date.now()}@test.com`}, 'Tickets Tester', 'active', 'hash', 1, 1) RETURNING id
    `),
  )
  userId = user.id

  await ensureAppsForOrg(orgId, {
    extraApps:
      process.env.NODE_ENV === "production"
        ? [testBridgeAManifest as any, testBridgeBManifest as any]
        : [],
  })
  // Always seed explicitly to make the test independent of auto-seed timing.
  await withSystemDb("tickets-prim-seed", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE kernel.organizations
      SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('tickets', ${JSON.stringify(ticketsSettingsDefaults)}::jsonb)
      WHERE id = ${orgId}
    `)
  })

  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: ["tickets:tickets:read", "tickets:tickets:write"],
    dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
  } as ActorContext
})

async function fetchTicket(id: string): Promise<any> {
  const rows = extractRows<any>(
    await db.execute(
      drizzleSql`SELECT * FROM app_tickets.tickets WHERE id = ${id} AND org_id = ${orgId}`,
    ),
  )
  return rows[0]
}

describe("tickets primitives", () => {
  it("tickets.bridge.scope-inheritance rejects missing inner dependency scope", async () => {
    const bridgeActor: ActorContext = {
      ...actor,
      scopes: ["test-bridge-a:thing:write"],
    } as ActorContext

    await expect(
      executeTool({
        toolName: "test-bridge-a:callB",
        orgId,
        actor: bridgeActor,
        params: { payload: "scope-check" },
      }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it("tickets.bridge.cycle rejects recursive cross-app call chains", async () => {
    const bridgeActor: ActorContext = {
      ...actor,
      scopes: ["test-bridge-a:thing:write", "test-bridge-b:thing:write"],
    } as ActorContext

    await expect(
      executeTool({
        toolName: "test-bridge-a:callB",
        orgId,
        actor: bridgeActor,
        params: { cycle: true },
      }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it("tickets.bridge.call-chain-limit rejects excessive recursion depth", async () => {
    const bridgeActor: ActorContext = {
      ...actor,
      scopes: ["test-bridge-a:thing:write"],
    } as ActorContext

    await expect(
      executeTool({
        toolName: "test-bridge-a:recurse",
        orgId,
        actor: bridgeActor,
        params: { depth: 0 },
      }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it("creates a ticket with reply_token, sla fields, and ticket-N handle", async () => {
    const result = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject: "Help me", channel: "manual", priority: "urgent" },
    })
    expect(result.blocked).toBeUndefined()
    const data = result.data
    expect(data.ticketHandle).toMatch(/^ticket-\d+$/)
    const t = await fetchTicket(data.ticketId)
    expect(t.reply_token).toMatch(/^[A-Z2-7]{16}$/)
    expect(t.sla_target_seconds).toBe(3600)
    expect(new Date(t.sla_deadline).getTime()).toBeGreaterThan(Date.now())
    expect(t.sla_active_started_at).not.toBeNull()
  })

  // BL-91 regression: a weak model promoting a thread/mail complaint into a ticket often
  // passes the customer's reported text as a BARE STRING for `initialMessage` (reading
  // "put the complaint detail in initialMessage"), which previously 400'd at ajv
  // ("initialMessage must be an object"). The manifest now accepts string|object and the
  // handler normalizes a string into an inbound message — so the natural call SUCCEEDS and
  // seeds the complaint as the first inbound message.
  it("creates a ticket when initialMessage is passed as a bare string (weak-model shape)", async () => {
    const complaint =
      "CV-expander outputs on the Modular Bundle are completely dead — no CV out on any of the four jacks after the latest firmware."
    const result = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Modular Bundle CV expander dead outputs",
        channel: "manual",
        priority: "high",
        initialMessage: complaint,
      },
    })
    expect(result.blocked).toBeUndefined()
    const data = result.data
    expect(data.ticketHandle).toMatch(/^ticket-\d+$/)
    const rows = extractRows<{ kind: string; text_body: string }>(
      await db.execute(
        drizzleSql`SELECT kind, text_body FROM app_tickets.messages WHERE org_id = ${orgId} AND ticket_id = ${data.ticketId}`,
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe("inbound")
    expect(rows[0]!.text_body).toBe(complaint)
  })

  // BL-91 repro/regression: a weak model often emits an EMPTY-STRING `team` on
  // tickets:create rather than omitting it. Under a scoped team dimension the
  // empty-string team isn't in the grant list, so the INSERT row failed the team
  // WITH CHECK → opaque HTTP 500 — the real cause behind the "flaky on the
  // contact-link step" park. An empty team must be coerced to NULL so the natural
  // call succeeds (an empty/unspecified team means "no team", always allowed).
  it("creates a ticket when team is an empty string under a scoped team grant", async () => {
    const scopedActor: ActorContext = {
      actorType: "user",
      userId,
      orgId,
      scopes: ["tickets:tickets:read", "tickets:tickets:write"],
      dimensionGrants: { team: ["support-eu"], sensitivity: ["restricted"] },
    } as ActorContext
    const result = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor: scopedActor,
      params: {
        subject: "Modular Bundle CV expander dead outputs",
        channel: "manual",
        priority: "high",
        team: "",
        initialMessage: { kind: "inbound", textBody: "no CV out on any of the four jacks" },
      },
    })
    expect(result.blocked).toBeUndefined()
    const data = result.data
    expect(data.ticketHandle).toMatch(/^ticket-\d+$/)
    const t = await fetchTicket(data.ticketId)
    expect(t.team).toBeNull()
  })

  it("setStatus open -> awaiting_customer pauses SLA", async () => {
    const create = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject: "Pause SLA", channel: "manual", priority: "high" },
    })
    const ticketId = create.data.ticketId
    await executeTool({
      toolName: "tickets:setStatus",
      orgId,
      actor,
      params: { ticketId, status: "awaiting_customer" },
    })
    const after = await fetchTicket(ticketId)
    expect(after.status).toBe("awaiting_customer")
    expect(after.sla_paused_at).not.toBeNull()
    expect(after.sla_active_started_at).toBeNull()
  })

  it("setStatus open -> closed rejects with invalid_transition", async () => {
    const create = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject: "Reject closed transition", channel: "manual" },
    })
    const ticketId = create.data.ticketId
    await expect(
      executeTool({
        toolName: "tickets:setStatus",
        orgId,
        actor,
        params: { ticketId, status: "closed" },
      }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it("tickets.rls.team-isolation filters tickets and inherited messages", async () => {
    const euTicketId = crypto.randomUUID()
    const usTicketId = crypto.randomUUID()
    await withSystemDb("tickets-rls-fixture", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, team, sensitivity,
          reply_token, sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
          message_count, created_at, updated_at
        ) VALUES
          (${euTicketId}, ${orgId}, ${`ticket-eu-${Date.now()}`}, 'EU ticket', 'open', 'normal', 'manual', 'support-eu', 'internal', ${`EU${Date.now()}`}, 3600, now() + interval '1 hour', now(), 0, 1, now(), now()),
          (${usTicketId}, ${orgId}, ${`ticket-us-${Date.now()}`}, 'US ticket', 'open', 'normal', 'manual', 'support-us', 'internal', ${`US${Date.now()}`}, 3600, now() + interval '1 hour', now(), 0, 1, now(), now())
      `)
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, text_body, sent_at, created_at, updated_at)
        VALUES
          (gen_random_uuid(), ${orgId}, ${euTicketId}, 'note', 'eu', now(), now(), now()),
          (gen_random_uuid(), ${orgId}, ${usTicketId}, 'note', 'us', now(), now(), now())
      `)
    })

    const euActor: UserContext = {
      actorType: "user",
      userId,
      orgId,
      scopes: ["tickets:tickets:read"],
      dimensionGrants: { team: ["support-eu"], sensitivity: ["restricted"] },
    }
    const search = await executeTool<TicketSearchData>({
      toolName: "tickets:search",
      orgId,
      actor: euActor,
      params: { includeMerged: true, limit: 100 },
    })
    const ids = search.data.items.map((item) => item.id)
    expect(ids).toContain(euTicketId)
    expect(ids).not.toContain(usTicketId)

    const messageRows = await withRlsContext(
      {
        ...euActor,
        scopes: [...euActor.scopes, "tickets:messages:read"],
        dimensionGrants: {
          ...euActor.dimensionGrants,
          "tickets:team": euActor.dimensionGrants.team,
          "tickets:sensitivity": euActor.dimensionGrants.sensitivity,
        },
      } as ActorContext,
      async (tx) =>
        extractRows<{ ticket_id: string }>(
          await tx.execute(
            drizzleSql`SELECT ticket_id FROM app_tickets.messages WHERE org_id = ${orgId}`,
          ),
        ),
    )
    expect(messageRows.map((row) => row.ticket_id)).toContain(euTicketId)
    expect(messageRows.map((row) => row.ticket_id)).not.toContain(usTicketId)
  })

  it("tickets.merge.happy-path copies messages and closes source", async () => {
    const target = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject: "Merge target", channel: "manual" },
    })
    const source = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Merge source",
        channel: "manual",
        initialMessage: { kind: "note", textBody: "source history" },
      },
    })
    const targetTicketId = target.data.ticketId
    const sourceTicketId = source.data.ticketId

    const merge = await executeTool({
      toolName: "tickets:merge",
      orgId,
      actor,
      params: { targetTicketId, sourceTicketIds: [sourceTicketId] },
    })

    expect(merge.data).toMatchObject({
      targetTicketId,
      mergedSourceCount: 1,
      copiedMessageCount: 1,
    })
    const sourceAfter = await fetchTicket(sourceTicketId)
    expect(sourceAfter.status).toBe("closed")
    expect(sourceAfter.closed_reason).toBe("merged")
    expect(sourceAfter.merged_into_ticket_id).toBe(targetTicketId)

    const rows = extractRows<{ ticket_id: string; text_body: string }>(
      await db.execute(
        drizzleSql`SELECT ticket_id, text_body FROM app_tickets.messages WHERE org_id = ${orgId} AND text_body = 'source history'`,
      ),
    )
    expect(rows.map((row) => row.ticket_id)).toContain(sourceTicketId)
    expect(rows.map((row) => row.ticket_id)).toContain(targetTicketId)
  })

  it("tickets.get with an empty org GUC returns an empty result instead of throwing", async () => {
    const created = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject: "Empty org GUC probe", channel: "manual" },
    })
    const emptyOrgActor = { ...actor, orgId: "" } as ActorContext
    // current_setting('app.current_org_id', true) returns '' (not NULL) with no RLS
    // context set — the org-condition cast in contacts_org_rls / categories_select /
    // can_read_ticket must filter to zero rows (NULLIF), never throw SQLSTATE 22P02.
    const result = await withRlsContext(emptyOrgActor, (tx) =>
      getTicket(tx, orgId, { ticketId: created.data.ticketId }),
    )
    if ("error" in result) throw new Error(`unexpected typed error: ${result.error.code}`)
    expect(result.ticket).toBeNull()
  })
})
