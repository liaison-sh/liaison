// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `importOrg`: apply a bundle (export.ts) to this instance.
//
// Prechecks, before anything is written (each refuses the whole import):
//   - the same schema version (newest migration), the same active version of
//     every app the org uses, and the same column fingerprint for every closure
//     table the bundle carries (an app or schema skew between the two
//     instances never lands rows in the wrong columns);
//   - the org id: absent, or held here as `incoming` by this same transfer (a
//     re-run), or held as `moved` by the transfer the bundle says the org
//     arrived through on the exporting side (a reverse move: that copy is
//     purged first and replaced). Anything else is refused;
//   - global unique keys: no row of another org on this instance holds a key of
//     a unique index without `org_id` that an incoming row holds (e.g. the same
//     Google login in two orgs, the org's slug). The conflicting rows are named.
//
// The rows then land in ONE transaction, as the migration role, with
// `session_replication_role = replica` (what pg_dump's --disable-triggers
// does): triggers would re-run side effects the source already ran (a
// message bumping its thread's updated_at, a default inbox created), so the
// copy is exact. Foreign keys are triggers too, so the transaction checks
// every foreign key of every imported row itself before it commits, and
// compares the org's row count per closure table with the manifest. The org
// row lands `incoming` with this transfer: it serves nothing until the move
// commits. Every sequence is raised to at least the source's value (handles
// such as `@contact-<n>` draw from instance-wide sequences). A delta (pass 2)
// upserts the changed rows and deletes the gone ones in the same way.
//
// After that commit: the replay marks go to Redis, and the secrets are re-keyed
// from the transfer keys to this instance's keys (rekey.ts). A failure there
// purges the incoming copy and throws.
import { rotateEncryptionKey } from "~/cli/keys-rotate"
import { rootLogger } from "~/lib/logger"
import { redisBullMQ } from "~/lib/redis"
import { type Manifest, readBundle } from "./bundle"
import { OBJECT_KEY_COLUMNS } from "./classification"
import {
  assertUuid,
  type Closure,
  type ClosureTable,
  columnFingerprint,
  loadClosure,
  ORG_TABLE,
  orgPredicate,
  query,
  quoteIdent,
  rel,
  stagedOrgPredicate,
  type TransferSql,
} from "./closure"
import { orgAppVersions, schemaVersion, type TransferHeader, WEBHOOK_REPLAY_MARK } from "./export"
import { purgeTransferCopy } from "./purge"
import { type FamilyKeys, KEY_FAMILIES, type TransferKeys } from "./rekey"
import {
  adoptEmbedder,
  embedderAdoptable,
  embedderSignature,
  importSearchDocuments,
} from "./search"

/** Usage rows: stamped with the transfer on arrival (migration 0271, cloud/usage-report.ts). */
const CREDIT_TRANSACTIONS_TABLE = "kernel.credit_transactions"

const log = rootLogger.child({ module: "org-transfer-import" })

const OBJECT_KEY_NAMES = new Set(Object.keys(OBJECT_KEY_COLUMNS).map((c) => c.split(".")[2]))
const ORG_OBJECT = /^orgs\/[^/]+\//

/**
 * The column (or jsonb path) of a bundle row that names an object outside
 * `orgs/<org>/`, or null. Object-key columns (classification.ts) must sit
 * under the org's prefix; any other string nested in a json value that has the
 * shape of an org object key must name this org's.
 */
