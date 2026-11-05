// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0139 adds the credit-note original link column to invoicing documents,
// backfills it from `external_refs`, and stamps `external_refs.import_file_id`
// on imported documents. Replayed against SCRATCH copies in their own schema
// (0118's recipe): the statements are the file's own, only schema names are
// swapped.

import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0155_invoicing_original_document_id.sql", import.meta.url).pathname
const SCRATCH = "mig0139_invoicing"
const ORG_A = "00000000-0000-0000-0000-0000000000aa"
const ORG_B = "00000000-0000-0000-0000-0000000000bb"
const INV = "00000000-0000-0000-0000-00000000a001"
const CN_OK = "00000000-0000-0000-0000-00000000a002"
const CN_BAD = "00000000-0000-0000-0000-00000000a003"
const CN_HAS = "00000000-0000-0000-0000-00000000a004"
const IMP_A = "00000000-0000-0000-0000-00000000a005"
const IMP_B = "00000000-0000-0000-0000-00000000a006"
const IMP_NONE = "00000000-0000-0000-0000-00000000a007"
const F_EARLY = "00000000-0000-0000-0000-00000000f001"
const F_LATE = "00000000-0000-0000-0000-00000000f002"
const F_ORGB = "00000000-0000-0000-0000-00000000f003"
const F_OTHERAPP = "00000000-0000-0000-0000-00000000f005"

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

/** Run the migration file against the scratch schema; `schema` swaps which schema name the
 *  file's guard looks for, so a name that does not exist exercises the "never installed" path. */
async function apply(schema: string = SCRATCH): Promise<void> {
  const text = readFileSync(FILE, "utf8")
    .replaceAll("app_invoicing", schema)
    .replaceAll("kernel.files", `${SCRATCH}.files`)
  await sql.unsafe(text)
}

async function docs(): Promise<
  Record<string, { original: string | null; refs: Record<string, unknown> }>
> {
  const rows = await sql.unsafe<
    { id: string; original_document_id: string | null; external_refs: Record<string, unknown> }[]
  >(`SELECT id, original_document_id, external_refs FROM ${SCRATCH}.documents ORDER BY id`)
  return Object.fromEntries(
    rows.map((r) => [r.id, { original: r.original_document_id, refs: r.external_refs }]),
  )
}

async function doc(id: string, orgId: string, refs: Record<string, unknown>, original?: string) {
  await sql.unsafe(
    `INSERT INTO ${SCRATCH}.documents (id, org_id, external_refs${original ? ", original_document_id" : ""})
     VALUES ('${id}', '${orgId}', '${JSON.stringify(refs)}'::jsonb${original ? `, '${original}'` : ""})`,
  )
}

async function file(
  id: string,
  orgId: string,
  filename: string,
  createdAt: string,
  opts?: { app?: string; uploadedBy?: string | null },
) {
  const uploadedBy = opts?.uploadedBy === undefined ? null : opts.uploadedBy
  await sql.unsafe(
    `INSERT INTO ${SCRATCH}.files (id, org_id, app, entity_type, filename, uploaded_by, created_at)
     VALUES ('${id}', '${orgId}', '${opts?.app ?? "invoicing"}', 'pdf', '${filename}',
             ${uploadedBy ? `'${uploadedBy}'` : "NULL"}, '${createdAt}')`,
  )
}

