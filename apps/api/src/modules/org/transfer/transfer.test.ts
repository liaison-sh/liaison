// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One org moved between two instances: instance A is this test namespace's
// database, instance B a second database cloned from the same migrated
// template, each with its own ENCRYPTION_KEY and BYOK_ENCRYPTION_KEY. The org
// is the standard seed world (seedStandardWorld) plus secrets of both key
// families, a webhook replay mark and a consumer mark.
//
// Pinned:
//   - full round trip: every closure table holds exactly the same rows on B as
//     on A (secrets compared as plaintext: each opens on B with B's key and not
//     with A's), the org lands `incoming`, a neighbour org on either side is
//     untouched and never copied;
//   - B's sequences continue above A's (no handle collision for a new contact);
//   - the webhook replay mark and the org's consumer marks arrive;
//   - pass 2: a delta (update, insert, delete on A since pass 1) brings B to
//     the same rows as one full copy;
//   - refusals that leave B with nothing: version skew, a global-key collision,
//     a corrupted section, a wrong transfer key (the incoming copy is purged);
//   - reverse move: B -> A replaces A's `moved` copy; a `moved` copy held by
//     another transfer refuses;
//   - purge of a moved copy: refused for another transfer, then no row left;
//   - the export of an org that is not moving changes nothing; estimate shape;
//   - the header names the org's own custom apps (the agents install them).
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drizzle } from "drizzle-orm/postgres-js"
import { MeiliSearch } from "meilisearch"
import postgres from "postgres"
import { COLUMNS, JSON_COLUMNS, JSON_CONTEXTS, looksEncrypted } from "~/cli/keys-rotate"
import { createPool } from "~/db/connection"
import { PrivilegedDbTestAccess } from "~/db/privileged"
import { creditTransactions } from "~/db/schema/kernel/credits"
import { durableConsumerMarks } from "~/db/schema/kernel/durable-consumer-marks"
import { pendingEvents } from "~/db/schema/kernel/pending-events"
import * as searchClientModule from "~/infra/search/client"
import { CryptoContext, decryptSecret, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { redisBullMQ } from "~/lib/redis"
import { installCatalogApp } from "~/modules/apps/catalog"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { AppSchemaDdlTestAccess } from "~/modules/apps/runtime"
import { orgSearchFilter } from "~/modules/org/purge/external"
import { IndexWriterTestAccess, writeIndexAndWait } from "~/modules/search/index-writer"
import {
  seedActiveAppVersion,
  seedCustomAppInstall,
  seedDurableConsumerMark,
  seedPendingEvent,
} from "~/seed/factories/org/platform-rows"
import { seedOrgRow, seedUserRow, setUserPreferences } from "~/seed/factories/org/rows"
import { seedStandardWorld } from "~/seed/tiers/standard/seed-standard"
import { createTestOrg } from "~/tests/helpers/org"
import { firstPartyAppTarball } from "~/tests/helpers/test-app-catalog"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { BundleError, BundleWriter, readBundle } from "./bundle"
import { loadClosure, orgPredicate, rel } from "./closure"
import { estimateTransfer } from "./estimate"
import { exportOrg, type Fingerprint } from "./export"
import { countOrgClosure, foreignObjectKey, ImportRefused, importOrg } from "./import"
import { purgeTransferCopy, TransferPurgeRefused } from "./purge"
import { generateTransferKeys, type TransferKeys } from "./rekey"
import * as searchModule from "./search"

const hex = () => randomBytes(32).toString("hex")
const KEYS_A = { encryption: env.ENCRYPTION_KEY, byok: hex() }
const KEYS_B = { encryption: hex(), byok: hex() }
const ADMIN = `xfer-${randomUUID().slice(0, 8)}@transfer.test`

const superA = process.env.DATABASE_URL_SUPERUSER as string
const dbA = new URL(superA).pathname.slice(1)
const dbB = `${dbA}_xfer_b`
const withDb = (url: string, db: string) => {
  const u = new URL(url)
  u.pathname = `/${db}`
  return u.toString()
}

let installRoot = ""
let prevAppsDir: string | undefined
const BUNDLED_APPS_DIR = join(import.meta.dir, "..", "..", "..", "..", "..", "..", "bundled-apps")

const INDEX = `test_org_transfer_${randomUUID().slice(0, 8)}`
const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})
const spies: Array<{ mockRestore: () => void }> = []

let A: postgres.Sql
let B: postgres.Sql
let poolB: ReturnType<typeof createPool>
let orgId = ""
let neighbourA = ""
let neighbourB = ""
const transferX = randomUUID()
let fingerprintX: Fingerprint

async function onB<T>(fn: () => Promise<T>): Promise<T> {
  PrivilegedDbTestAccess.usePool({ db: poolB.db, acquireTimeoutMs: 10_000 })
  try {
    return await fn()
  } finally {
    PrivilegedDbTestAccess.usePool(null)
  }
}