export function foreignObjectKey(line: string, orgId: string): string | null {
  const prefix = `orgs/${orgId}/`
  const outside = (v: string) => !v.startsWith(prefix) || v.split("/").includes("..")
  if (!line.includes("_key") && !line.includes("orgs/")) return null
  const row = JSON.parse(line) as Record<string, unknown>
  const walk = (v: unknown, path: string): string | null => {
    if (typeof v === "string") return ORG_OBJECT.test(v) && outside(v) ? path : null
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const hit = walk(v[i], `${path}[${i}]`)
        if (hit) return hit
      }
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        const hit = walk(x, `${path}.${k}`)
        if (hit) return hit
      }
    }
    return null
  }
  for (const [col, v] of Object.entries(row)) {
    if (OBJECT_KEY_NAMES.has(col)) {
      if (v === null || v === undefined || v === "") continue
      if (typeof v !== "string" || outside(v)) return col
      continue
    }
    if (v && typeof v === "object") {
      const hit = walk(v, col)
      if (hit) return hit
    }
  }
  return null
}

export class ImportRefused extends Error {
  constructor(
    message: string,
    readonly code: "skew" | "exists" | "collision" | "mismatch" | "format" | "rekey",
    readonly detail: unknown = null,
  ) {
    super(`org transfer import: ${message}`)
    this.name = "ImportRefused"
  }
}

export interface ImportOptions {
  sql: TransferSql & { begin: <T>(fn: (tx: TransferSql) => Promise<T>) => Promise<T> }
  lines: AsyncIterable<string> | Iterable<string>
  transferKeys: TransferKeys
  /** This instance's keys, per family. */
  ownKeys: FamilyKeys
  /** Run every check and roll back: nothing is written (the move's precheck). */
  dryRun?: boolean
  redis?: Pick<typeof redisBullMQ, "set">
  /** Test seam: how a replaced or aborted copy is purged. */
  purge?: typeof purgeTransferCopy
}

export interface ImportResult {
  orgId: string
  transferId: string
  mode: "full" | "delta"
  rows: Record<string, number>
  deleted: Record<string, number>
  /** The org's `moved` copy this import replaced (a reverse move). */
  replacedTransferId: string | null
  dryRun: boolean
  rekeyed: Record<string, number>
  /**
   * Wall time of the re-key walk (both key families, every encrypted column of
   * the org: it runs on every import, a delta's included, and is part of the
   * write gap's apply step). Logged so the timing spike reads it.
   */
  rekeyMs: number
  /** Search documents written to this instance's index. */
  searchDocuments: number
}

class DryRun extends Error {}

const BATCH = 500

function nonGenerated(t: ClosureTable): string[] {
  return t.columns.filter((c) => !c.generated).map((c) => c.name)
}

function typeOf(t: ClosureTable, column: string): string {
  const c = t.columns.find((x) => x.name === column)
  if (!c) throw new Error(`org transfer: ${t.name} has no column ${column}`)
  return c.type
}

async function existingCopy(
  sql: TransferSql,
  orgId: string,
): Promise<{ state: string | null; transferId: string | null } | null> {
  const rows = await query<{ state: string | null; transfer_id: string | null }>(
    sql,
    `SELECT transfer_state AS state, transfer_id::text AS transfer_id FROM kernel.organizations WHERE id = $1::uuid`,
    [orgId],
  )
  const r = rows[0]
  return r ? { state: r.state, transferId: r.transfer_id } : null
}

function checkSkew(
  header: TransferHeader,
  closure: Closure,
  ours: { schema: string; apps: Record<string, string> },
): void {
  const problems: string[] = []
  if (header.schemaVersion !== ours.schema) {
    problems.push(`schema version ${header.schemaVersion} here ${ours.schema}`)
  }
  // The org's own custom apps are installed here by the move after pass 1
  // (their tables are not in pass 1); a delta checks them like any app.
  const installedLater = new Set(
    header.mode === "full" ? (header.customApps ?? []).map((a) => a.name) : [],
  )
  for (const [name, version] of Object.entries(header.apps)) {
    const here = ours.apps[name] ?? ""
    if (installedLater.has(name) && here === "") continue
    if (here !== version) {
      problems.push(
        `app ${name} ${version || "(no active version)"} here ${here || "(no active version)"}`,
      )
    }
  }
  for (const [table, fp] of Object.entries(header.fingerprints)) {
    const t = closure.byName.get(table)
    if (!t) problems.push(`table ${table} is missing here`)
    else if (columnFingerprint(t) !== fp) problems.push(`table ${table} has other columns here`)
  }
  if (problems.length > 0) {
    throw new ImportRefused(`the two instances differ: ${problems.join("; ")}`, "skew", problems)
  }
}

