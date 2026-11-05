// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { isMessageVisible } from "~/services/security/visibility"

/**
 * End to end parity between the two halves of read-time visibility:
 * the DB-enforced predicate (the kernel.messages SELECT policy, migration 0060,
 * built from the generator clause) and the app-level mirror `isMessageVisible`.
 *
 * Every case here uses REAL rows: a real org, a real thread, real messages with
 * real required_scopes and disclosure_list values, read back through
 * `withRlsContext` (the liaison_rls role with the real GUCs) as a real member.
 * The clause-level fuzz lives in rls-generator.visibility-parity.test.ts; this
 * file proves the two implementations agree on what a viewer actually reads.
 *
 * The mirror covers the scope/disclosure half only: room membership is the
 * caller's check, so the app-side answer below ANDs membership in, exactly as
 * a caller does before filtering.
 */
describe("messages visibility: RLS policy and isMessageVisible parity on real rows", () => {
  const ORG_ID = crypto.randomUUID()
  const THREAD_ID = crypto.randomUUID()
  const MEMBER = crypto.randomUUID() // room member, grants vary per case
  const DISCLOSED = crypto.randomUUID() // room member, never holds a grant
  const OUTSIDER = crypto.randomUUID() // same org, not in the room
  const NIL_UUID = "00000000-0000-0000-0000-000000000000"
  const PARTICIPANTS = new Set<string>([MEMBER, DISCLOSED])
  const tag = ORG_ID.slice(0, 8)

  interface StoredMessage {
    id: string
    requiredScopes: string[]
    disclosureList: string[] | null
  }

  interface Viewer {
    userId: string
    grants: string[]
  }

  const stored = new Map<string, StoredMessage>()

  const ctx = (viewer: Viewer): UserContext => ({
    actorType: "user",
    userId: viewer.userId,
    orgId: ORG_ID,
    scopes: viewer.grants,
    dimensionGrants: {},
  })

  /** What the database returns for this viewer: the row, or nothing. */
  async function rlsSees(viewer: Viewer, messageId: string): Promise<boolean> {
    return withRlsContext(ctx(viewer), async (tx) => {
      const rows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`SELECT id FROM kernel.messages WHERE id = ${messageId}`),
      )
      return rows.length === 1
    })
  }

  /** What the app-level mirror answers for the same viewer and the same stored row. */
  function appSees(message: StoredMessage, viewer: Viewer): boolean {
    if (!PARTICIPANTS.has(viewer.userId)) return false
    return isMessageVisible(
      { requiredScopes: message.requiredScopes, disclosureList: message.disclosureList },
      { userId: viewer.userId, grants: viewer.grants },
    )
  }

  async function insertMessage(
    key: string,
    requiredScopes: string[],
    disclosureList: string[] | null,
  ): Promise<void> {
    const [inserted] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages
        (thread_id, org_id, author_id, content, required_scopes, disclosure_list)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${MEMBER}, ${key},
        ${requiredScopes}::text[], ${disclosureList}::uuid[])
      RETURNING id`
    const id = inserted?.id ?? ""
    // Read the stored values back: the parity compares against what the row
    // really holds, never against the literals this test happened to send.
    const [row] = await sql<{ required_scopes: string[]; disclosure_list: string[] | null }[]>`
      SELECT required_scopes, disclosure_list FROM kernel.messages WHERE id = ${id}`
    stored.set(key, {
      id,
      requiredScopes: row?.required_scopes ?? [],
      disclosureList: row?.disclosure_list ?? null,
    })
  }

  function message(key: string): StoredMessage {
    const row = stored.get(key)
    if (!row) throw new Error(`fixture message ${key} was not inserted`)
    return row
  }

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'VisParityOrg', ${`vis-parity-${tag}`})`
    for (const [id, name] of [
      [MEMBER, "member"],
      [DISCLOSED, "disclosed"],
      [OUTSIDER, "outsider"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${ORG_ID}, ${`vis-parity-${name}-${tag}@test.com`}, ${name}, 'x')`
    }
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${`vis-parity-${tag}`}, ${MEMBER})`
    for (const userId of [MEMBER, DISCLOSED]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${THREAD_ID}, ${userId}, ${ORG_ID})`
    }
    await insertMessage("exact", ["a:b:read"], null)
    await insertMessage("multi", ["a:b:read", "c:d"], null)
    await insertMessage("open", [], null)
    await insertMessage("disclosedToMember", ["a:b:read"], [DISCLOSED])
    await insertMessage("disclosedToOutsider", ["a:b:read"], [OUTSIDER])
    await insertMessage("emptyFirstSegment", [":read"], null)
    await insertMessage("sentinelRequired", ["__none__"], null)
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  interface ParityCase {
    name: string
    message: string
    viewer: Viewer
    expected: boolean
  }

  const CASES: ParityCase[] = [
    {
      name: "exact scope match: the grant equals the required scope",
      message: "exact",
      viewer: { userId: MEMBER, grants: ["a:b:read"] },
      expected: true,
    },
    {
      name: "wildcard grant a:* covers a:b:read",
      message: "exact",
      viewer: { userId: MEMBER, grants: ["a:*"] },
      expected: true,
    },
    {
      name: "bare * covers a:b:read",
      message: "exact",
      viewer: { userId: MEMBER, grants: ["*"] },
      expected: true,
    },
    {
      name: "parent grant a:b covers a:b:read",
      message: "exact",
      viewer: { userId: MEMBER, grants: ["a:b"] },
      expected: true,
    },
    {
      name: "sibling grant a:c does not cover a:b:read",
      message: "exact",
      viewer: { userId: MEMBER, grants: ["a:c"] },
      expected: false,
    },
    {
      name: "a member with no grants does not see a scoped row",
      message: "exact",
      viewer: { userId: MEMBER, grants: [] },
      expected: false,
    },
    {
      name: "two required scopes, the viewer holds only one",
      message: "multi",
      viewer: { userId: MEMBER, grants: ["a:b"] },
      expected: false,
    },
    {
      name: "two required scopes, the viewer holds both",
      message: "multi",
      viewer: { userId: MEMBER, grants: ["a:b:read", "c:*"] },
      expected: true,
    },
    {
      name: "empty requiredScopes is visible to a member with no grants",
      message: "open",
      viewer: { userId: MEMBER, grants: [] },
      expected: true,
    },
    {
      name: "empty requiredScopes is visible to a member holding an unrelated scope",
      message: "open",
      viewer: { userId: DISCLOSED, grants: ["x:y"] },
      expected: true,
    },
    {
      name: "a viewer on the disclosure list with no grants sees the row",
      message: "disclosedToMember",
      viewer: { userId: DISCLOSED, grants: [] },
      expected: true,
    },
    {
      name: "a member off the disclosure list without the scope does not",
      message: "disclosedToMember",
      viewer: { userId: MEMBER, grants: ["a:c"] },
      expected: false,
    },
    {
      name: "a non member sees nothing: scoped row, every scope granted",
      message: "exact",
      viewer: { userId: OUTSIDER, grants: ["*"] },
      expected: false,
    },
    {
      name: "a non member sees nothing: open row, every scope granted",
      message: "open",
      viewer: { userId: OUTSIDER, grants: ["*"] },
      expected: false,
    },
    {
      name: "a non member on the disclosure list is still a non member",
      message: "disclosedToOutsider",
      viewer: { userId: OUTSIDER, grants: ["a:b:read"] },
      expected: false,
    },
    {
      name: "the __none__ sentinel as a grant covers nothing",
      message: "exact",
      viewer: { userId: MEMBER, grants: ["__none__"] },
      expected: false,
    },
    {
      name: "the __none__ sentinel as a grant still reads an untagged row",
      message: "open",
      viewer: { userId: MEMBER, grants: ["__none__"] },
      expected: true,
    },
    {
      name: "an empty first segment scope is covered by the identical grant",
      message: "emptyFirstSegment",
      viewer: { userId: MEMBER, grants: [":read"] },
      expected: true,
    },
    {
      name: "an empty first segment scope is not covered by b:read",
      message: "emptyFirstSegment",
      viewer: { userId: MEMBER, grants: ["b:read"] },
      expected: false,
    },
  ]

  it("the JS predicate and the RLS policy agree on every case in the matrix", async () => {
    const failures: string[] = []
    for (const testCase of CASES) {
      const row = message(testCase.message)
      const fromDb = await rlsSees(testCase.viewer, row.id)
      const fromApp = appSees(row, testCase.viewer)
      if (fromDb !== fromApp) {
        failures.push(`${testCase.name}: rls=${fromDb} app=${fromApp} (disagreement)`)
      } else if (fromDb !== testCase.expected) {
        failures.push(`${testCase.name}: both=${fromDb} expected=${testCase.expected}`)
      }
    }
    expect(failures).toEqual([])
  })

  it("the NIL uuid is refused on a disclosure list", async () => {
    // Pass 1 found the policy admits any viewer whose id is on disclosure_list,
    // and withRlsContext resolves a system or non-uuid actor to the NIL uuid, so
    // a NIL entry would disclose the row to every such actor. Migration 0062
    // forbids storing it, which is why this case asserts the write is rejected
    // rather than comparing visibility. The query is awaited inside the promise:
    // postgres.js builders are lazy and never run otherwise.
    const attempt = (async () => {
      await sql`
        INSERT INTO kernel.messages
          (thread_id, org_id, author_id, content, required_scopes, disclosure_list)
        VALUES (${THREAD_ID}, ${ORG_ID}, ${MEMBER}, 'nil disclosure',
          ${["a:b:read"]}::text[], ${[NIL_UUID]}::uuid[])`
    })()
    await expect(attempt).rejects.toThrow(/messages_disclosure_list_real_users_chk/)
    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM kernel.messages
      WHERE thread_id = ${THREAD_ID} AND content = 'nil disclosure'`
    expect(rows[0]?.count).toBe("0")
  })

  it("degenerate grants: the RLS policy is stricter than the app mirror", async () => {
    // Recorded, not fixed: pass 1 flagged both of these. The GUC encoding maps an
    // empty grant list and the literal sentinel to "no grants at all", so SQL
    // refuses a required scope that the JS string comparison happens to match.
    // The divergence is fail closed (the database never returns the row), and it
    // is pinned here so a future change on either side is caught rather than
    // silently flipping the direction.
    const sentinel = message("sentinelRequired")
    const sentinelViewer: Viewer = { userId: MEMBER, grants: ["__none__"] }
    expect(await rlsSees(sentinelViewer, sentinel.id)).toBe(false)
    expect(appSees(sentinel, sentinelViewer)).toBe(true)

    const emptySegment = message("emptyFirstSegment")
    const emptyGrantViewer: Viewer = { userId: MEMBER, grants: [""] }
    expect(await rlsSees(emptyGrantViewer, emptySegment.id)).toBe(false)
    expect(appSees(emptySegment, emptyGrantViewer)).toBe(true)
  })
})
