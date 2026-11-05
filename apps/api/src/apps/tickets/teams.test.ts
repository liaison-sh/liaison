// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { backlogHealth } from "~/apps/tickets/backlog-health"
import { listTeams, renameTeam, setTeam } from "~/apps/tickets/teams"
import { extractRows, type PrivilegedDb } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"

const sqlDb = db as unknown as PrivilegedDb

interface SeedTicket {
  team: string | null
  status?: "open" | "awaiting_customer" | "awaiting_followup" | "closed"
  merged?: boolean
  subject?: string
}

interface Fixture {
  orgId: string
  inboxId: string
  ticketIds: string[]
  teamsOf: (orgId: string) => Promise<Array<{ team: string | null; n: number }>>
}

/**
 * A desk whose team labels are deliberately MESSY: the same site spelled three
 * ways, plus a leading space. That is what a real free-text dimension looks
 * like after two integrations and a migration have each written it their own
 * way, and it is the only interesting input to a rename.
 */
async function withTeamsFixture<T>(
  tickets: SeedTicket[],
  fn: (f: Fixture) => Promise<T>,
): Promise<T> {
  const slug = `teams-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Teams Org', ${slug}) RETURNING id
    `),
  )
  const orgId = org.id
  await ensureAppsForOrg(orgId, {})

  let inboxId = ""
  const ticketIds: string[] = []
  await withSystemDb("teams-fixture", async (tx) => {
    // kind='api': a receiving bucket with no mail account. A 'mailbox' inbox
    // would violate inboxes_kind_shape_check without a connected account.
    const [inbox] = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes
          (id, org_id, kind, name, default_sensitivity, is_default_for_create, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, 'api', 'Desk', 'internal', false, now(), now())
        RETURNING id
      `),
    )
    inboxId = inbox.id

    let seq = 0
    const insert = async (t: SeedTicket, mergedInto: string | null): Promise<string> => {
      const handle = `tm-${slug}-${seq}`
      const replyToken = `TMT${slug.slice(-6)}${seq.toString().padStart(4, "0")}`
      seq++
      const [row] = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO app_tickets.tickets (
            id, org_id, handle, subject, status, priority, channel, sensitivity,
            team, merged_into_ticket_id,
            reply_token, sla_target_seconds, sla_elapsed_seconds, message_count,
            created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${orgId}, ${handle}, ${t.subject ?? handle},
            ${t.status ?? "open"}, 'normal', 'manual', 'internal',
            ${t.team}, ${mergedInto}::uuid,
            ${replyToken}, 3600, 0, 1, now(), now()
          ) RETURNING id
        `),
      )
      return row.id
    }

    // merged_into_ticket_id is a real FK, so a merged-away row needs a real
    // survivor to point at. Create one only when the fixture asks for a merge;
    // it carries no team, so it never shows up in a team assertion.
    const mergeTarget = tickets.some((t) => t.merged)
      ? await insert({ team: null, subject: "merge target" }, null)
      : null

    for (const t of tickets) {
      ticketIds.push(await insert(t, t.merged ? mergeTarget : null))
    }
  })

  // Teams only — the fixture's untagged rows (including any merge target) are
  // not part of what these assertions are about.
  const teamsOf = async (id: string) =>
    extractRows<{ team: string | null; n: string }>(
      await db.execute(drizzleSql`
        SELECT team, COUNT(*) AS n FROM app_tickets.tickets
        WHERE org_id = ${id} AND team IS NOT NULL AND team <> ''
        GROUP BY team ORDER BY team
      `),
    ).map((r) => ({ team: r.team, n: Number(r.n) }))

  return fn({ orgId, inboxId, ticketIds, teamsOf })
}

