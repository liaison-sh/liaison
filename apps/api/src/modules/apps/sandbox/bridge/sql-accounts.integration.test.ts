// SPDX-License-Identifier: FSL-1.1-ALv2
// The generic bridge methods a sandboxed app uses instead of a privileged
// handle, through the real bridge and the real test database:
//   - ctx.sql.*: a query on the pool the platform holds for the org's SQL
//     connection (the credentials never cross into the answer), the row cap,
//     the statement timeout cancelled on the database, another org reaching
//     nothing, the pool closed when the account is disconnected, an audit line;
//   - ctx.accounts.*: the app's own accounts, the org's and the caller's own
//     only, metadata changed under the connection's admin scope only;
//   - ctx.kernel.findByIds: the caller's org only.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import {
  createCredentialConnection,
  disconnectConnection,
} from "~/modules/apps/connections/service"
import { SqlPoolTestAccess } from "~/modules/apps/connections/sql/pool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "sqlprobe"
// Set in beforeAll: org A (Alice its admin, Bob a member), org B (Carol).
let ORG_A = ""
let ORG_B = ""
let ALICE = ""
let BOB = ""
let CAROL = ""
let ACC_A_SQL = ""
let ACC_A_ORG = ""
let ACC_A_ALICE = ""
let ACC_A_BOB = ""
let ACC_B_ORG = ""
const NO_SUCH_USER = "00000000-0000-4000-8000-0000000e5b99"

const DSN =
  process.env.DATABASE_URL ?? "postgres://liaison_app:liaison_app@localhost:5432/liaison_test"

const manifest = {
  name: APP,
  schema: {},
  events: {},
  network: {},
  connections: {
    warehouse: {
      type: "credentials",
      allowedDomains: [],
      credentialFields: [{ name: "connectionString", type: "password" }],
      sql: { rawQuery: { scope: `${APP}:query:read` } },
    },
    drive: { type: "credentials", allowedDomains: [], credentialFields: [] },
  },
}

const saved = {
  privileged: process.env.LIAISON_DB_ALLOW_PRIVILEGED_SESSION,
  plaintext: process.env.LIAISON_DB_ALLOW_PLAINTEXT_LOCAL,
}

/** An account through the connections service, as a connect would store it. */
async function connect(
  org: string,
  user: string,
  connection: string,
  identifier: string,
  ownerType: "org" | "user",
  credentials: Record<string, string> = { token: "unused-in-these-tests" },
): Promise<string> {
  const dto = await withPrivilegedDb(org, "test-sql-accounts-connect", (tx) =>
    createCredentialConnection(tx as never, org, user, APP, connection, {
      identifier,
      credentials,
      ownerType,
    }),
  )
  return dto.id
}

beforeAll(async () => {
  await acquireTestLock()
  // The test database's own login reaches privileged roles: the transport's
  // pre-flight refuses that unless the operator opts out (as the database app's
  // integration suite does). Loopback plaintext is the local opt-in.
  process.env.LIAISON_DB_ALLOW_PRIVILEGED_SESSION = "true"
  process.env.LIAISON_DB_ALLOW_PLAINTEXT_LOCAL = "true"
  ORG_A = (await createTestOrg()).id
  ALICE = (await minimal.orgAdmin(ORG_A)).id
  BOB = (await minimal.person(ORG_A)).id
  const second = await minimal.secondOrg()
  ORG_B = second.orgId
  CAROL = second.adminUserId
  ACC_A_SQL = await connect(ORG_A, ALICE, "warehouse", "warehouse", "org", {
    connectionString: DSN,
  })
  ACC_A_ORG = await connect(ORG_A, ALICE, "drive", "org@a.test", "org")
  ACC_A_ALICE = await connect(ORG_A, ALICE, "drive", "alice@a.test", "user")
  ACC_A_BOB = await connect(ORG_A, BOB, "drive", "bob@a.test", "user")
  ACC_B_ORG = await connect(ORG_B, CAROL, "drive", "org@b.test", "org")
}, 120_000)

