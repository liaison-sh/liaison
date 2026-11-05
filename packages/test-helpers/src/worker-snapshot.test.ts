// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createDbClient } from "./db"
import { resolveTestCoordinates } from "./test-namespace"
import {
  dropWorkerSnapshot,
  installedAppsFingerprint,
  restoreWorkerData,
  snapshotWorkerData,
} from "./worker-snapshot"

// A high id no e2e lane or Playwright worker uses.
const WORKER = 97
const KS = `"w${WORKER}_kernel"`

describe("worker data snapshot / restore", () => {
  const db = createDbClient(process.env.E2E_DATABASE_URL ?? resolveTestCoordinates().superuserUrl())

  beforeAll(async () => {
    await db.cloneSchemas(WORKER)
    await db.grantWorkerSchemas(WORKER)
  }, 120_000)

  afterAll(async () => {
    await dropWorkerSnapshot(db.sql, WORKER)
    await db.dropWorkerSchemas(WORKER)
    await db.close()
  }, 60_000)

  it("puts rows, sequences and schemas back to the snapshot", async () => {
    const [org] = await db.sql.unsafe(
      `INSERT INTO ${KS}.organizations (name, slug) VALUES ('Snap Org', 'snap-org') RETURNING id`,
    )
    const seqName = `w${WORKER}_kernel.thread_handle_seq`
    const [hasSeq] = await db.sql.unsafe(`SELECT to_regclass('${seqName}') IS NOT NULL AS ok`)
    if (hasSeq.ok) await db.sql.unsafe(`SELECT nextval('${seqName}')`)
    const seqBefore = hasSeq.ok
      ? (await db.sql.unsafe(`SELECT last_value FROM ${seqName}`))[0].last_value
      : null

    await snapshotWorkerData(db.sql, WORKER)

    // What a scenario file does: more rows, an edit, a delete, a sequence
    // advance, and a schema a runtime app install would create.
    await db.sql.unsafe(
      `INSERT INTO ${KS}.organizations (name, slug) VALUES ('Extra Org', 'extra-org')`,
    )
    await db.sql.unsafe(`UPDATE ${KS}.organizations SET name = 'Renamed' WHERE id = $1`, [org.id])
    if (hasSeq.ok) await db.sql.unsafe(`SELECT nextval('${seqName}')`)
    await db.sql.unsafe(`CREATE SCHEMA "w${WORKER}_app_runtime_install"`)

    await restoreWorkerData(db.sql, WORKER)

    const orgs = await db.sql.unsafe(`SELECT id, name, slug FROM ${KS}.organizations ORDER BY slug`)
    expect(orgs.map((o) => [o.id, o.name, o.slug])).toEqual([[org.id, "Snap Org", "snap-org"]])
    if (hasSeq.ok) {
      const [after] = await db.sql.unsafe(`SELECT last_value FROM ${seqName}`)
      expect(String(after.last_value)).toBe(String(seqBefore))
    }
    const [schema] = await db.sql.unsafe(
      `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'w${WORKER}_app_runtime_install'`,
    )
    expect(schema.n).toBe(0)

    // Restoring twice in a row is the same state (a lane restores per file).
    await restoreWorkerData(db.sql, WORKER)
    const again = await db.sql.unsafe(`SELECT id FROM ${KS}.organizations`)
    expect(again.map((o) => o.id)).toEqual([org.id])
  }, 60_000)

  it("fingerprints the installed apps", async () => {
    expect(await installedAppsFingerprint(db.sql, WORKER)).toBe("")
  })
})