/** Target app versions for the names the bundle lists (the org's apps may not exist here yet). */
async function activeVersions(
  sql: TransferSql,
  names: string[],
  orgId: string,
): Promise<Record<string, string>> {
  if (names.length === 0) return {}
  const rows = await query<{ name: string; version: string }>(
    sql,
    `SELECT DISTINCT ON (name) name, version FROM kernel.apps_active_version
      WHERE name = ANY($1::text[]) AND (org_id IS NULL OR org_id = $2::uuid)
      ORDER BY name, org_id NULLS LAST`,
    [names, orgId] as never,
  )
  return Object.fromEntries(rows.map((r) => [r.name, r.version]))
}

async function stage(tx: TransferSql, t: ClosureTable, data: string[], n: number): Promise<string> {
  const name = `xfer_stage_${n}`
  await tx.unsafe(`CREATE TEMP TABLE ${name} (LIKE ${rel(t.name)}) ON COMMIT DROP`)
  for (let i = 0; i < data.length; i += BATCH) {
    const chunk = `[${data.slice(i, i + BATCH).join(",")}]`
    await tx.unsafe(
      `INSERT INTO ${name} SELECT * FROM jsonb_populate_recordset(null::${rel(t.name)}, $1::text::jsonb)`,
      [chunk] as never,
    )
  }
  return name
}

async function collisions(
  tx: TransferSql,
  closure: Closure,
  t: ClosureTable,
  staged: string,
  orgId: string,
): Promise<string[]> {
  const out: string[] = []
  for (const u of t.globalUniques) {
    const on = u.columns.map((c) => `x.${quoteIdent(c)} = s.${quoteIdent(c)}`).join(" AND ")
    const rows = await query<{ k: string }>(
      tx,
      `SELECT jsonb_build_array(${u.columns.map((c) => `s.${quoteIdent(c)}`).join(", ")})::text AS k
         FROM ${staged} s JOIN ${rel(t.name)} x ON ${on}
        WHERE NOT (${orgPredicate(closure, t, "x", orgId)}) LIMIT 5`,
    )
    for (const r of rows) out.push(`${t.name} ${u.columns.join("+")} ${r.k}`)
  }
  // Partial and expression unique indexes: the keys are evaluated on both sides
  // (the staged rows and the rows already here), the predicate on each side too.
  for (const u of t.complexUniques) {
    const keyList = u.keys.map((k, i) => `${k} AS e${i}`).join(", ")
    const pred = u.predicate ? ` WHERE ${u.predicate}` : ""
    const predAnd = u.predicate ? ` AND (${u.predicate})` : ""
    // The key expressions name the table's own columns: unqualified, they bind
    // to the staged table inside `s` and to `x` outside it (`s` has only e0...).
    const on = u.keys.map((k, i) => `s.e${i} = ${k}`).join(" AND ")
    const rows = await query<{ k: string }>(
      tx,
      `SELECT jsonb_build_array(${u.keys.map((_, i) => `s.e${i}`).join(", ")})::text AS k
         FROM (SELECT ${keyList} FROM ${staged}${pred}) s
         JOIN ${rel(t.name)} x ON ${on}
        WHERE NOT (${orgPredicate(closure, t, "x", orgId)})${predAnd} LIMIT 5`,
    )
    for (const r of rows) out.push(`${t.name} ${u.name} ${r.k}`)
  }
  return out
}

