// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The team dimension end to end: discover the desks, filter by one, repair a
// split label, and confirm a team-scoped operator only ever sees their own.
//
// The invariant worth an e2e (rather than a unit test) is the CLOSURE between
// three surfaces that each learn the team set separately: `teams.list` (the
// filter menu), `search` (the rows), and `backlogHealth` (the aggregate). They
// run under the caller's RLS context, so the honest test needs a real server, a
// real dimension grant, and a real token.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, createUserWithScopes } from "@liaison/test-helpers"
import { seedTicket, ts } from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

interface TestActor {
  id: string
  token: string
}

async function makeActor(
  url: string,
  env: WorkerEnv,
  world: TestWorld,
  opts: { name: string; scopes: string[]; dimensions?: Record<string, string[]> },
): Promise<TestActor> {
  const created = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
    name: opts.name,
    scopes: opts.scopes,
    dimensions: opts.dimensions ?? { "*": ["*"] },
    schemaPrefix: env.schemaPrefix,
  })
  return { id: created.id, token: created.token }
}

// The two spellings a migration and an integration each produced for the SAME
// desk. Repairing this is the whole point of teams.rename.
const SPLIT_A = "Okabé"
const SPLIT_B = "SGM - Okabé"
// A label whose leading space is REAL. It is the sharpest test of "verbatim":
// anything that trims on the way to the query silently matches nothing.
const SPACED = " Coeur Alsace"