afterAll(async () => {
  SqlPoolTestAccess.reset()
  for (const [k, v] of [
    ["LIAISON_DB_ALLOW_PRIVILEGED_SESSION", saved.privileged],
    ["LIAISON_DB_ALLOW_PLAINTEXT_LOCAL", saved.plaintext],
  ] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await releaseTestLock()
})

beforeEach(() => SqlPoolTestAccess.reset())

/** Calls one bridge method as `user` of `org`, inside that person's RLS transaction. */
function asUser<T>(
  org: string,
  user: string,
  scopes: string[],
  fn: (bridge: Record<string, any>) => Promise<T>,
): Promise<T> {
  return withRlsContext(
    { actorType: "user", userId: user, orgId: org, scopes, dimensionGrants: {} },
    (tx) => fn(createRpcBridge(APP, user, org, tx as never, manifest as never, scopes)),
  )
}

const QUERY_SCOPES = [`${APP}:query:read`]

describe("ctx.sql on a platform-held connection", () => {
  it("answers rows from the org's connection; the credentials never appear", async () => {
    const out: string = await asUser(ORG_A, ALICE, QUERY_SCOPES, (b) =>
      b.sql_query("warehouse", JSON.stringify({ sql: "SELECT $1::int AS n", params: [7] })),
    )
    expect(JSON.parse(out)).toMatchObject({ rows: [{ n: 7 }], truncated: false })
    const password = new URL(DSN).password
    if (password) expect(out).not.toContain(password)
    expect(out).not.toContain(DSN)
    expect(SqlPoolTestAccess.keys()).toEqual([`${ORG_A}::${APP}::warehouse::`])
  })

  it("caps the rows", async () => {
    const out = JSON.parse(
      await asUser(ORG_A, ALICE, QUERY_SCOPES, (b) =>
        b.sql_query(
          "warehouse",
          JSON.stringify({ sql: "SELECT generate_series(1, 50) AS n", maxRows: 10 }),
        ),
      ),
    )
    expect(out.rows).toHaveLength(10)
    expect(out.truncated).toBe(true)
  })

  it("cancels a statement past its timeout on the database", async () => {
    const started = Date.now()
    const out = JSON.parse(
      await asUser(ORG_A, ALICE, QUERY_SCOPES, (b) =>
        b.sql_query(
          "warehouse",
          JSON.stringify({
            sql: "SELECT count(*) FROM generate_series(1, 2000000000) AS g",
            timeoutMs: 1_000,
          }),
        ),
      ),
    )
    expect(out.error?.code).toBe("statement_timeout")
    expect(Date.now() - started).toBeLessThan(8_000)
  }, 20_000)

  it("refuses without the declared scope", async () => {
    const out = JSON.parse(
      await asUser(ORG_A, ALICE, [], (b) =>
        b.sql_query("warehouse", JSON.stringify({ sql: "SELECT 1 AS n" })),
      ),
    )
    expect(out.error.code).toBe("forbidden")
    expect(SqlPoolTestAccess.size()).toBe(0)
  })

  it("another org reaches nothing: its own (absent) connection, never org A's pool", async () => {
    await asUser(ORG_A, ALICE, QUERY_SCOPES, (b) =>
      b.sql_query("warehouse", JSON.stringify({ sql: "SELECT 1 AS n" })),
    )
    const out = JSON.parse(
      await asUser(ORG_B, CAROL, QUERY_SCOPES, (b) =>
        b.sql_query("warehouse", JSON.stringify({ sql: "SELECT 1 AS n" })),
      ),
    )
    expect(out.error.code).toBe("not_connected")
    expect(SqlPoolTestAccess.keys()).toEqual([`${ORG_A}::${APP}::warehouse::`])
  })

  it("writes an audit line for the call, without the SQL", async () => {
    await asUser(ORG_A, ALICE, QUERY_SCOPES, (b) =>
      b.sql_query("warehouse", JSON.stringify({ sql: "SELECT 42 AS answer" })),
    )
    const rows = await sql<{ action: string; metadata: Record<string, unknown> }[]>`
      SELECT action, metadata FROM kernel.audit_log
      WHERE org_id = ${ORG_A} AND app = ${APP} AND action = 'sql.query'
      ORDER BY "timestamp" DESC LIMIT 1`
    expect(rows[0]?.metadata).toMatchObject({ connection: "warehouse", outcome: "success" })
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain("SELECT")
  })

  it("closes the pool when the account is disconnected", async () => {
    await asUser(ORG_A, ALICE, QUERY_SCOPES, (b) =>
      b.sql_query("warehouse", JSON.stringify({ sql: "SELECT 1 AS n" })),
    )
    expect(SqlPoolTestAccess.size()).toBe(1)
    await withPrivilegedDb(ORG_A, "test-disconnect", (tx) =>
      disconnectConnection(tx, ORG_A, ALICE, ACC_A_SQL),
    )
    expect(SqlPoolTestAccess.size()).toBe(0)
    const out = JSON.parse(
      await asUser(ORG_A, ALICE, QUERY_SCOPES, (b) =>
        b.sql_query("warehouse", JSON.stringify({ sql: "SELECT 1 AS n" })),
      ),
    )
    expect(out.error.code).toBe("not_connected")
  })
})

describe("ctx.accounts: the app's own accounts", () => {
  it("lists the org's account and the caller's own, never another member's or org's", async () => {
    const out = JSON.parse(
      await asUser(ORG_A, ALICE, [], (b) => b.accounts_list("drive")),
    ) as Array<{ id: string; canManage: boolean; metadata: unknown }>
    expect(out.map((a) => a.id).sort()).toEqual([ACC_A_ORG, ACC_A_ALICE].sort())
    expect(out.find((a) => a.id === ACC_A_ALICE)?.canManage).toBe(true)
    // The org's account is managed under the connection's admin scope only.
    expect(out.find((a) => a.id === ACC_A_ORG)?.canManage).toBe(false)
    expect(out[0]?.metadata).toEqual({})
    expect(JSON.stringify(out)).not.toContain("credentials")
  })

  it("refuses a connection the manifest does not declare", async () => {
    await expect(asUser(ORG_A, ALICE, [], (b) => b.accounts_list("other"))).rejects.toThrow(
      /not declared/,
    )
  })

  it("changes the org account's metadata only with the admin scope", async () => {
    await expect(
      asUser(ORG_A, ALICE, [], (b) =>
        b.accounts_setMetadata(ACC_A_ORG, JSON.stringify({ sharedDrives: ["d1"] })),
      ),
    ).rejects.toThrow(/accounts:admin/)
    const changed = JSON.parse(
      await asUser(ORG_A, ALICE, [`${APP}:accounts:admin`], (b) =>
        b.accounts_setMetadata(ACC_A_ORG, JSON.stringify({ sharedDrives: ["d1"] })),
      ),
    )
    expect(changed.metadata).toEqual({ sharedDrives: ["d1"] })
  })

  it("never reaches another member's account or another org's", async () => {
    for (const id of [ACC_A_BOB, ACC_B_ORG]) {
      await expect(
        asUser(ORG_A, ALICE, [`${APP}:accounts:admin`], (b) =>
          b.accounts_setMetadata(id, JSON.stringify({ x: 1 })),
        ),
      ).rejects.toThrow(/no such account/)
    }
    const [bob] = await sql<{ metadata: unknown }[]>`
      SELECT metadata FROM kernel.connected_accounts WHERE id = ${ACC_A_BOB}`
    expect(bob?.metadata ?? {}).toEqual({})
  })
})

describe("ctx.kernel.findByIds", () => {
  it("answers the caller's org's users only, their directory fields only", async () => {
    const out = JSON.parse(
      await asUser(ORG_A, ALICE, ["*"], (b) =>
        b.kernel_findByIds(
          "users",
          JSON.stringify([ALICE, BOB, CAROL, NO_SUCH_USER, "not-a-uuid"]),
        ),
      ),
    ) as Array<Record<string, unknown>>
    expect(out.map((u) => u.id).sort()).toEqual([ALICE, BOB].sort())
    for (const u of out) expect(u).not.toHaveProperty("password_hash")
  })
})
