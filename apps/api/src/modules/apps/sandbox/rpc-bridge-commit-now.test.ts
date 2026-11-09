// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `ctx.db.insertNow` / `ctx.db.updateNow` (bridge/db.ts): an app's intent row
// committed in its own transaction, so it survives the run's rollback.
//
// The case it exists for: an approved gated call runs claim -> handler -> mark
// approved in ONE transaction (run-approved-handler.ts). A handler that writes
// its "about to buy" row with `ctx.db.insert`, calls the outside service, and is
// then killed by the sandbox ("App execution timed out") loses that row with the
// rollback, and the purchase has no local record. Real Postgres throughout.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { type RlsClient, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { createRlsSession, withRlsContext } from "~/db/rls"
import {
  createRpcBridge,
  createSandboxRpcBridge,
  createSessionRpcBridge,
} from "~/modules/apps/sandbox/rpc-bridge"
import { generateRlsPolicySql } from "~/modules/permissions/rls-generator"
import { insertAppRow } from "~/seed/factories/app-tables"
import { seedOrgRow, seedUserRows } from "~/seed/factories/org/rows"

const SCHEMA = "app_commitnowtest"
const APP_NAME = "commitnowtest"
const OTHER_SCHEMA = "app_commitnowother"
const ORG_A = "00000000-0000-0000-0000-0000000c0a01"
const ORG_B = "00000000-0000-0000-0000-0000000c0b01"
const USER_A = "00000000-0000-0000-0000-0000000c0a02"
const USER_B = "00000000-0000-0000-0000-0000000c0b02"

const MANIFEST = {
  name: APP_NAME,
  schema: { intents: { fields: { title: "string", state: "string" } } },
  events: { emits: [] },
  connections: {},
  network: { allowedDomains: [] },
} as const

const actorA = {
  actorType: "user" as const,
  userId: USER_A,
  orgId: ORG_A,
  scopes: ["*"],
  dimensionGrants: {},
}
const actorB = { ...actorA, userId: USER_B, orgId: ORG_B }

const table = (schema = SCHEMA) => `"${schema}".intents`

async function createSchema(schema: string, appName: string): Promise<void> {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await sql.unsafe(`CREATE SCHEMA "${schema}"`)
  await sql.unsafe(`
    CREATE TABLE ${table(schema)} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'intent',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  for (const role of ["liaison_rls", "liaison_admin"]) {
    await sql.unsafe(`GRANT USAGE ON SCHEMA "${schema}" TO ${role}`).catch(() => {})
    await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA "${schema}" TO ${role}`).catch(() => {})
  }
  const policySql = generateRlsPolicySql(
    schema,
    "intents",
    {},
    appName,
    "intents",
    MANIFEST.schema.intents.fields as Record<string, unknown>,
  )
  for (const stmt of policySql.split(";").filter((s) => s.trim())) await sql.unsafe(`${stmt};`)
}

async function rows(
  schema = SCHEMA,
): Promise<Array<{ org_id: string; title: string; state: string }>> {
  return (await sql.unsafe(
    `SELECT org_id::text AS org_id, title, state FROM ${table(schema)} ORDER BY title`,
  )) as unknown as Array<{ org_id: string; title: string; state: string }>
}

/** The commit-now channel execute-tool gives a run whose handler shares one transaction. */
const commitNowAs =
  (actor: typeof actorA) =>
  <T>(fn: (tx: RlsClient) => Promise<T>): Promise<T> =>
    withRlsContext(actor, fn)

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    return String((err as Error).message)
  }
  return "(no error)"
}

beforeAll(async () => {
  await createSchema(SCHEMA, APP_NAME)
  await createSchema(OTHER_SCHEMA, "commitnowother")
  await seedOrgRow(
    { id: ORG_A, name: "Commit Now Org A", slug: "commitnow-org-a" },
    { onConflict: "skip" },
  )
  await seedOrgRow(
    { id: ORG_B, name: "Commit Now Org B", slug: "commitnow-org-b" },
    { onConflict: "skip" },
  )
  await seedUserRows(
    [
      {
        id: USER_A,
        orgId: ORG_A,
        email: "commitnow-a@test.com",
        name: "Commit Now A",
        status: "active",
        authVersion: 1,
      },
      {
        id: USER_B,
        orgId: ORG_B,
        email: "commitnow-b@test.com",
        name: "Commit Now B",
        status: "active",
        authVersion: 1,
      },
    ],
    { onConflict: "skip" },
  )
})

