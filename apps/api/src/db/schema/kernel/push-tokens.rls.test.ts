// SPDX-License-Identifier: FSL-1.1-ALv2
//
// kernel.push_tokens is a USER-OWNED table: a device token is the address of
// one person's phone, so one member reading another's rows would hand them a
// way to address a colleague's device directly. The policy is therefore
// ownership, not membership, and this file pins both halves: a member reads
// (and writes) only their own rows, and the push fanout worker, which runs
// privileged because it must address every recipient of an event, reads across
// users.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"

describe("kernel.push_tokens RLS", () => {
  const ORG_ID = crypto.randomUUID()
  const ALICE = crypto.randomUUID()
  const BOB = crypto.randomUUID()
  const tag = ORG_ID.slice(0, 8)

  const ctx = (userId: string): UserContext => ({
    actorType: "user",
    userId,
    orgId: ORG_ID,
    scopes: ["*"],
    dimensionGrants: {},
  })

  async function readTokens(userId: string): Promise<string[]> {
    return withRlsContext(ctx(userId), async (tx) => {
      const rows = extractRows<{ token: string }>(
        await tx.execute(
          drizzleSql`SELECT token FROM kernel.push_tokens WHERE org_id = ${ORG_ID} ORDER BY token`,
        ),
      )
      return rows.map((r) => r.token)
    })
  }

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'PushTokensRlsOrg', ${`push-tok-${tag}`})`
    for (const [id, name] of [
      [ALICE, "alice"],
      [BOB, "bob"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${ORG_ID}, ${`push-tok-${name}-${tag}@test.com`}, ${name}, 'x')`
    }
    await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
      VALUES (${ORG_ID}, ${ALICE}, 'ios', 'alice-ios-token')`
    await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
      VALUES (${ORG_ID}, ${BOB}, 'android', 'bob-android-token')`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.push_tokens WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("a user can read only their own push token rows", async () => {
    expect(await readTokens(ALICE)).toEqual(["alice-ios-token"])
    expect(await readTokens(BOB)).toEqual(["bob-android-token"])
  })

  it("a privileged worker query reads across users", async () => {
    const tokens = await withPrivilegedDb(ORG_ID, "push-tokens-rls-test", async (tx) => {
      const rows = extractRows<{ token: string }>(
        await tx.execute(
          drizzleSql`SELECT token FROM kernel.push_tokens WHERE org_id = ${ORG_ID} ORDER BY token`,
        ),
      )
      return rows.map((r) => r.token)
    })
    expect(tokens).toEqual(["alice-ios-token", "bob-android-token"])
  })

  it("a user cannot register a token for somebody else", async () => {
    let failed = false
    try {
      await withRlsContext(ctx(ALICE), (tx) =>
        tx.execute(
          drizzleSql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
            VALUES (${ORG_ID}, ${BOB}, 'ios', 'alice-impersonating-bob')`,
        ),
      )
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
    expect(await readTokens(BOB)).toEqual(["bob-android-token"])
  })

  it("the same token cannot be registered twice for one user and platform", async () => {
    let failed = false
    try {
      await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
        VALUES (${ORG_ID}, ${ALICE}, 'ios', 'alice-ios-token')`
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
  })
})
