// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison invoicing import` — bulk-import historical accounting documents
 * (a Sufio/Shopify-era export) into the invoicing app WITH their original
 * numbers, dates, totals, and the ORIGINAL PDF attached as the document's
 * legal artifact (imported documents are historical records — re-rendering
 * them would fabricate a different document than the one legally issued).
 *
 * Input: a JSON manifest (array of parsed documents — see ImportDoc) + the
 * directory holding the source PDFs. This client maps each entry to the
 * `invoicing.document` import kind's canonical record (amounts to minor
 * units, VAT labels to basis points, an approximate tax treatment), stages
 * its PDF as an upload, and writes through one import run (modules/imports,
 * undoable from Settings). Idempotent on the source filename: an entry this
 * tool imported before, now or with its earlier version, is skipped. One bad
 * document fails alone and is reported in `failed[]`.
 *
 * Sequence safety: the run raises each (issuer, type, year) numbering
 * sequence to at least the max imported number_int, so a future issuance can
 * never re-allocate an imported number.
 *
 * I/O discipline: machine-readable JSON report on STDOUT, human progress on
 * STDERR (same as `config apply` / `tickets import`).
 */
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { putObject as defaultPutObject, deleteObjects } from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import { buildStorageKey } from "~/modules/files/service"
import { runImport } from "~/modules/imports/runner"

export function pdfPathFor(pdfDir: string, sourceFile: string): string {
  const root = resolve(pdfDir)
  const p = resolve(root, sourceFile)
  const rel = relative(root, p)
  if (sourceFile.includes("\u0000") || rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("source_file must name a file inside the PDF directory")
  }
  return p
}

const log = rootLogger.child({ module: "cli-invoicing-import" })

function invRel(name: string): ReturnType<typeof drizzleSql.raw> {
  return drizzleSql.raw(`${schemaRef("app_invoicing")}.${name}`)
}
function kernelRel(name: string): ReturnType<typeof drizzleSql.raw> {
  return drizzleSql.raw(`${schemaRef("kernel")}.${name}`)
}

const importLineSchema = z.object({
  item: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  quantity: z.string().nullable().optional(),
  unit_price: z.string().nullable().optional(),
  discount: z.string().nullable().optional(),
  vat_rate: z.string().nullable().optional(),
  total: z.string().nullable().optional(),
})

const importDocSchema = z.object({
  source_file: z.string().min(1),
  doc_type: z.enum(["invoice", "credit_note", "proforma"]),
  number_raw: z.string().min(1),
  number_int: z.number().int().nullable(),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  delivery_date: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  currency: z.string().min(3).max(3),
  counterparty: z.object({
    name: z.string().nullable(),
    company: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    country: z.string().nullable(),
    vat_id: z.string().nullable().optional(),
  }),
  lines: z.array(importLineSchema),
  shipping: z.string().nullable().optional(),
  vat_amount: z.string().nullable().optional(),
  vat_rate_label: z.string().nullable().optional(),
  vat_inclusive: z.boolean().optional(),
  subtotal: z.string().nullable().optional(),
  document_discount: z.string().nullable().optional(),
  document_discount_label: z.string().nullable().optional(),
  total: z.string().nullable(),
  amount_paid: z.string().nullable().optional(),
  amount_due: z.string().nullable().optional(),
  order_number: z.string().nullable().optional(),
  po_number: z.string().nullable().optional(),
  original_invoice_ref: z.string().nullable().optional(),
  validated: z.boolean(),
  validation_notes: z.array(z.string()).optional(),
  soft_notes: z.array(z.string()).optional(),
})
export type ImportDoc = z.infer<typeof importDocSchema>

