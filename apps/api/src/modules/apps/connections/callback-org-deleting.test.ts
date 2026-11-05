// SPDX-License-Identifier: FSL-1.1-ALv2
// A connection OAuth callback for an org whose deletion has started is refused
// with 410 ORG_DELETED before the grant is exchanged (S2.5): a flow started
// just before the mark must not write a fresh connection into the purge. The
// state is consumed, so a retry of the same callback is refused as well.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { redis } from "~/lib/redis"
import { forgetOrgApps } from "~/modules/apps/org-apps"
import { ORG_DELETED_CODE } from "~/modules/org/purge/deleting"

const DELETING = "0a1b2c3d-0000-4000-8000-00000000c41e"
const STATE = `test-deleting-${crypto.randomUUID()}`

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug, deleting_at)
    VALUES (${DELETING}, 'Deleting', ${`deleting-${STATE}`}, now())`
  forgetOrgApps(DELETING)
})

afterAll(async () => {
  await sql`DELETE FROM kernel.organizations WHERE id = ${DELETING}`
  forgetOrgApps(DELETING)
  await redis.del(`oauth:state:${STATE}`)
})

describe("connection OAuth callback of an org being deleted", () => {
  it("answers 410 ORG_DELETED and consumes the state", async () => {
    await redis.set(
      `oauth:state:${STATE}`,
      JSON.stringify({ orgId: DELETING, appName: "gmail" }),
      "EX",
      60,
    )
    const res = await app.fetch(
      new Request(`http://localhost/api/connections/callback?code=c&state=${STATE}`),
    )
    expect(res.status).toBe(410)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(ORG_DELETED_CODE)
    expect(await redis.get(`oauth:state:${STATE}`)).toBeNull()
  })
})
