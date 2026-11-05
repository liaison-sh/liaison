// SPDX-License-Identifier: FSL-1.1-ALv2
// ctx.kernel_findOne("users", id) gives an app the directory fields of a user of
// its org, never the credential columns or other apps' per-user settings.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const ORG = "00000000-0000-4000-8000-0000000d6001"
const USER = "00000000-0000-4000-8000-0000000d6011"
const APP = "userprobe"
const manifest = { name: APP, schema: {}, events: {}, connections: {}, network: {} }

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Cols', 'cols-org') ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash, totp_secret, recovery_codes, settings)
    VALUES (${USER}, ${ORG}, 'cols@test.com', 'Cole', 'hash-value', 'totp-value', '["code"]'::jsonb, '{"other":{"token":"x"}}'::jsonb)
    ON CONFLICT (id) DO NOTHING`
})
afterAll(async () => {
  await sql`DELETE FROM kernel.users WHERE id = ${USER}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("ctx.kernel_findOne users", () => {
  it("returns the directory fields only", async () => {
    const out: string = await withRlsContext(
      { actorType: "user", userId: USER, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
      (tx) =>
        createRpcBridge(APP, USER, ORG, tx as never, manifest as never).kernel_findOne(
          "users",
          USER,
        ),
    )
    const row = JSON.parse(out) as Record<string, unknown>
    expect(row.id).toBe(USER)
    expect(row.name).toBe("Cole")
    expect(row.email).toBe("cols@test.com")
    for (const secret of ["password_hash", "totp_secret", "recovery_codes", "settings"]) {
      expect(row).not.toHaveProperty(secret)
    }
  })
})
