// SPDX-License-Identifier: FSL-1.1-ALv2
// Ticket display ids `ticket-<CODE>-<n>` (S18-S21, A3, A13, A21, A22).
//
// The stored handle stays `ticket-<n>`. The display is computed from the
// ticket's CURRENT segment field value, and every input form resolves by the
// number: `ticket-B2C-12` finds the ticket stored as `ticket-12` even after
// it was reclassified B2B.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import {
  displayHandleFor,
  displayHandlesByIds,
  loadSegmentConfig,
  stripHandleTags,
} from "~/apps/tickets/display-handle"
import { processInboundMessage } from "~/apps/tickets/inbound"
import { resolveTicketRef } from "~/apps/tickets/resolve-ticket-ref"
import { renameTeam } from "~/apps/tickets/teams"
import { extractRows, type PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { type ActorContext, withRlsContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId = ""
let userId = ""
let inboxId = ""
const seq = 700_000_000 + Math.floor(Math.random() * 1e8)
const ids: Record<string, string> = {}

async function sys<T>(fn: (tx: PrivilegedDb) => Promise<T>): Promise<T> {
  return withSystemDb("display-handle-test", fn)
}

async function setSegment(value: unknown): Promise<void> {
  await sys((tx) =>
    tx.execute(drizzleSql`
      UPDATE kernel.organizations
      SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{tickets}',
        COALESCE(settings->'tickets', '{}'::jsonb) || jsonb_build_object('idSegment', ${JSON.stringify(value)}::jsonb), true)
      WHERE id = ${orgId}
    `),
  )
}

// A subject handle threads a message only from the ticket's requester or a
// participant; the inbound mails below come from this requester.
const REQUESTER = "jean@customer.test"

async function seedTicket(
  key: string,
  handle: string,
  fields: { audience?: string; team?: string },
) {
  const id = crypto.randomUUID()
  ids[key] = id
  await sys((tx) =>
    tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity, audience, team,
        reply_token, sla_target_seconds, sla_deadline, source_inbox_id, created_at, updated_at,
        requester_email
      ) VALUES (
        ${id}, ${orgId}, ${handle}, ${`Subject ${key}`}, 'open', 'normal', 'email', 'internal',
        ${fields.audience ?? null}, ${fields.team ?? null},
        ${`RT${key}${seq}`}, 3600, now() + interval '1 hour', ${inboxId}, now(), now(),
        ${REQUESTER}
      )
    `),
  )
  return id
}

beforeAll(async () => {
  const slug = `display-handle-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  orgId = await sys(
    async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'Seg', ${slug}) RETURNING id
      `),
      )[0]!.id,
  )
  // The tickets app's own schema (audience, team, ...) is installed per org,
  // as teams.test.ts does: this file must not rely on another one running first.
  await ensureAppsForOrg(orgId, {})
  await sys(async (tx) => {
    userId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@test.com`}, 'U', 'active', 'h', 1, 1) RETURNING id
      `),
    )[0]!.id
    inboxId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address, default_sensitivity, is_default_for_create, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, gen_random_uuid(), 'In', ${`in-${slug}@x.test`}, 'internal', true, now(), now())
        RETURNING id
      `),
    )[0]!.id
  })
  await setSegment({ by: "audience", codes: { b2b: "B2B", b2c: "B2C" } })
  await seedTicket("b2b", `ticket-${seq}`, { audience: "b2b" })
  await seedTicket("plain", `ticket-${seq + 1}`, {})
  // A stored handle that is not `ticket-<n>` (test fixtures, A21): exact match.
  await seedTicket("odd", `ticket-${seq}-77`, { audience: "b2b" })
})

afterAll(async () => {
  await sys((tx) => tx.execute(drizzleSql`DELETE FROM app_tickets.tickets WHERE org_id = ${orgId}`))
})

