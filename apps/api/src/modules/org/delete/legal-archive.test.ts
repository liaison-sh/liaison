// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The legal-retention archive's pieces outside one deletion run:
//   - the daily sweep deletes an archive past its retention (object and row),
//     and leaves one still within it;
//   - the instance never reads an identity: no secret-key name in the env
//     schema, no decrypt path in the module sources;
//   - the manifest marker: invoicing's einvoice_transmissions is legalRetention;
//   - the ledger and the archive index are outside the purge's catalog (no
//     org_id), so they survive every org deletion;
//   - the tar writer round-trips, long names included;
//   - fix round 1: invoicing marks documents (issued invoices and credit notes
//     only) and their lines; entry names always fit tar (multi-byte names,
//     long schema/table names); the sweep deletes a pending archive (written
//     before its upload, never recorded) after a day.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { generateX25519Identity, identityToRecipient } from "age-encryption"
import type { SQL } from "drizzle-orm"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { kernelJobSpec } from "~/infra/jobs/queue-classes"
import { deleteObject, headObject, putObject } from "~/infra/storage/object-storage"
import { envSchema } from "~/lib/env"
import { ORG_DELETE_JOB } from "~/modules/org/delete/job"
import {
  dataEntryBase,
  fileEntryName,
  legalArchiveObjectKey,
  legalRetentionTablesOf,
  sweepExpiredLegalArchives,
} from "~/modules/org/delete/legal-archive"
import { readTar, tarEnd, tarEntry, tarHeader } from "~/modules/org/delete/tar"
import { orgScopedTables } from "~/modules/org/purge/rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const orgId = crypto.randomUUID()
const keys: string[] = []

beforeAll(async () => {
  await acquireTestLock()
})

afterAll(async () => {
  await sql`DELETE FROM kernel.legal_archives WHERE deleted_org_id = ${orgId}`
  for (const k of keys) await deleteObject(k).catch(() => undefined)
  await releaseTestLock()
})

async function exists(key: string): Promise<boolean> {
  try {
    await headObject(key)
    return true
  } catch {
    return false
  }
}

describe("legal archive retention", () => {
  it("the sweep deletes an archive past retain_until and keeps one within it", async () => {
    const expired = legalArchiveObjectKey(orgId, new Date("2010-01-01T00:00:00Z"))
    const kept = legalArchiveObjectKey(orgId, new Date("2026-01-01T00:00:00Z"))
    for (const key of [expired, kept]) {
      keys.push(key)
      await putObject({
        key,
        body: new TextEncoder().encode("age"),
        contentType: "application/octet-stream",
      })
    }
    await sql`INSERT INTO kernel.legal_archives (deleted_org_id, org_slug, object_key, recipient, retain_until)
      VALUES (${orgId}, 'gone', ${expired}, 'age1x', now() - interval '1 day'),
             (${orgId}, 'gone', ${kept}, 'age1x', now() + interval '9 years')`
    const deleted = await sweepExpiredLegalArchives()
    expect(deleted).toBeGreaterThanOrEqual(1)
    expect(await exists(expired)).toBe(false)
    expect(await exists(kept)).toBe(true)
    const rows = await sql<{ object_key: string; deleted_at: Date | null }[]>`
      SELECT object_key, deleted_at FROM kernel.legal_archives WHERE deleted_org_id = ${orgId}`
    const byKey = new Map(rows.map((r) => [r.object_key, r.deleted_at]))
    expect(byKey.get(expired)).not.toBeNull()
    expect(byKey.get(kept)).toBeNull()
    // A second sweep has nothing left to do for these.
    await sweepExpiredLegalArchives()
    expect(await exists(kept)).toBe(true)
  })

  it("the sweep deletes a pending archive (never recorded) older than a day, not a fresh one", async () => {
    const stale = legalArchiveObjectKey(orgId, new Date("2011-01-01T00:00:00Z"))
    const fresh = legalArchiveObjectKey(orgId, new Date("2027-01-01T00:00:00Z"))
    for (const key of [stale, fresh]) {
      keys.push(key)
      await putObject({
        key,
        body: new TextEncoder().encode("age"),
        contentType: "application/octet-stream",
      })
    }
    await sql`INSERT INTO kernel.legal_archives (deleted_org_id, org_slug, object_key, recipient, retain_until, recorded_at, created_at)
      VALUES (${orgId}, 'gone', ${stale}, 'age1x', now() + interval '9 years', NULL, now() - interval '2 days'),
             (${orgId}, 'gone', ${fresh}, 'age1x', now() + interval '9 years', NULL, now())`
    await sweepExpiredLegalArchives()
    expect(await exists(stale)).toBe(false)
    expect(await exists(fresh)).toBe(true)
    const [row] =
      await sql`SELECT deleted_at FROM kernel.legal_archives WHERE object_key = ${stale}`
    expect(row?.deleted_at).not.toBeNull()
  })
})

