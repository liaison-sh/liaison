// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `exportOrg`: one org's closure (closure.ts) as a bundle (bundle.ts), read in
// ONE `REPEATABLE READ READ ONLY` snapshot of the source.
//
// Sections, in order:
//   header         format, org, transfer, mode, the source's schema version,
//                  the active version of every app the org uses, the column
//                  fingerprint of every closure table, every sequence's value,
//                  and the transfer the org arrived through (reverse moves);
//   rows:<table>   the org's rows (`to_jsonb` of each), secrets re-keyed to the
//                  transfer keys (rekey.ts). Mode `full` sends every row; mode
//                  `delta` (pass 2 of a move, D33) sends only the rows whose
//                  `(primary key, xmin)` is not in the previous pass's
//                  fingerprint;
//   deletes:<table> (delta) primary keys the previous pass sent that are gone;
//   search         (full) the org's search documents with their vectors
//                  (search.ts), so nothing is embedded again on the target;
//   redis          the org's provider-webhook replay marks with their TTL, so a
//                  provider retrying a delivery after the move is answered
//                  "duplicate" on the target as it would have been here.
// The manifest closes it with the org's row count per closure table.
//
// Read only: the export writes nothing on the source (an org that is not
// moving is unchanged by it).
import { redisBullMQ } from "~/lib/redis"
import { BUNDLE_FORMAT, BundleWriter } from "./bundle"
import {
  assertUuid,
  type Closure,
  columnFingerprint,
  loadClosure,
  ORG_TABLE,
  orgPredicate,
  query,
  quoteIdent,
  rel,
  type TransferSql,
} from "./closure"
import {
  encryptedPlaces,
  type FamilyKeys,
  type RekeyTally,
  rekeyRowForExport,
  type TransferKeys,
} from "./rekey"
import { embedderSignature, exportSearchDocuments } from "./search"

/** `(primary key as JSON text) -> xmin` per closure table. */
export type Fingerprint = Map<string, Map<string, string>>

export interface TransferHeader {
  format: number
  orgId: string
  transferId: string
  mode: "full" | "delta"
  schemaVersion: string
  apps: Record<string, string>
  fingerprints: Record<string, string>
  sequences: Record<string, string>
  /** The transfer through which this org arrived on the exporting instance, if any. */
  arrivedVia: string | null
  /** Secrets per family re-keyed into the bundle. */
  secrets: RekeyTally
  /** The search index's embedder when the bundle carries the org's documents, else null. */
  embedder: string | null
  /** The org's own custom apps (installed on the target by the move, not by the import). */
  customApps: CustomAppRef[]
}

export interface ExportOptions {
  sql: TransferSql & { begin: <T>(opts: string, fn: (tx: TransferSql) => Promise<T>) => Promise<T> }
  orgId: string
  transferId: string
  /** This instance's keys, per family. */
  instanceKeys: FamilyKeys
  transferKeys: TransferKeys
  /** Delta mode: what the previous pass sent. */
  since?: Fingerprint
  /** Carry the org's search documents (default: in a full export; a delta's catch-up runs after the commit). */
  search?: boolean
  /**
   * Leave out the closure tables of these schemas (pass 1 of an org with its
   * own custom apps: their tables exist on the target only once the app is
   * installed there; pass 1b carries their rows as new).
   */
  skipSchemas?: readonly string[]
  /** Test seam: the Redis client the replay marks are read from. */
  redis?: Pick<typeof redisBullMQ, "scan" | "get" | "pttl">
}

export interface ExportResult {
  lines: string[]
  /** What this pass sent: the next pass's `since`. */
  fingerprint: Fingerprint
  counts: Record<string, number>
  header: TransferHeader
}

export class ExportRefused extends Error {
  constructor(message: string) {
    super(`org transfer export: ${message}`)
    this.name = "ExportRefused"
  }
}

/** The key prefix (after any namespace prefix) of the webhook replay marks. */
export const WEBHOOK_REPLAY_MARK = "webhook:replay:"

/** The sha of the newest applied migration: equal on both sides or the move is refused. */
export async function schemaVersion(sql: TransferSql): Promise<string> {
  const rows = await query<{ hash: string; n: number }>(
    sql,
    `SELECT (SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC, id DESC LIMIT 1) AS hash,
            (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS n`,
  )
  return `${rows[0]?.n ?? 0}:${rows[0]?.hash ?? ""}`
}

