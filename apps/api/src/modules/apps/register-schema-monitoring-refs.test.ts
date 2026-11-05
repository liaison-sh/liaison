// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Monitoring 0.4.0 against the real kernel: incident refs and comments.
//
//   * the 0.3.5 -> 0.4.0 registration really adds `incidents.ref_number`, its
//     `(org_id, ref_number)` unique index and the `incident_comments` table, and a
//     later registration adds nothing twice;
//   * `assignMissingRefs` numbers through the real bridge and allocator, oldest
//     first, per org, and its lock-first protocol holds under a real overlapping
//     second numberer (the advisory lock, not luck, decides who numbers);
//   * the bridge refuses `where.id` on `updateMany`;
//   * `incident_comments` is reachable under RLS by the actors that write it: a
//     `monitoring:incidents:write` user, the system webhook actor that archives
//     episodes, with negative controls (a read-only holder, a holder of another
//     app's scope, another org);
//   * the handlers themselves run through the real bridge: the webhook's create,
//     reopen compare-and-set (its real `{ count }`) and episode archive,
//     `incidents_get` ordering, `incidents_comment`, and the `assign-refs` job under
//     the job runtime's system actor.
//
// Schema ownership: this file owns `app_monitoring` for its whole lifetime through
// the fixture take-over (`takeOverAppSchema` / `releaseAppSchema`), never a raw
// DROP SCHEMA. The registered schema is parked under a stash name meanwhile, so
// nothing else in this process may rely on a cached monitoring registration while
// it runs; the JS-only schema lock serializes the peers that also take it.
//
// Characterization test of the monitoring numbering and manifest: no red phase.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { type ActorContext, withRlsContext } from "~/db/rls"
import { registerApps } from "~/modules/apps/runtime"
import { withAppDimensionAliases } from "~/modules/apps/runtime-helpers"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { releaseAppSchema, takeOverAppSchema } from "~/tests/helpers/app-schema-fixture"
import {
  type AppSchemaLockHandle,
  acquireAppSchemaJsLock,
  releaseAppSchemaJsLock,
} from "~/tests/helpers/app-schema-lock"
import monitoringManifestJson from "../../../../../bundled-apps/monitoring/app.manifest.json"
import { incidentsCommentHandler } from "../../../../../bundled-apps/monitoring/src/comments"
import { incidentsGetHandler } from "../../../../../bundled-apps/monitoring/src/incidents"
import {
  assignRefsJobHandler,
  JOB_REF_BATCH,
} from "../../../../../bundled-apps/monitoring/src/jobs"
import { assignMissingRefs } from "../../../../../bundled-apps/monitoring/src/lib/refs"
import { alertWebhookHandler } from "../../../../../bundled-apps/monitoring/src/webhooks"

type RefsCtx = Parameters<typeof assignMissingRefs>[0]

const SCHEMA = "app_monitoring"
const SEQUENCE_KEY = "monitoring:incident_ref"

type Bridge = Record<string, any>
type ManifestJson = Record<string, any>

const manifest040: ManifestJson = {
  ...structuredClone(monitoringManifestJson as ManifestJson),
  _format: "manifest" as const,
  _bundlePath: "/apps/monitoring/handlers.js",
}

/** The schema-only registration descriptor of a manifest at `version`. */
function descriptor(m: ManifestJson, version: string): never {
  return {
    name: "monitoring",
    version,
    _format: "manifest",
    _bundlePath: "/apps/monitoring/handlers.js",
    scopes: m.scopes,
    schema: m.schema,
    ...(m.capabilities ? { capabilities: m.capabilities } : {}),
  } as never
}

/** The 0.3.5 manifest: no ref column, no ref unique, no comments table, no job, no capability. */
function manifest035(): ManifestJson {
  const m = structuredClone(monitoringManifestJson as ManifestJson)
  delete m.schema.incident_comments
  delete m.schema.incidents.fields.ref_number
  m.schema.incidents.constraints.unique = m.schema.incidents.constraints.unique.filter(
    (u: unknown) => !(Array.isArray(u) && u.length === 1 && u[0] === "ref_number"),
  )
  delete m.jobs
  delete m.capabilities
  m.version = "0.3.5"
  return m
}

