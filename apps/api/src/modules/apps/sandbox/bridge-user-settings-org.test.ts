// SPDX-License-Identifier: FSL-1.1-ALv2
// ctx.getUserSettings reads a user's settings for the calling app by user id. The
// bridge's transaction is privileged for some handlers, so the lookup is held to
// the bridge's own org: a user of another org reads as unknown (the defaults) and
// their row is left untouched.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { appSettingsRegistry } from "~/modules/apps/app-registries"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const ORG_A = "00000000-0000-4000-8000-0000000d5001"
const ORG_B = "00000000-0000-4000-8000-0000000d5002"
const USER_A = "00000000-0000-4000-8000-0000000d5011"
const USER_B = "00000000-0000-4000-8000-0000000d5012"
const APP = "settingsprobe"
const manifest = { name: APP, schema: {}, events: {}, connections: {}, network: {} }

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_A}, 'Set A', 'set-a'), (${ORG_B}, 'Set B', 'set-b') ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, settings) VALUES
    (${USER_A}, ${ORG_A}, 'seta@test.com', 'A', ${JSON.stringify({ [APP]: { note: "a-own" } })}::jsonb),
    (${USER_B}, ${ORG_B}, 'setb@test.com', 'B', ${JSON.stringify({ [APP]: { note: "b-secret" } })}::jsonb)
    ON CONFLICT (id) DO NOTHING`
  appSettingsRegistry.set([ORG_A, APP], {
    userSchema: z.object({ note: z.string() }),
    userDefaults: { note: "default" },
  })
})
afterAll(async () => {
  appSettingsRegistry.delete([ORG_A, APP])
  await sql`DELETE FROM kernel.users WHERE id IN (${USER_A}, ${USER_B})`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
})

describe("ctx.getUserSettings on a privileged bridge", () => {
  it("reads a user of the bridge's own org", async () => {
    const out: string = await withPrivilegedDb(ORG_A, "test", (tx) =>
      createRpcBridge(APP, `system:${APP}`, ORG_A, tx as never, manifest as never).getUserSettings(
        USER_A,
      ),
    )
    expect(JSON.parse(out)).toEqual({ note: "a-own" })
  })

  it("never reads or writes a user of another org", async () => {
    const out: string = await withPrivilegedDb(ORG_A, "test", (tx) =>
      createRpcBridge(APP, `system:${APP}`, ORG_A, tx as never, manifest as never).getUserSettings(
        USER_B,
      ),
    )
    expect(JSON.parse(out)).toEqual({ note: "default" })
    const [row] = await sql`SELECT settings FROM kernel.users WHERE id = ${USER_B}`
    expect((row.settings as Record<string, unknown>)[APP]).toEqual({ note: "b-secret" })
  })
})
