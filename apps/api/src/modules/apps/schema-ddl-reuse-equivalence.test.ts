// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `createTestOrg` registers apps with `appSchemaDdlReuse` on: an app whose
 * schema already carries the current DDL stamp gets only the new org's rows and
 * in-memory declarations, not its schema DDL again. This proves that shortcut
 * leaves the same state as the full registration: every row of every kernel and
 * app table, and every org-keyed entry of the app registries, compared modulo
 * ids and timestamps.
 *
 * Ids are compared through what they point at: each uuid becomes a label built
 * from the row it identifies (its table and non-id, non-time columns), so a
 * foreign key to the wrong row still differs. Two full registrations are
 * compared first, which shows the normalisation removes only noise.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import * as appRegistries from "~/modules/apps/app-registries"
import { appRegistrationStats } from "~/modules/apps/runtime"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ISO_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?$/

/**
 * Columns whose value is fresh randomness by design, so two full registrations
 * already differ there (each listed column was seen to): a session's refresh
 * token hash, the bootstrap user's password hash, an agent's avatar colour (the
 * least-used slot, a tie broken at random: pickAgentAvatarColor).
 */
const RANDOM_COLUMNS = new Set([
  "kernel.sessions.refresh_token_hash",
  "kernel.users.password_hash",
  "kernel.agents.avatar_color",
])

type Row = Record<string, unknown>

/** A value with uuids replaced through `label` and timestamps blanked. */
function normalise(value: unknown, label: (id: string) => string): unknown {
  if (typeof value === "string") {
    if (ISO_TIME.test(value)) return "<time>"
    return value.replace(UUID, (id) => label(id.toLowerCase()))
  }
  if (Array.isArray(value)) return value.map((v) => normalise(v, label))
  if (value && typeof value === "object") {
    const out: Row = {}
    for (const key of Object.keys(value as Row).sort()) {
      out[key] = normalise((value as Row)[key], label)
    }
    return out
  }
  return value
}

/** Every row of every kernel and app_* table, keyed `schema.table`, canonicalised. */
async function snapshotTables(): Promise<Map<string, string[]>> {
  const tables = await sql<{ name: string }[]>`
    SELECT schemaname || '.' || tablename AS name FROM pg_tables
    WHERE schemaname = 'kernel' OR schemaname LIKE 'app\\_%'
    ORDER BY 1`
  // Values drawn from a sequence (serial and identity columns, sequence-backed
  // handles) keep counting across resets, so they differ between any two runs.
  const sequenced = new Set(
    (
      await sql<{ col: string }[]>`
        SELECT n.nspname || '.' || c.relname || '.' || a.attname AS col
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attnum > 0 AND NOT a.attisdropped
          AND (a.attidentity <> '' OR pg_get_expr(d.adbin, d.adrelid) LIKE '%nextval(%')`
    ).map((r) => r.col),
  )
  const raw = new Map<string, Row[]>()
  for (const { name } of tables) {
    const rows = await sql.unsafe<{ r: Row }[]>(`SELECT to_jsonb(t) AS r FROM ${name} t`)
    if (rows.length === 0) continue
    raw.set(
      name,
      rows.map(({ r }) => {
        const row = { ...r }
        for (const col of Object.keys(row)) {
          if (RANDOM_COLUMNS.has(`${name}.${col}`)) row[col] = "<random>"
          else if (sequenced.has(`${name}.${col}`)) row[col] = "<sequence>"
        }
        return row
      }),
    )
  }
  // Pass 1: a label per row id, from the row with every id and time blanked.
  const labels = new Map<string, string>()
  for (const [name, rows] of raw) {
    for (const row of rows) {
      const { id, ...rest } = row
      if (typeof id !== "string") continue
      labels.set(id.toLowerCase(), `${name}:${JSON.stringify(normalise(rest, () => "<id>"))}`)
    }
  }
  // Pass 2: the rows with every id replaced by the label of the row it names.
  const out = new Map<string, string[]>()
  for (const [name, rows] of raw) {
    out.set(
      name,
      rows
        .map((row) => JSON.stringify(normalise(row, (id) => labels.get(id) ?? "<unknown-id>")))
        .sort(),
    )
  }
  return out
}