const slug = `monitoring-refs-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
let monitoringLock: AppSchemaLockHandle
let orgA: string
let orgB: string
let userId: string
let userB: string
const incidentsA: string[] = []
const BATCH = { limit: JOB_REF_BATCH }

type HandlerCtx = Parameters<typeof alertWebhookHandler>[1]
type Emitted = { action: string; entityId?: string; data?: Record<string, unknown> }

/**
 * The full handler ctx over the bridge: `adapter` plus delete, the acting user, and stubs for
 * the parts the kernel owns (emit goes to the outbox, which is not under test here).
 */
function handlerCtx(b: Bridge, actingUserId: string, emits: Emitted[]): HandlerCtx {
  const base = adapter(b) as unknown as { db: Record<string, unknown>; sequences: unknown }
  return {
    db: {
      ...base.db,
      delete: async (e: string, id: string) => {
        await b.db_delete(e, id)
      },
    },
    sequences: base.sequences,
    // The sandbox exposes the acting user through the bridge's getUserId(), not a ctx.userId field.
    getUserId: async () => actingUserId,
    emit: async (ev: Emitted) => {
      emits.push(ev)
    },
    logger: {
      info: () => {},
      warn: () => {},
      debug: () => {},
      // No error is expected on these paths: surface one instead of a silent 503.
      error: (msg: string, data?: unknown) => {
        throw new Error(`unexpected handler error log: ${msg} ${JSON.stringify(data)}`)
      },
    },
    config: { get: async () => null },
  } as unknown as HandlerCtx
}

/** The sandbox ctx surface `assignMissingRefs` uses, over the JSON-string bridge. */
function adapter(b: Bridge): RefsCtx {
  return {
    db: {
      findMany: async (e: string, o?: unknown) =>
        JSON.parse(await b.db_findMany(e, JSON.stringify(o ?? {}))),
      findOne: async (e: string, id: string) => JSON.parse(await b.db_findOne(e, id)),
      insert: async (e: string, d: unknown) => JSON.parse(await b.db_insert(e, JSON.stringify(d))),
      update: async (e: string, id: string, d: unknown) => {
        await b.db_update(e, id, JSON.stringify(d))
      },
      updateMany: async (e: string, o: unknown) =>
        JSON.parse(await b.db_updateMany(e, JSON.stringify(o))),
    },
    sequences: {
      allocate: async (p: unknown) => JSON.parse(await b.sequences_allocate(JSON.stringify(p))),
    },
  } as unknown as RefsCtx
}

/** One ambient transaction as the system webhook actor (the retry worker's shape). */
function inSystemTx<T>(
  orgId: string,
  fn: (ctx: RefsCtx, bridge: Bridge) => Promise<T>,
): Promise<T> {
  return withRlsContext(
    { actorType: "system", orgId, purpose: "webhook", scopes: ["monitoring"] },
    (tx) => {
      const bridge = createRpcBridge("monitoring", "system", orgId, tx, manifest040 as never)
      return fn(adapter(bridge), bridge)
    },
  )
}

function actor(scopes: string[], org: { orgId: string; userId: string }): ActorContext {
  return { actorType: "user", userId: org.userId, orgId: org.orgId, scopes, dimensionGrants: {} }
}

/** One bridge call the way execute-tool runs it for a user (org A's member by default). */
function asUser<T>(
  scopes: string[],
  fn: (bridge: Bridge) => Promise<T>,
  org: { orgId: string; userId: string } = { orgId: orgA, userId },
): Promise<T> {
  return withRlsContext(withAppDimensionAliases(actor(scopes, org), "monitoring"), (tx) =>
    fn(
      createRpcBridge(
        "monitoring",
        org.userId,
        org.orgId,
        tx,
        manifest040 as never,
        scopes,
        "user",
      ),
    ),
  )
}

async function insertAs(scopes: string[], row: Record<string, unknown>): Promise<boolean> {
  try {
    await asUser(scopes, (b) => b.db_insert("incident_comments", JSON.stringify(row)))
    return true
  } catch {
    return false
  }
}

async function readAs(
  scopes: string[],
  incidentId: string,
  org?: { orgId: string; userId: string },
): Promise<Record<string, any>[]> {
  return JSON.parse(
    await asUser(
      scopes,
      (b) =>
        b.db_findMany("incident_comments", JSON.stringify({ where: { incident_id: incidentId } })),
      org,
    ),
  )
}

async function insertIncident(orgId: string, title: string, firstSeenAt: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO app_monitoring.incidents
      (org_id, source, severity, title, status, count, first_seen_at, last_seen_at)
    VALUES (${orgId}, 'uptime', 'warning', ${title}, 'open', 1, ${firstSeenAt}, ${firstSeenAt})
    RETURNING id`
  return row!.id
}