afterAll(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${OTHER_SCHEMA}" CASCADE`)
  await sql`DELETE FROM kernel.users WHERE id IN (${USER_A}, ${USER_B})`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
})

afterEach(async () => {
  await sql.unsafe(`DELETE FROM ${table()}`)
  await sql.unsafe(`DELETE FROM ${table(OTHER_SCHEMA)}`)
})

/** One approved-style run: the whole handler shares `tx`, and a throw rolls it back. */
function sharedTxRun(
  body: (bridge: Record<string, any>) => Promise<void>,
  opts: { commitNowTx?: ReturnType<typeof commitNowAs>; readOnly?: boolean } = {},
): Promise<void> {
  return withRlsContext(actorA, async (tx) => {
    const bridge = createSandboxRpcBridge(
      APP_NAME,
      USER_A,
      ORG_A,
      tx,
      MANIFEST as never,
      actorA.scopes,
      "user",
      undefined,
      {
        ...(opts.commitNowTx ? { commitNowTx: opts.commitNowTx } : {}),
        ...(opts.readOnly ? { readOnlyRunOverride: true } : {}),
      },
    )
    await body(bridge)
  })
}

describe("ctx.db.insertNow: the intent row outlives the run's rollback", () => {
  it("a run killed after its outside call keeps the insertNow row and loses the plain insert", async () => {
    const outcome = await errorOf(
      sharedTxRun(
        async (bridge) => {
          await bridge.db_insertNow(
            "intents",
            JSON.stringify({ title: "intent", state: "in_flight" }),
          )
          // ... the outside call (a paid label) happens here ...
          await bridge.db_insert(
            "intents",
            JSON.stringify({ title: "with-the-run", state: "done" }),
          )
          throw new Error("App execution timed out")
        },
        { commitNowTx: commitNowAs(actorA) },
      ),
    )
    expect(outcome).toContain("timed out")
    expect(await rows()).toEqual([{ org_id: ORG_A, title: "intent", state: "in_flight" }])
  })

  it("updateNow commits the intent's next step even when the run then rolls back", async () => {
    await errorOf(
      sharedTxRun(
        async (bridge) => {
          const row = JSON.parse(
            await bridge.db_insertNow(
              "intents",
              JSON.stringify({ title: "intent", state: "in_flight" }),
            ),
          ) as { id: string }
          await bridge.db_updateNow("intents", row.id, JSON.stringify({ state: "bought" }))
          throw new Error("App execution timed out")
        },
        { commitNowTx: commitNowAs(actorA) },
      ),
    )
    expect(await rows()).toEqual([{ org_id: ORG_A, title: "intent", state: "bought" }])
  })

  it("the run still sees the committed row and can finish it on its own transaction", async () => {
    await sharedTxRun(
      async (bridge) => {
        const row = JSON.parse(
          await bridge.db_insertNow(
            "intents",
            JSON.stringify({ title: "intent", state: "in_flight" }),
          ),
        ) as { id: string }
        await bridge.db_update("intents", row.id, JSON.stringify({ state: "done" }))
      },
      { commitNowTx: commitNowAs(actorA) },
    )
    expect(await rows()).toEqual([{ org_id: ORG_A, title: "intent", state: "done" }])
  })

  it("a session bridge (per-call transactions) commits ahead through its own session", async () => {
    const bridge = createSessionRpcBridge(
      APP_NAME,
      USER_A,
      ORG_A,
      createRlsSession(actorA),
      MANIFEST as never,
      actorA.scopes,
    )
    await bridge.db_insertNow("intents", JSON.stringify({ title: "session", state: "in_flight" }))
    expect(await rows()).toEqual([{ org_id: ORG_A, title: "session", state: "in_flight" }])
  })
})

