// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0343: a scope only its exact grant holds (`isExactOnlyScope`, scope-coverage.ts) is held the
// same way where row security reads a stamp of what was read: a message's required scopes,
// an agent's memory and checkpoints, a secret request's, an app log line's scope tags, an
// approval's taint audience. `*`, a glob or a parent scope covers every other entry as before.
// Every read goes through `withRlsContext` (the `liaison_rls` role with the real context).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { EXACT_ONLY_SCOPES, isExactOnlyScope } from "~/modules/agent/scopes/scope-coverage"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import {
  seedMessageRow,
  seedThreadParticipantRow,
  seedThreadRow,
} from "~/seed/factories/threads/rows"

const ORG_ID = crypto.randomUUID()
const THREAD_ID = crypto.randomUUID()
const VIEWER = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)

const MARGIN = "projects:margin:read"
const ids: Record<string, string> = {}

const ctx = (scopes: string[]): UserContext => ({
  actorType: "user",
  userId: VIEWER,
  orgId: ORG_ID,
  scopes,
  dimensionGrants: {},
})

/** The contents of the messages the viewer reads through the policy, holding `scopes`. */
async function readable(scopes: string[]): Promise<string[]> {
  return withRlsContext(ctx(scopes), async (tx) =>
    extractRows<{ content: string }>(
      await tx.execute(
        drizzleSql`SELECT content FROM kernel.messages WHERE thread_id = ${THREAD_ID} ORDER BY content`,
      ),
    ).map((r) => r.content),
  )
}

const STAMPS: Record<string, string[]> = {
  margin: [MARGIN],
  "margin+projects": [MARGIN, "projects:projects:read"],
  projects: ["projects:projects:read"],
  marker: ["clevel"],
  open: [],
}

beforeAll(async () => {
  await seedOrgRow({ id: ORG_ID, name: "ExactStampOrg", slug: `exact-stamp-${tag}` })
  await seedUserRow({
    id: VIEWER,
    orgId: ORG_ID,
    email: `exact-stamp-${tag}@test.com`,
    name: "viewer",
    passwordHash: "x",
  })
  await seedThreadRow({
    id: THREAD_ID,
    orgId: ORG_ID,
    handle: `exact-stamp-${tag}`,
    createdBy: VIEWER,
  })
  await seedThreadParticipantRow({ threadId: THREAD_ID, userId: VIEWER, orgId: ORG_ID })
  for (const [content, required] of Object.entries(STAMPS)) {
    ids[content] = await seedMessageRow({
      threadId: THREAD_ID,
      orgId: ORG_ID,
      authorId: VIEWER,
      content,
      requiredScopes: required,
    })
  }
})

