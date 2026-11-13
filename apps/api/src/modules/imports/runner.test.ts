// SPDX-License-Identifier: FSL-1.1-ALv2
// The import runner (P3a T3): dedup, per-record savepoints, refusals before any
// write, dimension grants, cancel, the bundled path through the worker pool and
// its ledger recovery, API-only file sources (A9, R10) and org isolation.
// Real database, two fixture kinds on ad-hoc schemas: a host kind
// (`importfix.widget`) and a sandboxed bundle kind (`importbundlefix.widget`).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { getObjectBuffer, putObject } from "~/infra/storage/object-storage"
import { importRegistry, manifestFileParentRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { BUILTIN_IMPORT_HANDLERS } from "~/modules/imports/builtin-import-handlers"
import type { ImportKindDecl } from "~/modules/imports/kind-schema"
import { getImportKind } from "~/modules/imports/kinds"
import { insertLedgerRows } from "~/modules/imports/ledger"
import { recoverLedger } from "~/modules/imports/recover"
import { ImportInterruptedError, previewCheckSession, runImport } from "~/modules/imports/runner"
import { createImportRun, markRunRunning, requestRunCancel } from "~/modules/imports/runs"
import type { SourceItem } from "~/modules/imports/source"
import { sweepStaleImportRuns } from "~/modules/imports/sweep"
import { dedupMatchSql, type HostImportHandler, ImportError } from "~/modules/imports/types"
import { undoImportRun } from "~/modules/imports/undo"
import { generateRlsPolicySql } from "~/modules/permissions/rls-generator"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const HOST_SCHEMA = "app_importfix"
const BUNDLE_SCHEMA = "app_importbundlefix"
const FIXTURE_BUNDLE = new URL("./__fixtures__/import-fixture-bundle.js", import.meta.url).pathname

const HOST_DECL: ImportKindDecl = {
  schema: {
    type: "object",
    required: ["ref", "title"],
    properties: {
      ref: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
      team: { type: "string" },
    },
    additionalProperties: false,
  },
  handler: "importWidget",
  dedupKey: "ref",
  tables: [`${HOST_SCHEMA}.widgets`],
  writeScopes: ["importfix:widgets:write"],
}

// A kind whose records update an earlier record's row (an in-run roll-up, D6).
const ROLLUP_DECL: ImportKindDecl = {
  schema: {
    type: "object",
    required: ["ref", "title"],
    properties: {
      ref: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
      bumpRef: { type: "string" },
      silent: { type: "boolean" },
    },
    additionalProperties: false,
  },
  handler: "importRollups",
  dedupKey: "ref",
  tables: [`${HOST_SCHEMA}.widgets`],
  writeScopes: ["importfix:widgets:write"],
  rollupTables: [`${HOST_SCHEMA}.widgets`],
}

const BUNDLE_DECL: ImportKindDecl = {
  schema: {
    type: "object",
    required: ["ref", "title"],
    properties: { ref: { type: "string" }, title: { type: "string" } },
  },
  handler: "importWidgets",
  dedupKey: "ref",
  tables: [`${BUNDLE_SCHEMA}.widgets`],
  writeScopes: ["importbundlefix:widgets:write"],
}

const BUNDLE_MANIFEST = {
  name: "importbundlefix",
  schema: { widgets: { fields: { externalRef: "string", title: "string" } } },
  events: { emits: [] },
  connections: {},
  network: { allowedDomains: [] },
}

const hostHandler: HostImportHandler = {
  async importRecord(tx, ctx, record, dedupValue) {
    if (ctx.options.noPrecheck !== true) {
      const existing = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT id FROM ${drizzleSql.raw(HOST_SCHEMA)}.widgets
          WHERE org_id = ${ctx.orgId}::uuid
            AND ${dedupMatchSql(drizzleSql`external_ref`, ctx.sourceLabel, String(record.ref))}
          LIMIT 1
        `),
      )
      if (existing.length > 0) return { status: "skipped", rows: [] }
    }
    const inserted = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${drizzleSql.raw(HOST_SCHEMA)}.widgets (org_id, external_ref, title, team)
        VALUES (${ctx.orgId}::uuid, ${dedupValue}, ${String(record.title)}, ${
          typeof record.team === "string" ? record.team : null
        })
        RETURNING id
      `),
    )
    // A record whose title is "boom" fails AFTER its insert: the savepoint must
    // roll the row back, leaving nothing half-written.
    if (record.title === "boom") throw new Error("boom")
    return { status: "created", rows: [{ table: `${HOST_SCHEMA}.widgets`, id: inserted[0]!.id }] }
  },
  // With `options.after`, one more widget once the kind's last batch is in (D7).
  async afterKind(tx, ctx) {
    if (ctx.options.after !== true) return { rows: [] }
    const inserted = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${drizzleSql.raw(HOST_SCHEMA)}.widgets (org_id, external_ref, title)
        VALUES (${ctx.orgId}::uuid, ${`${ctx.sourceLabel}:__after__`}, 'after')
        RETURNING id
      `),
    )
    return {
      rows: [{ table: `${HOST_SCHEMA}.widgets`, id: inserted[0]!.id }],
      report: { linkedAfter: 1 },
    }
  },
}

/** Inserts a widget and, given `bumpRef`, updates the widget an earlier
 *  record of the run created (a roll-up such as a conversation's counters). */
const rollupHandler: HostImportHandler = {
  async importRecord(tx, ctx, record, dedupValue) {
    const inserted = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${drizzleSql.raw(HOST_SCHEMA)}.widgets (org_id, external_ref, title)
        VALUES (${ctx.orgId}::uuid, ${dedupValue}, ${String(record.title)})
        RETURNING id
      `),
    )
    const touched: Array<{ table: string; id: string }> = []
    if (typeof record.bumpRef === "string") {
      const bumped = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          UPDATE ${drizzleSql.raw(HOST_SCHEMA)}.widgets
          SET title = title || '+', updated_at = clock_timestamp()
          WHERE org_id = ${ctx.orgId}::uuid AND external_ref = ${`${ctx.sourceLabel}:${record.bumpRef}`}
          RETURNING id
        `),
      )
      // `silent`: the handler updates the row without saying so.
      if (record.silent !== true) {
        for (const b of bumped) touched.push({ table: `${HOST_SCHEMA}.widgets`, id: b.id })
      }
    }
    return {
      status: "created",
      rows: [{ table: `${HOST_SCHEMA}.widgets`, id: inserted[0]!.id }],
      touched,
    }
  },
}

let orgA = ""
let orgB = ""
let adminA = ""
let otherA = ""
let adminB = ""
const tmpDirs: string[] = []

function actor(
  userId: string,
  orgId: string,
  scopes: string[] = ["*"],
  dims: Record<string, string[]> = { "*": ["*"] },
): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: dims }
}

function recordsOf(records: Array<Record<string, unknown>>): {
  type: "records"
  records: SourceItem[]
} {
  return { type: "records", records: records.map((record, i) => ({ line: i + 1, record })) }
}

const ref = () => `W-${crypto.randomUUID().slice(0, 8)}`

async function hostRows(orgId: string, prefix = ""): Promise<Array<{ external_ref: string }>> {
  return extractRows(
    await sql.unsafe(
      `SELECT external_ref FROM ${HOST_SCHEMA}.widgets WHERE org_id = $1 AND external_ref LIKE $2`,
      [orgId, `${prefix}%`],
    ),
  )
}

async function ledgerCount(runId: string): Promise<number> {
  const rows =
    await sql`SELECT count(*)::int AS n FROM kernel.import_ledger WHERE run_id = ${runId}`
  return Number(rows[0]?.n ?? 0)
}

async function runStatus(runId: string): Promise<string> {
  const rows = await sql`SELECT status FROM kernel.import_runs WHERE id = ${runId}`
  return String(rows[0]?.status)
}

async function registerFixtureKinds(orgId: string, hostDecl: ImportKindDecl = HOST_DECL) {
  await ensureAppsForOrg(orgId)
  importRegistry.set([orgId, "importfix"], { kinds: { widget: hostDecl, rollup: ROLLUP_DECL } })
  importRegistry.set([orgId, "importbundlefix"], {
    kinds: {
      widget: BUNDLE_DECL,
      checkinsert: { ...BUNDLE_DECL, check: "checkWidgetsInsert" },
      checkeffect: { ...BUNDLE_DECL, check: "checkWidgetsEffect" },
    },
    bundle: { bundlePath: FIXTURE_BUNDLE, core: false },
    _manifest: BUNDLE_MANIFEST,
  })
}

async function makeUser(orgId: string, role: "admin" | "member"): Promise<string> {
  const { userId } = await ensureUser({
    orgId,
    email: `${role}-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: role,
    password: "pw-import-1!",
    role,
  })
  return userId
}