/** Active version of every app the org has (kernel.apps rows), as this instance runs it. */
export async function orgAppVersions(
  sql: TransferSql,
  orgId: string,
): Promise<Record<string, string>> {
  const rows = await query<{ name: string; version: string | null }>(
    sql,
    `SELECT a.name, (SELECT v.version FROM kernel.apps_active_version v
                      WHERE v.name = a.name AND (v.org_id IS NULL OR v.org_id = a.org_id)
                      ORDER BY v.org_id NULLS LAST LIMIT 1) AS version
       FROM kernel.apps a WHERE a.org_id = $1::uuid ORDER BY a.name`,
    [orgId],
  )
  return Object.fromEntries(rows.map((r) => [r.name, r.version ?? ""]))
}

export async function sequenceValues(sql: TransferSql): Promise<Record<string, string>> {
  const rows = await query<{ name: string; v: string | null }>(
    sql,
    `SELECT schemaname || '.' || sequencename AS name, last_value::text AS v FROM pg_sequences
      WHERE schemaname = 'kernel' OR schemaname LIKE 'app\\_%' ORDER BY 1`,
  )
  return Object.fromEntries(rows.filter((r) => r.v !== null).map((r) => [r.name, r.v as string]))
}

/** Changed rows whose JSON a delta reads per query. */
const DELTA_FETCH_CHUNK = 5000

function pkExpr(t: { primaryKey: string[] }, alias: string): string {
  return `jsonb_build_array(${t.primaryKey.map((c) => `${alias}.${quoteIdent(c)}`).join(", ")})::text`
}

/** `alias`'s primary key equals the `pkExpr` array in the jsonb `element`, column by column, typed. */
function pkJoin(
  t: { name: string; primaryKey: string[]; columns: Array<{ name: string; type: string }> },
  alias: string,
  element: string,
): string {
  return t.primaryKey
    .map((c, i) => {
      const type = t.columns.find((col) => col.name === c)?.type
      if (!type) throw new ExportRefused(`${t.name}: primary key column ${c} not in the catalog`)
      return `${alias}.${quoteIdent(c)} = (${element}->>${i})::${type}`
    })
    .join(" AND ")
}

async function readReplayMarks(
  redis: NonNullable<ExportOptions["redis"]>,
  orgId: string,
): Promise<string[]> {
  const out: string[] = []
  let cursor = "0"
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      `*${WEBHOOK_REPLAY_MARK}${orgId}:*`,
      "COUNT",
      5000,
    )
    cursor = next
    for (const key of keys) {
      const at = key.indexOf(WEBHOOK_REPLAY_MARK)
      const [value, ttl] = await Promise.all([redis.get(key), redis.pttl(key)])
      if (value === null || ttl <= 0) continue
      out.push(JSON.stringify({ key: key.slice(at), value, ttlMs: ttl }))
    }
  } while (cursor !== "0")
  return out.sort()
}

/** Refusals that hold whatever the target: a demo org, an org being deleted. */
async function assertExportable(tx: TransferSql, orgId: string): Promise<void> {
  const rows = await query<{ demo: boolean; deleting: boolean }>(
    tx,
    `SELECT jsonb_typeof(settings->'demo') = 'object' AS demo, deleting_at IS NOT NULL AS deleting
       FROM kernel.organizations WHERE id = $1::uuid`,
    [orgId],
  )
  const org = rows[0]
  if (!org) throw new ExportRefused(`organization ${orgId} not found`)
  if (org.demo) throw new ExportRefused("a demo workspace is never moved")
  if (org.deleting) throw new ExportRefused("the organization is being deleted")
}

/** One org-private custom app the org uses (installed on the target in the precopy). */
export interface CustomAppRef {
  name: string
  version: string
  sha256: string
  /** Its tables' schema (`app_<name>`). */
  schema: string
}

/**
 * The schemas of other orgs' private custom apps on this instance. They never
 * hold a row of this org, and the target need not have them, so the bundle
 * leaves them out entirely (their columns are not compared either).
 */
export async function foreignCustomSchemas(sql: TransferSql, orgId: string): Promise<string[]> {
  const rows = await query<{ name: string }>(
    sql,
    `SELECT DISTINCT name FROM kernel.apps_installed
      WHERE org_id IS NOT NULL AND org_id <> $1::uuid ORDER BY name`,
    [orgId],
  )
  return rows.map((r) => appSchemaOf(r.name))
}

export function appSchemaOf(name: string): string {
  return `app_${name.replace(/-/g, "_")}`
}

/**
 * Schemas of apps this instance knows (instance apps and the org's own), plus
 * `kernel`. A closure table in any other schema (one left behind by a removed
 * app) is carried only when it holds rows of the org.
 */