/** "1,234.56" / "-€5,900.00"-cleaned decimal string → integer minor units (×100). */
export function toMinor(amount: string | null | undefined): bigint {
  if (!amount) return 0n
  const cleaned = amount.replace(/[,\s]/g, "")
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned)
  if (!m) throw new Error(`unparseable amount: ${amount}`)
  const sign = m[1] === "-" ? -1n : 1n
  const units = BigInt(m[2])
  const cents = BigInt((m[3] ?? "").padEnd(2, "0") || "0")
  return sign * (units * 100n + cents)
}

/** "20%" / "25.5%" → basis points (2000 / 2550). */
export function rateToBp(label: string | null | undefined): number {
  if (!label) return 0
  const m = /([\d.]+)\s*%/.exec(label)
  if (!m) return 0
  return Math.round(Number.parseFloat(m[1]) * 100)
}

/** Tax treatment approximation for imported historical docs — same country
 *  buckets the issue-time classifier uses; informational only (totals are
 *  imported verbatim, never recomputed). */
const EU = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
])
export function approximateTreatment(country: string | null, hasVat: boolean): string {
  if (!country) return "export"
  if (country === "FR") return "fr_domestic"
  if (EU.has(country)) return hasVat ? "eu_reverse_charge" : "eu_destination"
  return "export"
}

export interface InvoicingImportResult {
  exitCode: number
  report: {
    ok: boolean
    imported: number
    skippedDuplicates: number
    skippedUnvalidated: string[]
    failed: Array<{ source_file: string; error: string }>
    sequencesRaised: Record<string, number>
    totalsByTypeCurrency: Record<string, string>
  }
}

/** The import runs' source label: refs `file:<source_file>`, lifecycle `import:file`. */
const SOURCE_LABEL = "file"

/** One manifest entry as the `invoicing.document` kind's canonical record. */
export function toCanonicalRecord(
  doc: ImportDoc,
  opts: { issuerProfileId: string; pdfFileId: string; originalNumber?: string | null },
): Record<string, unknown> {
  const cp = doc.counterparty
  // Lines: one per parsed line (+ shipping and a document discount). The
  // per-line tax split is not reconstructed: the document-level VAT total
  // carries the tax truthfully.
  const lines: Array<Record<string, unknown>> = doc.lines.map((l) => ({
    description: [l.item, l.description].filter((s) => s?.trim()).join(" — ") || "Item",
    quantity: l.quantity ?? "1",
    unitPriceMinor: toMinor(l.unit_price).toString(),
    taxRateBp: rateToBp(l.vat_rate ?? doc.vat_rate_label),
    totalMinor: toMinor(l.total).toString(),
  }))
  const shippingMinor = toMinor(doc.shipping)
  if (shippingMinor !== 0n) {
    lines.push({
      description: "Shipping",
      quantity: "1",
      unitPriceMinor: shippingMinor.toString(),
      taxRateBp: 0,
      totalMinor: shippingMinor.toString(),
    })
  }
  const discountMinor = toMinor(doc.document_discount)
  if (discountMinor !== 0n) {
    lines.push({
      description: doc.document_discount_label ?? "Discount",
      quantity: "1",
      unitPriceMinor: discountMinor.toString(),
      taxRateBp: 0,
      totalMinor: discountMinor.toString(),
    })
  }
  const totalMinor = toMinor(doc.total)
  const vatMinor = toMinor(doc.vat_amount)
  const paidMinor = toMinor(doc.amount_paid)
  const dueMinor = toMinor(doc.amount_due)
  // Paid only when the export says nothing is due and the whole total was paid.
  const paid = doc.doc_type === "invoice" && dueMinor === 0n && paidMinor === totalMinor
  return {
    externalRef: doc.source_file,
    type: doc.doc_type,
    number: doc.number_raw,
    ...(doc.number_int != null ? { numberInt: doc.number_int } : {}),
    issueDate: doc.issue_date,
    ...(doc.due_date ? { dueDate: doc.due_date } : {}),
    ...(doc.delivery_date ? { deliveryDate: doc.delivery_date } : {}),
    currency: doc.currency,
    counterparty: {
      ...(cp.name ? { name: cp.name } : {}),
      ...(cp.company ? { company: cp.company } : {}),
      ...(cp.address ? { address: cp.address } : {}),
      ...(cp.country ? { country: cp.country } : {}),
      ...(cp.vat_id ? { vatId: cp.vat_id } : {}),
    },
    lines,
    subtotalMinor: (totalMinor - vatMinor).toString(),
    taxTotalMinor: vatMinor.toString(),
    grandTotalMinor: totalMinor.toString(),
    amountPaidMinor: (paid ? totalMinor : 0n).toString(),
    taxTreatment: approximateTreatment(cp.country, !!cp.vat_id),
    ...(doc.order_number ? { orderNumber: doc.order_number } : {}),
    ...(doc.po_number ? { poNumber: doc.po_number } : {}),
    ...(doc.soft_notes?.length ? { notes: doc.soft_notes.join("\n") } : {}),
    ...(opts.originalNumber ? { originalNumber: opts.originalNumber } : {}),
    issuerProfileId: opts.issuerProfileId,
    pdf: { fileId: opts.pdfFileId },
  }
}