/** A thread only `ownerId` takes part in, with an NDJSON file uploaded to it. */
async function privateFile(orgId: string, ownerId: string, ndjson: string): Promise<string> {
  const fileId = crypto.randomUUID()
  const storageKey = `${orgId}/imports-test/${fileId}.ndjson`
  await putObject({
    key: storageKey,
    body: Buffer.from(ndjson),
    contentType: "application/x-ndjson",
  })
  await withPrivilegedDb(orgId, "t", async (tx) => {
    const threadId = crypto.randomUUID()
    await tx.execute(drizzleSql`
      INSERT INTO kernel.threads (id, org_id, handle, title, created_by)
      VALUES (${threadId}::uuid, ${orgId}::uuid, ${`imp-${threadId.slice(0, 8)}`}, 'import upload', ${ownerId}::uuid)
    `)
    await tx.execute(drizzleSql`
      INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${threadId}::uuid, ${ownerId}::uuid, ${orgId}::uuid, 'owner')
    `)
    await tx.execute(drizzleSql`
      INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type,
                                size_bytes, storage_key, uploaded_by)
      VALUES (${fileId}::uuid, ${orgId}::uuid, 'kernel', 'thread', ${threadId}, 'widgets.ndjson',
              'application/x-ndjson', ${Buffer.byteLength(ndjson)}, ${storageKey}, ${ownerId}::uuid)
    `)
  })
  return fileId
}

beforeAll(async () => {
  await acquireTestLock()
  for (const schema of [HOST_SCHEMA, BUNDLE_SCHEMA]) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await sql.unsafe(`CREATE SCHEMA "${schema}"`)
    await sql.unsafe(`
      CREATE TABLE "${schema}".widgets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL,
        external_ref text NOT NULL,
        title text NOT NULL,
        team text,
        doc_file_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    for (const role of ["liaison_rls", "liaison_admin"]) {
      await sql.unsafe(`GRANT USAGE ON SCHEMA "${schema}" TO ${role}`).catch(() => {})
      await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA "${schema}" TO ${role}`).catch(() => {})
    }
  }
  const policy = generateRlsPolicySql(
    BUNDLE_SCHEMA,
    "widgets",
    {},
    "importbundlefix",
    "widgets",
    BUNDLE_MANIFEST.schema.widgets.fields,
  )
  for (const stmt of policy.split(";").filter((s) => s.trim())) await sql.unsafe(`${stmt};`)

  orgA = (await ensureOrg({ slug: `imp-a-${crypto.randomUUID().slice(0, 8)}`, name: "Imp A" }))
    .orgId
  orgB = (await ensureOrg({ slug: `imp-b-${crypto.randomUUID().slice(0, 8)}`, name: "Imp B" }))
    .orgId
  adminA = await makeUser(orgA, "admin")
  otherA = await makeUser(orgA, "admin")
  adminB = await makeUser(orgB, "admin")
  await registerFixtureKinds(orgA)
  await registerFixtureKinds(orgB)
  BUILTIN_IMPORT_HANDLERS["importfix.widget"] = hostHandler
  BUILTIN_IMPORT_HANDLERS["importfix.rollup"] = rollupHandler
  // The real files SELECT policy (kernel thread parents included), as boot builds it.
  await rebuildFilesSelectPolicy()
}, 300_000)

afterAll(async () => {
  delete BUILTIN_IMPORT_HANDLERS["importfix.widget"]
  delete BUILTIN_IMPORT_HANDLERS["importfix.rollup"]
  // The fixture's file parents name a table dropped below: a later file in the
  // same process rebuilding the files policy would fail on them.
  for (const org of [orgA, orgB])
    manifestFileParentRegistry.deleteByPrefix([org, "importbundlefix"])
  await rebuildFilesSelectPolicy()
  await shutdownWorkerPool()
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  for (const schema of [HOST_SCHEMA, BUNDLE_SCHEMA]) {
    await sql
      .begin(async (tx) => {
        await tx.unsafe("SET LOCAL lock_timeout = '10s'")
        await tx.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      })
      .catch((err: unknown) => console.error(`drop ${schema} failed`, err))
  }
  await releaseTestLock()
}, 120_000)

