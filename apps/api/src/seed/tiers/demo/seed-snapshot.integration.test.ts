// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo tier's output, pinned. A visitor world seeded with every need at a
// fixed base time is read back table by table (every table with an `org_id`
// column, in this run's schemas), normalised for what legitimately differs
// between two runs (ids, write-time clocks, the org's slug, salted hashes and
// ciphertexts) or between two checkouts (what an installed app's build says
// about itself), and compared with `seed-snapshot.expected.json`: the row count
// and a content digest per table.
//
// A refactor of the seed engine (moving a layer onto the factories, say) must
// leave this file unchanged: identical rows, identical content. A change that
// is MEANT to change the world rewrites it on purpose:
//
//   SEED_SNAPSHOT_WRITE=1 bun run scripts/test-run.ts demo-seed \
//     --file src/seed/tiers/demo/seed-snapshot.integration.test.ts
//
// SEED_SNAPSHOT_DUMP=<dir> also writes each table's normalised rows there, so
// two runs can be diffed row by row.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEMO_WORLD_NEEDS } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { DEMO_COMPANY_NAME } from "~/modules/demo/demo-seeder"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"
import { seedDemoWorld } from "./seed-demo"

const DB_URL = process.env.DATABASE_URL ?? ""
/** Far from the wall clock, so a world timestamp never reads as a write time. */
const BASE_TIME = new Date("2025-01-15T09:00:00.000Z")
const EXPECTED_FILE = path.join(import.meta.dir, "seed-snapshot.expected.json")
const CATALOG_DEMO_APPS = ["invoicing", "social", "pennylane", "boxtal", "shopify", "monitoring"]

/**
 * Columns whose value is random per run by design: salted hashes, ciphertexts,
 * per-row secrets and one-time tokens. Their presence is kept, their value is not.
 */
const VOLATILE_COLUMN =
  /(^|_)(hash|salt|iv|nonce|secret|token|ciphertext|encrypted|signature|key_material|wrapped_key|fingerprint)(_|$)/

/**
 * Values handed out in arrival order by an org-wide or global counter (a
 * ticket's `ticket-8`, a contact's `@contact-26`, the outbox `seq`, the next
 * free avatar colour): concurrent writes may take them in either order, so the
 * value is kept only as its shape.
 */
const ARRIVAL_ORDER_COLUMN = /^(seq|avatar_color)$/
/**
 * Columns copied from the app package at install or registration, never chosen
 * by the seed: an app's `version` and its manifest's `everyMemberScopes` (the
 * schema hash is already volatile). They follow whatever the checkout's
 * bundled apps build to, so a version bump of any app would otherwise rewrite
 * this file for a world that did not change. Which apps are installed, their
 * status, access mode and config stay pinned.
 */
const BUILD_COLUMNS: Record<string, RegExp> = {
  "kernel.apps": /^(version|every_member_scopes)$/,
}
/** Arrays built from a set or a parallel lookup, whose order carries no meaning. */
const UNORDERED_COLUMN = /^(scope_ceiling|participants)$/
const COUNTER_HANDLE = /-[0-9a-f-]*\d[0-9a-f-]*$/

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ISO_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?$/

export interface TableSnapshot {
  rows: number
  digest: string
}

type Snapshot = Record<string, TableSnapshot>

/**
 * Tables whose normalised content still names the day the test ran. A write
 * clock inside a value (a `MEMORY.md` line's date, a generated reference) is
 * not an ISO timestamp column the window can hide, and it changes the digest
 * from one day to the next: the seed must stamp it from its base time.
 */
const wallClockLeaks = new Set<string>()

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[]
}

/** The schemas this run reads: its own prefix, never another worker's. */
function ownSchema(schema: string): string | null {
  const prefix = process.env.SCHEMA_PREFIX ?? ""
  if (prefix !== "") return schema.startsWith(prefix) ? schema.slice(prefix.length) : null
  return /^w\d+_/.test(schema) ? null : schema
}

interface Window {
  from: number
  to: number
}

function normalise(
  value: unknown,
  column: string,
  ctx: { slug: string; written: Window },
): unknown {
  if (value === null || value === undefined) return value
  if (VOLATILE_COLUMN.test(column)) return "<volatile>"
  if (ARRIVAL_ORDER_COLUMN.test(column)) return "<counter>"
  if (column === "handle" && typeof value === "string") return value.replace(COUNTER_HANDLE, "-<n>")
  if (typeof value === "string") {
    if (ISO_TS.test(value)) {
      const t = Date.parse(value)
      if (!Number.isNaN(t) && t >= ctx.written.from && t <= ctx.written.to) return "<written>"
      return new Date(t).toISOString()
    }
    return value.replace(UUID, "<uuid>").split(ctx.slug).join("<slug>")
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => normalise(v, column, ctx))
    if (!UNORDERED_COLUMN.test(column)) return items
    return items
      .map((v) => JSON.stringify(v))
      .sort()
      .map((v) => JSON.parse(v) as unknown)
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const k = key.replace(UUID, "<uuid>")
      out[k] = normalise((value as Record<string, unknown>)[key], key, ctx)
    }
    return out
  }
  return value
}