async function knownSchemas(sql: TransferSql, orgId: string): Promise<Set<string>> {
  const rows = await query<{ name: string }>(
    sql,
    `SELECT name FROM kernel.apps_active_version WHERE org_id IS NULL OR org_id = $1::uuid
     UNION SELECT name FROM kernel.apps_installed WHERE org_id IS NULL OR org_id = $1::uuid`,
    [orgId],
  )
  return new Set(["kernel", ...rows.map((r) => appSchemaOf(r.name))])
}

/** The org's own custom apps, at their active version. */
export async function orgCustomApps(sql: TransferSql, orgId: string): Promise<CustomAppRef[]> {
  const rows = await query<{ name: string; version: string; sha256: string }>(
    sql,
    `SELECT i.name, i.version, i.sha256 FROM kernel.apps_installed i
       JOIN kernel.apps_active_version v ON v.name = i.name AND v.version = i.version
      WHERE i.org_id = $1::uuid ORDER BY i.name`,
    [orgId],
  )
  return rows.map((r) => ({ ...r, schema: appSchemaOf(r.name) }))
}

export async function exportOrg(opts: ExportOptions): Promise<ExportResult> {
  const orgId = assertUuid(opts.orgId, "exportOrg")
  const transferId = assertUuid(opts.transferId, "exportOrg transfer")
  const redis = opts.redis ?? redisBullMQ
  const withSearch = opts.search ?? !opts.since
  return opts.sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (tx) => {
    await assertExportable(tx, orgId)
    const closure: Closure = await loadClosure(tx)
    const writer = new BundleWriter()
    const fingerprint: Fingerprint = new Map()
    const counts: Record<string, number> = {}
    const secrets: RekeyTally = { encryption: 0, byok: 0 }
    const arrived = await query<{ transfer_id: string }>(
      tx,
      `SELECT transfer_id::text FROM kernel.org_transfer_ledger
        WHERE org_id = $1::uuid AND direction = 'in' ORDER BY created_at DESC LIMIT 1`,
      [orgId],
    )
    const sections: Array<{ name: string; data: string[]; meta: Record<string, unknown> }> = []
    const deletes: typeof sections = []
    const skip = new Set([...(opts.skipSchemas ?? []), ...(await foreignCustomSchemas(tx, orgId))])
    const known = await knownSchemas(tx, orgId)
    const tables: typeof closure.tables = []
    for (const t of closure.tables) {
      const schema = t.name.slice(0, t.name.indexOf("."))
      if (skip.has(schema)) continue
      const prev = opts.since?.get(t.name)
      // A full export reads every row's JSON. A delta (pass 2, inside the
      // write gap) scans `(pk, xmin)` only and then reads the JSON of the
      // changed rows alone, so the gap is proportional to the delta, not to
      // the size of the org. Both reads share one repeatable-read snapshot.
      const rows: Array<{ k: string; x: string; j: string | null }> = prev
        ? await query<{ k: string; x: string }>(
            tx,
            `SELECT ${pkExpr(t, "t")} AS k, t.xmin::text AS x
               FROM ${rel(t.name)} t WHERE ${orgPredicate(closure, t, "t", orgId)}`,
          ).then((all) => all.map((r) => ({ ...r, j: null })))
        : await query<{ k: string; x: string; j: string }>(
            tx,
            `SELECT ${pkExpr(t, "t")} AS k, t.xmin::text AS x, to_jsonb(t)::text AS j
               FROM ${rel(t.name)} t WHERE ${orgPredicate(closure, t, "t", orgId)}`,
          )
      if (prev) {
        const changed = rows.filter((r) => prev.get(r.k) !== r.x)
        const json = new Map<string, string>()
        for (let i = 0; i < changed.length; i += DELTA_FETCH_CHUNK) {
          const keys = changed.slice(i, i + DELTA_FETCH_CHUNK).map((r) => JSON.parse(r.k))
          // Joined on the primary key columns themselves (typed), so each
          // chunk is an index lookup per row, not a scan of the org's rows.
          const got = await query<{ k: string; j: string }>(
            tx,
            `SELECT ${pkExpr(t, "t")} AS k, to_jsonb(t)::text AS j
               FROM jsonb_array_elements($1::text::jsonb) AS pk(e)
               JOIN ${rel(t.name)} t ON ${pkJoin(t, "t", "pk.e")}
              WHERE ${orgPredicate(closure, t, "t", orgId)}`,
            [JSON.stringify(keys)],
          )
          for (const g of got) json.set(g.k, g.j)
        }
        // Visible in the scan, gone from the same snapshot: impossible, and
        // refused rather than sent short.
        for (const r of changed) {
          const j = json.get(r.k)
          if (j === undefined) throw new ExportRefused(`${t.name} row ${r.k} vanished mid-export`)
          r.j = j
        }
      }
      // A table of no known app, without a row of the org: not this move's.
      if (!known.has(schema) && rows.length === 0 && !opts.since?.has(t.name)) continue
      tables.push(t)
      counts[t.name] = rows.length
      const seen = new Map<string, string>()
      const data: string[] = []
      const places = encryptedPlaces(t.name)
      const hasSecrets = places.columns.length > 0 || places.json.length > 0
      for (const r of rows) {
        seen.set(r.k, r.x)
        if (prev && prev.get(r.k) === r.x) continue
        if (!hasSecrets) {
          data.push(r.j!)
          continue
        }
        const row = JSON.parse(r.j!) as Record<string, unknown>
        rekeyRowForExport(t.name, row, opts.instanceKeys, opts.transferKeys, secrets)
        data.push(JSON.stringify(row))
      }
      fingerprint.set(t.name, seen)
      if (prev) {
        const gone = [...prev.keys()].filter((k) => !seen.has(k)).sort()
        if (gone.length > 0) deletes.push({ name: `deletes:${t.name}`, data: gone, meta: {} })
      }
      if (data.length > 0 || t.name === ORG_TABLE)
        sections.push({ name: `rows:${t.name}`, data, meta: {} })
    }
    const header: TransferHeader = {
      format: BUNDLE_FORMAT,
      orgId,
      transferId,
      mode: opts.since ? "delta" : "full",
      schemaVersion: await schemaVersion(tx),
      apps: await orgAppVersions(tx, orgId),
      fingerprints: Object.fromEntries(tables.map((t) => [t.name, columnFingerprint(t)])),
      sequences: await sequenceValues(tx),
      arrivedVia: arrived[0]?.transfer_id ?? null,
      secrets,
      embedder: withSearch ? await embedderSignature() : null,
      customApps: await orgCustomApps(tx, orgId),
    }
    writer.section("header", [JSON.stringify(header)])
    // Every delete first, children before parents (the target checks each row
    // it deletes belongs to the org through its parent), then the rows in
    // closure order: a row re-created under the same unique key lands after
    // the old one went.
    for (const s of deletes.reverse()) writer.section(s.name, s.data, s.meta)
    for (const s of sections) writer.section(s.name, s.data, s.meta)
    if (withSearch) writer.section("search", await exportSearchDocuments(orgId))
    writer.section("redis", await readReplayMarks(redis, orgId))
    const lines = writer.finish(counts)
    return { lines, fingerprint, counts, header }
  })
}