describe("runImport: host kinds", () => {
  it("dedups: a second run creates nothing and skips every record", async () => {
    const recs = [ref(), ref(), ref()].map((r) => ({ ref: r, title: `Widget ${r}` }))
    const prefix = `dd${crypto.randomUUID().slice(0, 6)}`
    const first = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: recordsOf(recs),
      sourceLabel: prefix,
      mode: "cli",
    })
    expect(first.status).toBe("done")
    expect(first.counts["importfix.widget"]).toEqual({ created: 3, skipped: 0, failed: 0 })
    expect(await ledgerCount(first.runId)).toBe(3)

    const second = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: recordsOf(recs),
      sourceLabel: prefix,
      mode: "cli",
    })
    expect(second.counts["importfix.widget"]).toEqual({ created: 0, skipped: 3, failed: 0 })
    expect(await ledgerCount(second.runId)).toBe(0)
    expect((await hostRows(orgA, `${prefix}:`)).length).toBe(3)
    // Stored as `<source>:<key>`.
    expect((await hostRows(orgA, `${prefix}:`)).map((r) => r.external_ref).sort()).toEqual(
      recs.map((r) => `${prefix}:${r.ref}`).sort(),
    )

    // Discriminator: without the precheck the same rerun doubles the rows.
    await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: recordsOf(recs),
      sourceLabel: prefix,
      mode: "cli",
      kindOptions: { "importfix.widget": { noPrecheck: true } },
    })
    expect((await hostRows(orgA, `${prefix}:`)).length).toBe(6)
  })

  it("a record that fails schema validation is listed and the run continues", async () => {
    const good = ref()
    const r = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: recordsOf([{ ref: ref() }, { ref: good, title: "ok" }]),
      sourceLabel: "sv",
      mode: "cli",
    })
    expect(r.status).toBe("done")
    expect(r.counts["importfix.widget"]).toEqual({ created: 1, skipped: 0, failed: 1 })
    expect(String(r.errors[0]?.error)).toMatch(/^invalid record: .*title/)
    expect(r.errors[0]?.line).toBe(1)
    expect((await hostRows(orgA, `sv:${good}`)).length).toBe(1)
  })

  it("each record runs in its own savepoint: the middle one fails alone", async () => {
    const [a, b, c] = [ref(), ref(), ref()]
    const r = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: recordsOf([
        { ref: a, title: "one" },
        { ref: b, title: "boom" },
        { ref: c, title: "three" },
      ]),
      sourceLabel: "sp",
      mode: "cli",
    })
    expect(r.counts["importfix.widget"]).toEqual({ created: 2, skipped: 0, failed: 1 })
    expect(r.errors).toEqual([{ line: 2, kind: "importfix.widget", dedupKey: b, error: "boom" }])
    expect((await hostRows(orgA, `sp:${a}`)).length).toBe(1)
    expect((await hostRows(orgA, `sp:${b}`)).length).toBe(0)
    expect((await hostRows(orgA, `sp:${c}`)).length).toBe(1)
    expect(await ledgerCount(r.runId)).toBe(2)
  })

  it("refuses a person without the kind's write scope before any write", async () => {
    const before =
      await sql`SELECT count(*)::int AS n FROM kernel.import_runs WHERE org_id = ${orgA}`
    const k = ref()
    const err = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA, ["importfix:widgets:read"]),
      kinds: ["importfix.widget"],
      source: recordsOf([{ ref: k, title: "nope" }]),
      sourceLabel: "ns",
      mode: "cli",
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).code).toBe("forbidden")
    expect((err as ImportError).message).toContain("importfix:widgets:write")
    const after =
      await sql`SELECT count(*)::int AS n FROM kernel.import_runs WHERE org_id = ${orgA}`
    expect(after[0]?.n).toBe(before[0]?.n)
    expect((await hostRows(orgA, `ns:${k}`)).length).toBe(0)
  })

  it("a record whose dimension value is outside the grant fails out_of_scope", async () => {
    await registerFixtureKinds(orgA, {
      ...HOST_DECL,
      dimension: { field: "team", dimension: "importfix:team" },
    })
    try {
      const [red, blue] = [ref(), ref()]
      const r = await runImport({
        orgId: orgA,
        actor: actor(adminA, orgA, ["*"], { team: ["red"] }),
        kinds: ["importfix.widget"],
        source: recordsOf([
          { ref: red, title: "red one", team: "red" },
          { ref: blue, title: "blue one", team: "blue" },
        ]),
        sourceLabel: "dm",
        mode: "cli",
      })
      expect(r.counts["importfix.widget"]).toEqual({ created: 1, skipped: 0, failed: 1 })
      expect(String(r.errors[0]?.error)).toMatch(/^out_of_scope/)
      expect((await hostRows(orgA, `dm:${blue}`)).length).toBe(0)
    } finally {
      await registerFixtureKinds(orgA)
    }
  })

  it("stops cleanly between batches when the run is cancelled", async () => {
    const recs = Array.from({ length: 6 }, () => ({ ref: ref(), title: "c" }))
    const r = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: recordsOf(recs),
      sourceLabel: "cx",
      mode: "cli",
      batchSize: 2,
      hooks: {
        afterBatch: async (i, runId) => {
          if (i === 0) await requestRunCancel(orgA, runId)
        },
      },
    })
    expect(r.status).toBe("cancelled")
    expect(await runStatus(r.runId)).toBe("cancelled")
    expect(r.counts["importfix.widget"]?.created).toBe(2)
    expect((await hostRows(orgA, "cx:")).length).toBe(2)
  })

  it("a shutdown abort stops between batches and puts the run back in the queue, for a re-run that finishes it", async () => {
    const recs = Array.from({ length: 6 }, () => ({ ref: ref(), title: "s" }))
    const run = await createImportRun({
      orgId: orgA,
      kinds: ["importfix.widget"],
      sourceLabel: "sd",
      source: {},
      mode: "api",
      dryRun: false,
      placeholders: false,
      startedBy: adminA,
    })
    const abort = new AbortController()
    const first = runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: recordsOf(recs),
      sourceLabel: "sd",
      mode: "cli",
      batchSize: 2,
      runId: run.id,
      signal: abort.signal,
      hooks: {
        afterBatch: async (i) => {
          if (i === 0) abort.abort()
        },
      },
    })
    await expect(first).rejects.toBeInstanceOf(ImportInterruptedError)
    expect(await runStatus(run.id)).toBe("queued")
    expect((await hostRows(orgA, "sd:")).length).toBe(2)

    const again = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: recordsOf(recs),
      sourceLabel: "sd",
      mode: "cli",
      batchSize: 2,
      runId: run.id,
    })
    expect(again.status).toBe("done")
    expect(again.counts["importfix.widget"]).toEqual({ created: 4, skipped: 2, failed: 0 })
    expect((await hostRows(orgA, "sd:")).length).toBe(6)
  })

  it("legacy refs: a row imported earlier with the bare key is skipped", async () => {
    const k = ref()
    await sql.unsafe(
      `INSERT INTO ${HOST_SCHEMA}.widgets (org_id, external_ref, title) VALUES ($1, $2, 'legacy')`,
      [orgA, k],
    )
    const r = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: recordsOf([{ ref: k, title: "again" }]),
      sourceLabel: "jira",
      mode: "cli",
    })
    expect(r.counts["importfix.widget"]).toEqual({ created: 0, skipped: 1, failed: 0 })
    expect((await hostRows(orgA, `jira:${k}`)).length).toBe(0)
  })
})

describe("runImport: sources and isolation", () => {
  it("an API run with a server path is refused before any read (R10)", async () => {
    const err = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: { type: "path", path: "/nonexistent/should-never-be-opened.ndjson" },
      sourceLabel: "x",
      mode: "api",
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).code).toBe("invalid_source")
  })

  it("an API record carrying a filePath fails before it is written", async () => {
    const k = ref()
    const fileId = await privateFile(
      orgA,
      adminA,
      `${JSON.stringify({ ref: k, title: "t", filePath: "/etc/hosts" })}\n`,
    )
    const r = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: { type: "file", fileId },
      sourceLabel: "fp",
      mode: "api",
    })
    expect(r.counts["importfix.widget"]).toEqual({ created: 0, skipped: 0, failed: 1 })
    expect(String(r.errors[0]?.error)).toContain("filePath")
  })

  it("reads an uploaded NDJSON file the person can see", async () => {
    const [a, b] = [ref(), ref()]
    const fileId = await privateFile(
      orgA,
      adminA,
      `${JSON.stringify({ ref: a, title: "from file" })}\n\n${JSON.stringify({
        kind: "importfix.widget",
        record: { ref: b, title: "enveloped" },
      })}\nnot json\n`,
    )
    const r = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: { type: "file", fileId },
      sourceLabel: "fl",
      mode: "api",
    })
    expect(r.counts["importfix.widget"]).toEqual({ created: 2, skipped: 0, failed: 1 })
    expect(String(r.errors[0]?.error)).toMatch(/^malformed JSON/)
    expect(r.errors[0]?.line).toBe(4)
  })

  it("refuses another person's private file and another org's file (A9)", async () => {
    const fileA = await privateFile(orgA, adminA, `${JSON.stringify({ ref: ref(), title: "x" })}\n`)
    const fileB = await privateFile(orgB, adminB, `${JSON.stringify({ ref: ref(), title: "x" })}\n`)
    const asOther = await runImport({
      orgId: orgA,
      actor: actor(otherA, orgA),
      kinds: ["importfix.widget"],
      source: { type: "file", fileId: fileA },
      sourceLabel: "a9",
      mode: "api",
    }).catch((e: unknown) => e)
    expect((asOther as ImportError).code).toBe("file_not_found")
    const crossOrg = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: { type: "file", fileId: fileB },
      sourceLabel: "a9",
      mode: "api",
    }).catch((e: unknown) => e)
    expect((crossOrg as ImportError).code).toBe("file_not_found")
  })

  it("a run in one org neither matches nor touches another org's rows", async () => {
    const k = ref()
    await sql.unsafe(
      `INSERT INTO ${HOST_SCHEMA}.widgets (org_id, external_ref, title) VALUES ($1, $2, 'b-side')`,
      [orgB, `xo:${k}`],
    )
    const r = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: recordsOf([{ ref: k, title: "a-side" }]),
      sourceLabel: "xo",
      mode: "cli",
    })
    expect(r.counts["importfix.widget"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const bRows = extractRows<{ title: string }>(
      await sql.unsafe(
        `SELECT title FROM ${HOST_SCHEMA}.widgets WHERE org_id = $1 AND external_ref = $2`,
        [orgB, `xo:${k}`],
      ),
    )
    expect(bRows).toEqual([{ title: "b-side" }])
    // An actor of org A cannot run against org B.
    const err = await runImport({
      orgId: orgB,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: recordsOf([{ ref: k, title: "x" }]),
      sourceLabel: "xo",
      mode: "cli",
    }).catch((e: unknown) => e)
    expect((err as ImportError).code).toBe("forbidden")
  })
})

