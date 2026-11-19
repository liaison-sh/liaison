// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0344 gives a document with no company its contact's own company; only an invoice or credit
// note whose contact has none takes the company of the schedule whose month-end row points at it,
// else of the project it bills. A source company never stands in for a contact's different
// company, a purchase order never takes one, and a document that already names a company is left
// alone. The live tables come from the app manifests, so the file is
// replayed against SCRATCH copies in their own schemas: the statements are the file's own, only
// the schema names are swapped (0113's recipe).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0344_invoicing_documents_company_backfill.sql", import.meta.url).pathname
const INV = "mig0344_invoicing"
const PROJ = "mig0344_projects"
const KERN = "mig0344_kernel"

const ORG = "00000000-0000-4000-8000-0000000000a1"
const COMPANY_S = "00000000-0000-4000-8000-0000000000c1"
const COMPANY_P = "00000000-0000-4000-8000-0000000000c2"
const COMPANY_KEPT = "00000000-0000-4000-8000-0000000000c3"
const SCHEDULE = "00000000-0000-4000-8000-0000000000e1"
const PROJECT = "00000000-0000-4000-8000-0000000000f1"
const LONE_PROJECT = "00000000-0000-4000-8000-0000000000f2"
const DOC_RUN = "00000000-0000-4000-8000-0000000000d1"
const DOC_PROJECT = "00000000-0000-4000-8000-0000000000d2"
const DOC_KEPT = "00000000-0000-4000-8000-0000000000d3"
const DOC_PLAIN = "00000000-0000-4000-8000-0000000000d4"
const DOC_LONE = "00000000-0000-4000-8000-0000000000d5"
const COMPANY_B = "00000000-0000-4000-8000-0000000000c4"
const CONTACT_B = "00000000-0000-4000-8000-0000000000b1"
const CONTACT_NONE = "00000000-0000-4000-8000-0000000000b2"
const CONTACT_GONE = "00000000-0000-4000-8000-0000000000b3"
const DOC_RUN_OTHER = "00000000-0000-4000-8000-0000000000d6"
const DOC_PROJECT_OTHER = "00000000-0000-4000-8000-0000000000d7"
const DOC_RUN_NO_COMPANY = "00000000-0000-4000-8000-0000000000d8"
const DOC_PO = "00000000-0000-4000-8000-0000000000d9"
const DOC_UNKNOWN_CONTACT = "00000000-0000-4000-8000-0000000000da"
const DOC_QUOTE = "00000000-0000-4000-8000-0000000000db"

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

async function applyMigration(): Promise<void> {
  const text = readFileSync(FILE, "utf8")
    .replaceAll("app_invoicing", INV)
    .replaceAll("app_projects", PROJ)
    .replaceAll("'kernel'", `'${KERN}'`)
    .replaceAll("kernel.contacts", `${KERN}.contacts`)
  for (const statement of text.split("--> statement-breakpoint")) {
    if (statement.trim() !== "") await sql.unsafe(statement)
  }
}

async function companies(): Promise<Record<string, string | null>> {
  const rows = await sql.unsafe<{ id: string; company_id: string | null }[]>(
    `SELECT id::text, company_id::text FROM ${INV}.documents`,
  )
  return Object.fromEntries(rows.map((r) => [r.id, r.company_id]))
}