async function refsByFirstSeen(orgId: string): Promise<Array<number | null>> {
  const rows = await sql<{ ref_number: number | null }[]>`
    SELECT ref_number FROM app_monitoring.incidents
    WHERE org_id = ${orgId} ORDER BY first_seen_at, id`
  return rows.map((r) => (r.ref_number == null ? null : Number(r.ref_number)))
}

async function sequenceValue(orgId: string): Promise<number | null> {
  const [row] = await sql<{ value: string | number }[]>`
    SELECT value FROM kernel.app_sequences
    WHERE org_id = ${orgId} AND app_id = 'monitoring' AND key = ${SEQUENCE_KEY}`
  return row ? Number(row.value) : null
}

async function uniqueIndexes(table: string): Promise<string[]> {
  const rows = await sql<{ cols: string }[]>`
    SELECT (SELECT string_agg(a.attname::text, ',' ORDER BY a.attname::text)
              FROM unnest(i.indkey) AS k(attnum)
              JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS cols
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = ${SCHEMA} AND t.relname = ${table}
      AND i.indisunique AND NOT i.indisprimary AND i.indpred IS NULL`
  return rows.map((r) => r.cols).sort()
}

async function columnCount(table: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM information_schema.columns
    WHERE table_schema = ${SCHEMA} AND table_name = ${table}`
  return Number(row!.n)
}

async function indexDefs(table: string): Promise<Array<{ indexname: string; indexdef: string }>> {
  return [
    ...(await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = ${SCHEMA} AND tablename = ${table} ORDER BY indexname`),
  ].map((r) => ({ indexname: r.indexname, indexdef: r.indexdef }))
}

/**
 * Backends waiting on THIS org's ref-sequence lock (the allocator's
 * `pg_advisory_xact_lock(hashtextextended('<org>:monitoring:incident_ref', 0))`), not on any
 * other advisory lock in the database (a concurrent registration's DDL lock, say). A bigint
 * advisory key shows in pg_locks as classid = high 32 bits, objid = low 32 bits, objsubid = 1.
 */
async function refLockWaiters(orgId: string): Promise<number> {
  const key = `${orgId}:${SEQUENCE_KEY}`
  const [row] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM pg_locks l
    WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND l.classid = ((hashtextextended(${key}, 0) >> 32) & 4294967295)::oid
      AND l.objid = (hashtextextended(${key}, 0) & 4294967295)::oid`
  return Number(row!.n)
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeAll(async () => {
  // JS-only: `registerApps` takes the Postgres advisory DDL lock on its own
  // connection, so holding that same lock here would deadlock the registration.
  monitoringLock = await acquireAppSchemaJsLock(SCHEMA)
  await takeOverAppSchema(SCHEMA, { lock: monitoringLock })
  // The fixture schema is owned by the test role and registration only grants
  // USAGE: without this its DDL is refused for a reason unrelated to the test.
  await sql.unsafe(`GRANT ALL ON SCHEMA ${SCHEMA} TO liaison_rls, liaison_app, liaison_admin`)

  const [a] = await sql<{ id: string }[]>`
    INSERT INTO kernel.organizations (id, name, slug)
    VALUES (gen_random_uuid(), 'Monitoring Refs Org A', ${`${slug}-a`}) RETURNING id`
  orgA = a!.id
  const [b] = await sql<{ id: string }[]>`
    INSERT INTO kernel.organizations (id, name, slug)
    VALUES (gen_random_uuid(), 'Monitoring Refs Org B', ${`${slug}-b`}) RETURNING id`
  orgB = b!.id
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
    VALUES (gen_random_uuid(), ${orgA}, ${`m-${slug}@test.com`}, 'Member', 'active', 'hash', 1, 1)
    RETURNING id`
  userId = u!.id
  const [ub] = await sql<{ id: string }[]>`
    INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
    VALUES (gen_random_uuid(), ${orgB}, ${`mb-${slug}@test.com`}, 'Member B', 'active', 'hash', 1, 1)
    RETURNING id`
  userB = ub!.id

  await registerApps([descriptor(manifest035(), "0.3.5")], orgA)
  // Inserted out of `first_seen_at` order: 03:00, 01:00, 02:00.
  incidentsA.push(await insertIncident(orgA, "third", "2026-07-01T03:00:00.000Z"))
  incidentsA.push(await insertIncident(orgA, "first", "2026-07-01T01:00:00.000Z"))
  incidentsA.push(await insertIncident(orgA, "second", "2026-07-01T02:00:00.000Z"))
})