/** A bare org with one user, in database A or B. */
async function insertOrg(target: "A" | "B", slug: string): Promise<string> {
  const write = async () => {
    const id = await seedOrgRow({ id: randomUUID(), name: slug, slug })
    await seedUserRow({ orgId: id, email: `${slug}@transfer.test`, name: slug, passwordHash: "x" })
    return id
  }
  return target === "B" ? onB(write) : write()
}

/** Plaintext of every secret in a row (so rows compare across two keys); throws if one does not open. */
function openSecrets(table: string, row: Record<string, unknown>, keys: typeof KEYS_A): void {
  for (const col of COLUMNS.filter((c) => `${c.schema}.${c.table}` === table)) {
    const v = row[col.column]
    if (typeof v !== "string" || v === "") continue
    const ctx = col.rowContext
      ? col.rowContext.build(
          Object.fromEntries(col.rowContext.columns.map((c) => [c, String(row[c])])),
        )
      : col.context
    row[col.column] = `plain:${decryptSecret(v, keys[col.family], ctx)}`
  }
  for (const col of JSON_COLUMNS.filter((c) => `${c.schema}.${c.table}` === table)) {
    const walk = (node: unknown, path: string[]): unknown => {
      if (typeof node === "string" && looksEncrypted(node)) {
        const family = col.familyAt(path)
        for (const ctx of JSON_CONTEXTS[family]) {
          try {
            return `plain:${decryptSecret(node, keys[family], ctx)}`
          } catch {}
        }
        throw new Error(`${table}.${col.column} ${path.join(".")} does not open`)
      }
      if (Array.isArray(node)) return node.map((n, i) => walk(n, [...path, String(i)]))
      if (node && typeof node === "object") {
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, [...path, k])]))
      }
      return node
    }
    row[col.column] = walk(row[col.column], [])
  }
}

/** The org's closure, every row as comparable JSON text, per table. */
async function snapshot(
  sql: postgres.Sql,
  keys: typeof KEYS_A,
  org = orgId,
): Promise<Record<string, string[]>> {
  const closure = await loadClosure(sql as never)
  const out: Record<string, string[]> = {}
  for (const t of closure.tables) {
    const rows = await sql.unsafe<{ j: Record<string, unknown> }[]>(
      `SELECT to_jsonb(t) AS j FROM ${rel(t.name)} t WHERE ${orgPredicate(closure, t, "t", org)}`,
    )
    out[t.name] = rows
      .map((r) => {
        const row = r.j
        if (t.name === "kernel.organizations") {
          delete row.transfer_state
          delete row.transfer_id
          delete row.transfer_at
        }
        // Stamped on arrival (the usage report counts only rows metered here).
        if (t.name === "kernel.credit_transactions") delete row.arrived_via
        openSecrets(t.name, row, keys)
        return JSON.stringify(row, Object.keys(row).sort())
      })
      .sort()
  }
  return out
}

/** Re-frame a bundle after changing its sections (valid digests, altered content). */
async function rewrite(
  lines: string[],
  fn: (name: string, data: string[]) => string[],
): Promise<string[]> {
  const w = new BundleWriter()
  const it = readBundle(lines)
  for (;;) {
    const n = await it.next()
    if (n.done) return w.finish(n.value.counts)
    w.section(n.value.name, fn(n.value.name, n.value.data), n.value.meta)
  }
}

async function searchCount(): Promise<number> {
  const r = await meili.index(INDEX).getDocuments({ filter: orgSearchFilter(orgId), limit: 100 })
  return r.results.length
}

async function orgRowsOn(sql: postgres.Sql, org: string): Promise<number> {
  const counts = await countOrgClosure(sql as never, await loadClosure(sql as never), org)
  return Object.values(counts).reduce((s, n) => s + n, 0)
}

async function exportFrom(
  sql: postgres.Sql,
  keys: typeof KEYS_A,
  org: string,
  transferId: string,
  since?: Fingerprint,
) {
  const transferKeys = generateTransferKeys()
  const result = await exportOrg({
    sql: sql as never,
    orgId: org,
    transferId,
    instanceKeys: keys,
    transferKeys,
    ...(since ? { since } : {}),
  })
  return { ...result, transferKeys }
}

function importInto(
  target: "A" | "B",
  lines: string[],
  transferKeys: TransferKeys,
  extra: { dryRun?: boolean } = {},
) {
  const run = () =>
    importOrg({
      sql: (target === "A" ? A : B) as never,
      lines,
      transferKeys,
      ownKeys: target === "A" ? KEYS_A : KEYS_B,
      ...extra,
    })
  return target === "B" ? onB(run) : run()
}