describe("tickets teams scenario", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let operator: TestActor
  let euOnly: TestActor

  beforeAll(async () => {
    ;({ env, world } = await setupScenario({ seed: 713, org: { name: "Tickets Teams E2E" } }))
    url = env.serverUrl

    operator = await makeActor(url, env, world, {
      name: "Desk Operator",
      scopes: ["tickets:tickets:read", "tickets:tickets:write"],
      dimensions: { team: ["*"], sensitivity: ["*"] },
    })
    euOnly = await makeActor(url, env, world, {
      name: "EU Only",
      scopes: ["tickets:tickets:read"],
      dimensions: { "tickets:team": ["support-eu"], team: ["support-eu"], sensitivity: ["*"] },
    })

    for (const t of [
      { team: SPLIT_A, subject: "split a" },
      { team: SPLIT_B, subject: "split b" },
      { team: SPLIT_B, subject: "split c", status: "closed" as const },
      { team: SPACED, subject: "spaced" },
      { team: "support-eu", subject: "eu one" },
      { team: null, subject: "untagged" },
    ]) {
      await seedTicket(env, {
        orgId: world.org.id,
        team: t.team,
        subject: t.subject,
        status: t.status ?? "open",
      })
    }
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  async function listTeams(token: string) {
    const res = await api(url, "/api/apps/tools/tickets:teams.list", {
      method: "POST",
      token,
      body: { params: {} },
    })
    expect(res.status).toBe(200)
    return res.body.data as Array<{ team: string; openCount: number; totalCount: number }>
  }

  it("T1: teams.list reports the live set, counts open separately from lifetime, and omits untagged", async () => {
    const teams = await listTeams(operator.token)
    const byName = new Map(teams.map((t) => [t.team, t]))

    expect(byName.get(SPLIT_A)).toEqual({ team: SPLIT_A, openCount: 1, totalCount: 1 })
    // Two tickets, one closed: the menu badge promises LIVE work.
    expect(byName.get(SPLIT_B)).toEqual({ team: SPLIT_B, openCount: 1, totalCount: 2 })
    // The untagged ticket creates no team.
    expect(teams.some((t) => !t.team)).toBe(false)
    // The split is visible as two entries. That is the point: it is a data
    // problem the operator must be able to SEE before repairing it.
    expect(byName.has(SPLIT_A) && byName.has(SPLIT_B)).toBe(true)
  })

  it("T2: every listed team returns rows via search AND is accepted by backlogHealth (closure)", async () => {
    const teams = await listTeams(operator.token)
    expect(teams.length).toBeGreaterThan(0)

    for (const t of teams) {
      const search = await api(url, "/api/apps/tools/tickets:search", {
        method: "POST",
        token: operator.token,
        body: { params: { team: [t.team], smartFilter: "all-open" } },
      })
      expect(search.status).toBe(200)
      const items = search.body.data?.items ?? []
      // Every row actually carries the team asked for, byte for byte.
      for (const row of items) expect(row.team).toBe(t.team)
      expect(items.length, `no rows for listed team ${JSON.stringify(t.team)}`).toBe(t.openCount)

      const health = await api(url, "/api/apps/tools/tickets:backlogHealth", {
        method: "POST",
        token: operator.token,
        body: { params: { team: t.team } },
      })
      expect(health.status).toBe(200)
      expect(
        health.body.data?.error?.code,
        `backlogHealth rejected a listed team: ${JSON.stringify(t.team)}`,
      ).toBeUndefined()
    }
  })

  it("T3: a leading space in a label is real and survives the round trip", async () => {
    const teams = await listTeams(operator.token)
    expect(teams.some((t) => t.team === SPACED)).toBe(true)

    // The trimmed spelling is a DIFFERENT team and must match nothing.
    const trimmed = await api(url, "/api/apps/tools/tickets:search", {
      method: "POST",
      token: operator.token,
      body: { params: { team: [SPACED.trim()], smartFilter: "all-open" } },
    })
    expect(trimmed.status).toBe(200)
    expect(trimmed.body.data?.items ?? []).toHaveLength(0)
  })

  it("T4: setTeam moves one ticket, trims what a human typed, and clears on blank", async () => {
    const seeded = await seedTicket(env, {
      orgId: world.org.id,
      team: null,
      subject: "to be tagged",
    })
    const set = await api(url, "/api/apps/tools/tickets:setTeam", {
      method: "POST",
      token: operator.token,
      body: { params: { ticketId: seeded.id, team: "  Newly Tagged  " } },
    })
    expect(set.status).toBe(200)
    expect(set.body.data?.team).toBe("Newly Tagged")

    const cleared = await api(url, "/api/apps/tools/tickets:setTeam", {
      method: "POST",
      token: operator.token,
      body: { params: { ticketId: seeded.id, team: null } },
    })
    expect(cleared.status).toBe(200)
    expect(cleared.body.data?.team).toBeNull()
    // Cleared means NULL, never the empty string, or the team menu grows a
    // nameless row.
    const [row] = await env.db.sql.unsafe(`SELECT team FROM ${ts(env)}.tickets WHERE id = $1`, [
      seeded.id,
    ])
    expect((row as any).team).toBeNull()
  })

  it("T5: teams.rename dry-runs, then merges the split label into one desk", async () => {
    const dry = await api(url, "/api/apps/tools/tickets:teams.rename", {
      method: "POST",
      token: operator.token,
      body: { params: { from: SPLIT_A, to: SPLIT_B, dryRun: true } },
    })
    expect(dry.status).toBe(200)
    expect(dry.body.data).toMatchObject({ ticketsUpdated: 1, merged: true, dryRun: true })
    // A dry run changes nothing: both spellings still exist.
    expect((await listTeams(operator.token)).some((t) => t.team === SPLIT_A)).toBe(true)

    const real = await api(url, "/api/apps/tools/tickets:teams.rename", {
      method: "POST",
      token: operator.token,
      body: { params: { from: SPLIT_A, to: SPLIT_B } },
    })
    expect(real.status).toBe(200)
    expect(real.body.data).toMatchObject({ ticketsUpdated: 1, merged: true, dryRun: false })

    const after = new Map((await listTeams(operator.token)).map((t) => [t.team, t]))
    expect(after.has(SPLIT_A)).toBe(false)
    // The merged desk carries BOTH histories: 2 live, 3 lifetime.
    expect(after.get(SPLIT_B)).toEqual({ team: SPLIT_B, openCount: 2, totalCount: 3 })
  })

  it("T6: an unknown `from` is refused as a BAD ARGUMENT (400, not 500) and names the near miss", async () => {
    const res = await api(url, "/api/apps/tools/tickets:teams.rename", {
      method: "POST",
      token: operator.token,
      body: { params: { from: SPACED.trim(), to: "Alsace" } },
    })
    // 400, not 500: naming a team nobody uses is the caller's mistake. A 500
    // reads as a server fault, pages the watchdog, and buries the one thing
    // that actually helps — the list of real labels.
    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe("unknown_team")
    // Quoted, because the difference is a space nobody can see in prose.
    expect(res.body.error?.message).toContain(JSON.stringify(SPACED))
    // And it really did nothing.
    expect((await listTeams(operator.token)).some((t) => t.team === SPACED)).toBe(true)
  })

  it("T6b: backlogHealth's unknown team is classified the same way (the shared code path)", async () => {
    const res = await api(url, "/api/apps/tools/tickets:backlogHealth", {
      method: "POST",
      token: operator.token,
      body: { params: { team: "no-such-desk" } },
    })
    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe("unknown_team")
  })

  it("T7: a team-scoped operator's menu holds only their own teams", async () => {
    // The filter menu must never advertise a desk whose tickets RLS will hide:
    // the operator would select it and get an empty list with no explanation.
    const teams = await listTeams(euOnly.token)
    expect(teams.map((t) => t.team)).toEqual(["support-eu"])

    for (const t of teams) {
      const search = await api(url, "/api/apps/tools/tickets:search", {
        method: "POST",
        token: euOnly.token,
        body: { params: { team: [t.team], smartFilter: "all-open" } },
      })
      expect(search.status).toBe(200)
      expect((search.body.data?.items ?? []).length).toBe(t.openCount)
    }
  })
})