describe("ctx.db.insertNow: the same walls as every app write", () => {
  it("refuses an entity the app does not declare: another app's table or a kernel table", async () => {
    await sharedTxRun(
      async (bridge) => {
        for (const entity of [
          "users",
          "organizations",
          `${OTHER_SCHEMA}.intents`,
          "../kernel.users",
        ]) {
          const msg = await errorOf(bridge.db_insertNow(entity, JSON.stringify({ title: "x" })))
          expect(`${entity}: ${msg}`).toContain("not found in app schema")
        }
      },
      { commitNowTx: commitNowAs(actorA) },
    )
    // The other app's bridge cannot reach this app's table either: same table name, its own schema.
    await withRlsContext(actorA, async (tx) => {
      const other = createSandboxRpcBridge(
        "commitnowother",
        USER_A,
        ORG_A,
        tx,
        { ...MANIFEST, name: "commitnowother" } as never,
        actorA.scopes,
        "user",
        undefined,
        { commitNowTx: commitNowAs(actorA) },
      )
      await other.db_insertNow("intents", JSON.stringify({ title: "other-app" }))
    })
    expect(await rows()).toEqual([])
    expect((await rows(OTHER_SCHEMA)).map((r) => r.title)).toEqual(["other-app"])
  })

  it("refuses an undeclared field, org_id included, so a row cannot be planted in another org", async () => {
    await sharedTxRun(
      async (bridge) => {
        const msg = await errorOf(
          bridge.db_insertNow("intents", JSON.stringify({ title: "x", org_id: ORG_B })),
        )
        expect(msg).toMatch(/org_id/)
      },
      { commitNowTx: commitNowAs(actorA) },
    )
    expect(await rows()).toEqual([])
  })

  it("refuses a cross-org write: a channel under another org's actor cannot write this org's row", async () => {
    const msg = await errorOf(
      sharedTxRun(
        async (bridge) => {
          await bridge.db_insertNow("intents", JSON.stringify({ title: "cross-org" }))
        },
        { commitNowTx: commitNowAs(actorB) },
      ),
    )
    expect(msg.toLowerCase()).toContain("row-level security")
    expect(await rows()).toEqual([])
  })

  it("updateNow cannot change another org's row", async () => {
    await withPrivilegedDb(ORG_B, "commitnow-seed-b", (tx) =>
      insertAppRow(tx, "commitnowtest", "intents", {
        org_id: ORG_B,
        title: "org-b",
        state: "intent",
      }),
    )
    const [{ id: idB }] = (await sql.unsafe(
      `SELECT id::text AS id FROM ${table()} WHERE org_id = '${ORG_B}'`,
    )) as unknown as [{ id: string }]
    await sharedTxRun(
      async (bridge) => {
        await bridge.db_updateNow("intents", idB, JSON.stringify({ state: "hijacked" }))
      },
      { commitNowTx: commitNowAs(actorA) },
    )
    expect(await rows()).toEqual([{ org_id: ORG_B, title: "org-b", state: "intent" }])
  })

  it("refuses on a read-only run, naming the table", async () => {
    await sharedTxRun(
      async (bridge) => {
        for (const call of [
          bridge.db_insertNow("intents", JSON.stringify({ title: "ro" })),
          bridge.db_updateNow("intents", ORG_A, JSON.stringify({ state: "ro" })),
        ]) {
          const msg = await errorOf(call)
          expect(msg.toLowerCase()).toContain("read_only_run")
          expect(msg).toContain(`${SCHEMA}.intents`)
        }
      },
      { commitNowTx: commitNowAs(actorA), readOnly: true },
    )
    expect(await rows()).toEqual([])
  })

  it("refuses, loudly, in a run with no transaction of its own to commit ahead in", async () => {
    const msg = await errorOf(
      withRlsContext(actorA, async (tx) => {
        const bridge = createRpcBridge(
          APP_NAME,
          USER_A,
          ORG_A,
          tx,
          MANIFEST as never,
          actorA.scopes,
        )
        await bridge.db_insertNow("intents", JSON.stringify({ title: "nowhere" }))
      }),
    )
    expect(msg).toContain("ctx.db.insertNow")
    expect(msg).toContain("ctx.db.insert")
    expect(await rows()).toEqual([])
  })
})