/**
 * The `(primary key, xmin)` of every row of the org's closure, nothing else:
 * the fail-closed re-check after pass 2 (any difference from what pass 2 sent
 * means a write slipped through the freeze, and the move aborts).
 */
export async function scanFingerprint(
  sql: ExportOptions["sql"],
  orgIdIn: string,
  opts: { skipSchemas?: readonly string[] } = {},
): Promise<Fingerprint> {
  const orgId = assertUuid(orgIdIn, "scanFingerprint")
  return sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (tx) => {
    const closure = await loadClosure(tx)
    const skip = new Set([...(opts.skipSchemas ?? []), ...(await foreignCustomSchemas(tx, orgId))])
    const out: Fingerprint = new Map()
    for (const t of closure.tables) {
      if (skip.has(t.name.slice(0, t.name.indexOf(".")))) continue
      const rows = await query<{ k: string; x: string }>(
        tx,
        `SELECT ${pkExpr(t, "t")} AS k, t.xmin::text AS x
           FROM ${rel(t.name)} t WHERE ${orgPredicate(closure, t, "t", orgId)}`,
      )
      out.set(t.name, new Map(rows.map((r) => [r.k, r.x])))
    }
    return out
  })
}

/** Where two fingerprints differ (tables, then a few keys), empty when equal. */
export function fingerprintDiff(a: Fingerprint, b: Fingerprint, limit = 10): string[] {
  const out: string[] = []
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(name) ?? new Map<string, string>()
    const y = b.get(name) ?? new Map<string, string>()
    for (const k of new Set([...x.keys(), ...y.keys()])) {
      if (x.get(k) !== y.get(k)) {
        out.push(`${name} ${k}`)
        if (out.length >= limit) return out
      }
    }
  }
  return out
}
