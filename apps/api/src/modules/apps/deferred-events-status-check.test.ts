// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression — the invoicing `deferred-retry` cron's success path
// (bundled-apps/invoicing/src/handlers/deferred-retry.ts) writes
// `status: "resolved"` on a successfully-retried deferred_events row. The
// column's CHECK constraint is generated straight from the manifest's
// `status.enum` array (ddl.ts `generateTableDdl`), so if the manifest enum
// omits a value the app code writes, every successful retry throws a real
// Postgres CHECK violation (23514) instead of landing.
//
// This test reads the ACTUAL manifest JSON (no hand-copied enum list that
// could drift), builds a real Postgres table with the generated DDL, and
// proves "resolved" is an accepted value while a bogus status is still
// rejected — real engine, not the bundled app's in-memory `createMockDb`
// shim, which never enforces a CHECK and would pass even if the manifest
// enum were wrong.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { generateTableDdl } from "~/modules/apps/ddl"

interface InvoicingManifest {
  schema: {
    deferred_events: {
      fields: {
        status: { type: string; enum: string[] }
      }
    }
  }
}

function loadInvoicingManifest(): InvoicingManifest {
  const liaisonRoot = join(import.meta.dir, "..", "..", "..", "..", "..")
  const manifestPath = join(liaisonRoot, "bundled-apps", "invoicing", "app.manifest.json")
  return JSON.parse(readFileSync(manifestPath, "utf8")) as InvoicingManifest
}

describe("deferred_events.status CHECK constraint (manifest-sourced)", () => {
  const manifest = loadInvoicingManifest()
  const statusField = manifest.schema.deferred_events.fields.status

  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS app_deferredchecktest CASCADE`)
    await sql.unsafe(`CREATE SCHEMA app_deferredchecktest`)
    const ddl = generateTableDdl("app_deferredchecktest", "deferred_events", {
      status: statusField,
    })
    for (const stmt of ddl.split(";\n").filter((s) => s.trim())) {
      await sql.unsafe(`${stmt};`)
    }
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS app_deferredchecktest CASCADE`)
  })

  it("manifest declares 'resolved' as a valid status (fixture sanity check)", () => {
    expect(statusField.enum).toContain("resolved")
  })

  it("a successful-retry row can be set to status='resolved' without violating the CHECK", async () => {
    const orgId = "00000000-0000-0000-0000-0000000000d1"
    const [row] = await sql.unsafe(`
      INSERT INTO app_deferredchecktest.deferred_events (org_id, status)
      VALUES ('${orgId}', 'awaiting_config')
      RETURNING id
    `)
    // The exact write deferredRetryJob's success path performs.
    await sql.unsafe(`
      UPDATE app_deferredchecktest.deferred_events
      SET status = 'resolved'
      WHERE id = '${row.id}'
    `)
    const [after] = await sql.unsafe(`
      SELECT status FROM app_deferredchecktest.deferred_events WHERE id = '${row.id}'
    `)
    expect(after.status).toBe("resolved")
  })

  it("a status outside the manifest enum is still rejected by the real CHECK constraint", async () => {
    // NOTE: a bare (non-transactional) `sql.unsafe()` PostgresError passed
    // through bun:test's `expect(...).rejects` matcher hangs the runner on
    // this bun version — reproduced in isolation outside this file too.
    // try/catch on the awaited promise is the safe equivalent (same pattern
    // already used by other non-transactional real-DB rejection assertions)
    // and does not hang.
    let threw = false
    try {
      await sql.unsafe(`
        INSERT INTO app_deferredchecktest.deferred_events (org_id, status)
        VALUES ('00000000-0000-0000-0000-0000000000d2', 'not_a_real_status')
      `)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})