describe("segment config", () => {
  it("is read under a real RLS context (organizations refuses RLS reads)", async () => {
    const actor = {
      actorType: "user",
      userId,
      orgId,
      scopes: ["tickets:tickets:read"],
      dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
    } as ActorContext
    const cfg = await withRlsContext(actor, async () => loadSegmentConfig(orgId))
    expect(cfg).toEqual({ by: "audience", codes: { b2b: "B2B", b2c: "B2C" } })
  })

  it("a malformed stored config reads as not segmenting", async () => {
    await setSegment({ by: "audience", codes: { b2b: "not a code!" } })
    expect(await loadSegmentConfig(orgId)).toEqual({ by: "none", codes: {} })
    await setSegment({ by: "audience", codes: { b2b: "B2B", b2c: "B2C" } })
  })
})

describe("display handles", () => {
  it("follow the CURRENT field value; the number never changes", async () => {
    await sys(async (db) => {
      expect(await displayHandleFor(db, orgId, ids.b2b!)).toBe(`ticket-B2B-${seq}`)
      expect(await displayHandleFor(db, orgId, ids.plain!)).toBe(`ticket-${seq + 1}`)
      expect(await displayHandleFor(db, orgId, ids.odd!)).toBe(`ticket-${seq}-77`)
    })
    await sys((db) =>
      db.execute(
        drizzleSql`UPDATE app_tickets.tickets SET audience = 'b2c' WHERE id = ${ids.b2b!}`,
      ),
    )
    const m = await sys((db) => displayHandlesByIds(db, orgId, [ids.b2b!, ids.plain!]))
    expect(m.get(ids.b2b!)).toBe(`ticket-B2C-${seq}`)
    expect(m.get(ids.plain!)).toBe(`ticket-${seq + 1}`)
    await sys((db) =>
      db.execute(
        drizzleSql`UPDATE app_tickets.tickets SET audience = 'b2b' WHERE id = ${ids.b2b!}`,
      ),
    )
  })

  it("a removed code falls back to ticket-<n>", async () => {
    await setSegment({ by: "audience", codes: { b2c: "B2C" } })
    expect(await sys((db) => displayHandleFor(db, orgId, ids.b2b!))).toBe(`ticket-${seq}`)
    await setSegment({ by: "audience", codes: { b2b: "B2B", b2c: "B2C" } })
  })
})

describe("resolveTicketRef accepts every handle form", () => {
  const resolve = (v: string) => sys((db) => resolveTicketRef(db, orgId, v))

  it("ticket-<n>, ticket-<SEG>-<n>, a stale segment, any case", async () => {
    for (const v of [
      `ticket-${seq}`,
      `ticket-B2B-${seq}`,
      `TICKET-b2b-${seq}`,
      // stale: the ticket is B2B now, the old id still resolves by number
      `ticket-B2C-${seq}`,
      `ticket-ANYTHING-${seq}`,
      `  ticket-B2B-${seq} `,
    ]) {
      expect(await resolve(v)).toEqual({ ok: true, ticketId: ids.b2b! })
    }
  })

  it("an exact stored handle wins, so a non-`ticket-<n>` handle still resolves", async () => {
    expect(await resolve(`ticket-${seq}-77`)).toEqual({ ok: true, ticketId: ids.odd! })
  })

  it("unknown numbers and garbage are typed errors", async () => {
    const miss = await resolve(`ticket-B2B-${seq + 99}`)
    expect(miss.ok).toBe(false)
    if (!miss.ok) expect(miss.error.code).toBe("not_found")
    const bad = await resolve("ticket-")
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe("invalid_params")
  })
})

