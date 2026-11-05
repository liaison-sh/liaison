// SPDX-License-Identifier: FSL-1.1-ALv2
//
// rls_ctx.enter() (migrations 0186, 0246) checks the request context once per
// transaction and keeps what verifies. These tests pin what that check
// accepts and refuses, and that its result lives in one transaction only:
//
//  - what enter() stores equals what the per-call check (rls_ctx.verified(),
//    the readers' fallback) returns, for every variable and every kind of
//    forged input: an untagged value, another value's tag, an empty value, a
//    cleared tag;
//  - a tag for org A does not admit org B;
//  - a variable changed after enter() changes nothing the readers return, and
//    calling enter() again after the change stores the "none" value;
//  - the next transaction on the same connection starts with nothing entered,
//    and setting the "entered" hint itself finds only empty settings;
//  - withRlsContext leaves the transaction on liaison_rls, and the next
//    transaction on the connection back on the login.
//
// Split logins only: unsplit, the request login is the privileged one, which
// reaches BYPASSRLS anyway and takes every variable as set.
import { afterAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { createPool, requestDatabaseUrl } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { grantContextTag, orgContextTag, type UserContext, withRlsContext } from "~/db/rls"
import { env } from "~/lib/env"

const SPLIT = Boolean(env.DATABASE_REQUEST_PASSWORD)
const ORG_A = randomUUID()
const ORG_B = randomUUID()
const USER = randomUUID()
const ROLE = randomUUID()
const NIL = "00000000-0000-0000-0000-000000000000"
const NOBODY = "ffffffff-ffff-ffff-ffff-ffffffffffff"

const member: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG_A,
  scopes: ["kernel:threads:read", "tickets"],
  dimensionGrants: { "tickets:team": ["probe"] },
  roles: [ROLE],
}

/** One connection on the request login: consecutive transactions share it. */
const onePool = SPLIT ? createPool(1, requestDatabaseUrl() ?? env.DATABASE_URL) : null

afterAll(async () => {
  await onePool?.client.end()
})

class RollBack extends Error {}

type Ctx = { org: string; user: string; scopes: string; dimensions: string; roles: string }

const READ_ALL = `SELECT rls_ctx.org_id() AS org, rls_ctx.user_id() AS "user",
  rls_ctx.scopes() AS scopes, rls_ctx.dimensions() AS dimensions, rls_ctx.roles() AS roles`

async function read(tx: Pick<RlsClient, "execute">, query = READ_ALL): Promise<Ctx> {
  const [row] = extractRows<Ctx>(await tx.execute(drizzleSql.raw(query)))
  if (!row) throw new Error("no row")
  return row
}

/**
 * In a savepoint: run `statements`, call enter(), then read the context twice,
 * from what enter() stored and from the per-call check (the "entered" hint
 * pointed elsewhere sends every reader to it). Rolled back.
 */
async function enteredAndChecked(
  tx: RlsClient,
  statements: string[],
): Promise<{ entered: Ctx; checked: Ctx }> {
  let out: { entered: Ctx; checked: Ctx } | undefined
  try {
    await tx.transaction(async (sp) => {
      for (const statement of statements) await sp.execute(drizzleSql.raw(statement))
      await sp.execute(drizzleSql.raw("SELECT rls_ctx.enter()"))
      const entered = await read(sp)
      await sp.execute(drizzleSql.raw("SELECT set_config('rls_ctx.entered', '0', true)"))
      out = { entered, checked: await read(sp) }
      throw new RollBack()
    })
  } catch (err) {
    if (!(err instanceof RollBack)) throw err
  }
  if (!out) throw new Error("savepoint did not run")
  return out
}

const set = (name: string, value: string) => `SELECT set_config('${name}', '${value}', true)`

