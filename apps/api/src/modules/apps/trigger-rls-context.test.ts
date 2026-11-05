// SPDX-License-Identifier: FSL-1.1-ALv2
// Can SQL running as the runtime role inside a request
// transaction (which is what an app trigger body is) overwrite the RLS context?
//
// Answer, asserted below: YES. `app.current_org_id` & co. are plain transaction GUCs; the
// request transaction runs as `liaison_rls`, and `set_config` is callable by any role, so a
// trigger body that does `PERFORM set_config('app.current_org_id', <other org>, true)` sees
// that org's rows through RLS. That is why triggers are limited to vouched packages and
// statically reviewed (install-service / trigger-review), not left to RLS to contain.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_A = "00000000-0000-4000-8000-0000000cc001"
const ORG_B = "00000000-0000-4000-8000-0000000cc002"
const USER_A = "00000000-0000-4000-8000-0000000cc011"
const USER_B = "00000000-0000-4000-8000-0000000cc012"

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_A}, 'Trg A', 'trg-a'), (${ORG_B}, 'Trg B', 'trg-b')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_A}, ${ORG_A}, 'trga@test.com', 'A'), (${USER_B}, ${ORG_B}, 'trgb@test.com', 'B')`
})
afterAll(async () => {
  await sql`DELETE FROM kernel.users WHERE id IN (${USER_A}, ${USER_B})`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
  await releaseTestLock()
})

describe("RLS context vs SQL running as the request role", () => {
  it("a plpgsql body running as liaison_rls can switch the org it reads through RLS", async () => {
    const seen = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${ORG_A}, true), set_config('app.current_user_id', ${USER_A}, true), set_config('app.current_scopes', '*', true)`
      await tx.unsafe("SET LOCAL ROLE liaison_rls")
      const before = await tx`SELECT id FROM kernel.users WHERE id IN (${USER_A}, ${USER_B})`
      // What a trigger body does: same role, same transaction, no extra privilege.
      await tx.unsafe(
        `DO $body$ BEGIN PERFORM set_config('app.current_org_id', '${ORG_B}', true); END $body$`,
      )
      const after = await tx`SELECT id FROM kernel.users WHERE id IN (${USER_A}, ${USER_B})`
      return { before: before.map((r) => r.id), after: after.map((r) => r.id) }
    })
    expect(seen.before).toEqual([USER_A])
    expect(seen.after).toEqual([USER_B])
  })
})