export async function runInvoicingImport(opts: {
  manifestPath: string
  pdfDir: string
  orgSlug?: string
  dryRun?: boolean
  putObject?: typeof defaultPutObject
}): Promise<InvoicingImportResult> {
  const putObject = opts.putObject ?? defaultPutObject
  const err = (s: string) => process.stderr.write(`${s}\n`)

  const resolved = await resolveOrgId(
    opts.orgSlug,
    "multiple orgs exist — pass --org <slug> to choose the import target",
  )
  if (!resolved.ok) throw new Error(resolved.message)
  const orgId = resolved.orgId
  const raw = JSON.parse(await readFile(opts.manifestPath, "utf8")) as unknown[]

  // Resolve the issuer profile (single-issuer orgs: take the only one).
  const issuers = extractRows<{ id: string }>(
    await withPrivilegedDb(orgId, "cli-invoicing-import-issuer", (tx) =>
      tx.execute(drizzleSql`
        SELECT id FROM ${invRel("issuer_profiles")}
        WHERE org_id = ${orgId}::uuid ORDER BY created_at ASC LIMIT 2
      `),
    ),
  )
  if (issuers.length === 0) throw new Error("no issuer profile — run `liaison config apply` first")
  if (issuers.length > 1) err("warning: multiple issuer profiles; importing under the oldest")
  const issuerId = (issuers[0] as { id: string }).id

  const report: InvoicingImportResult["report"] = {
    ok: true,
    imported: 0,
    skippedDuplicates: 0,
    skippedUnvalidated: [],
    failed: [],
    sequencesRaised: {},
    totalsByTypeCurrency: {},
  }

  const docs: ImportDoc[] = []
  for (const [i, entry] of raw.entries()) {
    const parsed = importDocSchema.safeParse(entry)
    if (!parsed.success) {
      report.failed.push({
        source_file: (entry as { source_file?: string })?.source_file ?? `#${i}`,
        error: `manifest schema: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      })
      continue
    }
    docs.push(parsed.data)
  }
  // Invoices first so credit notes can link their originals in one run.
  const typeOrder: Record<ImportDoc["doc_type"], number> = {
    invoice: 0,
    proforma: 1,
    credit_note: 2,
  }
  docs.sort((a, b) => typeOrder[a.doc_type] - typeOrder[b.doc_type])

  // Already imported, by this tool now (its external ref) or before (the
  // source filename it recorded): skipped without a record.
  const imported = new Set(
    extractRows<{ ref: string }>(
      await withPrivilegedDb(orgId, "cli-invoicing-import-dup", (tx) =>
        tx.execute(drizzleSql`
          SELECT external_refs->>'import_source' AS ref FROM ${invRel("documents")}
          WHERE org_id = ${orgId}::uuid AND external_refs->>'import_source' IS NOT NULL
          UNION
          SELECT substr(external_ref, ${SOURCE_LABEL.length + 2}) AS ref FROM ${invRel("documents")}
          WHERE org_id = ${orgId}::uuid AND external_ref LIKE ${`${SOURCE_LABEL}:%`}
        `),
      ),
    ).map((r) => r.ref),
  )
  // The invoice numbers a credit note may name: in this manifest or already
  // imported. "2677-2" names invoice "2677-2", else its base "2677".
  const invoiceNumbers = new Set([
    ...docs.filter((d) => d.doc_type === "invoice").map((d) => d.number_raw),
    ...extractRows<{ number: string }>(
      await withPrivilegedDb(orgId, "cli-invoicing-import-numbers", (tx) =>
        tx.execute(drizzleSql`
          SELECT number FROM ${invRel("documents")}
          WHERE org_id = ${orgId}::uuid AND type = 'invoice' AND number IS NOT NULL
        `),
      ),
    ).map((r) => r.number),
  ])
  const originalNumberOf = (ref: string | null | undefined): string | null => {
    if (!ref) return null
    if (invoiceNumbers.has(ref)) return ref
    const base = ref.split("-")[0] ?? ref
    return invoiceNumbers.has(base) ? base : ref
  }

  const toImport: ImportDoc[] = []
  for (const doc of docs) {
    if (!doc.validated) {
      report.skippedUnvalidated.push(doc.source_file)
      continue
    }
    if (imported.has(doc.source_file)) {
      report.skippedDuplicates += 1
      continue
    }
    toImport.push(doc)
  }
  if (opts.dryRun) {
    report.imported = toImport.length
    report.ok = report.failed.length === 0
    return { exitCode: report.ok ? 0 : 1, report }
  }

  // The person the run is attributed to: the org's first active user.
  const actorUserId = extractRows<{ id: string }>(
    await withPrivilegedDb(orgId, "cli-invoicing-import-actor", (tx) =>
      tx.execute(drizzleSql`
        SELECT id::text AS id FROM ${kernelRel("users")}
        WHERE org_id = ${orgId}::uuid AND status = 'active'
        ORDER BY created_at ASC, id ASC LIMIT 1
      `),
    ),
  )[0]?.id
  if (!actorUserId) throw new Error("the org has no active user to run the import as")
  const actor: UserContext = {
    actorType: "user",
    userId: actorUserId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }

  // Each PDF is staged as an upload of that person (an upload session they
  // own): the run copies it onto its document, then the staged copy goes.
  const staged: Array<{ id: string; storageKey: string }> = []
  const sessionId = randomUUID()
  await withPrivilegedDb(orgId, "cli-invoicing-import-session", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${kernelRel("file_upload_sessions")} (id, org_id, created_by, target_app, target_entity_type)
      VALUES (${sessionId}::uuid, ${orgId}::uuid, ${actorUserId}::uuid, 'kernel', 'import_upload')
    `),
  )
  const byRef = new Map(toImport.map((d) => [d.source_file, d]))
  const created: ImportDoc[] = []
  try {
    const records: Array<{ line: number; record: Record<string, unknown> }> = []
    for (const [i, doc] of toImport.entries()) {
      try {
        // The PDF is read from `<pdf dir>/<source_file>`: an entry must name a
        // file inside the PDF dir, never an absolute or `../` path.
        const pdfPath = pdfPathFor(opts.pdfDir, doc.source_file)
        const bytes = await readFile(pdfPath)
        const fileId = randomUUID()
        const storageKey = buildStorageKey({
          orgId,
          app: "kernel",
          entityType: "file_upload_session",
          entityId: sessionId,
          filename: doc.source_file,
        })
        await putObject({ key: storageKey, body: bytes, contentType: "application/pdf" })
        await withPrivilegedDb(orgId, "cli-invoicing-import-stage", (tx) =>
          tx.execute(drizzleSql`
            INSERT INTO ${kernelRel("files")}
              (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
               storage_key, uploaded_by)
            VALUES (${fileId}::uuid, ${orgId}::uuid, 'kernel', 'file_upload_session', ${sessionId},
                    ${doc.source_file}, 'application/pdf', ${bytes.byteLength}, ${storageKey},
                    ${actorUserId}::uuid)
          `),
        )
        staged.push({ id: fileId, storageKey })
        records.push({
          line: i + 1,
          record: toCanonicalRecord(doc, {
            issuerProfileId: issuerId,
            pdfFileId: fileId,
            originalNumber:
              doc.doc_type === "credit_note" ? originalNumberOf(doc.original_invoice_ref) : null,
          }),
        })
      } catch (e) {
        report.failed.push({ source_file: doc.source_file, error: (e as Error).message })
      }
    }

    if (records.length > 0) {
      await runImport({
        orgId,
        actor,
        kinds: ["invoicing.document"],
        source: { type: "records", records },
        sourceLabel: SOURCE_LABEL,
        mode: "cli",
        onRecord: (e) => {
          const doc = byRef.get(e.dedupKey)
          if (e.status === "created") {
            report.imported += 1
            if (doc) {
              created.push(doc)
              err(`imported ${doc.doc_type} ${doc.number_raw} (${doc.source_file})`)
            }
          } else if (e.status === "skipped") {
            report.skippedDuplicates += 1
          } else {
            report.failed.push({ source_file: e.dedupKey, error: e.error ?? "import failed" })
            log.error(
              { source_file: e.dedupKey, error: e.error },
              "invoicing import: document failed",
            )
          }
        },
      })
    }
  } finally {
    // The staged uploads: the run made its own copies.
    if (staged.length > 0) {
      await withPrivilegedDb(orgId, "cli-invoicing-import-unstage", async (tx) => {
        await tx.execute(drizzleSql`
          DELETE FROM ${kernelRel("files")}
          WHERE org_id = ${orgId}::uuid AND entity_type = 'file_upload_session' AND entity_id = ${sessionId}
        `)
        await tx.execute(drizzleSql`
          DELETE FROM ${kernelRel("file_upload_sessions")}
          WHERE org_id = ${orgId}::uuid AND id = ${sessionId}::uuid
        `)
      })
      await deleteObjects(staged.map((s) => s.storageKey)).catch((e) =>
        log.warn({ err: e, orgId }, "invoicing import: staged PDFs could not be removed"),
      )
    } else {
      await withPrivilegedDb(orgId, "cli-invoicing-import-unstage", (tx) =>
        tx.execute(drizzleSql`
          DELETE FROM ${kernelRel("file_upload_sessions")}
          WHERE org_id = ${orgId}::uuid AND id = ${sessionId}::uuid
        `),
      )
    }
  }

  // The sequences the run raised (to at least the highest imported number).
  const maxNumberInt = new Map<string, number>()
  const totals = new Map<string, bigint>()
  for (const doc of created) {
    if (doc.number_int != null) {
      const key = `invoicing:doc_number:${issuerId}:${doc.doc_type}:${doc.issue_date.slice(0, 4)}`
      maxNumberInt.set(key, Math.max(maxNumberInt.get(key) ?? 0, doc.number_int))
    }
    const tk = `${doc.doc_type}:${doc.currency}`
    totals.set(tk, (totals.get(tk) ?? 0n) + toMinor(doc.total))
  }
  for (const [key, n] of maxNumberInt) report.sequencesRaised[key] = n
  for (const [k, v] of totals) {
    const sign = v < 0n ? "-" : ""
    const abs = v < 0n ? -v : v
    report.totalsByTypeCurrency[k] =
      `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`
  }
  report.ok = report.failed.length === 0
  return { exitCode: report.ok ? 0 : 1, report }
}
