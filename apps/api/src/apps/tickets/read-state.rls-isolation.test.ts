// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { inboxCounts, markRead } from "~/apps/tickets/read-state"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { withCrossOrgTicketFixture, withInboxFixture } from "./read-state.test-fixtures"

type TeamMatrixFixture = {
  orgId: string
  userId: string
  /** keyed `${team ?? "none"}/${sensitivity}` */
  tickets: Record<string, string>
}

const MATRIX_TEAMS = [null, "support-eu", "support-us"] as const
const MATRIX_SENSITIVITIES = ["internal", "confidential", "restricted"] as const

/** One org, one user, one ticket per (team, sensitivity) pair, no read rows. */
async function seedTeamMatrix(label: string): Promise<TeamMatrixFixture> {
  const slug = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const fixture: TeamMatrixFixture = { orgId: "", userId: "", tickets: {} }
  await withSystemDb(`${label}-fixture`, async (tx) => {
    fixture.orgId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Ticket Team Matrix Org', ${slug})
        RETURNING id
      `),
    )[0].id
    fixture.userId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${fixture.orgId}, ${`${slug}@test.com`}, 'Team Matrix', 'active', 'hash', 1, 1)
        RETURNING id
      `),
    )[0].id
    let n = 0
    for (const team of MATRIX_TEAMS) {
      for (const sensitivity of MATRIX_SENSITIVITIES) {
        n++
        fixture.tickets[`${team ?? "none"}/${sensitivity}`] = extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            INSERT INTO app_tickets.tickets (
              id, org_id, handle, subject, status, priority, channel, team, sensitivity,
              reply_token, sla_target_seconds, sla_deadline, sla_active_started_at,
              sla_elapsed_seconds, message_count, last_inbound_at, created_at, updated_at
            ) VALUES (
              gen_random_uuid(), ${fixture.orgId}, ${`ticket-${slug}-${n}`}, 'Matrix', 'open', 'normal', 'manual',
              ${team}, ${sensitivity}, ${`M${n}${slug}`}, 3600, now() + interval '1 hour', now(), 0, 0,
              now() - interval '1 minute', now(), now()
            )
            RETURNING id
          `),
        )[0].id
      }
    }
  })
  await ensureAppsForOrg(fixture.orgId, {})
  return fixture
}

/** The "support" role bundle has no dimension grants: the shape of a plain support member. */
const SUPPORT_SCOPES = ["tickets:tickets:read", "tickets:tickets:write", "tickets:tickets:reply"]

describe("tickets.read-state.rls-isolation", () => {
  it("markRead under RLS rejects tickets outside the actor's org", async () => {
    await withCrossOrgTicketFixture(async ({ orgAActor, orgAUserId, orgBTicketId }) => {
      const out = await withRlsContext(orgAActor, (tx) =>
        markRead(tx as never, {
          ticketId: orgBTicketId,
          userId: orgAUserId,
        }),
      )
      expect("error" in out && out.error.code).toBe("ticket_not_found")
      // No row written cross-org.
      const rows = extractRows<{ count: string }>(
        await withRlsContext(orgAActor, (tx) =>
          tx.execute(
            drizzleSql`SELECT COUNT(*)::text AS count FROM app_tickets.ticket_reads WHERE ticket_id = ${orgBTicketId}`,
          ),
        ),
      )
      expect(Number(rows[0].count)).toBe(0)
    })
  })

  it("markRead under an empty org GUC returns not-found instead of throwing", async () => {
    await withCrossOrgTicketFixture(async ({ orgAActor, orgAUserId, orgAOwnTicketId }) => {
      const emptyOrgActor = { ...orgAActor, orgId: "" }
      const out = await withRlsContext(emptyOrgActor, (tx) =>
        markRead(tx as never, {
          ticketId: orgAOwnTicketId,
          userId: orgAUserId,
        }),
      )
      expect("error" in out && out.error.code).toBe("ticket_not_found")
    })
  })

  it("app_tickets.can_read_ticket tolerates an empty org GUC instead of throwing 22P02", async () => {
    // markRead's own ticket lookup is already NULLIF-guarded (runtime-generated
    // policy), so it short-circuits to ticket_not_found before ever reaching
    // can_read_ticket. This calls the function directly, the same way
    // ticket_reads_modify_self / ticket_reads_select / messages_select invoke it,
    // to prove the function body itself no longer throws on an empty org GUC.
    await withCrossOrgTicketFixture(async ({ orgAActor, orgAOwnTicketId }) => {
      const emptyOrgActor = { ...orgAActor, orgId: "" }
      const rows = await withRlsContext(emptyOrgActor, async (tx) =>
        extractRows<{ ok: boolean }>(
          await tx.execute(
            drizzleSql`SELECT app_tickets.can_read_ticket(${orgAOwnTicketId}::uuid) AS ok`,
          ),
        ),
      )
      expect(rows[0].ok).toBe(false)
    })
  })

  it("markRead under RLS succeeds for tickets the actor owns", async () => {
    await withCrossOrgTicketFixture(async ({ orgAActor, orgAUserId, orgAOwnTicketId }) => {
      const out = await withRlsContext(orgAActor, (tx) =>
        markRead(tx as never, {
          ticketId: orgAOwnTicketId,
          userId: orgAUserId,
        }),
      )
      expect("error" in out).toBe(false)
      if ("error" in out) return
      expect(out.readAt).toBeTruthy()
    })
  })

  it("ticket_reads select only exposes rows for dimension-visible tickets", async () => {
    const slug = `readstate-visibility-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    let orgId = ""
    let userId = ""
    let visibleTicketId = ""
    let hiddenTicketId = ""
    await withSystemDb("read-state-visibility-fixture", async (tx) => {
      const orgRows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'Read State Visibility Org', ${slug})
          RETURNING id
        `),
      )
      orgId = orgRows[0].id
      const userRows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}, ${`rs-vis-${slug}@test.com`}, 'RS Visibility', 'active', 'hash', 1, 1)
          RETURNING id
        `),
      )
      userId = userRows[0].id
      const ticketRows = extractRows<{ id: string; sensitivity: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO app_tickets.tickets (
            id, org_id, handle, subject, status, priority, channel, sensitivity,
            reply_token, sla_target_seconds, sla_deadline, sla_active_started_at,
            sla_elapsed_seconds, message_count, created_at, updated_at
          ) VALUES
            (gen_random_uuid(), ${orgId}, ${`ticket-${slug}-visible`}, 'Visible', 'open', 'normal', 'manual', 'internal', ${`V${slug}`}, 3600, now() + interval '1 hour', now(), 0, 0, now(), now()),
            (gen_random_uuid(), ${orgId}, ${`ticket-${slug}-hidden`}, 'Hidden', 'open', 'normal', 'manual', 'restricted', ${`H${slug}`}, 3600, now() + interval '1 hour', now(), 0, 0, now(), now())
          RETURNING id, sensitivity
        `),
      )
      visibleTicketId = ticketRows.find((row) => row.sensitivity === "internal")!.id
      hiddenTicketId = ticketRows.find((row) => row.sensitivity === "restricted")!.id
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.ticket_reads (ticket_id, user_id, org_id, read_at)
        VALUES (${visibleTicketId}, ${userId}, ${orgId}, now()), (${hiddenTicketId}, ${userId}, ${orgId}, now())
      `)
    })
    await ensureAppsForOrg(orgId, {})

    const rows = await withRlsContext(
      {
        actorType: "user",
        userId,
        orgId,
        scopes: ["tickets:tickets:read"],
        dimensionGrants: {
          "tickets:team": ["*"],
          "tickets:sensitivity": ["internal"],
        },
      },
      async (tx) =>
        extractRows<{ ticket_id: string }>(
          await tx.execute(drizzleSql`
            SELECT ticket_id FROM app_tickets.ticket_reads ORDER BY ticket_id
          `),
        ),
    )
    const ids = rows.map((row) => row.ticket_id)
    expect(ids).toContain(visibleTicketId)
    expect(ids).not.toContain(hiddenTicketId)
  })

  it("markRead succeeds on a ticket with no team for a reader holding no tickets:team grant", async () => {
    const fx = await seedTeamMatrix("readstate-team-null")
    const actor = {
      actorType: "user" as const,
      userId: fx.userId,
      orgId: fx.orgId,
      scopes: SUPPORT_SCOPES,
      dimensionGrants: {},
    }
    const out = await withRlsContext(actor, (tx) =>
      markRead(tx as never, { ticketId: fx.tickets["none/internal"], userId: fx.userId }),
    )
    expect("error" in out).toBe(false)
    const rows = extractRows<{ ticket_id: string }>(
      await withRlsContext(actor, (tx) =>
        tx.execute(drizzleSql`SELECT ticket_id FROM app_tickets.ticket_reads`),
      ),
    )
    expect(rows.map((r) => r.ticket_id)).toEqual([fx.tickets["none/internal"]])
  })

  it("a reader still cannot mark read a ticket whose team they lack", async () => {
    const fx = await seedTeamMatrix("readstate-team-other")
    const actor = {
      actorType: "user" as const,
      userId: fx.userId,
      orgId: fx.orgId,
      scopes: SUPPORT_SCOPES,
      dimensionGrants: { "tickets:team": ["support-eu"] },
    }
    const otherTeamTicket = fx.tickets["support-us/internal"]
    const out = await withRlsContext(actor, (tx) =>
      markRead(tx as never, { ticketId: otherTeamTicket, userId: fx.userId }),
    )
    expect("error" in out && out.error.code).toBe("ticket_not_found")
    // The ticket_reads write policy refuses the row on its own, too.
    await expect(
      withRlsContext(actor, (tx) =>
        tx.execute(drizzleSql`
          INSERT INTO app_tickets.ticket_reads (ticket_id, user_id, org_id, read_at)
          VALUES (${otherTeamTicket}, ${fx.userId}, ${fx.orgId}, now())
        `),
      ),
    ).rejects.toThrow()
    // Its own team and team-less tickets stay markable.
    for (const key of ["support-eu/internal", "none/internal"]) {
      const ok = await withRlsContext(actor, (tx) =>
        markRead(tx as never, { ticketId: fx.tickets[key], userId: fx.userId }),
      )
      expect("error" in ok).toBe(false)
    }
  })

  it("app_tickets.can_read_ticket agrees with the tickets select policy over a team x grant matrix", async () => {
    const fx = await seedTeamMatrix("readstate-parity")
    const grantSets: Array<{ scopes: string[]; dims: Record<string, string[]> }> = [
      { scopes: SUPPORT_SCOPES, dims: {} },
      { scopes: ["tickets:tickets:read"], dims: { "tickets:team": ["support-eu"] } },
      { scopes: ["tickets:tickets:read"], dims: { "tickets:team": ["*"] } },
      { scopes: ["tickets:tickets:read"], dims: { "tickets:sensitivity": ["confidential"] } },
      {
        scopes: ["tickets:tickets:read"],
        dims: { "tickets:team": ["support-eu"], "tickets:sensitivity": ["restricted"] },
      },
      { scopes: ["tickets:tickets:read"], dims: { "*": ["*"] } },
      { scopes: ["tickets:*"], dims: { "tickets:team": ["support-us"] } },
      { scopes: ["mail:messages:read"], dims: { "*": ["*"] } },
    ]
    let visibleSomewhere = 0
    for (const grant of grantSets) {
      const rows = await withRlsContext(
        {
          actorType: "user",
          userId: fx.userId,
          orgId: fx.orgId,
          scopes: grant.scopes,
          dimensionGrants: grant.dims,
        },
        async (tx) => {
          const visible = new Set(
            extractRows<{ id: string }>(
              await tx.execute(drizzleSql`SELECT id FROM app_tickets.tickets`),
            ).map((r) => r.id),
          )
          const out: Array<{ key: string; visible: boolean; canRead: boolean }> = []
          for (const [key, id] of Object.entries(fx.tickets)) {
            const canRead = extractRows<{ ok: boolean }>(
              await tx.execute(drizzleSql`SELECT app_tickets.can_read_ticket(${id}::uuid) AS ok`),
            )[0].ok
            out.push({ key, visible: visible.has(id), canRead })
          }
          return out
        },
      )
      for (const row of rows) {
        if (row.visible) visibleSomewhere++
        expect({
          grant: grant.dims,
          scopes: grant.scopes,
          key: row.key,
          canRead: row.canRead,
        }).toEqual({
          grant: grant.dims,
          scopes: grant.scopes,
          key: row.key,
          canRead: row.visible,
        })
      }
    }
    // The matrix must exercise both outcomes, or parity proves nothing.
    expect(visibleSomewhere).toBeGreaterThan(0)
    expect(visibleSomewhere).toBeLessThan(grantSets.length * Object.keys(fx.tickets).length)
  })

  it("inboxCounts under RLS omits inboxes from other orgs", async () => {
    await withInboxFixture(
      { otherOrgInbox: true },
      async ({ userId, orgId, inboxA, inboxB, otherOrgInboxId }) => {
        const out = await withRlsContext(
          {
            actorType: "user",
            userId,
            orgId,
            scopes: ["tickets:tickets:read", "tickets:inboxes:read"],
            dimensionGrants: {
              team: ["*"],
              sensitivity: ["restricted"],
              "tickets:team": ["*"],
              "tickets:sensitivity": ["restricted"],
            },
          },
          (tx) => inboxCounts(tx as never, {}),
        )
        const ids = out.counts.map((c) => c.inboxId)
        expect(ids).toContain(inboxA)
        expect(ids).toContain(inboxB)
        expect(ids).not.toContain(otherOrgInboxId)
      },
    )
  })

  it("inboxCounts totalUnread counts every visible unread ticket, inbox or not, own org only", async () => {
    // The walk: the "All" badge summed per-inbox counts and read 4 over a list
    // of many more unread tickets, because tickets with no source inbox (JSM
    // import, API, agent-created) belong to no inbox row.
    await withInboxFixture(
      { otherOrgInbox: true, orphanUnread: true },
      async ({ userId, orgId, inboxA, inboxB }) => {
        const out = await withRlsContext(
          {
            actorType: "user",
            userId,
            orgId,
            scopes: ["tickets:tickets:read", "tickets:inboxes:read"],
            dimensionGrants: {
              team: ["*"],
              sensitivity: ["restricted"],
              "tickets:team": ["*"],
              "tickets:sensitivity": ["restricted"],
            },
          },
          (tx) => inboxCounts(tx as never, {}),
        )
        const sum = out.counts.reduce((a, c) => a + c.unread, 0)
        expect(out.counts.find((c) => c.inboxId === inboxA)?.unread).toBe(2)
        expect(out.counts.find((c) => c.inboxId === inboxB)?.unread).toBe(1)
        expect(sum).toBe(3)
        // 2 (A) + 1 (B) + 1 with no inbox; the other org's unread is not visible.
        expect(out.totalUnread).toBe(4)
      },
    )
  })

  it("inboxCounts per-inbox rows skip merged tickets, as totalUnread does, so the rows never exceed it", async () => {
    // The web's "no inbox" row is totalUnread minus the per-inbox rows. A merged
    // ticket counted in its inbox row but not in the total made that sum lie.
    await withInboxFixture(
      { orphanUnread: true, mergedUnread: true },
      async ({ userId, orgId, inboxB }) => {
        const out = await withRlsContext(
          {
            actorType: "user",
            userId,
            orgId,
            scopes: ["tickets:tickets:read", "tickets:inboxes:read"],
            dimensionGrants: {
              team: ["*"],
              sensitivity: ["restricted"],
              "tickets:team": ["*"],
              "tickets:sensitivity": ["restricted"],
            },
          },
          (tx) => inboxCounts(tx as never, {}),
        )
        expect(out.counts.find((c) => c.inboxId === inboxB)?.unread).toBe(1)
        const sum = out.counts.reduce((a, c) => a + c.unread, 0)
        expect(out.totalUnread).toBe(4)
        expect(out.totalUnread! - sum).toBe(1)
      },
    )
  })

  it("inboxCounts omits totalUnread when scoped to specific inboxes", async () => {
    await withInboxFixture({ orphanUnread: true }, async ({ userId, orgId, inboxA }) => {
      const out = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: ["tickets:tickets:read", "tickets:inboxes:read"],
          dimensionGrants: {
            team: ["*"],
            sensitivity: ["restricted"],
            "tickets:team": ["*"],
            "tickets:sensitivity": ["restricted"],
          },
        },
        (tx) => inboxCounts(tx as never, { inboxIds: [inboxA] }),
      )
      expect(out.totalUnread).toBeUndefined()
    })
  })

  it("executeTool('tickets:markRead') rejects cross-org ticketId with ticket_not_found", async () => {
    await withCrossOrgTicketFixture(async ({ orgAActor, orgAId, orgBTicketId }) => {
      await expect(
        executeTool({
          toolName: "tickets:markRead",
          orgId: orgAId,
          actor: orgAActor,
          params: { ticketId: orgBTicketId },
        }),
      ).rejects.toMatchObject({ code: "ticket_not_found" })
    })
  })

  it("inboxCounts under RLS includes empty inboxes (zero unread)", async () => {
    await withInboxFixture({ noInbound: true }, async ({ userId, orgId, inboxA, inboxB }) => {
      const out = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: ["tickets:tickets:read", "tickets:inboxes:read"],
          dimensionGrants: {
            team: ["*"],
            sensitivity: ["restricted"],
            "tickets:team": ["*"],
            "tickets:sensitivity": ["restricted"],
          },
        },
        (tx) => inboxCounts(tx as never, {}),
      )
      // inboxB has zero tickets at all — it should still appear with unread=0.
      const b = out.counts.find((c) => c.inboxId === inboxB)
      expect(b).toBeTruthy()
      expect(b?.unread).toBe(0)
      // inboxA has tickets but none with inbound — also zero unread.
      const a = out.counts.find((c) => c.inboxId === inboxA)
      expect(a?.unread).toBe(0)
    })
  })
})