describe("the instance never holds the identity", () => {
  it("the env schema has a recipient and a retention, never an identity", () => {
    const legal = Object.keys(envSchema.shape).filter((k) => k.startsWith("LEGAL_ARCHIVE"))
    expect(legal.sort()).toEqual(["LEGAL_ARCHIVE_RECIPIENT", "LEGAL_ARCHIVE_RETENTION_YEARS"])
    for (const k of Object.keys(envSchema.shape)) {
      expect(k).not.toMatch(/AGE_IDENTITY|ARCHIVE_IDENTITY|ARCHIVE_SECRET|ARCHIVE_PRIVATE/)
    }
  })

  it("the env schema accepts an age recipient and refuses anything else", async () => {
    const field = envSchema.shape.LEGAL_ARCHIVE_RECIPIENT
    const recipient = await identityToRecipient(await generateX25519Identity())
    expect(field.safeParse(recipient).success).toBe(true)
    expect(field.safeParse("").success).toBe(true)
    expect(field.safeParse("age1notakey").success).toBe(false)
    expect(field.safeParse("AGE-SECRET-KEY-1QQQ").success).toBe(false)
  })

  it("no source of the deletion reads or decrypts with an identity", () => {
    for (const file of [
      "legal-archive.ts",
      "job.ts",
      "ledger.ts",
      "tar.ts",
      "../../../cli/org-delete.ts",
    ]) {
      const src = readFileSync(path.join(import.meta.dir, file), "utf8")
      expect(src).not.toMatch(
        /Decrypter|addIdentity|AGE-SECRET-KEY|LEGAL_ARCHIVE_IDENTITY|identityToRecipient/,
      )
    }
  })
})

describe("catalog", () => {
  it("invoicing marks einvoice_transmissions legalRetention", () => {
    const manifest = JSON.parse(
      readFileSync(
        path.join(import.meta.dir, "../../../../../../bundled-apps/invoicing/app.manifest.json"),
        "utf8",
      ),
    )
    const tables = legalRetentionTablesOf([manifest])
    expect(tables.map((t) => `${t.schema}.${t.table}`)).toContain(
      "app_invoicing.einvoice_transmissions",
    )
  })

  it("invoicing keeps issued invoices and credit notes and their lines, not drafts or quotes", () => {
    const manifest = JSON.parse(
      readFileSync(
        path.join(import.meta.dir, "../../../../../../bundled-apps/invoicing/app.manifest.json"),
        "utf8",
      ),
    )
    const byTable = new Map(legalRetentionTablesOf([manifest]).map((t) => [t.table, t]))
    const docs = byTable.get("documents")
    const where = new Map((docs?.filter?.where ?? []).map((w) => [w.column, w.values]))
    expect([...(where.get("type") ?? [])].sort()).toEqual(["credit_note", "invoice"])
    const statuses = where.get("status") ?? []
    for (const s of ["issued", "paid", "voided", "cancelled", "refunded", "fulfilled"]) {
      expect(statuses).toContain(s)
    }
    for (const s of ["draft", "pending_approval", "sent", "accepted"]) {
      expect(statuses).not.toContain(s)
    }
    // Every status the filter names is one the table allows.
    const allowed: string[] = manifest.schema.documents.fields.status.enum
    for (const s of statuses) expect(allowed).toContain(s)
    const lines = byTable.get("document_lines")
    expect(lines?.filter?.parent?.table).toBe("documents")
    expect(lines?.filter?.parent?.column).toBe("document_id")
    expect(lines?.filter?.parent?.filter).toEqual(docs?.filter)
  })

  it("the ledger and the archive index are not in the purge's catalog (they survive)", async () => {
    const tables = await withSystemDb("test", (tx) =>
      orgScopedTables({ execute: (q) => tx.execute(q as SQL) }, "all"),
    )
    const names = tables.map((t) => `${t.schema}.${t.table}`)
    expect(names.length).toBeGreaterThan(20)
    expect(names.some((n) => n.endsWith(".org_deletions"))).toBe(false)
    expect(names.some((n) => n.endsWith(".legal_archives"))).toBe(false)
  })
})

describe("the org-delete job", () => {
  it("has a queue class, so the CLI can hand it to the server", () => {
    expect(kernelJobSpec(ORG_DELETE_JOB).queueClass).toBe("bulk")
  })
})

describe("tar", () => {
  it("round-trips entries, a long name included", () => {
    const long = `files/${crypto.randomUUID()}/${"a".repeat(80)}.pdf`
    const chunks = [
      ...tarEntry("manifest.json", new TextEncoder().encode('{"a":1}')),
      ...tarEntry(long, new Uint8Array(1000).fill(7)),
      ...tarEntry("empty.ndjson", new Uint8Array(0)),
      tarEnd(),
    ]
    const tar = Buffer.concat(chunks)
    expect(tar.byteLength % 512).toBe(0)
    const entries = readTar(tar)
    expect(entries.map((e) => e.name)).toEqual(["manifest.json", long, "empty.ndjson"])
    expect(entries[1]?.bytes.byteLength).toBe(1000)
  })

  it("file entry names fit tar whatever the name (multi-byte, cut on code points)", () => {
    const id = crypto.randomUUID()
    for (const name of [
      `${"請求書".repeat(30)}.pdf`,
      `${"😀".repeat(60)}.pdf`,
      `${"a".repeat(300)}.pdf`,
      "",
    ]) {
      const entry = fileEntryName(id, name)
      expect(() => tarHeader(entry, 1)).not.toThrow()
      const last = entry.split("/").pop() ?? ""
      expect(Buffer.byteLength(last)).toBeLessThanOrEqual(100)
      // No lone surrogate: it round-trips through UTF-8.
      expect(Buffer.from(last, "utf8").toString("utf8")).toBe(last)
    }
  })

  it("data entry names fit tar for long schema and table names", () => {
    const long = `app_${"s".repeat(59)}.${"t".repeat(63)}`
    const base = dataEntryBase(3, long)
    expect(base).toBe("data/table-4")
    expect(() => tarHeader(`${base}.0001.ndjson`, 1)).not.toThrow()
    expect(dataEntryBase(0, "app_invoicing.documents")).toBe("data/app_invoicing.documents")
  })
})