describe("tickets teams — listTeams", () => {
  it("groups by team with live and lifetime counts, ignoring null and blank labels", async () => {
    await withTeamsFixture(
      [
        { team: "Alpha" },
        { team: "Alpha", status: "awaiting_customer" },
        // Closed and merged-away tickets still COUNT toward the team's history
        // but are not live work — the menu badge must not promise otherwise.
        { team: "Alpha", status: "closed" },
        { team: "Alpha", merged: true },
        { team: "Beta" },
        // Neither of these is a team; both are how "unset" gets written in practice.
        { team: null },
        { team: "" },
      ],
      async ({ orgId }) => {
        const teams = await listTeams(sqlDb, orgId)
        expect(teams.map((t) => t.team)).toEqual(["Alpha", "Beta"])
        expect(teams[0]).toEqual({ team: "Alpha", openCount: 2, totalCount: 4 })
        expect(teams[1]).toEqual({ team: "Beta", openCount: 1, totalCount: 1 })
      },
    )
  })

  it("keeps near-duplicate spellings DISTINCT — that split is the thing to see, not to hide", async () => {
    await withTeamsFixture(
      [{ team: "Okabé" }, { team: "SGM - Okabé" }, { team: " Okabé" }, { team: "okabé" }],
      async ({ orgId }) => {
        const teams = await listTeams(sqlDb, orgId)
        // Four labels, four teams. Folding case or trimming here would report a
        // single healthy desk and quietly hide the fact that its history is in
        // four pieces.
        expect(teams).toHaveLength(4)
        expect(teams.map((t) => t.team).sort()).toEqual(
          [" Okabé", "Okabé", "SGM - Okabé", "okabé"].sort(),
        )
      },
    )
  })

  it("does not leak another org's teams", async () => {
    await withTeamsFixture([{ team: "Mine" }], async ({ orgId }) => {
      await withTeamsFixture([{ team: "Theirs" }], async () => {
        const teams = await listTeams(sqlDb, orgId)
        expect(teams.map((t) => t.team)).toEqual(["Mine"])
      })
    })
  })
})

describe("tickets teams — the list feeds the filter (drift oracle)", () => {
  it("every team listTeams offers is accepted by the backlogHealth team filter", async () => {
    // These were two separate queries once. A team the menu offers but the
    // aggregate rejects is worse than no menu, so pin that they agree.
    await withTeamsFixture(
      [{ team: "Alpha" }, { team: " Leading Space" }, { team: "MiXeD" }, { team: null }],
      async ({ orgId }) => {
        const teams = await listTeams(sqlDb, orgId)
        expect(teams.length).toBeGreaterThan(0)
        for (const t of teams) {
          const out = await backlogHealth(sqlDb, orgId, { team: t.team })
          expect(
            "error" in out ? out.error.code : null,
            `backlogHealth rejected a listed team: ${JSON.stringify(t.team)}`,
          ).toBeNull()
        }
      },
    )
  })
})