async function applyRows(
  tx: TransferSql,
  t: ClosureTable,
  staged: string,
  upsert: boolean,
): Promise<number> {
  const cols = nonGenerated(t)
  const list = cols.map(quoteIdent).join(", ")
  const conflict = upsert
    ? ` ON CONFLICT (${t.primaryKey.map(quoteIdent).join(", ")}) DO UPDATE SET ${cols
        .filter((c) => !t.primaryKey.includes(c))
        .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
        .join(", ")}`
    : ""
  const set = conflict.endsWith("SET ")
    ? conflict.replace(/ DO UPDATE SET $/, " DO NOTHING")
    : conflict
  const rows = await query<{ n: number }>(
    tx,
    `WITH ins AS (INSERT INTO ${rel(t.name)} (${list}) OVERRIDING SYSTEM VALUE
       SELECT ${list} FROM ${staged}${set} RETURNING 1) SELECT count(*)::int AS n FROM ins`,
  )
  return rows[0]?.n ?? 0
}

async function applyDeletes(
  tx: TransferSql,
  closure: Closure,
  t: ClosureTable,
  keys: string[],
  orgId: string,
): Promise<number> {
  let n = 0
  for (let i = 0; i < keys.length; i += BATCH) {
    const chunk = `[${keys.slice(i, i + BATCH).join(",")}]`
    const match = t.primaryKey
      .map((c, j) => `x.${quoteIdent(c)} = (d.k->>${j})::${typeOf(t, c)}`)
      .join(" AND ")
    const rows = await query<{ n: number }>(
      tx,
      `WITH del AS (DELETE FROM ${rel(t.name)} x USING jsonb_array_elements($1::text::jsonb) d(k)
         WHERE ${match} AND ${orgPredicate(closure, t, "x", orgId)} RETURNING 1)
       SELECT count(*)::int AS n FROM del`,
      [chunk] as never,
    )
    n += rows[0]?.n ?? 0
  }
  return n
}

/**
 * Every foreign key of the org's rows resolves, to a row of the same org when it
 * points into the closure (triggers, FKs included, are off in the copy).
 */
async function danglingReferences(
  tx: TransferSql,
  closure: Closure,
  orgId: string,
): Promise<string[]> {
  const out: string[] = []
  for (const t of closure.tables) {
    for (const fk of t.foreignKeys) {
      const notNull = fk.columns.map((c) => `c.${quoteIdent(c)} IS NOT NULL`).join(" AND ")
      const join = fk.columns
        .map((c, i) => `r.${quoteIdent(fk.refColumns[i] as string)} = c.${quoteIdent(c)}`)
        .join(" AND ")
      // A reference into another closure table must land on a row of THIS org:
      // a forged bundle cannot point a row at another org's row that merely
      // exists here. A reference out of the closure only has to exist.
      const refTable = closure.byName.get(fk.refTable)
      const sameOrg = refTable ? ` AND ${orgPredicate(closure, refTable, "r", orgId)}` : ""
      const rows = await query<{ n: number }>(
        tx,
        `SELECT count(*)::int AS n FROM ${rel(t.name)} c
          WHERE ${orgPredicate(closure, t, "c", orgId)} AND ${notNull}
            AND NOT EXISTS (SELECT 1 FROM ${rel(fk.refTable)} r WHERE ${join}${sameOrg})`,
      )
      if ((rows[0]?.n ?? 0) > 0) out.push(`${t.name}.${fk.name} (${rows[0]?.n} row(s))`)
    }
  }
  return out
}

export async function countOrgClosure(
  tx: TransferSql,
  closure: Closure,
  orgId: string,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of closure.tables) {
    const rows = await query<{ n: number }>(
      tx,
      `SELECT count(*)::int AS n FROM ${rel(t.name)} t WHERE ${orgPredicate(closure, t, "t", orgId)}`,
    )
    out[t.name] = rows[0]?.n ?? 0
  }
  return out
}

