// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0249: kernel.messages SELECT checks required scopes through a key set built
// once per statement (kernel.scope_cover_keys) and a single pass per row
// (kernel.scopes_covered). The rows a viewer sees must be EXACTLY the rows
// 0060's clause admitted (generateRequiredScopesVisibilityClause, the
// reference kept in the generator): it is proven here side by side, under the
// real liaison_rls context, over hand-picked edge cases and a seeded random
// matrix. Then the cost: a thread of 300 messages carrying 138 scopes each,
// read by a viewer with 200 grants, counts its unread messages well inside the
// statement timeout (it timed out before). Last, the writer stores a tag once.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { messages, userThreadState } from "~/db/schema/kernel"
import { generateRequiredScopesVisibilityClause } from "~/modules/permissions/rls-generator"
import { inheritVisibility, sendMessage } from "~/modules/threads/message"
import { countThreadUnread } from "~/modules/threads/thread-state"
import * as minimal from "~/seed/tiers/minimal"

let ORG = ""
let VIEWER = ""
let OTHER = ""

const OLD_CLAUSE = generateRequiredScopesVisibilityClause({
  requiredScopesColumn: "required_scopes",
  disclosureListColumn: "disclosure_list",
})
const NEW_CLAUSE = `(
  kernel.scopes_covered(required_scopes, (SELECT kernel.scope_cover_keys((SELECT rls_ctx.scopes()))))
  OR COALESCE(NULLIF((SELECT rls_ctx.user_id()), '') = ANY (disclosure_list::text[]), false)
)`

const ctx = (scopes: string[], userId = VIEWER): UserContext => ({
  actorType: "user",
  userId,
  orgId: ORG,
  scopes,
  dimensionGrants: {},
})

/** A required-scopes value: null is a NULL column, a null entry a NULL element. */
type Required = (string | null)[] | null

/** Old and new verdicts for each required value, evaluated in one RLS transaction. */
async function verdicts(
  grants: string[],
  required: Required[],
  disclosure: (string[] | null)[] = [],
): Promise<{ n: number; old: boolean; new: boolean }[]> {
  const rows = required.map((r, i) => ({ r, d: disclosure[i] ?? null }))
  return withRlsContext(ctx(grants), async (tx) =>
    extractRows<{ n: number; old: boolean; new: boolean }>(
      await tx.execute(drizzleSql`
        SELECT t.n::int AS n, (${drizzleSql.raw(OLD_CLAUSE)}) AS old, (${drizzleSql.raw(NEW_CLAUSE)}) AS new
        FROM (
          SELECT x.n,
            CASE WHEN jsonb_typeof(x.e->'r') = 'null' THEN NULL
                 ELSE ARRAY(SELECT a.v FROM jsonb_array_elements_text(x.e->'r') WITH ORDINALITY AS a(v, o) ORDER BY a.o) END::text[] AS required_scopes,
            CASE WHEN jsonb_typeof(x.e->'d') = 'null' THEN NULL
                 ELSE ARRAY(SELECT jsonb_array_elements_text(x.e->'d')) END::uuid[] AS disclosure_list
          FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) WITH ORDINALITY AS x(e, n)
        ) AS t
        ORDER BY t.n
      `),
    ),
  )
}

/** Deterministic PRNG (mulberry32), so a failing case reproduces. */
function prng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SEGMENTS = ["a", "b", "c", "*", "", "read", "a*"]
function randomScope(rand: () => number): string {
  const n = 1 + Math.floor(rand() * 4)
  return Array.from({ length: n }, () => SEGMENTS[Math.floor(rand() * SEGMENTS.length)]).join(":")
}

const EDGE_GRANTS: string[][] = [
  [],
  ["*"],
  [""],
  ["", "x"],
  ["crm"],
  ["crm:*"],
  ["crm:deals"],
  ["crm:deals:read"],
  ["crm:deals:*"],
  ["*:read"],
  ["crm:*:read"],
  ["crm:*:*"],
  [":*"],
  ["crm:"],
  ["tickets:read", "crm:deals:read"],
  ["kernel:threads:read", "kernel:*", "crm:deals"],
  ["*", "*:read"],
]

const EDGE_REQUIRED: Required[] = [
  null,
  [],
  [""],
  [null],
  ["crm:deals:read", null],
  ["crm"],
  ["crm:"],
  ["crm:deals"],
  ["crm:deals:read"],
  ["crm:deals:read:extra"],
  ["crm:deals:read", "tickets:read"],
  ["crm:deals:read", "crm:deals:read"],
  ["*"],
  ["*:read"],
  ["crm:*"],
  ["crm:*:read"],
  [":x"],
  [":"],
  ["crm::read"],
  ["x"],
  ["kernel:threads:read", "crm:deals:write"],
  ["CRM:deals:read"],
  ["crm%:deals_"],
]

beforeAll(async () => {
  ORG = (await minimal.secondOrg({ name: "Scope Cover Org" })).orgId
  VIEWER = (await minimal.person(ORG)).id
  OTHER = (await minimal.person(ORG)).id
})