afterAll(async () => {
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("messages: an exact-only stamp entry is read only by its exact grant", () => {
  it("a person holding `*` reads every message but those stamped with an exact-only scope", async () => {
    expect(await readable(["*"])).toEqual(["open", "projects"])
  })

  it("the exact grant reads the margin message; `*` with it reads the rest too", async () => {
    expect(await readable([MARGIN])).toEqual(["margin", "open"])
    expect(await readable(["*", MARGIN])).toEqual(["margin", "margin+projects", "open", "projects"])
    expect(await readable(["*", MARGIN, "clevel"])).toEqual([
      "margin",
      "margin+projects",
      "marker",
      "open",
      "projects",
    ])
  })

  it("no glob or parent scope stands for an exact-only entry", async () => {
    expect(await readable(["projects:*"])).toEqual(["open", "projects"])
    expect(await readable(["projects:margin", "projects:projects:read"])).toEqual([
      "open",
      "projects",
    ])
    expect(await readable(["projects"])).toEqual(["open", "projects"])
  })

  it("a non-exact entry is still covered by `*`, a glob or a parent", async () => {
    for (const grants of [["*"], ["projects:*"], ["projects:projects"], ["projects"]])
      expect(await readable(grants)).toContain("projects")
  })
})

describe("kernel.scope_is_exact_only answers as isExactOnlyScope", () => {
  it("on every listed scope, bare markers, the wildcard and ordinary app scopes", async () => {
    const samples = [
      ...EXACT_ONLY_SCOPES,
      "clevel",
      "a*",
      "",
      "*",
      "*:read",
      "projects:projects:read",
      "projects:margin",
      "projects:margin:read:x",
      "restricted:agreements.agreement:1",
      "kernel:users:admin",
    ]
    const rows = await sql<{ s: string; exact: boolean }[]>`
      SELECT s, kernel.scope_is_exact_only(s) AS exact FROM unnest(${samples}::text[]) AS u(s)`
    for (const row of rows)
      expect({ s: row.s, exact: row.exact }).toEqual({ s: row.s, exact: isExactOnlyScope(row.s) })
  })
})

describe("the other stamp readers hold an exact-only scope only by its exact grant", () => {
  async function held(scopes: string[], scope: string): Promise<boolean> {
    return withRlsContext(ctx(scopes), async (tx) => {
      const [row] = extractRows<{ ok: boolean }>(
        await tx.execute(drizzleSql`SELECT kernel.stamp_scope_held(${scope}) AS ok`),
      )
      return row?.ok === true
    })
  }

  it("kernel.stamp_scope_held: exact-only by its exact grant, every other scope as has_scope", async () => {
    expect(await held(["*"], MARGIN)).toBe(false)
    expect(await held(["projects:*"], MARGIN)).toBe(false)
    expect(await held([MARGIN], MARGIN)).toBe(true)
    expect(await held(["*"], "clevel")).toBe(false)
    expect(await held(["clevel"], "clevel")).toBe(true)
    expect(await held(["*"], "projects:projects:read")).toBe(true)
    expect(await held(["projects:*"], "projects:projects:read")).toBe(true)
    expect(await held([], "projects:projects:read")).toBe(false)
    expect(await held(["*"], "")).toBe(false)
  })

  it("kernel.scopes_cover_ceiling: `*` covers every entry but an exact-only one", async () => {
    const rows = await sql<{ n: number; ok: boolean }[]>`
      SELECT n::int AS n, kernel.scopes_cover_ceiling(c.caller, c.ceiling) AS ok
      FROM (VALUES
        (1, ARRAY['*'], '["projects:projects:read"]'::jsonb),
        (2, ARRAY['*'], ${JSON.stringify([MARGIN])}::jsonb),
        (3, ARRAY['*', ${MARGIN}], ${JSON.stringify([MARGIN, "tickets:tickets:read"])}::jsonb),
        (4, ARRAY[${MARGIN}], ${JSON.stringify([MARGIN])}::jsonb),
        (5, ARRAY['*'], '["clevel"]'::jsonb),
        (6, ARRAY['tickets:tickets:read'], '["tickets:tickets:read","crm:deals:read"]'::jsonb),
        (7, ARRAY['*'], '[]'::jsonb)
      ) AS c(n, caller, ceiling)
      ORDER BY n`
    expect(rows.map((r) => r.ok)).toEqual([true, false, true, true, false, false, true])
  })

  it("the secret request, app log and approval policies read their stamps through it", async () => {
    const policies = await sql<{ tablename: string; qual: string }[]>`
      SELECT tablename, qual FROM pg_policies
      WHERE schemaname = 'kernel'
        AND policyname IN ('secret_requests_select', 'app_logs_select', 'approval_requests_select')
      ORDER BY tablename`
    expect(policies.map((p) => p.tablename)).toEqual([
      "app_logs",
      "approval_requests",
      "secret_requests",
    ])
    for (const p of policies) {
      expect(p.qual).toContain("kernel.stamp_scope_held(")
      expect(p.qual).not.toMatch(/has_scope\((req\.scope|t\.tag|must\.scope)\)/)
    }
  })
})