describe("0344 invoicing documents company backfill", () => {
  beforeAll(async () => {
    for (const s of [INV, PROJ, KERN]) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${s} CASCADE`)
      await sql.unsafe(`CREATE SCHEMA ${s}`)
    }
    await sql.unsafe(`CREATE TABLE ${INV}.documents (
      id uuid PRIMARY KEY, org_id uuid NOT NULL, type text NOT NULL, company_id uuid,
      billing_project_id uuid, counterparty_contact_id uuid)`)
    await sql.unsafe(`CREATE TABLE ${KERN}.contacts (
      id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid)`)
    await sql.unsafe(`INSERT INTO ${KERN}.contacts VALUES
      ('${CONTACT_B}', '${ORG}', '${COMPANY_B}'), ('${CONTACT_NONE}', '${ORG}', NULL)`)
    await sql.unsafe(`CREATE TABLE ${INV}.recurring_schedules (
      id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid)`)
    await sql.unsafe(`CREATE TABLE ${INV}.recurring_run_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,
      schedule_id uuid, document_id uuid)`)
    await sql.unsafe(`CREATE TABLE ${PROJ}.projects (
      id uuid PRIMARY KEY, org_id uuid NOT NULL, company_id uuid)`)
    await sql.unsafe(`INSERT INTO ${INV}.recurring_schedules VALUES
      ('${SCHEDULE}', '${ORG}', '${COMPANY_S}')`)
    await sql.unsafe(`INSERT INTO ${PROJ}.projects VALUES
      ('${PROJECT}', '${ORG}', '${COMPANY_P}'), ('${LONE_PROJECT}', '${ORG}', NULL)`)
    await sql.unsafe(`INSERT INTO ${INV}.documents VALUES
      ('${DOC_RUN}', '${ORG}', 'invoice', NULL, NULL, NULL),
      ('${DOC_PROJECT}', '${ORG}', 'invoice', NULL, '${PROJECT}', '${CONTACT_NONE}'),
      ('${DOC_KEPT}', '${ORG}', 'invoice', '${COMPANY_KEPT}', '${PROJECT}', '${CONTACT_B}'),
      ('${DOC_PLAIN}', '${ORG}', 'invoice', NULL, NULL, NULL),
      ('${DOC_LONE}', '${ORG}', 'invoice', NULL, '${LONE_PROJECT}', NULL),
      ('${DOC_RUN_OTHER}', '${ORG}', 'invoice', NULL, '${PROJECT}', '${CONTACT_B}'),
      ('${DOC_PROJECT_OTHER}', '${ORG}', 'credit_note', NULL, '${PROJECT}', '${CONTACT_B}'),
      ('${DOC_RUN_NO_COMPANY}', '${ORG}', 'invoice', NULL, NULL, '${CONTACT_NONE}'),
      ('${DOC_PO}', '${ORG}', 'purchase_order', NULL, '${PROJECT}', '${CONTACT_NONE}'),
      ('${DOC_UNKNOWN_CONTACT}', '${ORG}', 'invoice', NULL, '${PROJECT}', '${CONTACT_GONE}'),
      ('${DOC_QUOTE}', '${ORG}', 'quote', NULL, '${PROJECT}', NULL)`)
    await sql.unsafe(`INSERT INTO ${INV}.recurring_run_items (org_id, schedule_id, document_id)
      VALUES ('${ORG}', '${SCHEDULE}', '${DOC_RUN}'), ('${ORG}', '${SCHEDULE}', '${DOC_RUN_OTHER}'),
        ('${ORG}', '${SCHEDULE}', '${DOC_RUN_NO_COMPANY}')`)
  })

  afterAll(async () => {
    for (const s of [INV, PROJ, KERN]) await sql.unsafe(`DROP SCHEMA IF EXISTS ${s} CASCADE`)
    await sql.end()
  })

  it("fills the contact's company first, a source company only where the contact has none, and only where it is missing", async () => {
    await applyMigration()
    expect(await companies()).toEqual({
      [DOC_RUN]: COMPANY_S,
      [DOC_PROJECT]: COMPANY_P,
      [DOC_KEPT]: COMPANY_KEPT,
      [DOC_PLAIN]: null,
      [DOC_LONE]: null,
      // Made out to a contact of company B: B, never the schedule's or the project's company.
      [DOC_RUN_OTHER]: COMPANY_B,
      [DOC_PROJECT_OTHER]: COMPANY_B,
      [DOC_RUN_NO_COMPANY]: COMPANY_S,
      // A supplier's purchase order and a quote never take a client company from a source.
      [DOC_PO]: null,
      [DOC_QUOTE]: null,
      // A contact no longer on file: its company is unknown, so no source company is guessed.
      [DOC_UNKNOWN_CONTACT]: null,
    })
    // Re-runnable: a second pass changes nothing.
    await applyMigration()
    expect((await companies())[DOC_RUN]).toBe(COMPANY_S)
  })
})