afterAll(async () => {
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
})

/** A room created by the viewer (its only member unless `others` are named). */
function newThread(others: string[] = []): Promise<string> {
  return minimal.thread(ORG, VIEWER, {
    title: `Scope cover ${crypto.randomUUID().slice(0, 8)}`,
    participantIds: others,
  })
}

/**
 * Stored rows exactly as given, NULL elements and repeats included: rows
 * written before the writer normalised its tags (or by any other writer), so
 * this is a named privileged write, not the message service.
 */
function storedScopes(r: (string | null)[]) {
  return drizzleSql`(SELECT ARRAY(SELECT a.v FROM jsonb_array_elements_text(${JSON.stringify(r)}::jsonb) WITH ORDINALITY AS a(v, o) ORDER BY a.o))`
}
async function storeMessages(
  threadId: string,
  rows: { required: (string | null)[]; createdAt?: Date }[],
): Promise<string[]> {
  const out = await withPrivilegedDb(ORG, "scope-cover-test:stored-rows", (tx) =>
    tx
      .insert(messages)
      .values(
        rows.map((r) => ({
          threadId,
          orgId: ORG,
          authorId: OTHER,
          authorType: "user" as const,
          content: "m",
          requiredScopes: storedScopes(r.required),
          ...(r.createdAt ? { createdAt: r.createdAt } : {}),
        })),
      )
      .returning({ id: messages.id }),
  )
  return out.map((r) => r.id)
}

describe("0249 messages_select: same visibility as 0060's clause", () => {
  it("the installed policy uses the key set, not the per-grant regexp walk", async () => {
    const [row] = await sql<{ qual: string }[]>`
      SELECT pg_get_expr(polqual, polrelid) AS qual FROM pg_policy
      WHERE polrelid = 'kernel.messages'::regclass AND polname = 'messages_select'`
    expect(row?.qual).toContain("kernel.scopes_covered(required_scopes")
    expect(row?.qual).toContain("kernel.scope_cover_keys(( SELECT rls_ctx.scopes()")
    expect(row?.qual).not.toContain("regexp_split_to_array")
    // The membership gate is still there.
    expect(row?.qual).toContain("kernel.thread_participants")
  })

  it("agrees on every edge case (wildcards, mid-segment stars, empty and NULL entries)", async () => {
    for (const grants of EDGE_GRANTS) {
      const got = await verdicts(grants, EDGE_REQUIRED)
      for (const v of got) {
        expect({ grants, required: EDGE_REQUIRED[v.n - 1], verdict: v.new }).toEqual({
          grants,
          required: EDGE_REQUIRED[v.n - 1],
          verdict: v.old,
        })
      }
    }
  })

  it("agrees on a seeded random matrix of grant sets x required sets", async () => {
    const rand = prng(0x5c0de)
    let covered = 0
    let total = 0
    for (let g = 0; g < 60; g++) {
      const grants = Array.from({ length: Math.floor(rand() * 7) }, () => randomScope(rand))
      const required: Required[] = Array.from({ length: 80 }, () => {
        if (rand() < 0.03) return null
        return Array.from({ length: Math.floor(rand() * 4) }, () =>
          rand() < 0.03 ? null : randomScope(rand),
        )
      })
      const got = await verdicts(grants, required)
      expect(got).toHaveLength(required.length)
      for (const v of got) {
        total++
        if (v.old) covered++
        expect({ grants, required: required[v.n - 1], verdict: v.new }).toEqual({
          grants,
          required: required[v.n - 1],
          verdict: v.old,
        })
      }
    }
    // The matrix exercises both outcomes, not only refusals.
    expect(covered).toBeGreaterThan(total / 10)
    expect(covered).toBeLessThan(total)
  })

  it("the disclosure branch is unchanged", async () => {
    const got = await verdicts(
      ["tickets:read"],
      [["crm:deals:read"], ["crm:deals:read"], ["crm:deals:read"], null],
      [[VIEWER], [OTHER], null, [VIEWER]],
    )
    expect(got.map((v) => v.new)).toEqual(got.map((v) => v.old))
    expect(got.map((v) => v.new)).toEqual([true, false, false, true])
  })

  it("the rows a member reads through the policy are the rows 0060's clause admits", async () => {
    const thread = await newThread()
    const rows = EDGE_REQUIRED.filter((r): r is (string | null)[] => r !== null)
    const ids: string[] = []
    for (const r of rows) ids.push(...(await storeMessages(thread, [{ required: r }])))
    for (const grants of EDGE_GRANTS) {
      const expected = (await verdicts(grants, rows)).filter((v) => v.old).map((v) => ids[v.n - 1])
      const seen = await withRlsContext(ctx(grants), async (tx) =>
        extractRows<{ id: string }>(
          await tx.execute(drizzleSql`SELECT id FROM kernel.messages WHERE thread_id = ${thread}`),
        ).map((r) => r.id),
      )
      expect({ grants, seen: seen.sort() }).toEqual({ grants, seen: expected.sort() })
    }
    // A non-member still sees nothing, whatever it holds.
    const outsider = await withRlsContext(ctx(["*"], OTHER), async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`SELECT id FROM kernel.messages WHERE thread_id = ${thread}`),
      ),
    )
    expect(outsider).toEqual([])
  })
})