describe("runImport: bundled kinds", () => {
  async function bundleRows(prefix: string): Promise<number> {
    const rows = await sql.unsafe(
      `SELECT id FROM ${BUNDLE_SCHEMA}.widgets WHERE org_id = $1 AND external_ref LIKE $2`,
      [orgA, `${prefix}%`],
    )
    return rows.length
  }

  it("writes through ctx.db in the worker pool, ledgers the rows and dedups", async () => {
    const recs = [ref(), ref()].map((r) => ({ ref: r, title: `B ${r}` }))
    const label = `bn${crypto.randomUUID().slice(0, 6)}`
    const first = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importbundlefix.widget"],
      source: recordsOf(recs),
      sourceLabel: label,
      mode: "cli",
    })
    expect(first.counts["importbundlefix.widget"]).toEqual({ created: 2, skipped: 0, failed: 0 })
    expect(await bundleRows(`${label}:`)).toBe(2)
    expect(await ledgerCount(first.runId)).toBe(2)
    const again = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importbundlefix.widget"],
      source: recordsOf(recs),
      sourceLabel: label,
      mode: "cli",
    })
    expect(again.counts["importbundlefix.widget"]).toEqual({ created: 0, skipped: 2, failed: 0 })
  })

  it("recoverLedger restores the rows a crash between the two transactions left unrecorded", async () => {
    const label = `rc${crypto.randomUUID().slice(0, 6)}`
    let runId = ""
    const err = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importbundlefix.widget"],
      source: recordsOf([
        { ref: ref(), title: "r1" },
        { ref: ref(), title: "r2" },
      ]),
      sourceLabel: label,
      mode: "cli",
      hooks: {
        beforeBundledLedger: () => {
          throw new Error("simulated crash")
        },
      },
    }).catch((e: unknown) => e)
    expect((err as Error).message).toBe("simulated crash")
    const run = await sql`
      SELECT id FROM kernel.import_runs WHERE org_id = ${orgA} AND source_label = ${label}`
    runId = String(run[0]?.id)
    expect(await bundleRows(`${label}:`)).toBe(2)
    expect(await ledgerCount(runId)).toBe(0)
    expect(await recoverLedger(orgA, runId)).toBe(2)
    expect(await ledgerCount(runId)).toBe(2)
    // Idempotent.
    expect(await recoverLedger(orgA, runId)).toBe(0)
  })
})

// Keep `writeFileSync`/`mkdtempSync` referenced for path-source fixtures below.
describe("runImport: path sources (CLI)", () => {
  it("streams a local NDJSON file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imports-runner-"))
    tmpDirs.push(dir)
    const file = join(dir, "w.ndjson")
    const k = ref()
    writeFileSync(file, `${JSON.stringify({ ref: k, title: "local" })}\n`)
    const r = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: { type: "path", path: file },
      sourceLabel: "pt",
      mode: "cli",
    })
    expect(r.counts["importfix.widget"]).toEqual({ created: 1, skipped: 0, failed: 0 })
  })
})

describe("runImport: claims, caps, labels and the stale sweep (skeptic MINOR 9-11)", () => {
  it("of two workers claiming one queued run, exactly one wins", async () => {
    const run = await createImportRun({
      orgId: orgA,
      kinds: ["importfix.widget"],
      sourceLabel: "cl",
      source: {},
      mode: "api",
      dryRun: false,
      placeholders: false,
      startedBy: adminA,
    })
    const claims = await Promise.all([
      markRunRunning(orgA, run.id, true),
      markRunRunning(orgA, run.id, true),
    ])
    expect(claims.filter(Boolean)).toEqual([true])
  })

  it("refuses a source line longer than one record's cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imports-cap-"))
    tmpDirs.push(dir)
    const file = join(dir, "big.ndjson")
    writeFileSync(file, `${JSON.stringify({ ref: ref(), title: "x".repeat(1_100_000) })}\n`)
    const err = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: { type: "path", path: file },
      sourceLabel: "cap",
      mode: "cli",
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).code).toBe("invalid_source")
    expect((err as ImportError).message).toMatch(/line 1 is more than/)
  })

  it("refuses a bundled kind's run without a source label", async () => {
    const err = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importbundlefix.widget"],
      source: recordsOf([{ ref: ref(), title: "t" }]),
      sourceLabel: "",
      mode: "cli",
    }).catch((e: unknown) => e)
    expect((err as ImportError).code).toBe("invalid_request")
  })

  it("the sweep fails a run whose heartbeat stopped and recovers its bundled ledger", async () => {
    const label = `sw${crypto.randomUUID().slice(0, 6)}`
    const run = await createImportRun({
      orgId: orgA,
      kinds: ["importbundlefix.widget"],
      sourceLabel: label,
      source: {},
      mode: "api",
      dryRun: false,
      placeholders: false,
      startedBy: adminA,
      status: "running",
    })
    await sql`UPDATE kernel.import_runs SET started_at = now() - interval '30 minutes',
                heartbeat_at = now() - interval '20 minutes' WHERE id = ${run.id}`
    // Rows the crashed worker wrote through the bridge before recording them.
    await sql.unsafe(
      `INSERT INTO ${BUNDLE_SCHEMA}.widgets (org_id, external_ref, title, created_at)
       VALUES ($1, $2, 'w1', now() - interval '25 minutes'), ($1, $3, 'w2', now() - interval '25 minutes')`,
      [orgA, `${label}:a`, `${label}:b`],
    )
    const { swept } = await sweepStaleImportRuns()
    expect(swept).toBeGreaterThanOrEqual(1)
    expect(await runStatus(run.id)).toBe("failed")
    expect(await ledgerCount(run.id)).toBe(2)
    // A live run (fresh heartbeat) is left alone.
    const live = await createImportRun({
      orgId: orgA,
      kinds: ["importfix.widget"],
      sourceLabel: "live",
      source: {},
      mode: "api",
      dryRun: false,
      placeholders: false,
      startedBy: adminA,
      status: "running",
    })
    await sql`UPDATE kernel.import_runs SET started_at = now(), heartbeat_at = now() WHERE id = ${live.id}`
    await sweepStaleImportRuns()
    expect(await runStatus(live.id)).toBe("running")
  })
})

