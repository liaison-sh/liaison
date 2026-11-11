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
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { disconnectConnection } from "~/modules/apps/connections/service"
import { SqlPoolTestAccess } from "~/modules/apps/connections/sql/pool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "sqlprobe"
const ORG_A = "00000000-0000-4000-8000-0000000e5a01"
const ORG_B = "00000000-0000-4000-8000-0000000e5b01"
const ALICE = "00000000-0000-4000-8000-0000000e5a11" // org A
const BOB = "00000000-0000-4000-8000-0000000e5a12" // org A
const CAROL = "00000000-0000-4000-8000-0000000e5b11" // org B
const ACC_A_ORG = "00000000-0000-4000-8000-0000000e5a21"
const ACC_A_ALICE = "00000000-0000-4000-8000-0000000e5a22"
const ACC_A_BOB = "00000000-0000-4000-8000-0000000e5a23"
const ACC_B_ORG = "00000000-0000-4000-8000-0000000e5b21"
const ACC_A_SQL = "00000000-0000-4000-8000-0000000e5a24"

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

function encrypted(value: Record<string, string>): string {
  return encryptSecret(
    JSON.stringify(value),
    env.ENCRYPTION_KEY,
    CryptoContext.connectedAccountCredentials,
  )
}

async function insertAccount(row: {
  id: string
  org: string
  connection: string
  ownerType: "org" | "user"
  ownerId: string | null
  identifier: string
  creds?: Record<string, string>
  createdBy: string
}) {
  await sql`INSERT INTO kernel.connected_accounts
      (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
       credentials_encrypted, status, created_by, metadata)
    VALUES (${row.id}, ${row.org}, ${APP}, ${row.connection}, ${row.ownerType}, ${row.ownerId},
      'credentials', ${row.identifier}, ${row.creds ? encrypted(row.creds) : null}, 'active',
      ${row.createdBy}, '{"seed":true}'::jsonb)
    ON CONFLICT (id) DO NOTHING`
}

async function cleanup() {
  await sql`DELETE FROM kernel.connected_accounts WHERE org_id IN (${ORG_A}, ${ORG_B})`
  await sql`DELETE FROM kernel.audit_log WHERE org_id IN (${ORG_A}, ${ORG_B})`
  await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG_A}, ${ORG_B})`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
}

beforeAll(async () => {
  await acquireTestLock()
  // The test database's own login reaches privileged roles: the transport's
  // pre-flight refuses that unless the operator opts out (as the database app's
  // integration suite does). Loopback plaintext is the local opt-in.
  process.env.LIAISON_DB_ALLOW_PRIVILEGED_SESSION = "true"
  process.env.LIAISON_DB_ALLOW_PLAINTEXT_LOCAL = "true"
  await cleanup()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES
    (${ORG_A}, 'Sql A', 'sql-probe-a'), (${ORG_B}, 'Sql B', 'sql-probe-b')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash) VALUES
    (${ALICE}, ${ORG_A}, 'alice@sqlprobe.test', 'Alice', 'h'),
    (${BOB}, ${ORG_A}, 'bob@sqlprobe.test', 'Bob', 'h'),
    (${CAROL}, ${ORG_B}, 'carol@sqlprobe.test', 'Carol', 'h')`
  await insertAccount({
    id: ACC_A_SQL,
    org: ORG_A,
    connection: "warehouse",
    ownerType: "org",
    ownerId: null,
    identifier: "warehouse",
    creds: { connectionString: DSN },
    createdBy: ALICE,
  })
  await insertAccount({
    id: ACC_A_ORG,
    org: ORG_A,
    connection: "drive",
    ownerType: "org",
    ownerId: null,
    identifier: "org@a.test",
    createdBy: ALICE,
  })
  await insertAccount({
    id: ACC_A_ALICE,
    org: ORG_A,
    connection: "drive",
    ownerType: "user",
    ownerId: ALICE,
    identifier: "alice@a.test",
    createdBy: ALICE,
  })
  await insertAccount({
    id: ACC_A_BOB,
    org: ORG_A,
    connection: "drive",
    ownerType: "user",
    ownerId: BOB,
    identifier: "bob@a.test",
    createdBy: BOB,
  })
  await insertAccount({
    id: ACC_B_ORG,
    org: ORG_B,
    connection: "drive",
    ownerType: "org",
    ownerId: null,
    identifier: "org@b.test",
    createdBy: CAROL,
  })
}, 120_000)

afterAll(async () => {
  SqlPoolTestAccess.reset()
  await cleanup()
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
    expect(out[0]?.metadata).toEqual({ seed: true })
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
    expect(changed.metadata).toEqual({ seed: true, sharedDrives: ["d1"] })
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
    expect(bob?.metadata).toEqual({ seed: true })
  })
})

describe("ctx.kernel.findByIds", () => {
  it("answers the caller's org's users only, their directory fields only", async () => {
    const out = JSON.parse(
      await asUser(ORG_A, ALICE, ["*"], (b) =>
        b.kernel_findByIds("users", JSON.stringify([ALICE, BOB, CAROL, "not-a-uuid"])),
      ),
    ) as Array<Record<string, unknown>>
    expect(out.map((u) => u.id).sort()).toEqual([ALICE, BOB].sort())
    for (const u of out) expect(u).not.toHaveProperty("password_hash")
  })
})
