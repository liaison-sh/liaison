// SPDX-License-Identifier: FSL-1.1-ALv2
//
// kernel.portal_shares: one open share per object, the right shape per kind, and
// who on the member side may read the list.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { insertSql } from "~/seed/factories/org/test-rows"
import {
  attempt,
  createDoorWorld,
  type DoorWorld,
  dropDoorWorld,
  insertShare,
  memberContext,
} from "~/tests/security/portal-doors/fixture"

let w: DoorWorld

beforeAll(async () => {
  w = await createDoorWorld()
})

afterAll(async () => {
  await dropDoorWorld(w)
})

const code = (p: Promise<unknown>) =>
  p.then(
    () => "inserted",
    (err: { code?: string }) => err.code,
  )

describe("kernel.portal_shares", () => {
  it("one open share per company, kind and object; a closed one can be opened again", async () => {
    const object = crypto.randomUUID()
    const first = await insertShare(w, { company_id: w.companyA, kind: "file", object_id: object })
    expect(
      await code(insertShare(w, { company_id: w.companyA, kind: "file", object_id: object })),
    ).toBe("23505")
    await insertShare(w, { company_id: w.companyA, kind: "invoices" })
    expect(await code(insertShare(w, { company_id: w.companyA, kind: "invoices" }))).toBe("23505")
    await sql`UPDATE kernel.portal_shares SET closed_at = now(), closed_by_user_id = ${w.admin.userId} WHERE id = ${first}`
    expect(
      await code(insertShare(w, { company_id: w.companyA, kind: "file", object_id: object })),
    ).toBe("inserted")
    // Another company may hold the same object open.
    expect(
      await code(insertShare(w, { company_id: w.companyB, kind: "file", object_id: object })),
    ).toBe("inserted")
  })

  it("a company-wide kind names no object and every other kind names one", async () => {
    expect(
      await code(
        insertShare(w, {
          company_id: w.companyA,
          kind: "requests",
          object_id: crypto.randomUUID(),
        }),
      ),
    ).toBe("23514")
    expect(await code(insertShare(w, { company_id: w.companyA, kind: "agreement" }))).toBe("23514")
  })

  it("a member reads the shares only with a portal scope, and writes none", async () => {
    await insertShare(w, { company_id: w.companyB, kind: "requests" })
    const count = (scopes: string[]) =>
      withRlsContext(memberContext(w, scopes), async (tx) => {
        const r = await attempt(
          tx,
          `SELECT id FROM kernel.portal_shares WHERE org_id = '${w.orgId}'`,
        )
        return "rows" in r ? r.rows.length : r
      })
    expect(await count(["kernel:contacts:read"])).toBe(0)
    expect(await count(["kernel:portal:share"])).toBeGreaterThan(0)
    expect(await count(["kernel:portal:admin"])).toBeGreaterThan(0)
    const write = await withRlsContext(memberContext(w, ["*"]), (tx) =>
      attempt(
        tx,
        insertSql("kernel.portal_shares", {
          org_id: w.orgId,
          company_id: w.companyA,
          kind: "requests",
          shared_by_user_id: w.member.userId,
        }),
      ),
    )
    expect(write).toMatchObject({ code: "42501" })
  })
})