beforeAll(async () => {
  await acquireTestLock()
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX))
  spies.push(
    spyOn(searchClientModule, "getMeili").mockReturnValue(
      meili as unknown as ReturnType<typeof searchClientModule.getMeili>,
    ),
  )
  IndexWriterTestAccess.resetRebuildCache()
  const created = await meili.createIndex(INDEX, { primaryKey: "id" })
  await meili.tasks.waitForTask(created.taskUid)
  const settings = await meili.index(INDEX).updateSettings({ filterableAttributes: ["org_id"] })
  await meili.tasks.waitForTask(settings.taskUid)
  const admin = postgres(superA, { max: 1, onnotice: () => {} })
  const [{ c }] = await admin<{ c: string }[]>`SELECT shobj_description(oid, 'pg_database') AS c
    FROM pg_database WHERE datname = ${dbA}`
  const tpl = /template=([0-9a-f]+)/.exec(c ?? "")?.[1]
  if (!tpl) throw new Error(`the test database ${dbA} names no template`)
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbB} WITH (FORCE)`)
  await admin.unsafe(`CREATE DATABASE ${dbB} TEMPLATE liaison_tpl_${tpl}`)
  for (const r of ["liaison_app", "liaison_admin", "liaison_rls", "liaison_schema_admin"]) {
    await admin.unsafe(`GRANT ALL ON DATABASE ${dbB} TO ${r}`)
  }
  await admin.end()
  A = postgres(superA, { max: 2, onnotice: () => {} })
  B = postgres(withDb(superA, dbB), { max: 2, onnotice: () => {} })
  poolB = createPool(4, withDb(env.DATABASE_URL, dbB))

  ;({ id: orgId } = await createTestOrg({ email: ADMIN }))
  await seedStandardWorld({ adminEmail: ADMIN })
  // Both key families in the org's settings, and an encryption-family app secret.
  const byok = encryptSecret("sk-test-byok", KEYS_A.byok, CryptoContext.byokApiKey)
  const orgSecret = encryptSecret("org-secret", KEYS_A.encryption, CryptoContext.orgSettingsSecret)
  await A`UPDATE kernel.organizations SET settings = settings
    || ${A.json({ providerKeys: { openai: { apiKey: byok } }, transferTestSecret: orgSecret })}::jsonb
    WHERE id = ${orgId}`
  const [user] = await A<
    { id: string }[]
  >`SELECT id FROM kernel.users WHERE org_id = ${orgId} LIMIT 1`
  const totp = encryptSecret("JBSWY3DPEHPK3PXP", KEYS_A.encryption, CryptoContext.totpSecret)
  await A`UPDATE kernel.users SET totp_secret = ${totp} WHERE id = ${user!.id}`
  await setUserPreferences(user!.id, { theme: "dark" })
  const eventId = await seedPendingEvent(orgId, { entity: "t", action: "x" }, { processed: true })
  await seedDurableConsumerMark("push-fanout", eventId)

  neighbourA = await insertOrg("A", `nbr-a-${randomUUID().slice(0, 6)}`)
  neighbourB = await insertOrg("B", `nbr-b-${randomUUID().slice(0, 6)}`)
  // Two cells run the same release: the same catalog apps, so the same app schemas. A is this
  // namespace's database, where an earlier file may already have registered catalog apps (their
  // schemas stay when the next file truncates the rows); B is a fresh clone of the template.
  // Install and register on B every catalog app whose schema A carries, the way a cell's
  // catalog reconcile does, so neither the file order nor a clean namespace changes what the
  // two closures hold. The schema cache is process-wide: forget it so B's registration checks
  // B's own catalog.
  const schemasA = new Set(
    (
      await A<
        { nspname: string }[]
      >`SELECT nspname FROM pg_namespace WHERE starts_with(nspname, 'app_')`
    ).map((r) => r.nspname),
  )
  // The bundled apps whose schema A carries (an app's schema is app_<name>, dashes as underscores).
  const bundledApps = readdirSync(BUNDLED_APPS_DIR).filter(
    (name) =>
      existsSync(join(BUNDLED_APPS_DIR, name, "app.manifest.json")) &&
      schemasA.has(`app_${name.replace(/-/g, "_")}`),
  )
  const [installerB] = await B<
    { id: string }[]
  >`SELECT id FROM kernel.users WHERE org_id = ${neighbourB}`
  // Installs land in a temporary apps root of this file (the image's /var/lib/liaison is not here).
  installRoot = mkdtempSync(join(tmpdir(), "org-transfer-apps-"))
  prevAppsDir = process.env.LIAISON_APPS_DIR
  process.env.LIAISON_APPS_DIR = installRoot
  await onB(async () => {
    for (const name of bundledApps) {
      firstPartyAppTarball(name)
      await installCatalogApp({
        orgId: neighbourB,
        name,
        installedBy: installerB!.id,
        register: false,
      })
    }
    AppSchemaDdlTestAccess.forgetCurrentSchemas()
    await ensureAppsForOrg(neighbourB)
  })
  // Generous: the first run builds the bundled apps' packages it installs on B.
}, 900_000)

afterAll(async () => {
  PrivilegedDbTestAccess.usePool(null)
  await meili.deleteIndex(INDEX).catch(() => {})
  for (const s of spies) s.mockRestore()
  await redisBullMQ.del(`webhook:replay:${orgId}:shopify:orders:abc`)
  await poolB?.client.end({ timeout: 5 })
  await B?.end({ timeout: 5 })
  await A?.end({ timeout: 5 })
  const admin = postgres(superA, { max: 1, onnotice: () => {} })
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbB} WITH (FORCE)`)
  await admin.end()
  if (prevAppsDir === undefined) delete process.env.LIAISON_APPS_DIR
  else process.env.LIAISON_APPS_DIR = prevAppsDir
  if (installRoot) rmSync(installRoot, { recursive: true, force: true })
  await releaseTestLock()
})