async function snapshotOrg(
  orgId: string,
  slug: string,
  written: Window,
  dumpDir: string | null,
): Promise<Snapshot> {
  return withPrivilegedDb(orgId, "seed-snapshot", async (tx) => {
    const tables = rowsOf<{ schema: string; table: string }>(
      await tx.execute(sql`
        SELECT c.table_schema AS schema, c.table_name AS table
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.column_name = 'org_id' AND t.table_type = 'BASE TABLE'
          AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY 1, 2`),
    )
    const snapshot: Snapshot = {}
    for (const { schema, table } of tables) {
      const logical = ownSchema(schema)
      if (logical === null) continue
      const rows = rowsOf<{ r: Record<string, unknown> }>(
        await tx.execute(
          sql`SELECT to_jsonb(x) AS r FROM ${sql.identifier(schema)}.${sql.identifier(table)} x
              WHERE x.org_id = ${orgId}::uuid`,
        ),
      )
      if (rows.length === 0) continue
      const name = `${logical}.${table}`
      const build = BUILD_COLUMNS[name]
      const days = [written.from, written.to].map((t) => new Date(t).toISOString().slice(0, 10))
      const lines = rows
        .map(({ r }) => {
          const out: Record<string, unknown> = {}
          for (const col of Object.keys(r).sort())
            out[col] =
              build?.test(col) && r[col] !== null
                ? "<build>"
                : normalise(r[col], col, { slug, written })
          return JSON.stringify(out)
        })
        .sort()
      if (lines.some((line) => days.some((day) => line.includes(day)))) wallClockLeaks.add(name)
      snapshot[name] = {
        rows: lines.length,
        digest: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16),
      }
      if (dumpDir) writeFileSync(path.join(dumpDir, `${name}.jsonl`), `${lines.join("\n")}\n`)
    }
    return snapshot
  })
}

async function seedAndSnapshot(tag: string): Promise<Snapshot> {
  const slug = `demo-snap-${crypto.randomUUID().slice(0, 8)}`
  const from = Date.now() - 60_000
  const result = await seedDemoWorld({
    orgSlug: slug,
    orgName: DEMO_COMPANY_NAME,
    variant: "visitor",
    locale: "en",
    owner: { email: `owner@${slug}.example`, name: "Snapshot Owner", password: "SnapOwner1!Seed" },
    needs: [...DEMO_WORLD_NEEDS.products],
    baseTime: BASE_TIME,
  })
  expect(result.failures).toEqual([])
  expect(result.complete).toBe(true)
  const written = { from, to: Date.now() + 60_000 }
  const root = process.env.SEED_SNAPSHOT_DUMP
  const dumpDir = root ? path.join(root, tag) : null
  if (dumpDir) mkdirSync(dumpDir, { recursive: true })
  return snapshotOrg(result.orgId, slug, written, dumpDir)
}

function diff(expected: Snapshot, actual: Snapshot): string[] {
  const out: string[] = []
  for (const name of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
    const e = expected[name]
    const a = actual[name]
    if (!e) out.push(`${name}: new (${a?.rows} rows)`)
    else if (!a) out.push(`${name}: gone (was ${e.rows} rows)`)
    else if (e.rows !== a.rows) out.push(`${name}: ${e.rows} -> ${a.rows} rows`)
    else if (e.digest !== a.digest) out.push(`${name}: content changed (${a.rows} rows)`)
  }
  return out
}

beforeAll(() => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database: use liaison_hardening_test")
  }
  DemoModeTestAccess.set(true)
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(
      mkdtempSync(path.join(tmpdir(), "demo-seed-snapshot-")),
      "apps",
    )
  }
})

afterAll(() => {
  DemoModeTestAccess.set(null)
})

describe("the demo tier's output for a fixed base time", () => {
  let first: Snapshot
  let second: Snapshot

  beforeAll(async () => {
    for (const app of CATALOG_DEMO_APPS) await installFromDist(app, crypto.randomUUID())
    first = await seedAndSnapshot("first")
    second = await seedAndSnapshot("second")
  }, 2_400_000)

  it("is the same world twice in a row (the normalisation hides nothing real)", () => {
    expect(diff(first, second)).toEqual([])
  })

  it("names no wall-clock day in any value (every date comes from the base time)", () => {
    expect([...wallClockLeaks].sort()).toEqual([])
  })

  it("matches the pinned snapshot, table by table", () => {
    if (process.env.SEED_SNAPSHOT_WRITE === "1" || !existsSync(EXPECTED_FILE)) {
      writeFileSync(EXPECTED_FILE, `${JSON.stringify(first, null, 2)}\n`)
      console.log(`[seed-snapshot] wrote ${EXPECTED_FILE}`)
    }
    const expected = JSON.parse(readFileSync(EXPECTED_FILE, "utf8")) as Snapshot
    expect(diff(expected, first)).toEqual([])
  })
})