describe("0249 messages_select: cost", () => {
  it("counts unread on 300 messages x 138 scopes for a viewer with 200 grants in well under the timeout", async () => {
    const thread = await newThread()
    const required = Array.from({ length: 138 }, (_, i) => `app${i}:res${i % 7}:read`)
    // 138 grants that cover the tags (half by prefix, half exactly), plus noise.
    const grants = [
      ...required.map((s, i) => (i % 2 === 0 ? s.replace(/:read$/, "") : s)),
      ...Array.from({ length: 62 }, (_, i) => `noise${i}:things:read`),
    ]
    const base = Date.now() - 1_000_000
    const ids = await storeMessages(
      thread,
      Array.from({ length: 300 }, (_, g) => ({ required, createdAt: new Date(base + g * 1000) })),
    )
    await withPrivilegedDb(ORG, "scope-cover-test:read-state", (tx) =>
      tx
        .insert(userThreadState)
        .values({ userId: VIEWER, threadId: thread, orgId: ORG, lastReadMessageId: ids[0] ?? null })
        .onConflictDoUpdate({
          target: [userThreadState.userId, userThreadState.threadId],
          set: { lastReadMessageId: ids[0] ?? null },
        }),
    )

    const started = performance.now()
    const unread = await withRlsContext(ctx(grants), (tx) =>
      countThreadUnread(tx, { userId: VIEWER, threadId: thread }),
    )
    const elapsed = performance.now() - started
    console.log(`countThreadUnread 300 x 138 scopes, 200 grants: ${elapsed.toFixed(1)} ms`)
    expect(unread).toBe(299)
    expect(elapsed).toBeLessThan(500)
  }, 60_000)
})

describe("message writer: the required-scope tag is a set", () => {
  it("the migration's cleanup deduplicates stored tags, keeping order and NULL-bearing rows as they are", async () => {
    const thread = await newThread()
    const insert = async (r: (string | null)[]) =>
      (await storeMessages(thread, [{ required: r }]))[0] ?? ""
    const dup = await insert(["b:read", "a:read", "b:read", "a:read", "c:read"])
    const withNull = await insert(["a:read", null, "a:read"])
    const clean = await insert(["z:read", "a:read"])
    const file = readFileSync(join(import.meta.dir, "0249_messages_select_scope_cover.sql"), "utf8")
    // The cleanup is the statement that starts with the UPDATE: it runs before the policy
    // swap, so reads are not blocked behind the full-table scan.
    const cleanup = file
      .split("--> statement-breakpoint")
      .find((stmt) => stmt.includes("UPDATE kernel.messages"))
    if (!cleanup) throw new Error("0249 has no UPDATE kernel.messages statement")
    expect(file.search(/^UPDATE kernel\.messages/m)).toBeLessThan(file.search(/^ALTER POLICY/m))
    await sql.unsafe(cleanup)
    // As text, so a NULL element reads back as `null` (the array parser's NULL is ambiguous).
    const read = async (id: string) =>
      (
        await sql<{ r: (string | null)[] }[]>`
          SELECT to_jsonb(required_scopes) AS r FROM kernel.messages WHERE id = ${id}`
      )[0]?.r
    expect(await read(dup)).toEqual(["b:read", "a:read", "c:read"])
    expect(await read(withNull)).toEqual(["a:read", null, "a:read"])
    expect(await read(clean)).toEqual(["z:read", "a:read"])
  })

  it("sendMessage stores a repeated scope once, in first-seen order", async () => {
    const thread = await newThread()
    const scopes = [
      "kernel:threads:read",
      "crm:deals:read",
      "kernel:threads:read",
      "crm:deals:read",
    ]
    const msg = await withRlsContext(
      ctx(["kernel:threads:write", "kernel:threads:read", "crm:deals:read"]),
      (tx) =>
        sendMessage(tx, {
          orgId: ORG,
          userId: VIEWER,
          threadId: thread,
          content: "dup",
          requiredScopes: scopes,
        }),
    )
    const [row] = await sql<{ required_scopes: string[] }[]>`
      SELECT required_scopes FROM kernel.messages WHERE id = ${msg?.id ?? ""}`
    expect(row?.required_scopes).toEqual(["kernel:threads:read", "crm:deals:read"])
  })

  it("inheritVisibility unions without repeats, its own duplicates included", () => {
    const out = inheritVisibility(
      { requiredScopes: ["a:read", "a:read", "b:read"], disclosureList: null },
      { requiredScopes: ["b:read", "c:read", "c:read"], disclosureList: null },
    )
    expect(out.requiredScopes).toEqual(["a:read", "b:read", "c:read"])
  })
})