describe("inbound threads every handle form onto the same ticket (S21)", () => {
  const inboxRow = () => ({ id: inboxId, org_id: orgId, email_address: "support@seg.test" })
  let n = 0
  const email = (subject: string) => {
    n += 1
    return {
      messageId: `<seg-${n}-${Date.now()}@customer.test>`,
      inReplyTo: null,
      references: [],
      from: { email: REQUESTER, name: "Jean" },
      to: [{ email: "support@seg.test" }],
      cc: [],
      subject,
      textBody: "Merci.",
      htmlBody: null,
      sentAt: new Date().toISOString(),
      headers: {},
    } as never
  }
  const run = (subject: string) =>
    sys((tx) =>
      processInboundMessage(email(subject), inboxRow() as never, { orgId, db: tx as never }),
    )

  it("an old subject [#ticket-<n>] and a new one [#ticket-B2B-<n>] both append", async () => {
    const old = await run(`Re: Subject b2b [#ticket-${seq}]`)
    expect(old).toMatchObject({ outcome: "appended", ticketId: ids.b2b! })
    const seg = await run(`Re: Subject b2b [#ticket-B2B-${seq}]`)
    expect(seg).toMatchObject({ outcome: "appended", ticketId: ids.b2b! })
    const stale = await run(`Re: Subject b2b [#ticket-b2c-${seq}]`)
    expect(stale).toMatchObject({ outcome: "appended", ticketId: ids.b2b! })
  })
})

describe("stripHandleTags (A13)", () => {
  it("removes every form naming the same number, and only it", () => {
    expect(stripHandleTags("Re: Hello [#ticket-12]", "ticket-B2B-12")).toBe("Re: Hello")
    expect(stripHandleTags("Re: Hello [#ticket-B2C-12] [#ticket-12]", "ticket-12")).toBe(
      "Re: Hello",
    )
    expect(stripHandleTags("Re: Hello [#ticket-120]", "ticket-12")).toBe("Re: Hello [#ticket-120]")
    expect(stripHandleTags("Re: Hello [#ticket-3]", "ticket-12")).toBe("Re: Hello [#ticket-3]")
  })
})

describe("team rename moves the segment codes (A22)", () => {
  it("onto a free name moves the code; onto an existing team keeps the target's", async () => {
    await seedTicket("ops", `ticket-${seq + 10}`, { team: "Ops" })
    await seedTicket("sales", `ticket-${seq + 11}`, { team: "Sales" })
    await seedTicket("support", `ticket-${seq + 12}`, { team: "Support" })
    await setSegment({ by: "team", codes: { Ops: "OPS", Sales: "SAL", Support: "SUP" } })

    await sys((db) => renameTeam(db, orgId, { from: "Ops", to: "Operations" }))
    expect(await loadSegmentConfig(orgId)).toEqual({
      by: "team",
      codes: { Operations: "OPS", Sales: "SAL", Support: "SUP" },
    })
    expect(await sys((db) => displayHandleFor(db, orgId, ids.ops!))).toBe(`ticket-OPS-${seq + 10}`)

    await sys((db) => renameTeam(db, orgId, { from: "Sales", to: "Support" }))
    expect(await loadSegmentConfig(orgId)).toEqual({
      by: "team",
      codes: { Operations: "OPS", Support: "SUP" },
    })
    expect(await sys((db) => displayHandleFor(db, orgId, ids.sales!))).toBe(
      `ticket-SUP-${seq + 11}`,
    )
    await setSegment({ by: "audience", codes: { b2b: "B2B", b2c: "B2C" } })
  })

  // The code move is part of the rename's OUTCOME: it commits with the rename
  // and rolls back with it. It used to commit on its own privileged
  // connection, so a rename that failed afterwards still moved the code.
  const renamer = () =>
    ({
      actorType: "user",
      userId,
      orgId,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    }) as ActorContext

  it("a rename that rolls back leaves the codes unchanged", async () => {
    await seedTicket("rbA", `ticket-${seq + 40}`, { team: "Alpha" })
    await setSegment({ by: "team", codes: { Alpha: "ALP" } })
    try {
      let renamed: unknown = null
      await expect(
        withRlsContext(renamer(), async (tx) => {
          renamed = await renameTeam(tx, orgId, { from: "Alpha", to: "Beta" })
          throw new Error("the rename's transaction fails after the rename")
        }),
      ).rejects.toThrow("fails after the rename")
      expect(renamed).toMatchObject({ from: "Alpha", to: "Beta", ticketsUpdated: 1 })
      expect(await loadSegmentConfig(orgId)).toEqual({ by: "team", codes: { Alpha: "ALP" } })
    } finally {
      await setSegment({ by: "audience", codes: { b2b: "B2B", b2c: "B2C" } })
    }
  })

  it("a rename that commits under a real RLS context moves the code (A3)", async () => {
    await seedTicket("rbG", `ticket-${seq + 41}`, { team: "Gamma" })
    await setSegment({ by: "team", codes: { Gamma: "GAM" } })
    try {
      const out = await withRlsContext(renamer(), (tx) =>
        renameTeam(tx, orgId, { from: "Gamma", to: "Delta" }),
      )
      expect(out).toMatchObject({ from: "Gamma", to: "Delta", ticketsUpdated: 1 })
      expect(await loadSegmentConfig(orgId)).toEqual({ by: "team", codes: { Delta: "GAM" } })
    } finally {
      await setSegment({ by: "audience", codes: { b2b: "B2B", b2c: "B2C" } })
    }
  })
})