async function raiseSequences(tx: TransferSql, source: Record<string, string>): Promise<void> {
  const ours = await query<{ name: string }>(
    tx,
    `SELECT schemaname || '.' || sequencename AS name FROM pg_sequences
      WHERE schemaname = 'kernel' OR schemaname LIKE 'app\\_%'`,
  )
  for (const { name } of ours) {
    const v = source[name]
    if (v === undefined) continue
    await tx.unsafe(
      `SELECT setval($1::text::regclass, greatest($2::bigint,
         (SELECT coalesce(last_value, 1) FROM pg_sequences WHERE schemaname || '.' || sequencename = $3)))`,
      [rel(name), v, name] as never,
    )
  }
}

export async function importOrg(opts: ImportOptions): Promise<ImportResult> {
  const sections = readBundle(opts.lines)
  const first = await sections.next()
  if (first.done || first.value.name !== "header" || first.value.data.length !== 1) {
    throw new ImportRefused("the bundle does not start with its header", "format")
  }
  const header = JSON.parse(first.value.data[0] as string) as TransferHeader
  const orgId = assertUuid(header.orgId, "importOrg")
  const transferId = assertUuid(header.transferId, "importOrg transfer")
  const purge = opts.purge ?? purgeTransferCopy
  const delta = header.mode === "delta"

  // The existing copy, decided before the transaction (a replacement is purged first).
  const existing = await existingCopy(opts.sql, orgId)
  let replacedTransferId: string | null = null
  if (existing && !delta) {
    if (existing.state === "incoming" && existing.transferId === transferId) {
      if (!opts.dryRun) await purge(orgId, transferId, "incoming")
    } else if (
      existing.state === "moved" &&
      header.arrivedVia !== null &&
      existing.transferId === header.arrivedVia
    ) {
      replacedTransferId = existing.transferId
      if (!opts.dryRun) await purge(orgId, existing.transferId, "moved")
    } else {
      throw new ImportRefused(
        `organization ${orgId} already exists here (${existing.state ?? "active"}${
          existing.transferId ? ` for transfer ${existing.transferId}` : ""
        }); only a copy this org was moved away from by the transfer it arrived through on the other side is replaced`,
        "exists",
        existing,
      )
    }
  }
  if (delta && (existing?.state !== "incoming" || existing.transferId !== transferId)) {
    throw new ImportRefused(
      `a delta needs the org incoming for transfer ${transferId} here`,
      "exists",
      existing,
    )
  }

  if (header.embedder !== null) {
    const fit = await embedderAdoptable(header.embedder)
    if (fit === "skew") {
      const ours = await embedderSignature()
      throw new ImportRefused(
        `the search indexes differ (embedder ${header.embedder} here ${ours}): the vectors would not be usable`,
        "skew",
      )
    }
    // No embedder declared here yet (a fresh index): declare the source's, as the first vector write
    // would. A dry run writes nothing; the real import declares it before any document.
    if (fit === "adopt" && !opts.dryRun) await adoptEmbedder(header.embedder)
  }

  const rows: Record<string, number> = {}
  const deleted: Record<string, number> = {}
  const search: { docs: string[] | null; written: number } = { docs: null, written: 0 }
  const marks: Array<{ key: string; value: string; ttlMs: number }> = []
  let manifest: Manifest | null = null
  try {
    await opts.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL session_replication_role = replica")
      await tx.unsafe("SET LOCAL lock_timeout = '10s'")
      const closure = await loadClosure(tx)
      checkSkew(header, closure, {
        schema: await schemaVersion(tx),
        apps: await activeVersions(tx, Object.keys(header.apps), orgId),
      })
      if (delta) {
        // The org's apps must still match what is here (the precheck ran at pass 1).
        const ours = await orgAppVersions(tx, orgId)
        for (const [name, v] of Object.entries(ours)) {
          if (header.apps[name] !== undefined && header.apps[name] !== v) {
            throw new ImportRefused(`app ${name} changed version during the move`, "skew")
          }
        }
      }
      const found: string[] = []
      let n = 0
      let sawRows = false
      const applying = !(opts.dryRun && existing && !delta)
      // Without applying, a parent that came earlier in this bundle is only in its staging table.
      const stagedOf = new Map<string, string>()
      for (;;) {
        const next = await sections.next()
        if (next.done) {
          manifest = next.value
          break
        }
        const s = next.value
        if (s.name === "search") {
          search.docs = s.data
          continue
        }
        if (s.name === "redis") {
          for (const d of s.data) marks.push(JSON.parse(d) as (typeof marks)[number])
          continue
        }
        const [kind, table] = [
          s.name.slice(0, s.name.indexOf(":")),
          s.name.slice(s.name.indexOf(":") + 1),
        ]
        const t = closure.byName.get(table)
        if (!t || !(table in header.fingerprints)) {
          throw new ImportRefused(`section ${s.name} names a table outside the closure`, "format")
        }
        if (kind === "deletes") {
          if (!delta) throw new ImportRefused("deletes in a full bundle", "format")
          if (sawRows) throw new ImportRefused("deletes after rows", "format")
          deleted[table] = await applyDeletes(tx, closure, t, s.data, orgId)
          continue
        }
        if (kind !== "rows") throw new ImportRefused(`unknown section ${s.name}`, "format")
        sawRows = true
        let data = s.data
        if (table === ORG_TABLE) {
          // The copy serves nothing until the move commits.
          data = data.map((d) => {
            const row = JSON.parse(d) as Record<string, unknown>
            if (row.id !== orgId) throw new ImportRefused("the org row is another org", "format")
            row.transfer_state = "incoming"
            row.transfer_id = transferId
            row.transfer_at = new Date().toISOString()
            return JSON.stringify(row)
          })
        } else if (table === CREDIT_TRANSACTIONS_TABLE) {
          // Metered on another instance's key: stamped with the transfer it
          // arrived through, so this instance's daily usage report never
          // counts it (it reports only what its own key spent). A row that
          // already arrived through an earlier move keeps that stamp, unless
          // that move took the org away from here: this key spent it, so this
          // instance reports it, as if the org had never left.
          data = data.map((d) => {
            const row = JSON.parse(d) as Record<string, unknown>
            if (row.arrived_via == null) row.arrived_via = transferId
            else if (row.arrived_via === replacedTransferId) row.arrived_via = null
            return JSON.stringify(row)
          })
        }
        if (data.length === 0) continue
        // A row can only name this org's objects: its keys live under
        // `orgs/<org>/`. Another prefix would let the org read another org's file.
        for (const d of data) {
          const bad = foreignObjectKey(d, orgId)
          if (bad)
            throw new ImportRefused(`${table}.${bad} names an object outside the org`, "format")
        }
        const staged = await stage(tx, t, data, n++)
        stagedOf.set(t.name, staged)
        if (found.length > 0) {
          // An earlier section collided and was not applied: rows below it
          // cannot be matched to their parents, only checked for collisions.
          found.push(...(await collisions(tx, closure, t, staged, orgId)))
          continue
        }
        // Every incoming row must be this org's (its org_id, or its parent row,
        // already applied: sections come in closure order). A bundle can never
        // write into another org.
        const strays = await query<{ n: number }>(
          tx,
          `SELECT count(*)::int AS n FROM ${staged} s WHERE NOT (${
            applying
              ? orgPredicate(closure, t, "s", orgId)
              : stagedOrgPredicate(closure, t, "s", orgId, (n) => stagedOf.get(n))
          })`,
        )
        if ((strays[0]?.n ?? 0) > 0) {
          throw new ImportRefused(`${strays[0]?.n} row(s) of ${table} are not this org's`, "format")
        }
        found.push(...(await collisions(tx, closure, t, staged, orgId)))
        if (found.length > 0 || !applying) continue
        rows[table] = await applyRows(tx, t, staged, delta)
      }
      if (found.length > 0) {
        throw new ImportRefused(
          `rows of this org collide with another org's here: ${found.join("; ")}. ` +
            "Resolve it on one side first (for a sign-in, the person disconnects that login in one of the two orgs)",
          "collision",
          found,
        )
      }
      const m = manifest as Manifest | null
      if (!m) throw new ImportRefused("no manifest", "format")
      // A dry run over a copy that a real run would purge first stops at the
      // checks above: the old copy's rows are still in the way.
      if (!applying) throw new DryRun()
      const dangling = await danglingReferences(tx, closure, orgId)
      if (dangling.length > 0) {
        throw new ImportRefused(
          `references that do not resolve here: ${dangling.join(", ")}`,
          "mismatch",
          dangling,
        )
      }
      const here = await countOrgClosure(tx, closure, orgId)
      const diff = Object.entries(m.counts).filter(([table, count]) => (here[table] ?? 0) !== count)
      if (diff.length > 0) {
        throw new ImportRefused(
          `row counts differ from the source: ${diff.map(([t, c]) => `${t} ${here[t] ?? 0}/${c}`).join(", ")}`,
          "mismatch",
          diff,
        )
      }
      await raiseSequences(tx, header.sequences)
      await tx.unsafe(
        `INSERT INTO kernel.org_transfer_ledger (transfer_id, org_id, direction, arrived_via)
         VALUES ($1::uuid, $2::uuid, 'in', $3::uuid) ON CONFLICT (transfer_id) DO NOTHING`,
        [transferId, orgId, header.arrivedVia] as never,
      )
      if (opts.dryRun) throw new DryRun()
    })
  } catch (err) {
    if (err instanceof DryRun) {
      return {
        orgId,
        transferId,
        mode: header.mode,
        rows,
        deleted,
        replacedTransferId,
        dryRun: true,
        rekeyed: {},
        rekeyMs: 0,
        searchDocuments: 0,
      }
    }
    throw err
  }

  const redis = opts.redis ?? redisBullMQ
  for (const mark of marks) {
    if (!mark.key.startsWith(`${WEBHOOK_REPLAY_MARK}${orgId}:`)) continue
    await redis.set(mark.key, mark.value, "PX", mark.ttlMs, "NX")
  }

  const rekeyed: Record<string, number> = {}
  const rekeyStart = Date.now()
  let rekeyMs = 0
  try {
    for (const family of KEY_FAMILIES) {
      const own = opts.ownKeys[family]
      if (!own) {
        if ((header.secrets[family] ?? 0) > 0) {
          throw new ImportRefused(
            `the org holds ${family} secrets and this instance has no ${family} key`,
            "rekey",
          )
        }
        continue
      }
      const report = await rotateEncryptionKey({
        family,
        fromKey: opts.transferKeys[family],
        toKey: own,
        onlyOrgIds: [orgId],
        execute: true,
      })
      rekeyed[family] = report.targets.reduce((s, t) => s + t.rekeyed, 0)
    }
    rekeyMs = Date.now() - rekeyStart
    if (search.docs) search.written = await importSearchDocuments(orgId, search.docs)
  } catch (err) {
    log.error(
      { err, orgId, transferId },
      "org transfer import: re-keying or the search copy failed; the incoming copy is purged",
    )
    if (!delta || existing?.state === "incoming") {
      await purge(orgId, transferId, "incoming").catch((e) =>
        log.error(
          { err: e, orgId, transferId },
          "org transfer import: purging the incoming copy failed",
        ),
      )
    }
    throw err instanceof ImportRefused
      ? err
      : new ImportRefused(String((err as Error).message), "rekey")
  }
  log.info(
    { orgId, transferId, mode: header.mode, replacedTransferId, rekeyMs },
    "org transfer imported",
  )
  return {
    orgId,
    transferId,
    mode: header.mode,
    rows,
    deleted,
    replacedTransferId,
    dryRun: false,
    rekeyed,
    rekeyMs,
    searchDocuments: search.written,
  }
}
