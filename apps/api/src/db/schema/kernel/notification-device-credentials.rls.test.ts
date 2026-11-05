// SPDX-License-Identifier: FSL-1.1-ALv2
//
// kernel.notification_device_credentials holds the hashed receipt credentials
// of notification devices. Only privileged code touches it, so the request
// role (liaison_rls) must not reach it at all, even holding '*' and even for
// the user's own rows; the privileged connection must (0128).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"

/** The database's own message: drizzle wraps it as the cause of "Failed query". */
async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string } }
    return `${e.message ?? ""} | ${e.cause?.message ?? ""}`
  }
  return "no error"
}

describe("kernel.notification_device_credentials RLS (0128)", () => {
  const ORG_ID = crypto.randomUUID()
  const ALICE = crypto.randomUUID()
  const tag = ORG_ID.slice(0, 8)
  const DEVICE = `d.${tag}`

  const ctx: UserContext = {
    actorType: "user",
    userId: ALICE,
    orgId: ORG_ID,
    scopes: ["*"],
    dimensionGrants: {},
  }

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'DeviceCredRlsOrg', ${`dev-cred-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${ALICE}, ${ORG_ID}, ${`dev-cred-${tag}@test.com`}, 'alice', 'x')`
    await sql`INSERT INTO kernel.notification_device_credentials
      (org_id, user_id, device_id, surface, token_hash, server_origin)
      VALUES (${ORG_ID}, ${ALICE}, ${DEVICE}, 'desktop', ${`hash-${tag}`}, 'https://t.test')`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.notification_device_credentials WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("the request role cannot read the table, not even its own rows with '*'", async () => {
    expect(
      await failure(
        withRlsContext(ctx, (tx) =>
          tx.execute(
            drizzleSql`SELECT token_hash FROM kernel.notification_device_credentials WHERE user_id = ${ALICE}`,
          ),
        ),
      ),
    ).toContain("permission denied")
  })

  it("the request role cannot write a credential", async () => {
    expect(
      await failure(
        withRlsContext(ctx, (tx) =>
          tx.execute(drizzleSql`INSERT INTO kernel.notification_device_credentials
            (org_id, user_id, device_id, surface, token_hash, server_origin)
            VALUES (${ORG_ID}, ${ALICE}, ${`${DEVICE}-2`}, 'desktop', ${`forged-${tag}`}, 'https://t.test')`),
        ),
      ),
    ).toContain("permission denied")
  })

  it("the privileged connection reads it", async () => {
    const rows = await withPrivilegedDb(ORG_ID, "test-dev-cred-read", async (tx) =>
      extractRows<{ device_id: string }>(
        await tx.execute(
          drizzleSql`SELECT device_id FROM kernel.notification_device_credentials WHERE org_id = ${ORG_ID}`,
        ),
      ),
    )
    expect(rows.map((r) => r.device_id)).toEqual([DEVICE])
  })
})
