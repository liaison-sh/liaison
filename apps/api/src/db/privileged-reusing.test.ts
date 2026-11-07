// SPDX-License-Identifier: FSL-1.1-ALv2
//
// withPrivilegedReusing: on a privileged transaction of the same org it runs on
// that transaction (no second privileged slot, so no nested acquisition);
// anywhere else it takes a privileged transaction of its own, and it never
// elevates the caller's transaction in place. The suite runs with
// NESTED_PRIVILEGED_STRICT=1, so a nested acquisition here would throw.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import {
  PrivilegedDbTestAccess,
  withPrivilegedDb,
  withPrivilegedReusing,
  withSystemDb,
} from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { ensureOrg } from "~/modules/provisioning/ensure-org"

let ORG_ID = ""
let OTHER_ORG_ID = ""

/** A request context in ORG_ID: its GUCs are all the probe reads. */
function ctx(): UserContext {
  return {
    actorType: "user",
    userId: crypto.randomUUID(),
    orgId: ORG_ID,
    scopes: [],
    dimensionGrants: {},
  }
}

type Probe = { pid: number; role: string; org: string }

async function probe(tx: Pick<RlsClient, "execute">): Promise<Probe> {
  const [row] = extractRows<Probe>(
    await tx.execute(drizzleSql`
      SELECT pg_backend_pid() AS pid, current_user::text AS role,
             current_setting('app.current_org_id', true) AS org`),
  )
  if (!row) throw new Error("no probe row")
  return row
}

let strictBefore: string | undefined

beforeAll(async () => {
  strictBefore = process.env.NESTED_PRIVILEGED_STRICT
  process.env.NESTED_PRIVILEGED_STRICT = "1"
  const tag = crypto.randomUUID().slice(0, 8)
  ORG_ID = (await ensureOrg({ slug: `priv-reuse-${tag}`, name: "Privileged Reuse" })).orgId
  OTHER_ORG_ID = (
    await ensureOrg({ slug: `priv-reuse-other-${tag}`, name: "Privileged Reuse Other" })
  ).orgId
})

afterAll(() => {
  if (strictBefore === undefined) delete process.env.NESTED_PRIVILEGED_STRICT
  else process.env.NESTED_PRIVILEGED_STRICT = strictBefore
})

describe("withPrivilegedReusing", () => {
  it("runs on a held privileged transaction of the same org: one slot, the caller's connection", async () => {
    PrivilegedDbTestAccess.record()
    const { outer, inner } = await withPrivilegedDb(ORG_ID, "reuse-outer", async (tx) => {
      const outer = await probe(tx)
      const inner = await withPrivilegedReusing(tx, ORG_ID, "reuse-inner", (ptx) => probe(ptx))
      return { outer, inner }
    })
    const acquisitions = PrivilegedDbTestAccess.recorded()
    expect(inner.pid).toBe(outer.pid)
    expect(inner.role).toBe("liaison_admin")
    expect(acquisitions.map((a) => a.reason)).toEqual(["reuse-outer"])
  })

  it("from a privileged transaction of another org, refuses to reuse it (a nested acquisition)", async () => {
    const err = await withPrivilegedDb(OTHER_ORG_ID, "reuse-other-org", (tx) =>
      withPrivilegedReusing(tx, ORG_ID, "reuse-inner", (ptx) => probe(ptx)),
    ).catch((e: Error) => e)
    expect(String(err)).toContain("nested privileged acquisition: reuse-inner")
  })

  it("from an org-less system transaction, does not reuse it", async () => {
    const err = await withSystemDb("reuse-system", (tx) =>
      withPrivilegedReusing(tx, ORG_ID, "reuse-inner", (ptx) => probe(ptx)),
    ).catch((e: Error) => e)
    expect(String(err)).toContain("nested privileged acquisition: reuse-inner")
  })

  it("from a request transaction, takes its own privileged transaction and leaves the caller's role alone", async () => {
    const { outer, inner, after } = await withRlsContext(ctx(), async (tx) => {
      const outer = await probe(tx)
      const inner = await withPrivilegedReusing(tx, ORG_ID, "reuse-from-rls", (ptx) => probe(ptx))
      return { outer, inner, after: await probe(tx) }
    })
    expect(inner.role).toBe("liaison_admin")
    expect(inner.org).toBe(ORG_ID)
    expect(inner.pid).not.toBe(outer.pid)
    expect(after.role).toBe(outer.role)
  })

  it("with no transaction, takes its own privileged transaction", async () => {
    const inner = await withPrivilegedReusing(null, ORG_ID, "reuse-none", (ptx) => probe(ptx))
    expect(inner.role).toBe("liaison_admin")
    expect(inner.org).toBe(ORG_ID)
  })
})