describe("0139 invoicing original_document_id", () => {
  beforeEach(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.unsafe(`CREATE SCHEMA ${SCRATCH}`)
    // A registered-shape documents table: the runtime reconciler has not added the new column yet.
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.documents (
      id uuid PRIMARY KEY, org_id uuid NOT NULL, external_refs jsonb NOT NULL DEFAULT '{}'::jsonb)`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.files (
      id uuid PRIMARY KEY, org_id uuid NOT NULL, app text NOT NULL, entity_type text NOT NULL,
      filename text NOT NULL, uploaded_by uuid, created_at timestamptz NOT NULL)`)
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.end()
  })

  it("backfills the link from external_refs, skipping malformed values and rows already linked", async () => {
    await doc(INV, ORG_A, {})
    await doc(CN_OK, ORG_A, { original_document_id: INV })
    await doc(CN_BAD, ORG_A, { original_document_id: "INV-2026-0001" })
    await sql.unsafe(`ALTER TABLE ${SCRATCH}.documents ADD COLUMN original_document_id uuid`)
    await doc(CN_HAS, ORG_A, { original_document_id: CN_OK }, INV)
    await apply()
    const d = await docs()
    expect(d[CN_OK]!.original).toBe(INV)
    expect(d[CN_BAD]!.original).toBeNull()
    expect(d[CN_HAS]!.original).toBe(INV)
    expect(d[INV]!.original).toBeNull()
  })

  it("stamps import_file_id with the earliest invoicing system-uploaded file of the same org and name", async () => {
    await doc(IMP_A, ORG_A, { import_source: "batch-1.pdf" })
    await doc(IMP_B, ORG_B, { import_source: "batch-1.pdf" })
    await doc(IMP_NONE, ORG_A, { import_source: "missing.pdf" })
    await file(F_LATE, ORG_A, "batch-1.pdf", "2026-03-02T00:00:00Z")
    await file(F_EARLY, ORG_A, "batch-1.pdf", "2026-03-01T00:00:00Z")
    await file(F_ORGB, ORG_B, "batch-1.pdf", "2026-03-05T00:00:00Z")
    await file(
      "00000000-0000-0000-0000-00000000f006",
      ORG_A,
      "batch-1.pdf",
      "2026-02-01T00:00:00Z",
      {
        uploadedBy: "00000000-0000-0000-0000-0000000000c1",
      },
    )
    await file(F_OTHERAPP, ORG_A, "batch-1.pdf", "2026-01-01T00:00:00Z", { app: "mail" })
    await apply()
    const d = await docs()
    expect(d[IMP_A]!.refs.import_file_id).toBe(F_EARLY)
    expect(d[IMP_B]!.refs.import_file_id).toBe(F_ORGB)
    expect(d[IMP_NONE]!.refs.import_file_id).toBeUndefined()
    expect(d[IMP_A]!.refs.import_source).toBe("batch-1.pdf")
  })

  it("does not overwrite an import_file_id already stamped", async () => {
    await doc(IMP_A, ORG_A, { import_source: "batch-1.pdf", import_file_id: F_LATE })
    await file(F_EARLY, ORG_A, "batch-1.pdf", "2026-03-01T00:00:00Z")
    await apply()
    expect((await docs())[IMP_A]!.refs.import_file_id).toBe(F_LATE)
  })

  it("adds the column once and a second run changes nothing", async () => {
    await doc(INV, ORG_A, {})
    await doc(CN_OK, ORG_A, { original_document_id: INV })
    await doc(IMP_A, ORG_A, { import_source: "batch-1.pdf" })
    await file(F_EARLY, ORG_A, "batch-1.pdf", "2026-03-01T00:00:00Z")
    await apply()
    const first = await docs()
    await apply()
    expect(await docs()).toEqual(first)
    const cols = await sql.unsafe(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = '${SCRATCH}' AND table_name = 'documents' AND column_name = 'original_document_id'`,
    )
    expect(cols.map((c) => c.data_type)).toEqual(["uuid"])
  })

  it("is a no-op when the invoicing schema was never created", async () => {
    await doc(CN_OK, ORG_A, { original_document_id: INV })
    await apply("mig0139_absent_schema")
    const cols = await sql.unsafe(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = '${SCRATCH}' AND table_name = 'documents' AND column_name = 'original_document_id'`,
    )
    expect(cols).toHaveLength(0)
    const [row] = await sql.unsafe<{ external_refs: Record<string, unknown> }[]>(
      `SELECT external_refs FROM ${SCRATCH}.documents WHERE id = '${CN_OK}'`,
    )
    expect(row!.external_refs).toEqual({ original_document_id: INV })
  })
})