describe.if(SPLIT)("rls_ctx.enter() on the request login", () => {
  test("stores its own verified context", async () => {
    const out = await withRlsContext(member, (tx) => enteredAndChecked(tx, []))
    const own = {
      org: ORG_A,
      user: USER,
      scopes: "kernel:threads:read,tickets",
      dimensions: '{"tickets:team":["probe"]}',
      roles: ROLE,
    }
    expect(out.entered).toEqual(own)
    expect(out.checked).toEqual(own)
  })

  test("stores exactly what the per-call check accepts, for every forged input", async () => {
    const bTag = await orgContextTag(ORG_B)
    const otherScopesTag = await grantContextTag("scopes", "kernel:threads:read")
    const cases: Array<{ name: string; statements: string[]; expect: Partial<Ctx> }> = [
      {
        name: "untagged org",
        statements: [set("app.current_org_id", ORG_B)],
        expect: { org: NIL },
      },
      {
        name: "org B with the tag of org B, set from inside",
        // The request login cannot compute this tag; were it ever leaked, the
        // value is B's own, so this pins that the check is the tag, not the text.
        statements: [set("app.current_org_id", ORG_B), set("app.current_org_tag", bTag)],
        expect: { org: ORG_B },
      },
      { name: "empty org", statements: [set("app.current_org_id", "")], expect: { org: NIL } },
      {
        name: "cleared org tag",
        statements: [set("app.current_org_tag", "")],
        expect: { org: NIL },
      },
      {
        name: "user with no tag",
        statements: [set("app.current_user_id", randomUUID())],
        expect: { user: NOBODY },
      },
      {
        name: "user tag reused as org tag",
        statements: [
          "SELECT set_config('app.current_org_tag', current_setting('app.current_user_tag'), true)",
        ],
        expect: { org: NIL },
      },
      {
        name: "scopes widened",
        statements: [set("app.current_scopes", "*")],
        expect: { scopes: "__none__" },
      },
      {
        name: "scopes narrowed with another value's tag",
        statements: [
          set("app.current_scopes", "tickets"),
          set("app.current_scopes_tag", otherScopesTag),
        ],
        expect: { scopes: "__none__" },
      },
      {
        name: "dimensions widened",
        statements: [set("app.current_dimensions", '{"*":["*"]}')],
        expect: { dimensions: "{}" },
      },
      {
        name: "roles forged",
        statements: [set("app.current_roles", randomUUID())],
        expect: { roles: "__none__" },
      },
      {
        name: "roles cleared",
        statements: [set("app.current_roles", "")],
        expect: { roles: "__none__" },
      },
    ]
    const results = await withRlsContext(member, async (tx) => {
      const own = await read(tx)
      const out: Array<{ name: string; entered: Ctx; checked: Ctx; expected: Ctx }> = []
      for (const c of cases) {
        const r = await enteredAndChecked(tx, c.statements)
        out.push({ name: c.name, ...r, expected: { ...own, ...c.expect } })
      }
      return out
    })
    for (const r of results) {
      expect({ name: r.name, ctx: r.entered }).toEqual({ name: r.name, ctx: r.expected })
      expect({ name: r.name, ctx: r.checked }).toEqual({ name: r.name, ctx: r.expected })
    }
  })

  test("a tag for org A does not admit org B", async () => {
    const out = await withRlsContext(member, async (tx) => {
      const aTag = await orgContextTag(ORG_A)
      return enteredAndChecked(tx, [
        set("app.current_org_id", ORG_B),
        set("app.current_org_tag", aTag),
      ])
    })
    expect(out.entered.org).toBe(NIL)
    expect(out.checked.org).toBe(NIL)
  })

  test("a variable changed after enter() changes nothing; entering again stores none", async () => {
    const out = await withRlsContext(member, async (tx) => {
      await tx.execute(drizzleSql.raw(set("app.current_org_id", ORG_B)))
      await tx.execute(drizzleSql.raw(set("app.current_scopes", "*")))
      const after = await read(tx)
      await tx.execute(drizzleSql.raw("SELECT rls_ctx.enter()"))
      return { after, again: await read(tx) }
    })
    expect(out.after.org).toBe(ORG_A)
    expect(out.after.scopes).toBe("kernel:threads:read,tickets")
    expect(out.again.org).toBe(NIL)
    expect(out.again.scopes).toBe("__none__")
  })

  test("the next transaction on the same connection has nothing entered", async () => {
    if (!onePool) throw new Error("split logins expected")
    const first = await withRlsContext(
      member,
      async (tx) => ({
        pid: (await read(tx, "SELECT pg_backend_pid()::text AS org")).org,
        role: (await read(tx, "SELECT current_user::text AS org")).org,
        ctx: await read(tx),
      }),
      { db: onePool.db },
    )
    const next = await onePool.db.transaction(async (tx) => {
      const plain = await read(tx)
      const pid = (await read(tx, "SELECT pg_backend_pid()::text AS org")).org
      const role = (await read(tx, "SELECT current_user::text AS org")).org
      const hint = (await read(tx, "SELECT current_setting('rls_ctx.entered', true) AS org")).org
      // The hint pointed at this backend sends the readers to the slot, which the commit cleared.
      await tx.execute(
        drizzleSql.raw("SELECT set_config('rls_ctx.entered', pg_backend_pid()::text, true)"),
      )
      await tx.execute(drizzleSql.raw(set("app.current_org_id", ORG_A)))
      const forgedHint = await read(tx)
      return { plain, pid, role, hint, forgedHint }
    })
    expect(first.role).toBe("liaison_rls")
    expect(first.ctx.org).toBe(ORG_A)
    expect(next.pid).toBe(first.pid)
    expect(next.role).toBe("liaison_request")
    expect(next.hint ?? "").toBe("")
    expect(next.plain.org).toBe(NIL)
    // The slot's settings outlive the commit only as empty placeholders: no
    // scope, no role, and an org, user and grants that no policy accepts (their
    // casts refuse an empty string). Nothing of the previous transaction.
    expect(next.forgedHint).toEqual({ org: "", user: "", scopes: "", dimensions: "", roles: "" })
  })
})

describe("rls_ctx.enter() on the privileged login", () => {
  test("stores the variables as set", async () => {
    const out = await withPrivilegedDb(ORG_A, "rls-context-enter-test", async (tx) => {
      await tx.execute(drizzleSql`SELECT set_config('app.current_org_id', ${ORG_B}, true),
        set_config('app.current_user_id', ${USER}, true),
        set_config('app.current_scopes', 'kernel', true),
        set_config('app.current_dimensions', '{"x":["y"]}', true),
        set_config('app.current_roles', ${ROLE}, true),
        rls_ctx.enter()`)
      return read(tx)
    })
    expect(out).toEqual({
      org: ORG_B,
      user: USER,
      scopes: "kernel",
      dimensions: '{"x":["y"]}',
      roles: ROLE,
    })
  })
})
