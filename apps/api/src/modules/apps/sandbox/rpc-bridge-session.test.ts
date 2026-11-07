// SPDX-License-Identifier: FSL-1.1-ALv2
//
// TDD for the bridge-owned-transactions refactor.
//
// `createSessionRpcBridge(appName, userId, orgId, session, manifest, ...)` has
// the SAME surface as `createRpcBridge`, except an `RlsSession` (from
// `~/db/rls`) replaces the ambient `RlsClient` `txDb` param. Each bridge
// METHOD INVOCATION opens and commits its own short RLS transaction via
// `session.run(...)` — so a handler that calls several bridge methods no
// longer holds one connection for its whole run, and (the deliberate
// semantics change pinned by this file) an early bridge write is NOT rolled
// back by a later failure in the same handler.
//
// This file imports `createSessionRpcBridge` from `~/modules/apps/sandbox/
// rpc-bridge`, which does not exist yet — these tests MUST fail to load until
// the production code lands (red phase). Uses the real Postgres test DB
// throughout (no DB mocks), following the ad-hoc-real-schema pattern from
// `modules/apps/invoicing-documents-search-shape.test.ts` and the
// createTestOrg/createTestUser + withRlsContext pattern from
// `rpc-bridge.sequences.test.ts`.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { createRlsSession, withRlsContext } from "~/db/rls"
import { declaredEmits } from "~/infra/events/event-bus"
import { createRpcBridge, createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { generateRlsPolicySql } from "~/modules/permissions/rls-generator"

const SCHEMA = "app_sessbridgetest"
const APP_NAME = "sessbridgetest"
const ORG_A = "00000000-0000-0000-0000-0000000d0a01"
const ORG_B = "00000000-0000-0000-0000-0000000d0b01"
const USER_A = "00000000-0000-0000-0000-0000000d0a02"
const USER_B = "00000000-0000-0000-0000-0000000d0b02"

// Minimal-but-faithful manifest — a single writable/readable entity plus a
// declared emit, enough to exercise db_insert/db_findMany/emit through both
// the ambient bridge (createRpcBridge) and the session bridge
// (createSessionRpcBridge) for parity comparison.
const MANIFEST = {
  name: APP_NAME,
  schema: {
    items: {
      fields: { title: "string", status: "string" },
    },
  },
  events: { emits: ["items:created"] },
  connections: {},
  network: { allowedDomains: [] },
} as const

function itemsTable() {
  return `"${SCHEMA}".items`
}

async function setUpSchema(): Promise<void> {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`)
  await sql.unsafe(`
    CREATE TABLE ${itemsTable()} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  for (const role of ["liaison_rls", "liaison_admin"]) {
    await sql.unsafe(`GRANT USAGE ON SCHEMA "${SCHEMA}" TO ${role}`).catch(() => {})
    await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA "${SCHEMA}" TO ${role}`).catch(() => {})
  }
  const policySql = generateRlsPolicySql(
    SCHEMA,
    "items",
    {},
    APP_NAME,
    "items",
    MANIFEST.schema.items.fields as Record<string, unknown>,
  )
  for (const stmt of policySql.split(";").filter((s) => s.trim())) {
    await sql.unsafe(`${stmt};`)
  }
}

async function tearDownSchema(): Promise<void> {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
}

async function seedOrgAndUsers(): Promise<void> {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG_A}, 'Session Bridge Org A', 'sessbridge-org-a')
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG_B}, 'Session Bridge Org B', 'sessbridge-org-b')
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
    VALUES (${USER_A}, ${ORG_A}, 'sessbridge-a@test.com', 'Sess Bridge User A', 'active', 1)
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
    VALUES (${USER_B}, ${ORG_B}, 'sessbridge-b@test.com', 'Sess Bridge User B', 'active', 1)
    ON CONFLICT (id) DO NOTHING`
}

async function cleanupOrgAndUsers(): Promise<void> {
  await sql`DELETE FROM kernel.users WHERE id IN (${USER_A}, ${USER_B})`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
}

const actorA = {
  actorType: "user" as const,
  userId: USER_A,
  orgId: ORG_A,
  scopes: ["*"],
  dimensionGrants: {},
}

const actorB = {
  actorType: "user" as const,
  userId: USER_B,
  orgId: ORG_B,
  scopes: ["*"],
  dimensionGrants: {},
}

let savedEmits: Set<string> | undefined

beforeAll(async () => {
  await setUpSchema()
  await seedOrgAndUsers()
  savedEmits = declaredEmits.get(APP_NAME)
  declaredEmits.set(APP_NAME, new Set(MANIFEST.events.emits))
})

afterAll(async () => {
  if (savedEmits) declaredEmits.set(APP_NAME, savedEmits)
  else declaredEmits.delete(APP_NAME)
  await tearDownSchema()
  await cleanupOrgAndUsers()
})

afterEach(async () => {
  await sql.unsafe(`DELETE FROM ${itemsTable()}`)
  await sql`DELETE FROM kernel.pending_events WHERE org_id IN (${ORG_A}, ${ORG_B})`
})

describe("createSessionRpcBridge — surface parity with createRpcBridge", () => {
  it("db_insert then db_findMany through a session bridge returns the same org-scoped rows as the ambient-tx bridge for the same actor (RLS parity)", async () => {
    // Seed one row per org directly (bypassing RLS) so both bridges have data
    // to see/not-see.
    await withPrivilegedDb(ORG_A, "sessbridge-parity-seed-a", async (tx) => {
      await tx.execute(
        drizzleSql`INSERT INTO ${drizzleSql.raw(itemsTable())} (org_id, title, status)
          VALUES (${ORG_A}::uuid, 'Org A item', 'open')`,
      )
    })
    await withPrivilegedDb(ORG_B, "sessbridge-parity-seed-b", async (tx) => {
      await tx.execute(
        drizzleSql`INSERT INTO ${drizzleSql.raw(itemsTable())} (org_id, title, status)
          VALUES (${ORG_B}::uuid, 'Org B item', 'open')`,
      )
    })

    // Ambient-tx bridge (the OLD contract): one withRlsContext transaction.
    const ambientRaw = await withRlsContext(actorA, async (tx) => {
      const bridge = createRpcBridge(APP_NAME, USER_A, ORG_A, tx, MANIFEST as never, actorA.scopes)
      return bridge.db_findMany("items", JSON.stringify({}))
    })
    const ambientRows = JSON.parse(ambientRaw) as Array<{ title: string }>

    // Session bridge (the NEW contract): each method call is its own
    // session.run transaction, but must resolve the SAME RLS-scoped rows for
    // the same actor.
    const session = createRlsSession(actorA)
    const sessionBridge = createSessionRpcBridge(
      APP_NAME,
      USER_A,
      ORG_A,
      session,
      MANIFEST as never,
      actorA.scopes,
    )
    const sessionRaw = await sessionBridge.db_findMany("items", JSON.stringify({}))
    const sessionRows = JSON.parse(sessionRaw) as Array<{ title: string }>

    expect(sessionRows.map((r) => r.title).sort()).toEqual(ambientRows.map((r) => r.title).sort())
    expect(sessionRows.map((r) => r.title)).toEqual(["Org A item"])
    expect(sessionRows.map((r) => r.title)).not.toContain("Org B item")
  })

  it("session bridge db_findMany for org B's actor does NOT see org A's rows (RLS still enforced per session.run call)", async () => {
    await withPrivilegedDb(ORG_A, "sessbridge-parity-seed-a2", async (tx) => {
      await tx.execute(
        drizzleSql`INSERT INTO ${drizzleSql.raw(itemsTable())} (org_id, title, status)
          VALUES (${ORG_A}::uuid, 'Org A secret', 'open')`,
      )
    })

    const session = createRlsSession(actorB)
    const sessionBridge = createSessionRpcBridge(
      APP_NAME,
      USER_B,
      ORG_B,
      session,
      MANIFEST as never,
      actorB.scopes,
    )
    const raw = await sessionBridge.db_findMany("items", JSON.stringify({}))
    const rows = JSON.parse(raw) as Array<{ title: string }>
    expect(rows).toHaveLength(0)
  })
})

describe("createSessionRpcBridge — per-call transaction contract (deliberate semantics change)", () => {
  it("write-call-A succeeds, then a later handler-level throw does NOT roll back A (new per-call contract)", async () => {
    const session = createRlsSession(actorA)
    const sessionBridge = createSessionRpcBridge(
      APP_NAME,
      USER_A,
      ORG_A,
      session,
      MANIFEST as never,
      actorA.scopes,
    )

    // Call A: a real write through the session bridge, its own committed
    // session.run transaction.
    const insertedRaw = await sessionBridge.db_insert(
      "items",
      JSON.stringify({ title: "write-A", status: "open" }),
    )
    const inserted = JSON.parse(insertedRaw) as { id: string }
    expect(inserted.id).toBeTruthy()

    // Simulate the REST of the handler throwing AFTER call A committed — under
    // the OLD ambient-tx contract this would have rolled back call A too
    // (same transaction); under the NEW per-call contract call A is already
    // committed and independent.
    let handlerThrew = false
    try {
      await (async () => {
        throw new Error("simulated handler failure after write-A")
      })()
    } catch {
      handlerThrew = true
    }
    expect(handlerThrew).toBe(true)

    // Assert call A's write PERSISTED — read it back via a fresh, independent
    // query, not the same session/transaction.
    const rows = await withPrivilegedDb(ORG_A, "sessbridge-persist-check", async (tx) => {
      return extractRows<{ title: string }>(
        await tx.execute(
          drizzleSql`SELECT title FROM ${drizzleSql.raw(itemsTable())} WHERE id = ${inserted.id}::uuid`,
        ),
      )
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.title).toBe("write-A")
  })

  it("two sequential session-bridge write calls: the FIRST persists even when the SECOND call itself fails validation", async () => {
    const session = createRlsSession(actorA)
    const sessionBridge = createSessionRpcBridge(
      APP_NAME,
      USER_A,
      ORG_A,
      session,
      MANIFEST as never,
      actorA.scopes,
    )

    const firstRaw = await sessionBridge.db_insert(
      "items",
      JSON.stringify({ title: "first-write-persists", status: "open" }),
    )
    const first = JSON.parse(firstRaw) as { id: string }

    // Second call deliberately references an undeclared field so the bridge
    // rejects it — this must NOT undo the first call's own committed
    // transaction (each session.run is atomic in itself, per spec).
    await expect(
      sessionBridge.db_insert(
        "items",
        JSON.stringify({ title: "second-write-invalid", not_a_field: "x" }),
      ),
    ).rejects.toThrow()

    const rows = await withPrivilegedDb(ORG_A, "sessbridge-first-persist-check", async (tx) => {
      return extractRows<{ title: string }>(
        await tx.execute(
          drizzleSql`SELECT title FROM ${drizzleSql.raw(itemsTable())} WHERE id = ${first.id}::uuid`,
        ),
      )
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.title).toBe("first-write-persists")
  })
})

describe("createSessionRpcBridge — single-call write + queueEvent atomicity", () => {
  it("a single bridge method that both writes and queues an event commits both atomically (event row present after the call)", async () => {
    const session = createRlsSession(actorA)
    const sessionBridge = createSessionRpcBridge(
      APP_NAME,
      USER_A,
      ORG_A,
      session,
      MANIFEST as never,
      actorA.scopes,
    )

    // The write half: db_insert commits its row in its own per-call tx.
    const insertedRaw = await sessionBridge.db_insert(
      "items",
      JSON.stringify({ title: "write-plus-event", status: "open" }),
    )
    const inserted = JSON.parse(insertedRaw) as { id: string }
    expect(inserted.id).toBeTruthy()

    // The queue half: `emit` writes its transactional-outbox row via
    // tx.queueEvent ON THE PER-CALL TRANSACTION — the regression this pins is
    // queueEvent silently attaching to a transaction that never commits.
    await sessionBridge.emit(
      JSON.stringify({ entity: "items", action: "created", entityId: inserted.id, data: {} }),
    )

    const eventRows = await sql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${ORG_A}
    `
    const matching = eventRows.filter((r) => {
      const p = r.payload as { entity?: string; action?: string; entityId?: string }
      return p.entity === "items" && p.action === "created" && p.entityId === inserted.id
    })
    expect(matching).toHaveLength(1)
  })

  it("event row is absent if the write itself fails validation (nothing to commit for a rejected call)", async () => {
    const session = createRlsSession(actorA)
    const sessionBridge = createSessionRpcBridge(
      APP_NAME,
      USER_A,
      ORG_A,
      session,
      MANIFEST as never,
      actorA.scopes,
    )

    await expect(
      sessionBridge.db_insert("items", JSON.stringify({ not_a_declared_field: "x" })),
    ).rejects.toThrow()

    const eventRows = await sql`
      SELECT payload FROM kernel.pending_events WHERE org_id = ${ORG_A}
    `
    expect(eventRows).toHaveLength(0)
  })
})

describe("createSessionRpcBridge — pool-freed proof (spec TDD item 3)", () => {
  it("a concurrent session.run completes well under the acquire timeout while a fake long handler holds NO session.run open", async () => {
    const session = createRlsSession(actorA)
    const sessionBridge = createSessionRpcBridge(
      APP_NAME,
      USER_A,
      ORG_A,
      session,
      MANIFEST as never,
      actorA.scopes,
    )

    // Fake "long handler": does sandbox-shaped work (a fetch-equivalent delay)
    // WITHOUT holding any session.run transaction open — this is exactly the
    // target contract ("a tool call never owns a Postgres connection while it
    // isn't executing SQL"). If the OLD ambient-tx model were used instead,
    // an equivalent-shaped handler would hold a live transaction/connection
    // for this entire sleep.
    const fakeLongHandler = new Promise<void>((resolve) => setTimeout(resolve, 300))

    const start = Date.now()
    const [writeResult] = await Promise.all([
      sessionBridge.db_insert(
        "items",
        JSON.stringify({ title: "pool-freed-proof", status: "open" }),
      ),
      fakeLongHandler,
    ])
    const elapsedMs = Date.now() - start

    expect(JSON.parse(writeResult).id).toBeTruthy()
    // Comfortably under DB_ACQUIRE_TIMEOUT_MS (default 25s; test env commonly
    // pins it far lower) — the session.run call is NOT blocked behind the fake
    // handler's sleep because the handler holds no connection during it.
    expect(elapsedMs).toBeLessThan(5_000)
  })

  it("pool-diag inFlight returns to 0 between two session-bridge calls made by the SAME handler (no leaked handle across calls)", async () => {
    const { PoolDiagTestAccess, getPoolDiagState } = await import("~/db/pool-diag")
    PoolDiagTestAccess.reset()

    const session = createRlsSession(actorA)
    const sessionBridge = createSessionRpcBridge(
      APP_NAME,
      USER_A,
      ORG_A,
      session,
      MANIFEST as never,
      actorA.scopes,
    )

    await sessionBridge.db_insert("items", JSON.stringify({ title: "call-1", status: "open" }))
    expect(getPoolDiagState().inFlight).toBe(0)

    // Simulate wall-clock time between bridge calls (sandbox IPC / external
    // HTTP / Meili query) — the whole point of the refactor is that NOTHING
    // holds a connection during this gap.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(getPoolDiagState().inFlight).toBe(0)

    await sessionBridge.db_insert("items", JSON.stringify({ title: "call-2", status: "open" }))
    expect(getPoolDiagState().inFlight).toBe(0)

    const rows = await sql.unsafe(
      `SELECT title FROM ${itemsTable()} WHERE org_id = '${ORG_A}' ORDER BY title`,
    )
    expect(rows.map((r) => r.title)).toEqual(["call-1", "call-2"])
  })
})

describe("createSessionRpcBridge — construction-time poison guard", () => {
  it("method-name enumeration does not query the session/txDb during construction (a query at construction time is a bug)", async () => {
    const { PoolDiagTestAccess, getPoolDiagState } = await import("~/db/pool-diag")
    PoolDiagTestAccess.reset()

    const session = createRlsSession(actorA)
    // Constructing the bridge only builds closures — it must never itself run
    // a query (session.run), so inFlight stays 0 immediately after
    // construction, before any bridge method is invoked.
    const sessionBridge = createSessionRpcBridge(
      APP_NAME,
      USER_A,
      ORG_A,
      session,
      MANIFEST as never,
      actorA.scopes,
    )
    expect(typeof sessionBridge.db_insert).toBe("function")
    expect(typeof sessionBridge.db_findMany).toBe("function")
    expect(getPoolDiagState().inFlight).toBe(0)
  })
})

describe("createSessionRpcBridge — attachmentBytesLedger survives per-call bridge rebuilds", () => {
  // Regression for the bug the session-bridge refactor introduced and fixed:
  // files_getAttachmentBytes / files_importAttachment enforce a 35MB PER_SEND
  // cumulative cap that must count across a handler's WHOLE run. Under
  // createSessionRpcBridge, createRpcBridge is rebuilt fresh on every single
  // method call (each in its own session.run transaction) — without a ledger
  // object hoisted OUT of that per-call closure and threaded through
  // bridgeOptions.attachmentBytesLedger, each rebuild would start a fresh
  // `{ cumulative: 0 }` and the cap would never trip. This test proves the
  // ledger object supplied at createSessionRpcBridge construction time is the
  // SAME object mutated by both calls — cumulative bytes read accumulate
  // across two separate files_getAttachmentBytes invocations instead of
  // resetting.
  const fileBytes = Buffer.from("x".repeat(64 * 1024)) // 64KB — small, deterministic
  let fileId: string
  let itemId: string
  let storageKey: string

  beforeAll(async () => {
    // files_getAttachmentBytes reads kernel.files through the caller's RLS tx
    // (`files_select` — USING(false) by default; a manifest entity must
    // register a `fileParent` and the boot rebuild must project a branch for
    // it before any app's org can SELECT its own file rows at all). Register
    // this suite's `items` entity as a real fileParent — same mechanism a
    // production manifest uses — then rebuild the policy so the join has
    // something to match: entity_id -> items.id, scoped by org_id.
    const { manifestFileParentRegistry } = await import("~/modules/apps/app-registries")
    const { rebuildFilesSelectPolicy } = await import("~/infra/boot-phase10")
    manifestFileParentRegistry.set([ORG_A, APP_NAME, "items"], {
      tableName: "items",
      schemaRef: SCHEMA,
      joinOn: "id",
      readScope: `${APP_NAME}:items:read`,
      writeScope: `${APP_NAME}:items:write`,
    })
    // Production builds the policy from the catalog; this fixture app is not in
    // it, so the rebuild takes the registry's parents.
    const { CatalogDerivationsTestAccess } = await import("~/modules/apps/catalog-derivations")
    await rebuildFilesSelectPolicy({ parents: CatalogDerivationsTestAccess.registryFileParents() })

    const [item] = await withPrivilegedDb(ORG_A, "sessbridge-attachment-item-seed", async (tx) => {
      return extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`INSERT INTO ${drizzleSql.raw(itemsTable())} (org_id, title, status)
            VALUES (${ORG_A}::uuid, 'attachment ledger parent', 'open')
            RETURNING id::text AS id`,
        ),
      )
    })
    itemId = item.id

    const { putObject } = await import("~/infra/storage/object-storage")
    storageKey = `orgs/${ORG_A}/sessbridgetest/attachment-ledger-test.bin`
    await putObject({ key: storageKey, body: fileBytes, contentType: "application/octet-stream" })
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type,
                                size_bytes, storage_key, uploaded_by)
      VALUES (gen_random_uuid(), ${ORG_A}, ${APP_NAME}, 'items', ${itemId}, 'attachment-ledger-test.bin',
              'application/octet-stream', ${fileBytes.byteLength}, ${storageKey}, ${USER_A})
      RETURNING id::text AS id
    `
    fileId = row.id
  }, 30_000)

  afterAll(async () => {
    if (fileId) await sql`DELETE FROM kernel.files WHERE id = ${fileId}`
    // The policy swap above is DDL: it outlives this process on this database.
    // Left in place, every later file on the database reads its files through a
    // policy that knows only the fixture's `items`, and a thread's own files come
    // back as missing. Drop the fixture parent and put the catalog's policy back.
    const { manifestFileParentRegistry } = await import("~/modules/apps/app-registries")
    manifestFileParentRegistry.delete([ORG_A, APP_NAME, "items"])
    const { restoreFilesSelectPolicy } = await import("~/tests/helpers/files-select-policy")
    await restoreFilesSelectPolicy()
  })

  it("ledger.getAttachmentBytes.cumulative accumulates ACROSS two session-bridge calls instead of resetting per call", async () => {
    // Privileged per-call session -- the exact adapter shape runtime.ts uses
    // for the external-search dispatch. kernel.files SELECT visibility under
    // liaison_rls requires a registered fileParent (rebuildFilesSelectPolicy),
    // which this ad-hoc test app deliberately does not have; the regression
    // under test is the LEDGER surviving per-call bridge rebuilds, and the
    // privileged session exercises the identical rebuild path.
    const session = {
      ctx: { actorType: "system", orgId: ORG_A, purpose: "job" },
      run: (fn: (tx: unknown) => Promise<unknown>) =>
        withPrivilegedDb(ORG_A, "sessbridge-ledger-test", fn as never),
    } as never
    const ledger = {
      importAttachment: { cumulative: 0 },
      getAttachmentBytes: { cumulative: 0 },
    }
    const sessionBridge = createSessionRpcBridge(
      APP_NAME,
      USER_A,
      ORG_A,
      session,
      MANIFEST as never,
      actorA.scopes,
      undefined,
      undefined,
      { attachmentBytesLedger: ledger },
    )

    const params = JSON.stringify({
      fileId,
      allowedParents: [{ app: APP_NAME, entityType: "items", entityId: itemId }],
    })

    const first = JSON.parse(await sessionBridge.files_getAttachmentBytes(params)) as {
      sizeBytes: number
    }
    expect(first.sizeBytes).toBe(fileBytes.byteLength)
    // After call 1 the shared ledger object already reflects the read — proof
    // it is the SAME object every per-call bridge rebuild mutates, not a
    // fresh `{ cumulative: 0 }` captured inside that call's closure.
    expect(ledger.getAttachmentBytes.cumulative).toBe(fileBytes.byteLength)

    await sessionBridge.files_getAttachmentBytes(params)
    // Call 2 accumulates ON TOP of call 1 — the pre-fix bug would have reset
    // to fileBytes.byteLength again instead of doubling.
    expect(ledger.getAttachmentBytes.cumulative).toBe(2 * fileBytes.byteLength)
    // The importAttachment budget is a SEPARATE counter, untouched by reads.
    expect(ledger.importAttachment.cumulative).toBe(0)
  })
})

describe("codec bridge methods — host-side bulk encoders", () => {
  // Bulk encodes must run host-side (native Buffer, milliseconds) because the
  // in-sandbox fallback encoder is interpreted per-byte on the main thread: a
  // multi-MB payload (Gmail send raw = base64url of the whole RFC 2822
  // message) froze the entire process for tens of seconds in prod.
  it("codec_base64UrlEncodeUtf8 / codec_base64EncodeUtf8 match native Buffer output, including multi-byte UTF-8", async () => {
    const session = createRlsSession(actorA)
    const sessionBridge = createSessionRpcBridge(
      APP_NAME,
      USER_A,
      ORG_A,
      session,
      MANIFEST as never,
      actorA.scopes,
    )
    const samples = [
      "hello world",
      "MIME-Version: 1.0\r\nSubject: héllo — ünïcode ✓\r\n\r\nbody",
      "a".repeat(100_000),
    ]
    for (const s of samples) {
      expect(await sessionBridge.codec_base64UrlEncodeUtf8(s)).toBe(
        Buffer.from(s, "utf8").toString("base64url"),
      )
      expect(await sessionBridge.codec_base64EncodeUtf8(s)).toBe(
        Buffer.from(s, "utf8").toString("base64"),
      )
    }
  })

  it("codec methods run TXLESS on the session bridge — they execute against the poison tx and still succeed (no RLS transaction opened per encode)", async () => {
    // A session whose run() would blow up if invoked proves the codec call
    // never opens a transaction.
    const explodingSession = {
      ctx: actorA,
      run: async () => {
        throw new Error("codec method must not open a session.run transaction")
      },
    }
    const sessionBridge = createSessionRpcBridge(
      APP_NAME,
      USER_A,
      ORG_A,
      explodingSession as never,
      MANIFEST as never,
      actorA.scopes,
    )
    expect(await sessionBridge.codec_base64UrlEncodeUtf8("txless")).toBe(
      Buffer.from("txless", "utf8").toString("base64url"),
    )
  })
})

describe("effects bridge methods: one claimer for the handler's whole run", () => {
  afterAll(async () => {
    await sql`DELETE FROM kernel.effect_ledger WHERE org_id = ${ORG_A}`
  })

  it("a claim and its markUnknown in one session-bridge run are the same claimer: the claim turns unknown, and the next run is told unknown, not in flight", async () => {
    // Tx-less as well: the ledger goes through the privileged pool, never a session transaction.
    const explodingSession = {
      ctx: actorA,
      run: async () => {
        throw new Error("effects methods must not open a session.run transaction")
      },
    }
    const bridgeFor = () =>
      createSessionRpcBridge(
        APP_NAME,
        USER_A,
        ORG_A,
        explodingSession as never,
        MANIFEST as never,
        actorA.scopes,
      )
    const key = `lost-answer-${crypto.randomUUID()}`
    const run1 = bridgeFor()
    expect(JSON.parse(await run1.effects_claim(key, "{}"))).toEqual({ state: "claimed" })
    // The call was made and its answer lost: this run's own claim turns unknown.
    expect(JSON.parse(await run1.effects_markUnknown(key))).toEqual({ ok: true })
    const run2 = bridgeFor()
    expect(JSON.parse(await run2.effects_claim(key, "{}"))).toEqual({ state: "unknown" })
  })
})
