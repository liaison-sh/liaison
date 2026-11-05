// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The scopes, dimension grants and roles a request transaction runs with
// cannot be changed from inside it, like its org (rls-org-context.test.ts) and
// user (rls-user-context.test.ts). withRlsContext sets each variable with a tag
// only the server can compute, and rls_ctx.enter() keeps the verified values
// for the rest of the transaction; the policies and helper functions read
// them through rls_ctx.scopes() / dimensions() / roles(). SQL run from a
// request transaction that sets a variable itself gains no scope, grant or
// role. Split logins only: unsplit, the request login is the privileged one,
// which reaches BYPASSRLS anyway.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { env } from "~/lib/env"

const SPLIT = Boolean(env.DATABASE_REQUEST_PASSWORD)
const ORG = randomUUID()
const USER = randomUUID()
const ROLE = randomUUID()

const member: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["kernel:threads:read"],
  dimensionGrants: {},
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

async function one<T>(tx: Pick<RlsClient, "execute">, query: string): Promise<T | undefined> {
  const [row] = extractRows<{ v: T }>(await tx.execute(drizzleSql.raw(query)))
  return row?.v
}

const isAdmin = (tx: RlsClient) => one<boolean>(tx, "SELECT kernel.session_is_admin() AS v")
const policies = (tx: RlsClient) =>
  one<number>(tx, `SELECT count(*)::int AS v FROM kernel.approval_policies WHERE org_id = '${ORG}'`)
const anyGrant = (tx: RlsClient) =>
  one<boolean>(tx, "SELECT kernel.has_dimension_value('tickets:team', 'probe') AS v")
const holdsRole = (tx: RlsClient) => one<boolean>(tx, `SELECT kernel.has_role('${ROLE}') AS v`)