describe("a preview's check changes nothing", () => {
  async function bundleRows(prefix: string): Promise<number> {
    const rows = await sql.unsafe(
      `SELECT id FROM ${BUNDLE_SCHEMA}.widgets WHERE org_id = $1 AND external_ref LIKE $2`,
      [orgA, `${prefix}%`],
    )
    return rows.length
  }

  function preview(kind: string, titles: string[], label: string) {
    return runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: [kind],
      source: recordsOf(titles.map((title) => ({ ref: ref(), title }))),
      sourceLabel: label,
      mode: "cli",
      dryRun: true,
    })
  }

  it("a check that inserts fails its records and leaves no row", async () => {
    const label = `ci${crypto.randomUUID().slice(0, 6)}`
    const run = await preview("importbundlefix.checkinsert", ["one", "two"], label)
    expect(run.counts["importbundlefix.checkinsert"]).toEqual({ created: 0, skipped: 0, failed: 2 })
    expect(String(run.errors[0]?.error)).toMatch(/read_only|may only read/i)
    expect(await bundleRows(`${label}:`)).toBe(0)
  })

  for (const effect of ["fetch", "enqueueJob", "smtp_send", "emit"]) {
    it(`a check that calls ${effect} fails its record`, async () => {
      const run = await preview("importbundlefix.checkeffect", [effect], `ce${effect.slice(0, 4)}`)
      expect(run.counts["importbundlefix.checkeffect"]).toEqual({
        created: 0,
        skipped: 0,
        failed: 1,
      })
      expect(String(run.errors[0]?.error)).toContain(`ctx.${effect}`)
    })
  }

  it("the check's transactions are READ ONLY: a write that reaches the database fails there", async () => {
    const label = `ro${crypto.randomUUID().slice(0, 6)}`
    const write = previewCheckSession(actor(adminA, orgA)).run((tx) =>
      tx.execute(drizzleSql`
        INSERT INTO ${drizzleSql.raw(BUNDLE_SCHEMA)}.widgets (org_id, external_ref, title)
        VALUES (${orgA}::uuid, ${`${label}:x`}, 'x')`),
    )
    await expect(write).rejects.toThrow()
    const cause = await write.catch((e: unknown) => e)
    expect(String((cause as { cause?: { code?: string } })?.cause?.code)).toBe("25006")
    expect(await bundleRows(`${label}:`)).toBe(0)
  })
})

describe("undo of a bundled kind's run", () => {
  it("refuses a ledgered row created before the run started, and deletes nothing", async () => {
    // A row that existed before the run (another import, a person's work).
    const old = extractRows<{ id: string }>(
      await sql.unsafe(
        `INSERT INTO ${BUNDLE_SCHEMA}.widgets (org_id, external_ref, title, created_at)
         VALUES ($1, $2, 'older', now() - interval '2 days') RETURNING id`,
        [orgA, `pre:${ref()}`],
      ),
    )[0]!.id
    const run = await createImportRun({
      orgId: orgA,
      kinds: ["importbundlefix.widget"],
      sourceLabel: "pre",
      source: {},
      mode: "api",
      dryRun: false,
      placeholders: false,
      startedBy: adminA,
      status: "done",
    })
    await sql`UPDATE kernel.import_runs SET started_at = now() - interval '1 hour' WHERE id = ${run.id}`
    // A hostile bundle's ledger names the older row as its own.
    await withPrivilegedDb(orgA, "t", (tx) =>
      insertLedgerRows(tx, {
        orgId: orgA,
        runId: run.id,
        kind: "importbundlefix.widget",
        recordKey: "pre",
        rows: [{ table: `${BUNDLE_SCHEMA}.widgets`, id: old }],
      }),
    )
    const report = await undoImportRun(orgA, run.id, { userId: adminA })
    expect(report).toEqual({
      deleted: 0,
      refused: [{ table: `${BUNDLE_SCHEMA}.widgets`, id: old, reason: "predates_run" }],
    })
    const left = await sql.unsafe(`SELECT id FROM ${BUNDLE_SCHEMA}.widgets WHERE id = $1`, [old])
    expect(left.length).toBe(1)
  })
})

