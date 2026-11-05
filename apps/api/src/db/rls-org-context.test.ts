// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org a request transaction runs under cannot be changed from inside it.
// withRlsContext sets `app.current_org_id` together with a tag only the server
// can compute; the policies read the org through `rls_ctx.org_id()`, which
// accepts it on the request login only with a matching tag. SQL run from a
// request transaction (liaison_request) that sets the org variable itself, or
// clears it, reads no row of another org and cannot act on one through the
// SECURITY DEFINER functions. Split logins only: unsplit, the request login is
// the privileged one, which reaches BYPASSRLS anyway.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type SystemContext, withRlsContext } from "~/db/rls"
import { env } from "~/lib/env"

const SPLIT = Boolean(env.DATABASE_REQUEST_PASSWORD)
const ORG_A = randomUUID()
const ORG_B = randomUUID()
const ctxA: SystemContext = { actorType: "system", orgId: ORG_A, purpose: "job" }

function pgCode(err: unknown): string {
  const e = err as { code?: string; cause?: { code?: string } } | null
  return e?.cause?.code ?? e?.code ?? "unknown"
}

async function rolesOf(tx: Pick<RlsClient, "execute">, org: string): Promise<number> {
  const [row] = extractRows<{ n: number }>(
    await tx.execute(drizzleSql`SELECT count(*)::int AS n FROM kernel.roles WHERE org_id = ${org}`),
  )
  return row?.n ?? -1
}

class RollBack extends Error {}

/** Run `statements` in a savepoint, count org B's roles there, roll the savepoint back. */
async function forgedRead(tx: RlsClient, ...statements: string[]): Promise<number> {
  let n = -1
  try {
    await tx.transaction(async (sp) => {
      for (const statement of statements) await sp.execute(drizzleSql.raw(statement))
      n = await rolesOf(sp, ORG_B)
      throw new RollBack()
    })
  } catch (err) {
    if (!(err instanceof RollBack)) throw err
  }
  return n
}

beforeAll(async () => {
  for (const id of [ORG_A, ORG_B]) {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${id}, 'RlsOrgContext', ${`rls-org-context-${id.slice(0, 8)}`})`
    await sql`INSERT INTO kernel.roles (org_id, name) VALUES (${id}, 'probe')`
  }
})

afterAll(async () => {
  await sql`DELETE FROM kernel.roles WHERE org_id IN (${ORG_A}, ${ORG_B})`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
})

describe.if(SPLIT)("the org context of a request transaction", () => {
  test("reads its own org's rows and none of another's", async () => {
    const counts = await withRlsContext(ctxA, async (tx) => ({
      own: await rolesOf(tx, ORG_A),
      other: await rolesOf(tx, ORG_B),
    }))
    expect(counts).toEqual({ own: 1, other: 0 })
  })

  test("setting the org variable from inside reads 0 rows of the other org", async () => {
    const results = await withRlsContext(ctxA, async (tx) => {
      const tag = extractRows<{ t: string }>(
        await tx.execute(drizzleSql`SELECT current_setting('app.current_org_tag', true) AS t`),
      )[0]?.t
      return {
        setConfig: await forgedRead(
          tx,
          `SELECT set_config('app.current_org_id', '${ORG_B}', true)`,
        ),
        setLocal: await forgedRead(tx, `SET LOCAL app.current_org_id = '${ORG_B}'`),
        // The tag of the transaction's own org does not fit another org.
        reuseTag: await forgedRead(
          tx,
          `SELECT set_config('app.current_org_id', '${ORG_B}', true), set_config('app.current_org_tag', '${tag}', true)`,
        ),
        afterResetRole: await forgedRead(
          tx,
          "RESET ROLE",
          "SET LOCAL ROLE liaison_rls",
          `SELECT set_config('app.current_org_id', '${ORG_B}', true)`,
        ),
        // The real context still reads its own org afterwards.
        own: await rolesOf(tx, ORG_A),
      }
    })
    expect(results).toEqual({ setConfig: 0, setLocal: 0, reuseTag: 0, afterResetRole: 0, own: 1 })
  })

  test("a forged or cleared org does not reach another org through a definer function", async () => {
    const codes = await withRlsContext(ctxA, async (tx) => {
      const out: Record<string, string> = {}
      for (const [name, value] of [
        ["forged", ORG_B],
        ["cleared", ""],
      ] as const) {
        try {
          await tx.transaction(async (sp) => {
            await sp.execute(drizzleSql`SELECT set_config('app.current_org_id', ${value}, true)`)
            await sp.execute(
              drizzleSql`SELECT kernel.lock_live_message(${ORG_B}::uuid, ${randomUUID()}::uuid)`,
            )
          })
          out[name] = "allowed"
        } catch (err) {
          out[name] = pgCode(err)
        }
      }
      return out
    })
    expect(codes).toEqual({ forged: "42501", cleared: "42501" })
  })

  test("the privileged pool keeps its plain org variable", async () => {
    const n = await withPrivilegedDb(ORG_B, "rls-org-context-test", async (tx) => {
      const [row] = extractRows<{ org: string }>(
        await tx.execute(drizzleSql`SELECT rls_ctx.org_id() AS org`),
      )
      return row?.org
    })
    expect(n).toBe(ORG_B)
  })
})

describe("what reads the org variable", () => {
  test("no policy or function outside rls_ctx reads app.current_org_id itself", async () => {
    const pattern = "current_setting\\(\\s*'app\\.current_org_id'"
    const policies = await sql<{ name: string }[]>`
      SELECT p.polrelid::regclass::text || ' ' || p.polname AS name
        FROM pg_policy p
       WHERE coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ ${pattern}
          OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ ${pattern}`
    const functions = await sql<{ name: string }[]>`
      SELECT p.oid::regprocedure::text AS name
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prosrc ~ ${pattern} AND n.nspname <> 'rls_ctx'`
    expect({
      policies: policies.map((r) => r.name),
      functions: functions.map((r) => r.name),
    }).toEqual({ policies: [], functions: [] })
  })
})