/** Every registry entry keyed by `orgId`, with the org id dropped from key and value. */
function snapshotRegistries(orgId: string): Map<string, string> {
  // Functions (handlers, loaders) compare by presence; a cycle by its marker.
  const canon = (value: unknown, ancestors: unknown[]): unknown => {
    if (typeof value === "function") return "<fn>"
    if (typeof value === "string") return value.replaceAll(orgId, "<org>")
    if (!value || typeof value !== "object") return value
    if (ancestors.includes(value)) return "<cycle>"
    const inner = [...ancestors, value]
    if (value instanceof Set) return [...value].map((v) => canon(v, inner)).sort()
    if (Array.isArray(value)) return value.map((v) => canon(v, inner))
    const entries = value instanceof Map ? [...value] : Object.entries(value)
    return Object.fromEntries(
      entries
        .map(([k, v]) => [String(k), canon(v, inner)] as const)
        .sort(([x], [y]) => (x < y ? -1 : 1)),
    )
  }
  const out = new Map<string, string>()
  for (const [registryName, registry] of Object.entries(appRegistries)) {
    const entries = (registry as { entries?: () => Iterable<[string[], unknown]> })?.entries
    if (typeof entries !== "function" || registry instanceof Map) continue
    for (const [key, value] of entries.call(registry)) {
      if (!Array.isArray(key) || key[0] !== orgId) continue
      out.set(`${registryName}:${key.slice(1).join("/")}`, JSON.stringify(canon(value, [])))
    }
  }
  return out
}

/**
 * For each table (or registry key) whose canonical contents differ, the entries
 * only one side holds, so a failure names exactly the rows that differ.
 */
function differences(
  a: Map<string, string[] | string>,
  b: Map<string, string[] | string>,
): string[] {
  const diffs: string[] = []
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const left = [a.get(key) ?? []].flat()
    const right = [b.get(key) ?? []].flat()
    if (JSON.stringify(left) === JSON.stringify(right)) continue
    const onlyLeft = left.filter((x) => !right.includes(x))
    const onlyRight = right.filter((x) => !left.includes(x))
    diffs.push(
      `${key} (${left.length} vs ${right.length} entries)\n` +
        onlyLeft.map((x) => `  - ${x}`).join("\n") +
        "\n" +
        onlyRight.map((x) => `  + ${x}`).join("\n"),
    )
  }
  return diffs
}

const EMAIL = "equivalence@t.co"

async function bootstrap(reuseAppSchemaDdl: boolean) {
  const { id } = await createTestOrg({ email: EMAIL, password: undefined, reuseAppSchemaDdl })
  return { id, tables: await snapshotTables(), registries: snapshotRegistries(id) }
}

describe("createTestOrg app schema DDL reuse", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("leaves the same rows and registrations as the full registration", async () => {
    const full = await bootstrap(false)
    // The noise floor: two full registrations must already compare equal.
    const fullAgain = await bootstrap(false)
    expect(differences(full.tables, fullAgain.tables)).toEqual([])
    expect(differences(full.registries, fullAgain.registries)).toEqual([])

    const before = { ...appRegistrationStats }
    const fast = await bootstrap(true)
    // The shortcut actually ran, for every registered app, with no DDL
    // transaction at all.
    const appCount = fast.tables.get("kernel.apps")?.length ?? 0
    expect(appCount).toBeGreaterThan(5)
    expect(appRegistrationStats.ddlReused - before.ddlReused).toBe(appCount)
    expect(appRegistrationStats.ddlTransactions - before.ddlTransactions).toBe(0)

    // Non-vacuity: the comparison covers real state.
    console.log(
      `compared ${full.tables.size} non-empty tables (${[...full.tables.values()].flat().length} rows) and ${full.registries.size} registry entries`,
    )
    expect(full.tables.size).toBeGreaterThan(10)
    expect(full.registries.size).toBeGreaterThan(100)
    expect(differences(full.tables, fast.tables)).toEqual([])
    expect(differences(full.registries, fast.registries)).toEqual([])
  }, 120_000)
})
