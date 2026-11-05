// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The user a request transaction runs as cannot be changed from inside it,
// like its org (rls-org-context.test.ts). withRlsContext sets
// `app.current_user_id` together with a tag only the server can compute; the
// policies read the user through `rls_ctx.user_id()`, which accepts it on the
// request login only with a matching tag. SQL run from a request transaction
// that sets the user variable itself reads no other user's rows, and clearing
// it does not turn the transaction into a system context (the nil uuid some
// policies exempt). Split logins only: unsplit, the request login is the
// privileged one, which reaches BYPASSRLS anyway.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { env } from "~/lib/env"

const SPLIT = Boolean(env.DATABASE_REQUEST_PASSWORD)
const NIL = "00000000-0000-0000-0000-000000000000"
const ORG_A = randomUUID()
const ORG_B = randomUUID()
const USER_A = randomUUID()
const USER_A2 = randomUUID()
const USER_B = randomUUID()

const ctxA: UserContext = {
  actorType: "user",
  userId: USER_A,
  orgId: ORG_A,
  scopes: [],
  dimensionGrants: {},
}

async function prefsOf(tx: Pick<RlsClient, "execute">, user: string): Promise<number> {
  const [row] = extractRows<{ n: number }>(
    await tx.execute(
      drizzleSql`SELECT count(*)::int AS n FROM kernel.user_preferences WHERE user_id = ${user}::uuid`,
    ),
  )
  return row?.n ?? -1
}

class RollBack extends Error {}

/** Run `statements` in a savepoint, then `read` there, and roll the savepoint back. */
async function forged<T>(
  tx: RlsClient,
  statements: string[],
  read: (sp: RlsClient) => Promise<T>,
): Promise<T | undefined> {
  let out: T | undefined
  try {
    await tx.transaction(async (sp) => {
      for (const statement of statements) await sp.execute(drizzleSql.raw(statement))
      out = await read(sp as RlsClient)
      throw new RollBack()
    })
  } catch (err) {
    if (!(err instanceof RollBack)) throw err
  }
  return out
}

async function readerValue(tx: Pick<RlsClient, "execute">): Promise<string | null> {
  const [row] = extractRows<{ u: string | null }>(
    await tx.execute(drizzleSql`SELECT rls_ctx.user_id() AS u`),
  )
  return row?.u ?? null
}

beforeAll(async () => {
  for (const [org, users] of [
    [ORG_A, [USER_A, USER_A2]],
    [ORG_B, [USER_B]],
  ] as const) {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${org}, 'RlsUserContext', ${`rls-user-context-${org.slice(0, 8)}`})`
    for (const user of users) {
      await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name)
        VALUES (${user}, ${org}, ${`rls-user-${user.slice(0, 8)}@example.test`}, 'x', 'Probe')`
      await sql`INSERT INTO kernel.user_preferences (user_id) VALUES (${user})`
    }
  }
})

afterAll(async () => {
  await sql`DELETE FROM kernel.users WHERE id IN (${USER_A}, ${USER_A2}, ${USER_B})`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
})

describe.if(SPLIT)("the user context of a request transaction", () => {
  test("reads its own user's preferences and no one else's", async () => {
    const counts = await withRlsContext(ctxA, async (tx) => ({
      own: await prefsOf(tx, USER_A),
      sameOrg: await prefsOf(tx, USER_A2),
      otherOrg: await prefsOf(tx, USER_B),
    }))
    expect(counts).toEqual({ own: 1, sameOrg: 0, otherOrg: 0 })
  })

  test("setting the user variable from inside reads 0 rows of the other user", async () => {
    const results = await withRlsContext(ctxA, async (tx) => {
      const tag = extractRows<{ t: string | null }>(
        await tx.execute(drizzleSql`SELECT current_setting('app.current_user_tag', true) AS t`),
      )[0]?.t
      const read = (user: string) => (sp: RlsClient) => prefsOf(sp, user)
      return {
        setConfig: await forged(
          tx,
          [`SELECT set_config('app.current_user_id', '${USER_B}', true)`],
          read(USER_B),
        ),
        setLocal: await forged(tx, [`SET LOCAL app.current_user_id = '${USER_A2}'`], read(USER_A2)),
        // The tag of the transaction's own user does not fit another user.
        reuseTag: await forged(
          tx,
          [
            `SELECT set_config('app.current_user_id', '${USER_A2}', true), set_config('app.current_user_tag', '${tag ?? ""}', true)`,
          ],
          read(USER_A2),
        ),
        afterResetRole: await forged(
          tx,
          [
            "RESET ROLE",
            "SET LOCAL ROLE liaison_rls",
            `SELECT set_config('app.current_user_id', '${USER_B}', true)`,
          ],
          read(USER_B),
        ),
        own: await prefsOf(tx, USER_A),
      }
    })
    expect(results).toEqual({ setConfig: 0, setLocal: 0, reuseTag: 0, afterResetRole: 0, own: 1 })
  })

  test("a forged or cleared user is no user, never the system sentinel", async () => {
    const values = await withRlsContext(ctxA, async (tx) => ({
      own: await readerValue(tx),
      forged: await forged(
        tx,
        [`SELECT set_config('app.current_user_id', '${USER_B}', true)`],
        readerValue,
      ),
      nil: await forged(
        tx,
        [`SELECT set_config('app.current_user_id', '${NIL}', true)`],
        readerValue,
      ),
      cleared: await forged(
        tx,
        ["SELECT set_config('app.current_user_id', '', true)"],
        readerValue,
      ),
    }))
    expect(values.own).toBe(USER_A)
    for (const v of [values.forged, values.nil, values.cleared]) {
      expect(v).not.toBe(USER_B)
      expect(v).not.toBe(NIL)
      expect(v).not.toBe("")
      expect(v).not.toBeNull()
    }
  })

  test("a system context keeps its nil user", async () => {
    const v = await withRlsContext(
      { actorType: "system", orgId: ORG_A, purpose: "job" },
      readerValue,
    )
    expect(v).toBe(NIL)
  })

  test("the privileged pool keeps its plain user variable", async () => {
    const v = await withPrivilegedDb(ORG_B, "rls-user-context-test", async (tx) => {
      await tx.execute(drizzleSql`SELECT set_config('app.current_user_id', ${USER_B}, true)`)
      return readerValue(tx)
    })
    expect(v).toBe(USER_B)
  })
})

describe("what reads the user variable", () => {
  test("no policy or function outside rls_ctx reads app.current_user_id itself", async () => {
    const pattern = "current_setting\\(\\s*'app\\.current_user_id'"
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
