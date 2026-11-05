// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The elevation helpers on both deployment shapes. With DATABASE_REQUEST_PASSWORD
// (every namespaced run, db/connection.ts) request transactions log in as
// liaison_request, which cannot step into liaison_admin; without it every pool
// logs in as DATABASE_URL, which can. Each helper picks its path from the
// transaction's login, so each is proven on both: this file runs split in the
// unit suite and unsplit in the `unsplit-logins` suite (scripts/test-run.ts,
// LIAISON_TEST_UNSPLIT_LOGINS=1). The connection a statement ran on is
// `pg_backend_pid()`: in place means the caller's own backend.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient, sql } from "~/db"
import { privilegedFrom, withElevatableRlsFrom } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { env } from "~/lib/env"
import { asAdmin } from "~/modules/sharing/service"

const SPLIT = Boolean(env.DATABASE_REQUEST_PASSWORD)
const ORG_ID = crypto.randomUUID()
const OTHER_ORG_ID = crypto.randomUUID()
const USER_ID = crypto.randomUUID()

const ctx: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: [],
  dimensionGrants: {},
}

type Probe = { pid: number; role: string; login: string; org: string }

async function probe(tx: Pick<RlsClient, "execute">): Promise<Probe> {
  const [row] = extractRows<Probe>(
    await tx.execute(drizzleSql`
      SELECT pg_backend_pid() AS pid, current_user::text AS role, session_user::text AS login,
             current_setting('app.current_org_id', true) AS org`),
  )
  if (!row) throw new Error("no probe row")
  return row
}

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null
  return e?.cause?.code ?? e?.code
}

beforeAll(async () => {
  for (const id of [ORG_ID, OTHER_ORG_ID]) {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${id}, 'ElevationBothLogins', ${`elevation-${id.slice(0, 8)}`})`
  }
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
    VALUES (${USER_ID}, ${ORG_ID}, ${`elevation-${USER_ID.slice(0, 8)}@test.com`}, 'elevator', 'x')`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.users WHERE id = ${USER_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_ID}, ${OTHER_ORG_ID})`
})

describe(`elevation helpers (${SPLIT ? "split" : "unsplit"} logins)`, () => {
  it("a request transaction logs in as the setup says", async () => {
    const p = await withRlsContext(ctx, probe)
    expect(p.role).toBe("liaison_rls")
    if (SPLIT) expect(p.login).toBe("liaison_request")
    else expect(p.login).not.toBe("liaison_request")
  })

  it("privilegedFrom runs as liaison_admin, in place only when the login can elevate", async () => {
    const { outer, inner, after } = await withRlsContext(ctx, async (tx) => {
      const outer = await probe(tx)
      const inner = await privilegedFrom(tx, ORG_ID, "elevation-test", (ptx) => probe(ptx))
      return { outer, inner, after: await probe(tx) }
    })
    expect(inner.role).toBe("liaison_admin")
    expect(inner.pid === outer.pid).toBe(!SPLIT)
    expect(after.role).toBe("liaison_rls")
  })

  it("withElevatableRlsFrom keeps the actor, on the caller's transaction only when it can elevate", async () => {
    const { outer, inner, elevated, after } = await withRlsContext(ctx, async (tx) => {
      const outer = await probe(tx)
      const { inner, elevated } = await withElevatableRlsFrom(
        tx,
        "elevation-test",
        async (etx) => ({
          inner: await probe(etx),
          elevated: await asAdmin(etx, () => probe(etx)),
        }),
      )
      return { outer, inner, elevated, after: await probe(tx) }
    })
    expect(inner.org).toBe(ORG_ID)
    expect(inner.role).toBe("liaison_rls")
    expect(inner.pid === outer.pid).toBe(!SPLIT)
    expect(inner.login).not.toBe("liaison_request")
    expect(elevated.role).toBe("liaison_admin")
    expect(after.role).toBe("liaison_rls")
  })

  it("asAdmin on a request transaction elevates in place unsplit and is refused split", async () => {
    const attempt = withRlsContext(ctx, (tx) => asAdmin(tx, () => probe(tx)))
    if (SPLIT) await expect(attempt).rejects.toThrow(/cannot step into liaison_admin/)
    else expect((await attempt).role).toBe("liaison_admin")
  })

  it("a definer function runs from a request transaction for its own org only", async () => {
    await withRlsContext(ctx, (tx) =>
      tx.execute(
        drizzleSql`SELECT kernel.tickets_move_team_segment_code(${ORG_ID}::uuid, 'a', 'b')`,
      ),
    )
    await withRlsContext(ctx, (tx) =>
      tx.execute(
        drizzleSql`SELECT kernel.recompute_search_acl('kernel.contact', ${crypto.randomUUID()}::uuid)`,
      ),
    )
    const foreign = await withRlsContext(ctx, (tx) =>
      tx.execute(
        drizzleSql`SELECT kernel.tickets_move_team_segment_code(${OTHER_ORG_ID}::uuid, 'a', 'b')`,
      ),
    ).then(
      () => "allowed",
      (err) => pgCode(err),
    )
    expect(foreign).toBe("42501")
  })
})