describe("runImport: a bundle's host-verified side channels (D4)", () => {
  const STARTED_KEY = `imports-test/${crypto.randomUUID()}`

  /** A kernel.files row, as a bundle's files_* bridge call would have written it. */
  async function fileRow(args: {
    id?: string
    orgId: string
    app: string
    uploadedBy: string
    old?: boolean
  }): Promise<{ id: string; storageKey: string }> {
    const id = args.id ?? crypto.randomUUID()
    const storageKey = `${args.orgId}/${STARTED_KEY}/${id}.pdf`
    await putObject({
      key: storageKey,
      body: Buffer.from("%PDF-1.4"),
      contentType: "application/pdf",
    })
    await sql.unsafe(
      `INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type,
                                 size_bytes, storage_key, uploaded_by, created_at)
       VALUES ($1::uuid, $2, $3, 'pdf', $1::text, 'doc.pdf', 'application/pdf', 8, $4, $5,
               ${args.old ? "now() - interval '1 day'" : "now()"})`,
      [id, args.orgId, args.app, storageKey, args.uploadedBy],
    )
    return { id, storageKey }
  }

  async function ledgerFiles(runId: string): Promise<string[]> {
    const rows = await sql`
      SELECT row_id FROM kernel.import_ledger WHERE run_id = ${runId} AND table_name = 'kernel.files'`
    return rows.map((r) => String(r.row_id))
  }

  it("a file row of the kind's own app and org is ledgered and undone with its storage object", async () => {
    const label = `fl${crypto.randomUUID().slice(0, 6)}`
    const fileId = crypto.randomUUID()
    let storageKey = ""
    const result = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importbundlefix.widget"],
      source: recordsOf([{ ref: ref(), title: "with pdf", fileId }]),
      sourceLabel: label,
      mode: "cli",
      hooks: {
        // The bundle copied the PDF during the run (files_attachToParent): the
        // host's bridge created the row, so the run knows it.
        beforeBundledLedger: async (bridge) => {
          bridge.fileIds.add(fileId)
          const id = fileId
          storageKey = `${orgA}/${STARTED_KEY}/${id}.pdf`
          await putObject({
            key: storageKey,
            body: Buffer.from("%PDF-1.4"),
            contentType: "application/pdf",
          })
          await sql.unsafe(
            `INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type,
                                       size_bytes, storage_key, uploaded_by)
             VALUES ($1::uuid, $2, 'importbundlefix', 'pdf', $1::text, 'doc.pdf', 'application/pdf', 8, $3, $4)`,
            [id, orgA, storageKey, adminA],
          )
        },
      },
    })
    expect(result.counts["importbundlefix.widget"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    expect(await ledgerFiles(result.runId)).toEqual([fileId])
    const report = await undoImportRun(orgA, result.runId, { userId: adminA })
    expect(report.refused).toEqual([])
    expect(report.deleted).toBe(2)
    expect((await sql`SELECT 1 FROM kernel.files WHERE id = ${fileId}`).length).toBe(0)
    expect(await getObjectBuffer(storageKey).catch(() => null)).toBeNull()
  })

  it("each wrong file claim fails its record on its own, is never ledgered and survives undo", async () => {
    const label = `fh${crypto.randomUUID().slice(0, 6)}`
    // One flaw per record, every other condition right. All but the last were
    // "created through the bridge" during the run, so only the flaw refuses them.
    const cases: Array<{ flaw: string; file: Parameters<typeof fileRow>[0]; viaBridge: boolean }> =
      [
        {
          flaw: "another app",
          file: { orgId: orgA, app: "importfix", uploadedBy: adminA },
          viaBridge: true,
        },
        {
          flaw: "another org",
          file: { orgId: orgB, app: "importbundlefix", uploadedBy: adminB },
          viaBridge: true,
        },
        {
          flaw: "another uploader",
          file: { orgId: orgA, app: "importbundlefix", uploadedBy: otherA },
          viaBridge: true,
        },
        {
          flaw: "before the run",
          file: { orgId: orgA, app: "importbundlefix", uploadedBy: adminA, old: true },
          viaBridge: true,
        },
        {
          flaw: "not made by the run's bridge",
          file: { orgId: orgA, app: "importbundlefix", uploadedBy: adminA },
          viaBridge: false,
        },
      ].map((c) => ({ ...c, file: { ...c.file, id: crypto.randomUUID() } }))
    const made: Array<{ id: string; storageKey: string }> = []
    const result = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importbundlefix.widget"],
      source: recordsOf(cases.map((c) => ({ ref: ref(), title: c.flaw, fileId: c.file.id }))),
      sourceLabel: label,
      mode: "cli",
      hooks: {
        beforeBundledLedger: async (bridge) => {
          for (const c of cases) {
            made.push(await fileRow(c.file))
            if (c.viaBridge) bridge.fileIds.add(c.file.id!)
          }
        },
      },
    })
    expect(result.counts["importbundlefix.widget"]).toEqual({ created: 0, skipped: 0, failed: 5 })
    expect(result.errors.map((e) => String(e.error))).toEqual(
      cases.map((c) => `forbidden_row: kernel.files ${c.file.id}`),
    )
    expect(await ledgerFiles(result.runId)).toEqual([])
    // The widgets the bundle did write are ledgered, so undo removes them;
    // the files they named are untouched.
    const report = await undoImportRun(orgA, result.runId, { userId: adminA })
    expect(report.deleted).toBe(5)
    for (const f of made) {
      expect((await sql`SELECT 1 FROM kernel.files WHERE id = ${f.id}`).length).toBe(1)
      expect(await getObjectBuffer(f.storageKey)).toBeInstanceOf(Buffer)
    }
  })

  it("a file row is on one run's ledger at most", async () => {
    const run = (label: string) =>
      createImportRun({
        orgId: orgA,
        kinds: ["importbundlefix.widget"],
        sourceLabel: label,
        source: {},
        mode: "api",
        dryRun: false,
        placeholders: false,
        startedBy: adminA,
        status: "done",
      })
    const file = await fileRow({ orgId: orgA, app: "importbundlefix", uploadedBy: adminA })
    const [a, b] = [await run("one"), await run("two")]
    const ledger = (runId: string) =>
      withPrivilegedDb(orgA, "t", (tx) =>
        insertLedgerRows(tx, {
          orgId: orgA,
          runId,
          kind: "importbundlefix.widget",
          recordKey: "k",
          rows: [{ table: "kernel.files", id: file.id }],
        }),
      )
    await ledger(a.id)
    const refused = await ledger(b.id).then(
      () => "ledgered",
      (err: unknown) => {
        const cause = (err as { cause?: { code?: string; constraint_name?: string } }).cause
        return `${cause?.code} ${cause?.constraint_name}`
      },
    )
    expect(refused).toBe("23505 import_ledger_files_once")
  })

  it("sequenceFloors raise only the app's own keys and never lower one", async () => {
    const label = `sq${crypto.randomUUID().slice(0, 6)}`
    const keyA = `importbundlefix:doc:${label}:a`
    const keyB = `importbundlefix:doc:${label}:b`
    const foreign = `invoicing:doc:${label}`
    await sql`
      INSERT INTO kernel.app_sequences (org_id, app_id, key, value)
      VALUES (${orgA}, 'importbundlefix', ${keyA}, 9)`
    const result = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importbundlefix.widget"],
      source: recordsOf([
        { ref: ref(), title: "low", floors: [{ key: keyA, value: 5 }] },
        { ref: ref(), title: "high", floors: [{ key: keyB, value: 12 }] },
        { ref: ref(), title: "foreign", floors: [{ key: foreign, value: 3 }] },
        { ref: ref(), title: "huge", floors: [{ key: keyB, value: 2 ** 31 + 1 }] },
      ]),
      sourceLabel: label,
      mode: "cli",
    })
    expect(result.counts["importbundlefix.widget"]).toEqual({ created: 2, skipped: 0, failed: 2 })
    expect(result.errors.map((e) => String(e.error))).toEqual([
      expect.stringMatching(/^forbidden_sequence: /),
      expect.stringMatching(/^forbidden_sequence: /),
    ])
    const seq = await sql`
      SELECT app_id, key, value::int AS value FROM kernel.app_sequences
      WHERE org_id = ${orgA} AND key LIKE ${`%${label}%`} ORDER BY key`
    expect(seq.map((r) => [r.app_id, r.key, r.value])).toEqual([
      ["importbundlefix", keyA, 9],
      ["importbundlefix", keyB, 12],
    ])
  })
})

describe("runImport: afterKind and in-run roll-ups (D6, D7)", () => {
  it("afterKind runs once after the kind's last batch, is ledgered and undone", async () => {
    const label = `ak${crypto.randomUUID().slice(0, 6)}`
    const result = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importfix.widget"],
      source: recordsOf([
        { ref: ref(), title: "one" },
        { ref: ref(), title: "two" },
      ]),
      sourceLabel: label,
      mode: "cli",
      batchSize: 1,
      kindOptions: { "importfix.widget": { after: true } },
    })
    expect(result.counts["importfix.widget"]).toEqual({ created: 2, skipped: 0, failed: 0 })
    expect(result.report.linkedAfter).toBe(1)
    expect((await hostRows(orgA, `${label}:__after__`)).length).toBe(1)
    const keys = await sql`
      SELECT record_key FROM kernel.import_ledger WHERE run_id = ${result.runId} ORDER BY seq`
    expect(keys.map((r) => r.record_key).at(-1)).toBe("__after__")
    const report = await undoImportRun(orgA, result.runId, { userId: adminA })
    expect(report).toEqual({ deleted: 3, refused: [] })
    expect((await hostRows(orgA, `${label}:`)).length).toBe(0)
  })

  it("a roll-up row a later record of the run reported touching is undone; any other change is refused", async () => {
    const label = `ru${crypto.randomUUID().slice(0, 6)}`
    const [a, b, c] = [ref(), ref(), ref()]
    const run = (records: Array<Record<string, unknown>>) =>
      runImport({
        orgId: orgA,
        actor: actor(adminA, orgA),
        kinds: ["importfix.rollup"],
        source: recordsOf(records),
        sourceLabel: label,
        mode: "cli",
        batchSize: 1,
      })
    const first = await run([
      { ref: a, title: "root" },
      { ref: b, title: "reply", bumpRef: a },
    ])
    expect(first.counts["importfix.rollup"]).toEqual({ created: 2, skipped: 0, failed: 0 })
    expect(await undoImportRun(orgA, first.runId, { userId: adminA })).toEqual({
      deleted: 2,
      refused: [],
    })

    // An update the handler does not report is not the run's own: refused.
    const [d, e] = [ref(), ref()]
    const silent = await run([
      { ref: d, title: "root" },
      { ref: e, title: "reply", bumpRef: d, silent: true },
    ])
    const silentReport = await undoImportRun(orgA, silent.runId, { userId: adminA })
    expect(silentReport.refused.map((r) => r.reason)).toEqual(["changed_after_import"])

    const second = await run([{ ref: c, title: "kept" }])
    await sql.unsafe(
      `UPDATE ${HOST_SCHEMA}.widgets SET title = 'edited', updated_at = clock_timestamp()
       WHERE org_id = $1 AND external_ref = $2`,
      [orgA, `${label}:${c}`],
    )
    const report = await undoImportRun(orgA, second.runId, { userId: adminA })
    expect(report.deleted).toBe(0)
    expect(report.refused.map((r) => r.reason)).toEqual(["changed_after_import"])
  })
})