describe("org transfer between two instances", () => {
  it("exporting an org that is not moving changes nothing on the source", async () => {
    const before = await snapshot(A, KEYS_A)
    const xminBefore = await A`SELECT xmin::text AS x FROM kernel.organizations WHERE id = ${orgId}`
    await exportFrom(A, KEYS_A, orgId, randomUUID())
    expect(await snapshot(A, KEYS_A)).toEqual(before)
    expect(await A`SELECT xmin::text AS x FROM kernel.organizations WHERE id = ${orgId}`).toEqual(
      xminBefore,
    )
  })

  it("names the org's own custom apps in the header and leaves out orphan app schemas", async () => {
    const name = `xfer-custom-${randomUUID().slice(0, 6)}`
    await seedCustomAppInstall({
      name,
      version: "1.0.0",
      sourceUrl: "upload:test",
      sha256: "x",
      installedBy: randomUUID(),
      orgId: neighbourA,
    })
    await seedActiveAppVersion(
      { name, version: "1.0.0", orgId: neighbourA },
      { onConflict: "skip" },
    )
    try {
      // A schema another org's app (or a removed app) left: not carried, not compared.
      await A.unsafe(`CREATE SCHEMA IF NOT EXISTS app_xfer_orphan`)
      await A.unsafe(
        `CREATE TABLE IF NOT EXISTS app_xfer_orphan.notes (id uuid PRIMARY KEY, org_id uuid NOT NULL)`,
      )
      const { header } = await exportFrom(A, KEYS_A, neighbourA, randomUUID())
      expect(header.customApps.map((a) => a.name)).toEqual([name])
      expect(header.customApps[0]?.schema).toBe(`app_${name.replace(/-/g, "_")}`)
      expect(Object.keys(header.fingerprints)).not.toContain("app_xfer_orphan.notes")
    } finally {
      await A.unsafe("DROP SCHEMA IF EXISTS app_xfer_orphan CASCADE")
      await A`DELETE FROM kernel.apps_active_version WHERE name = ${name}`
      await A`DELETE FROM kernel.apps_installed WHERE name = ${name}`
    }
  })

  it("estimates rows, bytes and the freeze", async () => {
    const e = await estimateTransfer(A as never, orgId)
    expect(e.rows).toBeGreaterThan(100)
    expect(e.bytes).toBeGreaterThan(e.rows)
    expect(e.freezeSeconds).toBeGreaterThan(0)
    expect(e.tables.find((t) => t.table === "kernel.role_scope_grants")?.rows ?? 0).toBeGreaterThan(
      0,
    )
  })

  it("refuses a schema or app version skew before writing anything", async () => {
    // Both indexes declare one embedder (a header of none fits any index, so it could not skew).
    const embedder = spyOn(searchModule, "embedderSignature").mockResolvedValue(
      "memory:userProvided:8",
    )
    try {
      await skewCases()
    } finally {
      embedder.mockRestore()
    }
    expect(await orgRowsOn(B, orgId)).toBe(0)
  })

  async function skewCases() {
    const embedder = searchModule.embedderSignature as unknown as {
      mockResolvedValue: (v: string) => void
    }
    const { lines, transferKeys } = await exportFrom(A, KEYS_A, orgId, randomUUID())
    await B.unsafe("ALTER TABLE kernel.user_preferences ADD COLUMN xfer_skew int")
    try {
      const err = await importInto("B", lines, transferKeys).catch((e) => e)
      expect(err).toBeInstanceOf(ImportRefused)
      expect((err as ImportRefused).code).toBe("skew")
    } finally {
      await B.unsafe("ALTER TABLE kernel.user_preferences DROP COLUMN xfer_skew")
    }
    const { header } = await exportFrom(A, KEYS_A, orgId, randomUUID())
    const name = Object.keys(header.apps)[0] as string
    expect(name).toBeDefined()
    const before = await B<{ version: string }[]>`SELECT version FROM kernel.apps_active_version
      WHERE name = ${name} AND org_id IS NULL`
    if (before[0]) {
      await B`UPDATE kernel.apps_active_version SET version = '0.0.0-skew' WHERE name = ${name} AND org_id IS NULL`
    } else {
      await onB(() => seedActiveAppVersion({ name, version: "0.0.0-skew" }))
    }
    try {
      const err = await importInto("B", lines, transferKeys).catch((e) => e)
      expect((err as ImportRefused).code).toBe("skew")
      expect(String((err as Error).message)).toContain(`app ${name}`)
    } finally {
      if (before[0]) {
        await B`UPDATE kernel.apps_active_version SET version = ${before[0].version} WHERE name = ${name} AND org_id IS NULL`
      } else {
        await B`DELETE FROM kernel.apps_active_version WHERE name = ${name} AND org_id IS NULL`
      }
    }
    embedder.mockResolvedValue("memory:other:7")
    const err = await importInto("B", lines, transferKeys).catch((e) => e)
    expect((err as ImportRefused).code).toBe("skew")
    expect(String((err as Error).message)).toContain("search indexes differ")
  }

  it("adopts the source's embedder on a fresh target index (none declared): dry run declares nothing, the import does", async () => {
    const { lines, transferKeys, header } = await exportFrom(A, KEYS_A, orgId, randomUUID())
    expect(header.embedder).not.toBeNull() // the export carried no search section in this substrate
    const fit = spyOn(searchModule, "embedderAdoptable")
    const adopt = spyOn(searchModule, "adoptEmbedder")
    fit.mockResolvedValue("adopt")
    adopt.mockResolvedValue()
    try {
      const dry = await importInto("B", lines, transferKeys, { dryRun: true }).catch((e) => e)
      expect((dry as ImportRefused).code).not.toBe("skew")
      expect(adopt).not.toHaveBeenCalled()
      // The real import adopts before any row; a wrong key then refuses it, so B is left empty for the next cases.
      const err = await importInto("B", lines, generateTransferKeys()).catch((e) => e)
      expect((err as ImportRefused).code).toBe("rekey")
      expect(adopt).toHaveBeenCalledWith(header.embedder)
    } finally {
      fit.mockRestore()
      adopt.mockRestore()
    }
    expect(await orgRowsOn(B, orgId)).toBe(0)
  })

  it("a source with no embedder moves into an index that has one: keyword only, nothing declared", async () => {
    const signature = spyOn(searchModule, "embedderSignature")
    const adopt = spyOn(searchModule, "adoptEmbedder")
    try {
      signature.mockResolvedValue("none")
      const { lines, transferKeys, header } = await exportFrom(A, KEYS_A, orgId, randomUUID())
      expect(header.embedder).toBe("none")
      signature.mockResolvedValue("memory:userProvided:8")
      const dry = await importInto("B", lines, transferKeys, { dryRun: true }).catch((e) => e)
      expect((dry as ImportRefused).code).not.toBe("skew")
      // Past the embedder check: a wrong key refuses the real import, B stays empty for the next cases.
      const err = await importInto("B", lines, generateTransferKeys()).catch((e) => e)
      expect((err as ImportRefused).code).toBe("rekey")
      expect(adopt).not.toHaveBeenCalled()
    } finally {
      signature.mockRestore()
      adopt.mockRestore()
    }
    expect(await orgRowsOn(B, orgId)).toBe(0)
  })

  it("refuses a corrupted section and leaves nothing", async () => {
    const { lines, transferKeys } = await exportFrom(A, KEYS_A, orgId, randomUUID())
    const i = lines.findIndex((l) => l.includes('"section":"rows:kernel.users"'))
    const tampered = [...lines]
    tampered[i + 1] = (tampered[i + 1] as string).replace(/"name": ?"/, '"name":"X')
    const err = await importInto("B", tampered, transferKeys).catch((e) => e)
    expect(err).toBeInstanceOf(BundleError)
    expect(await orgRowsOn(B, orgId)).toBe(0)
  })

  it("refuses a wrong transfer key and purges the incoming copy", async () => {
    const { lines } = await exportFrom(A, KEYS_A, orgId, randomUUID())
    const err = await importInto("B", lines, generateTransferKeys()).catch((e) => e)
    expect(err).toBeInstanceOf(ImportRefused)
    expect((err as ImportRefused).code).toBe("rekey")
    expect(await orgRowsOn(B, orgId)).toBe(0)
  })

  it("copies the whole closure, re-keyed, the org incoming, neighbours untouched", async () => {
    const neighbourBBefore = await snapshot(B, KEYS_B, neighbourB)
    const seqA = await A<
      { v: string }[]
    >`SELECT last_value::text AS v FROM kernel.contact_handle_seq`
    const mark = `webhook:replay:${orgId}:shopify:orders:abc`
    await redisBullMQ.set(mark, "1", "EX", 3600)
    // A usage row metered on A's key.
    const [metered] = await drizzle(A)
      .insert(creditTransactions)
      .values({ orgId, type: "usage", amount: "-1", balanceAfter: "0", rawCostUsd: "0.5" })
      .returning({ id: creditTransactions.id })
    // (An earlier refusal's purge of the incoming copy cleared the shared index and Redis.)
    await writeIndexAndWait({
      docs: [1, 2, 3].map((n) => ({
        id: `xfer-${orgId}-${n}`,
        org_id: orgId,
        entity_type: "transfer_test",
      })),
    })
    const { lines, transferKeys, fingerprint, header } = await exportFrom(
      A,
      KEYS_A,
      orgId,
      transferX,
    )
    // One Redis and one index serve both instances here: drop the mark and the
    // documents so only the import can bring them back.
    await redisBullMQ.del(mark)
    await writeIndexAndWait({ deleteFilters: [orgSearchFilter(orgId)] })
    expect(await searchCount()).toBe(0)
    expect(header.secrets.byok).toBe(1)
    expect(header.secrets.encryption).toBeGreaterThanOrEqual(2)
    const dry = await importInto("B", lines, transferKeys, { dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(await orgRowsOn(B, orgId)).toBe(0)

    const result = await importInto("B", lines, transferKeys)
    fingerprintX = fingerprint
    expect(result.rekeyed.encryption).toBeGreaterThanOrEqual(2)
    expect(result.rekeyed.byok).toBe(1)

    const a = await snapshot(A, KEYS_A)
    const b = await snapshot(B, KEYS_B)
    for (const table of Object.keys(a))
      expect({ table, rows: b[table] }).toEqual({ table, rows: a[table] })
    expect(a["kernel.role_scope_grants"]?.length ?? 0).toBeGreaterThan(0)
    expect(a["kernel.user_preferences"]?.length ?? 0).toBeGreaterThan(0)
    expect(a["kernel.durable_consumer_marks"]?.length).toBe(1)

    // Secrets open on B with B's key and not with A's.
    const [u] = await B<
      { t: string }[]
    >`SELECT totp_secret AS t FROM kernel.users WHERE org_id = ${orgId} AND totp_secret IS NOT NULL`
    expect(decryptSecret(u!.t, KEYS_B.encryption, CryptoContext.totpSecret)).toBe(
      "JBSWY3DPEHPK3PXP",
    )
    expect(() => decryptSecret(u!.t, KEYS_A.encryption, CryptoContext.totpSecret)).toThrow()
    const [o] = await B<{ s: { providerKeys: { openai: { apiKey: string } } } }[]>`
      SELECT settings AS s FROM kernel.organizations WHERE id = ${orgId}`
    expect(
      decryptSecret(o!.s.providerKeys.openai.apiKey, KEYS_B.byok, CryptoContext.byokApiKey),
    ).toBe("sk-test-byok")

    const [state] = await B<
      { s: string; t: string }[]
    >`SELECT transfer_state AS s, transfer_id::text AS t
      FROM kernel.organizations WHERE id = ${orgId}`
    expect(state).toEqual({ s: "incoming", t: transferX })

    // Every usage row arrives stamped with the transfer (B's daily usage report
    // never counts it); A's own copy stays unstamped (A metered it, A reports it).
    const stamps = await B<{ v: string | null }[]>`
      SELECT arrived_via::text AS v FROM kernel.credit_transactions WHERE org_id = ${orgId}`
    expect(stamps.length).toBeGreaterThan(0)
    expect(stamps.every((r) => r.v === transferX)).toBe(true)
    const [onA] = await A<{ v: string | null }[]>`
      SELECT arrived_via::text AS v FROM kernel.credit_transactions WHERE id = ${metered!.id}::uuid`
    expect(onA!.v).toBeNull()

    // Neighbours: A's never copied, B's untouched.
    expect(await orgRowsOn(B, neighbourA)).toBe(0)
    expect(await snapshot(B, KEYS_B, neighbourB)).toEqual(neighbourBBefore)

    // Sequences continue above A's: a new handle on B cannot collide.
    const [next] = await B<{ v: string }[]>`SELECT nextval('kernel.contact_handle_seq')::text AS v`
    expect(BigInt(next!.v)).toBeGreaterThan(BigInt(seqA[0]!.v))
    const handles = await B<
      { h: string }[]
    >`SELECT handle AS h FROM kernel.contacts WHERE org_id = ${orgId}`
    expect(handles.some((h) => h.h === `@contact-${next!.v}`)).toBe(false)

    expect(result.searchDocuments).toBe(3)
    expect(await searchCount()).toBe(3)

    // The replay mark arrives with its TTL.
    expect(await redisBullMQ.pttl(mark)).toBeGreaterThan(3_000_000)
  })

  it("pass 2 applies the delta since pass 1: the same rows as one full copy", async () => {
    const [user] = await A<
      { id: string }[]
    >`SELECT id FROM kernel.users WHERE org_id = ${orgId} ORDER BY email LIMIT 1`
    await A`UPDATE kernel.users SET name = 'Renamed in pass 2' WHERE id = ${user!.id}`
    await setUserPreferences(user!.id, { timezone: "Europe/Paris" })
    const [gone] = await A<{ id: string }[]>`DELETE FROM kernel.role_scope_grants WHERE id = (
      SELECT g.id FROM kernel.role_scope_grants g JOIN kernel.roles r ON r.id = g.role_id
       WHERE r.org_id = ${orgId} LIMIT 1) RETURNING id::text`
    expect(gone).toBeDefined()
    const totp = encryptSecret("NEWSECRET234567A", KEYS_A.encryption, CryptoContext.totpSecret)
    await A`UPDATE kernel.users SET totp_secret = ${totp} WHERE id = ${user!.id}`

    const { lines, transferKeys, fingerprint } = await exportFrom(
      A,
      KEYS_A,
      orgId,
      transferX,
      fingerprintX,
    )
    const rowSections = lines.filter((l) => l.startsWith('{"k":"begin","section":"rows:'))
    expect(rowSections.length).toBeLessThan(6)
    const result = await importInto("B", lines, transferKeys)
    expect(result.mode).toBe("delta")
    expect(result.deleted["kernel.role_scope_grants"]).toBe(1)
    fingerprintX = fingerprint
    expect(await snapshot(B, KEYS_B)).toEqual(await snapshot(A, KEYS_A))
  })

  it("refuses a bundle row that belongs to another org, writing nothing", async () => {
    const before = await snapshot(B, KEYS_B, neighbourB)
    const { lines, transferKeys } = await exportFrom(A, KEYS_A, neighbourA, randomUUID())
    const forged = await rewrite(lines, (name, data) =>
      name === "rows:kernel.users"
        ? [
            ...data,
            JSON.stringify({
              ...JSON.parse(data[0] as string),
              id: randomUUID(),
              org_id: neighbourB,
              email: "intruder@transfer.test",
            }),
          ]
        : data,
    )
    const err = await importInto("B", forged, transferKeys).catch((e) => e)
    expect((err as ImportRefused).code).toBe("format")
    expect(String((err as Error).message)).toContain("not this org's")
    expect(await snapshot(B, KEYS_B, neighbourB)).toEqual(before)
    expect(await orgRowsOn(B, neighbourA)).toBe(0)
  })

  for (const [label, forge] of [
    ["a file row", (_o: string, b: string) => ({ storage_key: `orgs/${b}/stolen.bin` })],
    ["an export row", (_o: string, b: string) => ({ object_key: `orgs/${b}/exports/x.zip` })],
    [
      "a traversal out of the org's prefix",
      (o: string, b: string) => ({ object_key: `orgs/${o}/../${b}/exports/x.zip` }),
    ],
    [
      "a key nested in a json value",
      (_o: string, b: string) => ({
        settings: { attachments: [{ name: "a.pdf", key: `orgs/${b}/mail/a.pdf` }] },
      }),
    ],
  ] as const) {
    it(`refuses ${label} that names another org's object, writing nothing`, async () => {
      const before = await snapshot(B, KEYS_B, neighbourB)
      const { lines, transferKeys } = await exportFrom(A, KEYS_A, neighbourA, randomUUID())
      let seen = 0
      const forged = await rewrite(lines, (name, data) => {
        // The check keys on the column names, whatever the table.
        if (name !== "rows:kernel.users") return data
        seen = data.length
        return data.map((d, i) =>
          i === 0 ? JSON.stringify({ ...JSON.parse(d), ...forge(neighbourA, neighbourB) }) : d,
        )
      })
      expect(seen).toBeGreaterThan(0)
      const err = await importInto("B", forged, transferKeys).catch((e) => e)
      expect((err as ImportRefused).code).toBe("format")
      expect(String((err as Error).message)).toContain("outside the org")
      expect(await snapshot(B, KEYS_B, neighbourB)).toEqual(before)
      expect(await orgRowsOn(B, neighbourA)).toBe(0)
    })
  }

  it("an object key check passes the org's own keys and unrelated text", () => {
    const o = randomUUID()
    expect(foreignObjectKey(JSON.stringify({ storage_key: `orgs/${o}/a.bin` }), o)).toBeNull()
    expect(foreignObjectKey(JSON.stringify({ object_key: null, body: "orgs/x" }), o)).toBeNull()
    expect(foreignObjectKey(JSON.stringify({ meta: { k: `orgs/${o}/a..b.pdf` } }), o)).toBeNull()
    expect(foreignObjectKey(JSON.stringify({ object_key: "exports/a.zip" }), o)).toBe("object_key")
    expect(foreignObjectKey(JSON.stringify({ meta: [{ k: "orgs/y/a" }] }), o)).toBe("meta[0].k")
  })

  it("refuses a collision on an expression unique index, before anything is written", async () => {
    // B holds the first org's users (copied above). A lower(email) index on B
    // makes another spelling of one of those emails a collision no plain unique sees.
    const [taken] = await B<{ email: string }[]>`SELECT email FROM kernel.users
      WHERE org_id = ${orgId} AND email IS NOT NULL LIMIT 1`
    expect(taken?.email).toBeTruthy()
    const { lines, transferKeys } = await exportFrom(A, KEYS_A, neighbourA, randomUUID())
    const forged = await rewrite(lines, (name, data) =>
      name === "rows:kernel.users"
        ? data.map((d, i) =>
            i === 0 ? JSON.stringify({ ...JSON.parse(d), email: taken!.email.toUpperCase() }) : d,
          )
        : data,
    )
    await B.unsafe("CREATE UNIQUE INDEX zz_test_users_lower_email ON kernel.users (lower(email))")
    try {
      const err = await importInto("B", forged, transferKeys).catch((e) => e)
      expect(err).toBeInstanceOf(ImportRefused)
      expect((err as ImportRefused).code).toBe("collision")
      expect(String((err as Error).message)).toContain("zz_test_users_lower_email")
      expect(await orgRowsOn(B, neighbourA)).toBe(0)
    } finally {
      await B.unsafe("DROP INDEX kernel.zz_test_users_lower_email")
    }
  })

  it("refuses an org whose rows collide with another org's global keys", async () => {
    const victim = await insertOrg("A", `clash-${randomUUID().slice(0, 6)}`)
    const [{ slug }] = await A<
      { slug: string }[]
    >`SELECT slug FROM kernel.organizations WHERE id = ${victim}`
    await insertOrg("B", slug as string)
    const { lines, transferKeys } = await exportFrom(A, KEYS_A, victim, randomUUID())
    const err = await importInto("B", lines, transferKeys).catch((e) => e)
    expect(err).toBeInstanceOf(ImportRefused)
    expect((err as ImportRefused).code).toBe("collision")
    expect(String((err as Error).message)).toContain("kernel.organizations slug")
    expect(await orgRowsOn(B, victim)).toBe(0)
  })

  it("reverse move: B -> A replaces A's moved copy; another transfer's copy refuses", async () => {
    // Commit of transfer X: A's copy moved, B's active.
    await A`UPDATE kernel.organizations SET transfer_state = 'moved', transfer_id = ${transferX}, transfer_at = now()
      WHERE id = ${orgId}`
    await B`UPDATE kernel.organizations SET transfer_state = NULL, transfer_id = NULL, transfer_at = NULL
      WHERE id = ${orgId}`
    await B`UPDATE kernel.threads SET title = 'Written on B' WHERE id = (
      SELECT id FROM kernel.threads WHERE org_id = ${orgId} ORDER BY id LIMIT 1)`
    // A parent written on B after the move, with a child linked to it (T10 live: the reverse move's
    // dry run, which applies nothing, refused the child as "not this org's").
    const ormB = drizzle(B)
    const [ev] = await ormB
      .insert(pendingEvents)
      .values({ orgId, payload: { t10: "after the move" } })
      .returning({ id: pendingEvents.id })
    await ormB.insert(durableConsumerMarks).values({ consumer: "t10-reverse", eventId: ev!.id })
    const transferY = randomUUID()
    const back = await exportFrom(B, KEYS_B, orgId, transferY)
    expect(back.header.arrivedVia).toBe(transferX)

    const other = randomUUID()
    await A`UPDATE kernel.organizations SET transfer_id = ${other} WHERE id = ${orgId}`
    const refused = await importInto("A", back.lines, back.transferKeys).catch((e) => e)
    expect((refused as ImportRefused).code).toBe("exists")
    await A`UPDATE kernel.organizations SET transfer_id = ${transferX} WHERE id = ${orgId}`

    const dry = await importInto("A", back.lines, back.transferKeys, { dryRun: true })
    expect(dry.dryRun).toBe(true)
    const [still] = await A<
      { s: string }[]
    >`SELECT transfer_state AS s FROM kernel.organizations WHERE id = ${orgId}`
    expect(still!.s).toBe("moved")

    const result = await importInto("A", back.lines, back.transferKeys)
    expect(result.replacedTransferId).toBe(transferX)
    expect(await snapshot(A, KEYS_A)).toEqual(await snapshot(B, KEYS_B))
    const [t] = await A<{ n: number }[]>`SELECT count(*)::int AS n FROM kernel.threads
      WHERE org_id = ${orgId} AND title = 'Written on B'`
    expect(t!.n).toBe(1)
    const [s] = await A<
      { s: string }[]
    >`SELECT transfer_state AS s FROM kernel.organizations WHERE id = ${orgId}`
    expect(s!.s).toBe("incoming")

    // B's copy becomes moved; its purge is refused for another transfer, then leaves nothing.
    await B`UPDATE kernel.organizations SET transfer_state = 'moved', transfer_id = ${transferY}, transfer_at = now()
      WHERE id = ${orgId}`
    const purgeErr = await onB(() => purgeTransferCopy(orgId, randomUUID(), "moved")).catch(
      (e) => e,
    )
    expect(purgeErr).toBeInstanceOf(TransferPurgeRefused)
    expect(await orgRowsOn(B, orgId)).toBeGreaterThan(0)
    await onB(() =>
      purgeTransferCopy(orgId, transferY, "moved", {
        externalDeps: { deleteObjects: async () => 0, countObjects: async () => 0 },
      }),
    )
    expect(await orgRowsOn(B, orgId)).toBe(0)
    expect(await snapshot(B, KEYS_B, neighbourB)).toBeDefined()
  })
})