describe("tickets teams — renameTeam", () => {
  it("moves every ticket of the team and reports the count", async () => {
    await withTeamsFixture(
      [{ team: "Old" }, { team: "Old", status: "closed" }, { team: "Other" }],
      async ({ orgId, teamsOf }) => {
        const out = await renameTeam(sqlDb, orgId, { from: "Old", to: "New" })
        if ("error" in out) throw new Error(`unexpected error: ${out.error.message}`)
        expect(out.ticketsUpdated).toBe(2)
        expect(out.merged).toBe(false)
        expect(out.dryRun).toBe(false)
        // Closed tickets move too: the point is that the desk's HISTORY follows
        // the name, not just its live work.
        expect(await teamsOf(orgId)).toEqual([
          { team: "New", n: 2 },
          { team: "Other", n: 1 },
        ])
      },
    )
  })

  it("renaming ONTO an existing team merges them, and says so", async () => {
    await withTeamsFixture(
      [{ team: "Okabé" }, { team: "SGM - Okabé" }, { team: "SGM - Okabé" }],
      async ({ orgId, teamsOf }) => {
        const out = await renameTeam(sqlDb, orgId, { from: "Okabé", to: "SGM - Okabé" })
        if ("error" in out) throw new Error(`unexpected error: ${out.error.message}`)
        expect(out.merged).toBe(true)
        expect(out.ticketsUpdated).toBe(1)
        expect(await teamsOf(orgId)).toEqual([{ team: "SGM - Okabé", n: 3 }])
      },
    )
  })

  it("matches `from` EXACTLY, and names the near miss instead of renaming the wrong team", async () => {
    await withTeamsFixture(
      [{ team: " Coeur Alsace" }, { team: "Coeur Alsace" }],
      async ({ orgId, teamsOf }) => {
        // Asking for the trimmed name must NOT reach the space-prefixed one.
        const out = await renameTeam(sqlDb, orgId, { from: "  Coeur Alsace  ", to: "Alsace" })
        if (!("error" in out)) throw new Error("expected an error for a non-exact `from`")
        expect(out.error.code).toBe("unknown_team")
        // Whitespace is invisible in prose, so the message quotes the candidates.
        expect(out.error.message).toContain('" Coeur Alsace"')
        expect(out.error.message).toContain("exactly")
        // Nothing moved.
        expect(await teamsOf(orgId)).toEqual([
          { team: " Coeur Alsace", n: 1 },
          { team: "Coeur Alsace", n: 1 },
        ])
      },
    )
  })

  it("re-points an inbox default_team so new arrivals do not recreate the old label", async () => {
    await withTeamsFixture([{ team: "Old" }], async ({ orgId, inboxId }) => {
      await withSystemDb("teams-inbox-default", async (tx) => {
        await tx.execute(drizzleSql`
          UPDATE app_tickets.inboxes SET default_team = 'Old' WHERE id = ${inboxId}
        `)
      })
      const out = await renameTeam(sqlDb, orgId, { from: "Old", to: "New" })
      if ("error" in out) throw new Error(`unexpected error: ${out.error.message}`)
      expect(out.inboxDefaultsUpdated).toBe(1)
      const [row] = extractRows<{ default_team: string | null }>(
        await db.execute(
          drizzleSql`SELECT default_team FROM app_tickets.inboxes WHERE id = ${inboxId}`,
        ),
      )
      expect(row.default_team).toBe("New")
    })
  })

  it("dryRun reports the blast radius and writes nothing", async () => {
    await withTeamsFixture([{ team: "Old" }, { team: "Old" }], async ({ orgId, teamsOf }) => {
      const out = await renameTeam(sqlDb, orgId, { from: "Old", to: "New", dryRun: true })
      if ("error" in out) throw new Error(`unexpected error: ${out.error.message}`)
      expect(out.dryRun).toBe(true)
      expect(out.ticketsUpdated).toBe(2)
      expect(await teamsOf(orgId)).toEqual([{ team: "Old", n: 2 }])
    })
  })

  it("an unknown team is a loud error, never a silent zero-row success", async () => {
    await withTeamsFixture([{ team: "Alpha" }], async ({ orgId }) => {
      const out = await renameTeam(sqlDb, orgId, { from: "Nope", to: "New" })
      if (!("error" in out)) throw new Error("expected unknown_team")
      expect(out.error.code).toBe("unknown_team")
      expect(out.error.message).toContain("Alpha")
    })
  })

  it("rejects a no-op and a blank target", async () => {
    await withTeamsFixture([{ team: "Alpha" }], async ({ orgId }) => {
      const same = await renameTeam(sqlDb, orgId, { from: "Alpha", to: "Alpha" })
      expect("error" in same && same.error.code).toBe("invalid_params")
      // A blank target would erase the team under the guise of renaming it.
      const blank = await renameTeam(sqlDb, orgId, { from: "Alpha", to: "   " })
      expect("error" in blank && blank.error.code).toBe("invalid_params")
    })
  })
})

describe("tickets teams — setTeam", () => {
  it("trims, and treats blank as a clear rather than storing an empty string", async () => {
    await withTeamsFixture([{ team: null }], async ({ orgId, ticketIds }) => {
      const id = ticketIds[0]!
      expect(await setTeam(sqlDb, orgId, id, "  Alpha  ")).toEqual({ ticketId: id, team: "Alpha" })
      expect(await setTeam(sqlDb, orgId, id, "   ")).toEqual({ ticketId: id, team: null })
      // "" must never become a team: listTeams would then show a nameless row.
      const teams = await listTeams(sqlDb, orgId)
      expect(teams).toEqual([])
    })
  })

  it("reports a ticket it cannot see rather than claiming success", async () => {
    await withTeamsFixture([{ team: "Alpha" }], async ({ orgId }) => {
      const out = await setTeam(sqlDb, orgId, "00000000-0000-0000-0000-000000000000", "Beta")
      expect("error" in out && out.error.code).toBe("not_found")
    })
  })
})