describe("runImport: a bundle's attachments (an uploaded file onto one of its rows)", () => {
  const parents = (orgId: string) => {
    // `widget_doc` keys files by the row id; `widget_pdf` is self-parented:
    // the row's doc_file_id names the file, as an invoice's pdf_file_id does.
    const base = {
      schemaRef: BUNDLE_SCHEMA,
      tableName: "widgets",
      readScope: "importbundlefix:widgets:read",
      writeScope: "importbundlefix:widgets:write",
    }
    manifestFileParentRegistry.set([orgId, "importbundlefix", "widget_doc"], {
      ...base,
      joinOn: "id",
    })
    manifestFileParentRegistry.set([orgId, "importbundlefix", "widget_pdf"], {
      ...base,
      joinOn: "doc_file_id",
    })
  }

  async function attachedFiles(runId: string) {
    return sql`
      SELECT f.id, f.app, f.entity_type, f.entity_id, f.storage_key, f.copied_from_id
      FROM kernel.import_ledger l JOIN kernel.files f ON f.id = l.row_id
      WHERE l.run_id = ${runId} AND l.table_name = 'kernel.files'`
  }

  it("refuses an attach past the org's storage cap and stores no copy", async () => {
    parents(orgA)
    const label = `cap${crypto.randomUUID().slice(0, 6)}`
    const source = await privateFile(orgA, adminA, "%PDF-1.4 original")
    // The org at a 1 GB cap, already holding 1 GB.
    const [prev] = await sql`SELECT caps FROM kernel.organizations WHERE id = ${orgA}`
    await sql`UPDATE kernel.organizations SET caps = ${JSON.stringify({ storageGb: 1 })}::jsonb WHERE id = ${orgA}`
    const [pad] = await sql`
      INSERT INTO kernel.files (org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key)
      VALUES (${orgA}, 'kernel', 'cap_pad', ${crypto.randomUUID()}, 'pad.bin', 'application/octet-stream',
              ${1024 ** 3}, ${`${orgA}/cap-pad/${label}`})
      RETURNING id`
    try {
      const result = await runImport({
        orgId: orgA,
        actor: actor(adminA, orgA),
        kinds: ["importbundlefix.widget"],
        source: recordsOf([
          { ref: ref(), title: "over cap", attach: { fileId: source, parent: "widget_doc" } },
        ]),
        sourceLabel: label,
        mode: "cli",
      })
      expect(result.counts["importbundlefix.widget"]).toEqual({ created: 0, skipped: 0, failed: 1 })
      expect(String(result.errors[0]?.error)).toMatch(/STORAGE_QUOTA_EXCEEDED/)
      expect((await attachedFiles(result.runId)).length).toBe(0)
    } finally {
      await sql`DELETE FROM kernel.files WHERE id = ${pad!.id}`
      await sql`UPDATE kernel.organizations SET caps = ${JSON.stringify(prev?.caps ?? {})}::jsonb WHERE id = ${orgA}`
    }
  })

  it("copies a file the person can see onto the record's row, self-parented, and undo removes it", async () => {
    parents(orgA)
    const label = `at${crypto.randomUUID().slice(0, 6)}`
    const source = await privateFile(orgA, adminA, "%PDF-1.4 original")
    const result = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importbundlefix.widget"],
      source: recordsOf([
        { ref: ref(), title: "with pdf", attach: { fileId: source, parent: "widget_pdf" } },
        { ref: ref(), title: "with doc", attach: { fileId: source, parent: "widget_doc" } },
      ]),
      sourceLabel: label,
      mode: "cli",
    })
    expect(result.counts["importbundlefix.widget"]).toEqual({ created: 2, skipped: 0, failed: 0 })
    const files = await attachedFiles(result.runId)
    expect(files.length).toBe(2)
    const widgets = await sql.unsafe(
      `SELECT id, title, doc_file_id FROM ${BUNDLE_SCHEMA}.widgets WHERE external_ref LIKE $1 ORDER BY title`,
      [`${label}:%`],
    )
    const pdf = files.find((f) => f.entity_type === "widget_pdf")!
    const doc = files.find((f) => f.entity_type === "widget_doc")!
    const withPdf = widgets.find((w) => w.title === "with pdf")!
    const withDoc = widgets.find((w) => w.title === "with doc")!
    expect([pdf.app, pdf.entity_id, pdf.copied_from_id]).toEqual([
      "importbundlefix",
      String(pdf.id),
      source,
    ])
    expect(withPdf.doc_file_id).toBe(pdf.id)
    expect(doc.entity_id).toBe(String(withDoc.id))
    expect(String(await getObjectBuffer(String(pdf.storage_key)))).toBe("%PDF-1.4 original")

    const report = await undoImportRun(orgA, result.runId, { userId: adminA })
    expect(report.refused).toEqual([])
    expect((await sql`SELECT 1 FROM kernel.files WHERE id = ${pdf.id}`).length).toBe(0)
    expect(await getObjectBuffer(String(pdf.storage_key)).catch(() => null)).toBeNull()
    // The uploaded source stays.
    expect((await sql`SELECT 1 FROM kernel.files WHERE id = ${source}`).length).toBe(1)
  })

  it("refuses another org's file, a row the record did not write, an unknown parent, and a parent the person cannot write", async () => {
    parents(orgA)
    const label = `ah${crypto.randomUUID().slice(0, 6)}`
    const mine = await privateFile(orgA, adminA, "mine")
    const foreign = await privateFile(orgB, adminB, "foreign")
    const [older] = await sql.unsafe(
      `INSERT INTO ${BUNDLE_SCHEMA}.widgets (org_id, external_ref, title) VALUES ($1, $2, 'older') RETURNING id`,
      [orgA, `pre:${ref()}`],
    )
    const recs = [
      { ref: ref(), title: "foreign file", attach: { fileId: foreign, parent: "widget_pdf" } },
      {
        ref: ref(),
        title: "other row",
        attach: { fileId: mine, parent: "widget_pdf", rowId: older!.id },
      },
      { ref: ref(), title: "no parent", attach: { fileId: mine, parent: "pdf" } },
    ]
    const result = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importbundlefix.widget"],
      source: recordsOf(recs),
      sourceLabel: label,
      mode: "cli",
    })
    expect(result.counts["importbundlefix.widget"]).toEqual({ created: 0, skipped: 0, failed: 3 })
    for (const e of result.errors) expect(String(e.error)).toMatch(/^forbidden_attachment: /)
    expect((await attachedFiles(result.runId)).length).toBe(0)
    const [olderAfter] = await sql.unsafe(
      `SELECT doc_file_id FROM ${BUNDLE_SCHEMA}.widgets WHERE id = $1`,
      [older!.id],
    )
    expect(olderAfter!.doc_file_id).toBeNull()

    const noWrite = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA, ["importbundlefix:widgets:write:limited"]),
      kinds: ["importbundlefix.widget"],
      source: recordsOf([
        { ref: ref(), title: "no scope", attach: { fileId: mine, parent: "widget_pdf" } },
      ]),
      sourceLabel: label,
      mode: "cli",
    }).catch((e: unknown) => e)
    // Without the kind's write scope the run itself is refused before any write.
    expect(String(noWrite)).toMatch(/missing scope/)
  })
})