afterAll(async () => {
  const orgs = [orgA, orgB].filter(Boolean)
  try {
    if (orgs.length > 0) {
      await sql`DELETE FROM kernel.app_sequences WHERE org_id IN ${sql(orgs)}`
      await sql`DELETE FROM kernel.apps WHERE org_id IN ${sql(orgs)}`
      await sql`DELETE FROM kernel.users WHERE org_id IN ${sql(orgs)}`
      await sql`DELETE FROM kernel.organizations WHERE id IN ${sql(orgs)}`
    }
  } finally {
    try {
      await releaseAppSchema(SCHEMA)
    } finally {
      await releaseAppSchemaJsLock(SCHEMA)
    }
  }
})

describe("monitoring 0.4.0: incident refs and comments on the real kernel", () => {
  it("upgrades 0.3.5 to 0.4.0: nullable ref_number, its unique index, the comments table", async () => {
    await registerApps([descriptor(manifest040, "0.4.0")], orgA)

    const cols = await sql<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = ${SCHEMA} AND table_name = 'incidents' AND column_name = 'ref_number'`
    expect(cols.map((c) => c.is_nullable)).toEqual(["YES"])
    expect(await uniqueIndexes("incidents")).toContain("org_id,ref_number")

    const fks = await sql<{ cols: string; confdeltype: string }[]>`
      SELECT (SELECT string_agg(a.attname::text, ',' ORDER BY a.attname::text)
                FROM unnest(c.conkey) AS k(attnum)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
             c.confdeltype::text AS confdeltype
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_class r ON r.oid = c.confrelid
      WHERE c.contype = 'f' AND n.nspname = ${SCHEMA}
        AND t.relname = 'incident_comments' AND r.relname = 'incidents'`
    expect(fks.length).toBe(1)
    expect(fks[0]!.cols.split(",")).toContain("incident_id")
    expect(fks[0]!.confdeltype).toBe("c")

    expect(await refsByFirstSeen(orgA)).toEqual([null, null, null])
  })

  it("registering again adds no duplicate index or column", async () => {
    const before = {
      unique: await uniqueIndexes("incidents"),
      incidentCols: await columnCount("incidents"),
      commentCols: await columnCount("incident_comments"),
      commentIndexes: await indexDefs("incident_comments"),
    }
    await registerApps([descriptor(manifest040, "0.4.1")], orgA)
    const after = {
      unique: await uniqueIndexes("incidents"),
      incidentCols: await columnCount("incidents"),
      commentCols: await columnCount("incident_comments"),
      commentIndexes: await indexDefs("incident_comments"),
    }
    expect(after).toEqual(before)
  })

  it("numbers the un-numbered incidents oldest first through the real bridge, once", async () => {
    expect(await inSystemTx(orgA, (ctx) => assignMissingRefs(ctx, BATCH))).toEqual({
      assigned: 3,
      remaining: false,
    })
    expect(await refsByFirstSeen(orgA)).toEqual([1, 2, 3])

    expect(await inSystemTx(orgA, (ctx) => assignMissingRefs(ctx, BATCH))).toEqual({
      assigned: 0,
      remaining: false,
    })
    expect(await sequenceValue(orgA)).toBe(3)
  })

  it("a second numberer overlapping an uncommitted one waits on the lock and renumbers nothing", async () => {
    incidentsA.push(await insertIncident(orgA, "fourth", "2026-07-02T01:00:00.000Z"))
    incidentsA.push(await insertIncident(orgA, "fifth", "2026-07-02T02:00:00.000Z"))

    const allocatedA = deferred()
    const gate = deferred()
    const txA = inSystemTx(orgA, async (ctx) => {
      const r = await assignMissingRefs(ctx, BATCH)
      allocatedA.resolve()
      await gate.promise
      return r
    })
    await allocatedA.promise

    // A holds the org advisory lock, uncommitted: B's unlocked probe still sees
    // NULL rows, so B must block in `allocate` until A commits.
    const txB = inSystemTx(orgA, (ctx) => assignMissingRefs(ctx, BATCH))
    const deadline = Date.now() + 10_000
    while ((await refLockWaiters(orgA)) < 1) {
      if (Date.now() > deadline) {
        gate.resolve()
        await Promise.allSettled([txA, txB])
        throw new Error("the second numberer never waited on the advisory lock within 10 s")
      }
      await Bun.sleep(50)
    }
    gate.resolve()

    const [a, b] = await Promise.all([txA, txB])
    expect(a).toEqual({ assigned: 2, remaining: false })
    expect(b).toEqual({ assigned: 0, remaining: false })
    expect(await refsByFirstSeen(orgA)).toEqual([1, 2, 3, 4, 5])
    // A used 4 and 5; B allocated 6 under the lock, found nothing left and burned it.
    expect(await sequenceValue(orgA)).toBe(6)
  })

  it("the bridge refuses where.id on updateMany", async () => {
    await expect(
      inSystemTx(orgA, (_ctx, bridge) =>
        bridge.db_updateMany(
          "incidents",
          JSON.stringify({ where: { id: incidentsA[0] }, data: { title: "x" } }),
        ),
      ),
    ).rejects.toThrow(/where.id is not allowed here/)
  })

  it("numbers per org and resolves a ref only inside its own org", async () => {
    await registerApps([descriptor(manifest040, "0.4.0")], orgB)
    const incidentB = await insertIncident(orgB, "org b", "2026-07-03T01:00:00.000Z")

    expect(await inSystemTx(orgB, (ctx) => assignMissingRefs(ctx, BATCH))).toEqual({
      assigned: 1,
      remaining: false,
    })
    expect(await refsByFirstSeen(orgB)).toEqual([1])
    expect(await sequenceValue(orgB)).toBe(1)
    expect(await sequenceValue(orgA)).toBe(6)

    const byRef1 = (await inSystemTx(orgB, (ctx) =>
      ctx.db.findMany("incidents", { where: { ref_number: 1 } }),
    )) as Array<{ id: string }>
    expect(byRef1.map((r) => r.id)).toEqual([incidentB])
    expect(
      await inSystemTx(orgB, (ctx) => ctx.db.findMany("incidents", { where: { ref_number: 5 } })),
    ).toEqual([])
  })

  it("a monitoring:incidents:write user comments; a reader reads; others are refused", async () => {
    const incidentId = incidentsA[1]!
    const row = { incident_id: incidentId, kind: "comment", body: "b", author_id: userId }

    expect(await insertAs(["monitoring:incidents:write"], row)).toBe(true)
    const read = await readAs(["monitoring:incidents:read"], incidentId)
    expect(read.map((r) => ({ kind: r.kind, body: r.body, author_id: r.author_id }))).toEqual([
      { kind: "comment", body: "b", author_id: userId },
    ])

    expect(await insertAs(["monitoring:incidents:read"], { ...row, body: "refused" })).toBe(false)
    expect(await readAs(["kpi:read"], incidentId)).toEqual([])
  })

  it("another org sees none of org A's comments and cannot comment on org A's incident", async () => {
    const orgBMember = { orgId: orgB, userId: userB }
    const incidentId = incidentsA[1]!
    expect((await readAs(["monitoring:incidents:read"], incidentId)).length).toBe(1)
    expect(
      await readAs(
        ["monitoring:incidents:read", "monitoring:incidents:write"],
        incidentId,
        orgBMember,
      ),
    ).toEqual([])
    // The tool path resolves the incident through org B's bridge first: not found.
    await expect(
      asUser(
        ["monitoring:incidents:write"],
        (b) => incidentsCommentHandler({ incidentId, body: "cross-org" }, handlerCtx(b, userB, [])),
        orgBMember,
      ),
    ).rejects.toThrow(/incident_not_found/)
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM app_monitoring.incident_comments WHERE body = 'cross-org'`
    expect(Number(row!.n)).toBe(0)
  })

  it("the system webhook actor archives an episode under RLS", async () => {
    const incidentId = incidentsA[1]!
    await inSystemTx(orgA, (ctx) =>
      ctx.db.insert("incident_comments", {
        incident_id: incidentId,
        kind: "episode",
        body: "old body",
        episode_title: "old title",
        episode_resolved_at: "2026-07-05T03:00:00.000Z",
        episode_resolution_note: "restarted",
        author_id: null,
      }),
    )

    const episodes = (await readAs(["monitoring:incidents:read"], incidentId)).filter(
      (r) => r.kind === "episode",
    )
    expect(
      episodes.map((r) => ({
        body: r.body,
        episode_title: r.episode_title,
        episode_resolved_at: new Date(r.episode_resolved_at).toISOString(),
        episode_resolution_note: r.episode_resolution_note,
        author_id: r.author_id ?? null,
      })),
    ).toEqual([
      {
        body: "old body",
        episode_title: "old title",
        episode_resolved_at: "2026-07-05T03:00:00.000Z",
        episode_resolution_note: "restarted",
        author_id: null,
      },
    ])
  })

  it("deleting an incident deletes its comments", async () => {
    const incidentId = incidentsA[1]!
    const comments = async () => {
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*) AS n FROM app_monitoring.incident_comments WHERE incident_id = ${incidentId}`
      return Number(row!.n)
    }
    expect(await comments()).toBe(2)
    await sql`DELETE FROM app_monitoring.incidents WHERE id = ${incidentId}`
    expect(await comments()).toBe(0)
  })

  it("the reopen compare-and-set counts one row on the real bridge, then zero", async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO app_monitoring.incidents
        (org_id, source, severity, title, status, count, first_seen_at, last_seen_at, dedup_key, ref_number)
      VALUES (${orgA}, 'cas', 'warning', 'cas', 'resolved', 1, now(), now(), 'cas-key', 900)
      RETURNING id`
    const cas = JSON.stringify({
      where: { source: "cas", dedup_key: "cas-key", status: "resolved" },
      data: { status: "open" },
    })
    expect(
      await inSystemTx(orgA, async (_ctx, b) =>
        JSON.parse(await b.db_updateMany("incidents", cas)),
      ),
    ).toEqual({
      count: 1,
    })
    expect(
      await inSystemTx(orgA, async (_ctx, b) =>
        JSON.parse(await b.db_updateMany("incidents", cas)),
      ),
    ).toEqual({
      count: 0,
    })
    await sql`DELETE FROM app_monitoring.incidents WHERE id = ${row!.id}`
  })

  it("the webhook creates, reopens (one episode) and folds through the real bridge", async () => {
    const alert = {
      source: "grafana",
      severity: "warning",
      title: "Disk almost full",
      body: "disk at 91%",
      dedupKey: "disk",
      ts: "2026-07-05T03:00:00Z",
    }
    const deliver = async (payload: Record<string, unknown>) => {
      const emits: Emitted[] = []
      const res = await inSystemTx(orgA, (_ctx, b) =>
        alertWebhookHandler(payload, handlerCtx(b, "system", emits)),
      )
      return { res, emits }
    }
    const episodes = async (id: string) => {
      const rows = await sql<
        { episode_title: string; body: string | null; episode_resolution_note: string | null }[]
      >`
        SELECT episode_title, body, episode_resolution_note FROM app_monitoring.incident_comments
        WHERE incident_id = ${id} AND kind = 'episode'`
      return [...rows].map((r) => ({ ...r }))
    }

    const created = await deliver(alert)
    expect(created.res.status).toBe(200)
    expect(created.emits.map((e) => e.action)).toEqual(["created"])
    // Every older incident of org A is numbered; the sequence stood at 6.
    expect({
      ref: created.emits[0]!.data?.ref,
      refLabel: created.emits[0]!.data?.refLabel,
    }).toEqual({
      ref: "INC-7",
      refLabel: "[INC-7] ",
    })
    const id = created.emits[0]!.entityId!
    await sql`
      UPDATE app_monitoring.incidents
      SET status = 'resolved', resolved_at = now(), resolution_note = 'restarted', acknowledged_at = now()
      WHERE id = ${id}`

    const reopened = await deliver({
      ...alert,
      severity: "critical",
      title: "Disk full",
      ts: "2026-07-05T05:00:00Z",
    })
    expect(reopened.res.status).toBe(200)
    expect(reopened.emits.map((e) => [e.action, e.data?.ref])).toEqual([["reopened", "INC-7"]])
    const [live] = await sql<Record<string, unknown>[]>`
      SELECT status, severity, title, body, count, resolved_at, resolution_note, acknowledged_at, ref_number
      FROM app_monitoring.incidents WHERE id = ${id}`
    expect({ ...live }).toEqual({
      status: "open",
      severity: "critical",
      title: "Disk full",
      body: "disk at 91%",
      count: 2,
      resolved_at: null,
      resolution_note: null,
      acknowledged_at: null,
      ref_number: 7,
    })
    expect(await episodes(id)).toEqual([
      {
        episode_title: "Disk almost full",
        body: "disk at 91%",
        episode_resolution_note: "restarted",
      },
    ])

    const again = await deliver({
      ...alert,
      severity: "critical",
      title: "Disk full",
      ts: "2026-07-05T05:01:00Z",
    })
    expect(again.emits.map((e) => e.action)).toEqual(["repeated"])
    expect((await episodes(id)).length).toBe(1)
  })

  it("incidents_comment and incidents_get run through a user's bridge: comments oldest first, by ref", async () => {
    const emits: Emitted[] = []
    for (const body of ["vendor ticket 4821", "rolled back"]) {
      await asUser(["monitoring:incidents:write"], (b) =>
        incidentsCommentHandler({ incidentId: "inc-7", body }, handlerCtx(b, userId, emits)),
      )
    }
    expect(emits.map((e) => [e.action, e.data?.ref])).toEqual([
      ["commented", "INC-7"],
      ["commented", "INC-7"],
    ])
    const res = await asUser(["monitoring:incidents:read"], (b) =>
      incidentsGetHandler({ incidentId: " INC-7 " }, handlerCtx(b, userId, [])),
    )
    expect(res.data.ref).toBe("INC-7")
    expect(
      res.data.comments.map((c) => [
        c.kind,
        c.kind === "episode" ? c.episodeTitle : c.body,
        c.authorId,
      ]),
    ).toEqual([
      ["episode", "Disk almost full", null],
      ["comment", "vendor ticket 4821", userId],
      ["comment", "rolled back", userId],
    ])
    expect(res.data.commentsTruncated).toBe(false)
  })

  it("the assign-refs job numbers under the job runtime's system actor", async () => {
    await insertIncident(orgA, "late", "2026-07-06T01:00:00.000Z")
    const result = await withRlsContext(
      { actorType: "system", orgId: orgA, purpose: "job", scopes: ["monitoring:*"] },
      (tx) => {
        const bridge = createRpcBridge(
          "monitoring",
          "system:monitoring:assign-refs",
          orgA,
          tx,
          manifest040 as never,
        )
        return assignRefsJobHandler({}, handlerCtx(bridge, "system:monitoring:assign-refs", []))
      },
    )
    expect(result).toEqual({ assigned: 1, remaining: false })
    expect(await sequenceValue(orgA)).toBe(8)
  })
})