/** The ways SQL inside the transaction can set a variable, each with `value`. */
function forgeries(variable: string, value: string, tag: string | undefined): string[][] {
  return [
    [`SELECT set_config('${variable}', '${value}', true)`],
    [`SET LOCAL ${variable} = '${value}'`],
    // The tag of the transaction's own value does not fit another value.
    [
      `SELECT set_config('${variable}', '${value}', true), set_config('${variable}_tag', '${tag ?? ""}', true)`,
    ],
    [
      "RESET ROLE",
      "SET LOCAL ROLE liaison_rls",
      `SELECT set_config('${variable}', '${value}', true)`,
    ],
    // Calling the verifier again after forging stores nothing that did not verify.
    [`SELECT set_config('${variable}', '${value}', true)`, "SELECT rls_ctx.enter()"],
  ]
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'RlsGrantsContext', ${`rls-grants-context-${ORG.slice(0, 8)}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name)
    VALUES (${USER}, ${ORG}, ${`rls-grants-${USER.slice(0, 8)}@example.test`}, 'x', 'Probe')`
  await sql`INSERT INTO kernel.approval_policies (org_id, tool_name) VALUES (${ORG}, 'probe_tool')`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.approval_policies WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE id = ${USER}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe.if(SPLIT)("the grants of a request transaction", () => {
  test("its own scopes, grants and roles hold", async () => {
    const out = await withRlsContext(
      {
        ...member,
        scopes: ["kernel"],
        dimensionGrants: { "tickets:team": ["probe"] },
        roles: [ROLE],
      },
      async (tx) => ({
        admin: await isAdmin(tx),
        policies: await policies(tx),
        grant: await anyGrant(tx),
        role: await holdsRole(tx),
      }),
    )
    expect(out).toEqual({ admin: true, policies: 1, grant: true, role: true })
  })

  test("setting the scopes variable from inside grants no scope", async () => {
    const out = await withRlsContext(member, async (tx) => {
      const tag = await one<string>(
        tx,
        "SELECT current_setting('app.current_scopes_tag', true) AS v",
      )
      const results: Array<{ admin?: boolean; policies?: number }> = []
      for (const statements of forgeries("app.current_scopes", "*", tag)) {
        results.push({
          admin: await forged(tx, statements, isAdmin),
          policies: await forged(tx, statements, policies),
        })
      }
      return { results, own: await one<string>(tx, "SELECT rls_ctx.scopes() AS v") }
    })
    expect(out.results).toEqual(Array(5).fill({ admin: false, policies: 0 }))
    expect(out.own).toBe("kernel:threads:read")
  })

  test("setting the dimensions variable from inside grants no dimension", async () => {
    const out = await withRlsContext(member, async (tx) => {
      const tag = await one<string>(
        tx,
        "SELECT current_setting('app.current_dimensions_tag', true) AS v",
      )
      const results: Array<boolean | undefined> = []
      for (const statements of forgeries("app.current_dimensions", '{"*":["*"]}', tag)) {
        results.push(await forged(tx, statements, anyGrant))
      }
      return { results, own: await one<string>(tx, "SELECT rls_ctx.dimensions() AS v") }
    })
    expect(out.results).toEqual([false, false, false, false, false])
    expect(out.own).toBe("{}")
  })

  test("setting the roles variable from inside grants no role", async () => {
    const out = await withRlsContext(member, async (tx) => {
      const tag = await one<string>(
        tx,
        "SELECT current_setting('app.current_roles_tag', true) AS v",
      )
      const results: Array<boolean | undefined> = []
      for (const statements of forgeries("app.current_roles", ROLE, tag)) {
        results.push(await forged(tx, statements, holdsRole))
      }
      return { results, own: await one<string>(tx, "SELECT rls_ctx.roles() AS v") }
    })
    expect(out.results).toEqual([false, false, false, false, false])
    expect(out.own).toBe("__none__")
  })

  test("the verified copies are not listed among the settings", async () => {
    const listed = await withRlsContext(member, (tx) =>
      one<number>(tx, "SELECT count(*)::int AS v FROM pg_settings WHERE name LIKE 'rls\\_ctx%'"),
    )
    expect(listed).toBe(0)
  })

  test("the privileged pool keeps its plain variables", async () => {
    const out = await withPrivilegedDb(ORG, "rls-grants-context-test", async (tx) => {
      await tx.execute(drizzleSql`SELECT set_config('app.current_scopes', 'kernel', true),
        set_config('app.current_dimensions', '{"x":["y"]}', true),
        set_config('app.current_roles', ${ROLE}, true)`)
      return {
        scopes: await one<string>(tx, "SELECT rls_ctx.scopes() AS v"),
        dimensions: await one<string>(tx, "SELECT rls_ctx.dimensions() AS v"),
        roles: await one<string>(tx, "SELECT rls_ctx.roles() AS v"),
      }
    })
    expect(out).toEqual({ scopes: "kernel", dimensions: '{"x":["y"]}', roles: ROLE })
  })
})

describe("what reads the grant variables", () => {
  test("no policy or function outside rls_ctx reads app.current_scopes, _dimensions or _roles itself", async () => {
    const pattern = "current_setting\\(\\s*'app\\.current_(scopes|dimensions|roles)'"
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

  test("every policy that holds a sublink reads the request context in a sub-select", async () => {
    // An InitPlan, once per statement. A policy without a sublink keeps the
    // plain call: a first sublink can trip Postgres's policy recursion check.
    const rows = await sql<{ name: string }[]>`
      SELECT p.polrelid::regclass::text || ' ' || p.polname AS name
        FROM pg_policy p
       WHERE coalesce(p.polqual::text, '') || coalesce(p.polwithcheck::text, '') LIKE '%{SUBLINK %'
         AND coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
             coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
             ~ '(?<!SELECT )(?<!SELECT \\()rls_ctx\\.(org_id|user_id|scopes|dimensions|roles)\\(\\)'`
    expect(rows.map((r) => r.name)).toEqual([])
  })
})