describe("runImport: the rows a bundle reports are checked before they are ledgered", () => {
  async function ledgered(runId: string) {
    return (
      await sql`SELECT row_id::text AS id FROM kernel.import_ledger WHERE run_id = ${runId}`
    ).map((r) => String(r.id))
  }

  it("refuses a pre-existing row the bundle claims, and never attaches to it or ledgers it", async () => {
    const label = `pr${crypto.randomUUID().slice(0, 6)}`
    const mine = await privateFile(orgA, adminA, "probe")
    manifestFileParentRegistry.set([orgA, "importbundlefix", "widget_pdf"], {
      schemaRef: BUNDLE_SCHEMA,
      tableName: "widgets",
      readScope: "importbundlefix:widgets:read",
      writeScope: "importbundlefix:widgets:write",
      joinOn: "doc_file_id",
    })
    const [older] = await sql.unsafe(
      `INSERT INTO ${BUNDLE_SCHEMA}.widgets (org_id, external_ref, title) VALUES ($1, $2, 'older') RETURNING id`,
      [orgA, `pre:${ref()}`],
    )
    const olderId = String(older!.id)
    const result = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importbundlefix.widget"],
      source: recordsOf([
        { ref: ref(), title: "claims older", claimRowId: olderId },
        {
          ref: ref(),
          title: "attaches to older",
          claimRowId: olderId,
          attach: { fileId: mine, parent: "widget_pdf", rowId: olderId },
        },
      ]),
      sourceLabel: label,
      mode: "cli",
    })
    expect(result.counts["importbundlefix.widget"]).toEqual({ created: 0, skipped: 0, failed: 2 })
    for (const e of result.errors) expect(String(e.error)).toMatch(/^forbidden_row: /)
    expect(await ledgered(result.runId)).not.toContain(olderId)
    const [after] = await sql.unsafe(
      `SELECT doc_file_id FROM ${BUNDLE_SCHEMA}.widgets WHERE id = $1`,
      [olderId],
    )
    expect(after!.doc_file_id).toBeNull()
    // Undo removes what the records did write, and never the older row.
    await undoImportRun(orgA, result.runId, { userId: adminA })
    expect(
      (await sql.unsafe(`SELECT 1 FROM ${BUNDLE_SCHEMA}.widgets WHERE id = $1`, [olderId])).length,
    ).toBe(1)
  })

  it("refuses a row another run imported", async () => {
    const label = `pr${crypto.randomUUID().slice(0, 6)}`
    const first = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importbundlefix.widget"],
      source: recordsOf([{ ref: ref(), title: "first run" }]),
      sourceLabel: label,
      mode: "cli",
    })
    const [firstRow] = await ledgered(first.runId)
    const second = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importbundlefix.widget"],
      source: recordsOf([{ ref: ref(), title: "second", claimRowId: firstRow }]),
      sourceLabel: label,
      mode: "cli",
    })
    expect(second.counts["importbundlefix.widget"]).toEqual({ created: 0, skipped: 0, failed: 1 })
    expect(await ledgered(second.runId)).not.toContain(firstRow)
  })

  it("ledgers the rows of a record that failed after writing, so undo removes them", async () => {
    const label = `pf${crypto.randomUUID().slice(0, 6)}`
    const result = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA),
      kinds: ["importbundlefix.widget"],
      source: recordsOf([{ ref: ref(), title: "half written", failAfterInsert: true }]),
      sourceLabel: label,
      mode: "cli",
    })
    expect(result.counts["importbundlefix.widget"]).toEqual({ created: 0, skipped: 0, failed: 1 })
    const rows = await ledgered(result.runId)
    expect(rows.length).toBe(1)
    await undoImportRun(orgA, result.runId, { userId: adminA })
    expect(
      (await sql.unsafe(`SELECT 1 FROM ${BUNDLE_SCHEMA}.widgets WHERE id = $1`, [rows[0]])).length,
    ).toBe(0)
  })

  it("needs the file parent's own write scope, not only the kind's", async () => {
    manifestFileParentRegistry.set([orgA, "importbundlefix", "widget_secret"], {
      schemaRef: BUNDLE_SCHEMA,
      tableName: "widgets",
      readScope: "importbundlefix:widgets:read",
      writeScope: "importbundlefix:secrets:write",
      joinOn: "id",
    })
    const mine = await privateFile(orgA, adminA, "secret")
    const result = await runImport({
      orgId: orgA,
      actor: actor(adminA, orgA, ["importbundlefix:widgets:write"]),
      kinds: ["importbundlefix.widget"],
      source: recordsOf([
        { ref: ref(), title: "secret", attach: { fileId: mine, parent: "widget_secret" } },
      ]),
      sourceLabel: `ps${crypto.randomUUID().slice(0, 6)}`,
      mode: "cli",
    })
    expect(result.counts["importbundlefix.widget"]).toEqual({ created: 0, skipped: 0, failed: 1 })
    expect(String(result.errors[0]?.error)).toMatch(/needs importbundlefix:secrets:write/)
  })
})

describe("getImportKind: an installed app's kind from the CLI (no registration)", () => {
  const APP = "importinstfix"
  let root = ""
  let prevDir: string | undefined

  function writeApp(kinds: Record<string, unknown>) {
    const dir = join(root, APP, "1.0.0")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "app.manifest.json"),
      JSON.stringify({
        name: APP,
        version: "1.0.0",
        schema: { widgets: { fields: { externalRef: "string", title: "string" } } },
        import: { kinds },
      }),
    )
    copyFileSync(FIXTURE_BUNDLE, join(dir, "bundle.js"))
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "imports-installed-"))
    tmpDirs.push(root)
    prevDir = process.env.LIAISON_APPS_DIR
    process.env.LIAISON_APPS_DIR = root
    await sql`
      INSERT INTO kernel.apps_active_version (name, version) VALUES (${APP}, '1.0.0')
      ON CONFLICT (name) DO UPDATE SET version = '1.0.0'`
  })
  afterAll(async () => {
    if (prevDir === undefined) delete process.env.LIAISON_APPS_DIR
    else process.env.LIAISON_APPS_DIR = prevDir
    await sql`DELETE FROM kernel.apps_active_version WHERE name = ${APP}`
  })

  it("finds the active version's kind, sandboxed, with its bundle and bridge manifest", async () => {
    writeApp({
      widget: {
        schema: BUNDLE_DECL.schema,
        handler: "importWidgets",
        dedupKey: "ref",
        tables: [`app_${APP}.widgets`],
        writeScopes: [`${APP}:widgets:write`],
      },
      // Roll-up tables are for built-in kinds only.
      counted: {
        schema: BUNDLE_DECL.schema,
        handler: "importWidgets",
        dedupKey: "ref",
        tables: [`app_${APP}.widgets`],
        writeScopes: [`${APP}:widgets:write`],
        rollupTables: [`app_${APP}.widgets`],
      },
      // A hostile kind naming a kernel table is never resolved.
      people: {
        schema: BUNDLE_DECL.schema,
        handler: "importWidgets",
        dedupKey: "ref",
        tables: ["kernel.contacts"],
        writeScopes: [`${APP}:widgets:write`],
      },
    })
    const k = await getImportKind(orgA, `${APP}.widget`, { ensureApps: false })
    expect(k?.app).toBe(APP)
    expect(k?.bundle).toEqual({ bundlePath: join(root, APP, "1.0.0", "bundle.js"), core: false })
    expect((k?.manifest as { name?: string } | undefined)?.name).toBe(APP)
    expect(await getImportKind(orgA, `${APP}.people`, { ensureApps: false })).toBeNull()
    expect(await getImportKind(orgA, `${APP}.counted`, { ensureApps: false })).toBeNull()
    // An app with no active version is not resolved.
    expect(await getImportKind(orgA, "importnotinstalled.widget", { ensureApps: false })).toBeNull()
  })
})