describe("merge accepts every handle form (S20)", () => {
  it("merges by display, stale and plain handles, returning the target uuid", async () => {
    const { mergeTickets } = await import("~/apps/tickets/merge")
    await seedTicket("mtarget", `ticket-${seq + 20}`, { audience: "b2b" })
    await seedTicket("msource", `ticket-${seq + 21}`, { audience: "b2c" })
    const out = await sys((db) =>
      mergeTickets(
        db,
        orgId,
        { targetTicketId: `ticket-B2B-${seq + 20}`, sourceTicketIds: [`ticket-b2b-${seq + 21}`] },
        { actorType: "user", userId },
      ),
    )
    expect(out).toMatchObject({ targetTicketId: ids.mtarget!, mergedSourceCount: 1 })
    const merged = await sys(async (db) =>
      extractRows<{ merged_into_ticket_id: string | null }>(
        await db.execute(
          drizzleSql`SELECT merged_into_ticket_id FROM app_tickets.tickets WHERE id = ${ids.msource!}`,
        ),
      ),
    )
    expect(merged[0]?.merged_into_ticket_id).toBe(ids.mtarget!)
  })

  it("an unknown handle is a typed not_found, never a uuid cast error", async () => {
    const { mergeTickets } = await import("~/apps/tickets/merge")
    const out = await sys((db) =>
      mergeTickets(
        db,
        orgId,
        { targetTicketId: `ticket-B2B-${seq + 9999}`, sourceTicketIds: [`ticket-${seq + 1}`] },
        { actorType: "user", userId },
      ),
    )
    expect(out).toMatchObject({ error: { code: "not_found" } })
  })
})

describe("global search indexes the display handle and the stored one (A12)", () => {
  it("the ticket document's handle is the display form; ticket-<n> stays searchable", async () => {
    const { ensureAppsForOrg } = await import("~/modules/apps/init")
    const { collectSearchableRegistrations } = await import("~/modules/search/searchable-entities")
    const { buildSearchDocument } = await import("~/modules/search/doc-builder")
    const { registerTicketsSearchEnrichment } = await import("~/apps/tickets/search-enrichment")
    await ensureAppsForOrg(orgId, {})
    registerTicketsSearchEnrichment()
    const reg = collectSearchableRegistrations(orgId).entities.find(
      (e) => e.app === "tickets" && e.entityType === "ticket",
    )!
    const row = await sys(async (db) =>
      extractRows<Record<string, unknown>>(
        await db.execute(drizzleSql`SELECT * FROM app_tickets.tickets WHERE id = ${ids.b2b!}`),
      ),
    )
    const doc = await buildSearchDocument(reg, orgId, row[0]!)
    expect(doc.handle).toBe(`ticket-B2B-${seq}`)
    expect(String(doc.body)).toContain(`ticket-${seq}`)

    const plainRow = await sys(async (db) =>
      extractRows<Record<string, unknown>>(
        await db.execute(drizzleSql`SELECT * FROM app_tickets.tickets WHERE id = ${ids.plain!}`),
      ),
    )
    const plainDoc = await buildSearchDocument(reg, orgId, plainRow[0]!)
    expect(plainDoc.handle).toBe(`ticket-${seq + 1}`)
  })
})
