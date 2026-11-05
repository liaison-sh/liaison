// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Import kind `invoicing.document` (manifest `import.kinds.document`): the
// bundle export the import runner calls in the sandbox with records it has
// validated against the kind's schema. A record is one historical invoice,
// credit note or proforma, vendor-neutral: amounts in minor units, dates as
// YYYY-MM-DD, the original PDF as an uploaded file (`pdf.fileId`). Turning a
// vendor's export ("€1,234.56", its own VAT labels) into this shape is the
// client's or the transform's job.
//
// Per record:
//  - the issuer is the record's `issuerProfileId`, else the org's only
//    profile (none: `issuer_missing`; several and none named: `issuer_ambiguous`);
//  - dedup on `external_ref` (`<source>:<key>`); a number the issuer already
//    used for that type and year is skipped (the numbering unique index);
//  - a credit note links `original_document_id` to the document an earlier
//    record or run imported with `originalExternalRef` (originals first), or
//    else to the issuer's invoice numbered `originalNumber`;
//  - the document is written issued (paid when fully paid) with its lines, a
//    lifecycle sourced `import:<source>`, and `pdf_status = ready`;
//  - the host attaches the PDF (result `attachments`, the `pdf` file parent)
//    and raises the (issuer, type, year) numbering sequence to the imported
//    number (result `sequenceFloors`, never lowered), so a later issue can
//    never reuse it.
// No legal original is recorded: once the import is checked, the
// `einvoicing_backfill_legacy_originals` tool records them from the PDFs.
// Imports only create; an existing document is never touched.

import type { DbClient } from "@liaison/app-sdk"

export interface ImportBatch {
  runId: string
  kind: string
  sourceLabel: string
  records: Array<{ record: Record<string, unknown>; dedupValue: string }>
  /** The claims earlier batches of the run made (the host keeps them for the run). */
  claimed?: string[]
}

export interface ImportResult {
  status: "created" | "skipped" | "failed"
  rows: Array<{ table: string; id: string }>
  attachments?: Array<{ fileId: string; parent: string; rowId: string; ref?: string }>
  sequenceFloors?: Array<{ key: string; value: number }>
  /** The numbers this record holds for the rest of the run (`claimed` of later batches). */
  claims?: string[]
  error?: string
}

export interface ImportCtx {
  db: Pick<DbClient, "findMany" | "insert">
}

type Row = Record<string, unknown>

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

function minor(v: unknown, field: string): string {
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v)
  if (typeof v === "string" && /^-?\d+$/.test(v)) return v
  throw new Error(`${field} must be an integer amount in minor units`)
}

function day(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error(`${field} must be a YYYY-MM-DD date`)
  }
  return v
}

async function issuerFor(ctx: ImportCtx, record: Row, cache: Map<string, string[]>): Promise<string> {
  const named = str(record.issuerProfileId)
  if (named) {
    const found = (await ctx.db.findMany("issuer_profiles", { where: { id: named }, limit: 1 })) as Row[]
    if (found.length === 0) throw new Error(`issuer_not_found: ${named}`)
    return named
  }
  let all = cache.get("issuers")
  if (!all) {
    const rows = (await ctx.db.findMany("issuer_profiles", {
      where: { archived_at: null },
      limit: 2,
    })) as Row[]
    all = rows.map((r) => String(r.id))
    cache.set("issuers", all)
  }
  if (all.length === 0) {
    // The issuer's legal identity is printed on every document: it comes from
    // the person, never from the model (a made-up SIREN can be a real company's).
    throw new Error(
      "issuer_missing: the org has no issuer profile yet. Ask the person for their company's legal name, address and legal identifiers (SIREN or SIRET, VAT number), or for a document that shows them; never make them up. Create the profile with what they give, then name it with issuerProfileId",
    )
  }
  if (all.length !== 1) {
    throw new Error(
      "issuer_ambiguous: the org has several active issuer profiles; name one with issuerProfileId",
    )
  }
  return all[0] as string
}

export async function importDocuments(batch: ImportBatch, ctx: ImportCtx): Promise<ImportResult[]> {
  const out: ImportResult[] = []
  const prepare = documentPreparer(batch, ctx)
  for (const { record, dedupValue } of batch.records) {
    try {
      const prepared = await prepare(record, dedupValue)
      if (prepared === "skipped") {
        out.push({ status: "skipped", rows: [] })
        continue
      }
      const result = await prepared.write()
      // A number is held only by a document the run created.
      if (result.status === "created") {
        prepared.claim()
        result.claims = prepared.claims
      }
      out.push(result)
    } catch (err) {
      out.push({ status: "failed", rows: [], error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

/** One record's result in a preview: what the run would do, nothing written. */
export interface CheckResult {
  status: "created" | "skipped" | "failed"
  claims?: string[]
  error?: string
}

/**
 * The preview's check (manifest `import.kinds.document.check`): every check
 * the run makes before its first insert (issuer, dates, amounts, numbers,
 * dedup), through the run's own path, without writing. A record the run would
 * refuse (`issuer_missing` on an org without an issuer profile) is refused
 * here too.
 */
export async function checkDocuments(batch: ImportBatch, ctx: ImportCtx): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  const prepare = documentPreparer(batch, ctx)
  for (const { record, dedupValue } of batch.records) {
    try {
      const prepared = await prepare(record, dedupValue)
      if (prepared === "skipped") {
        out.push({ status: "skipped" })
        continue
      }
      // Passed every check: its numbers are held for the rest of the preview.
      prepared.claim()
      out.push({ status: "created", claims: prepared.claims })
    } catch (err) {
      out.push({ status: "failed", error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

/**
 * Checks and converts one record (throws its refusal), and returns the write
 * that creates it, or "skipped" when the document is already there. The run
 * and the preview share it, so a preview refuses what the run would.
 */
function documentPreparer(
  batch: ImportBatch,
  ctx: ImportCtx,
): (record: Row, dedupValue: string) => Promise<"skipped" | PreparedDocument> {
  const cache = new Map<string, string[]>()
  // The numbers earlier records of this run hold (earlier batches through the
  // host's `claimed`, this batch's as they pass): a preview writes nothing, so
  // two records with one number are refused here, in the preview and the run alike.
  const claimed = new Set<string>(batch.claimed ?? [])
  const source = batch.sourceLabel
  return async (record, dedupValue) => {
    const existing = (await ctx.db.findMany("documents", {
      where: { external_ref: dedupValue },
      limit: 1,
    })) as Row[]
    if (existing.length > 0) return "skipped"

    // Everything is checked and converted before the first insert, so a bad
    // value never leaves half a document behind.
    const type = str(record.type)
    if (type !== "invoice" && type !== "credit_note" && type !== "proforma") {
      throw new Error("type must be invoice, credit_note or proforma")
    }
    const issuerId = await issuerFor(ctx, record, cache)
    const issueDate = day(record.issueDate, "issueDate")
    const dueDate = record.dueDate ? day(record.dueDate, "dueDate") : null
    const deliveryDate = record.deliveryDate ? day(record.deliveryDate, "deliveryDate") : null
    const year = Number(issueDate.slice(0, 4))
    const number = str(record.number)
    const numberInt =
      typeof record.numberInt === "number" && Number.isSafeInteger(record.numberInt)
        ? record.numberInt
        : null
    if (number && numberInt !== null) {
      const runs = (number.match(/\d+/g) ?? []).map((d) => Number(d))
      if (!runs.includes(numberInt)) {
        throw new Error(`number_mismatch: number ${number} does not carry numberInt ${numberInt}`)
      }
    }
    const pdf = (record.pdf ?? {}) as Row
    const pdfFileId = str(pdf.fileId)
    if (!pdfFileId) throw new Error("pdf.fileId is required (the original document)")

    const grand = minor(record.grandTotalMinor, "grandTotalMinor")
    const tax = minor(record.taxTotalMinor, "taxTotalMinor")
    const subtotal =
      record.subtotalMinor !== undefined
        ? minor(record.subtotalMinor, "subtotalMinor")
        : String(BigInt(grand) - BigInt(tax))
    const paidAmount =
      record.amountPaidMinor !== undefined && record.amountPaidMinor !== null
        ? minor(record.amountPaidMinor, "amountPaidMinor")
        : "0"
    const isPaid = type === "invoice" && BigInt(paidAmount) === BigInt(grand) && BigInt(grand) !== 0n
    // The status follows the payment: a stated status must agree with it.
    const stated = str(record.status)
    if (stated !== null && (stated === "paid") !== isPaid) {
      throw new Error(
        `status_mismatch: status ${stated} but ${isPaid ? "fully paid" : "not fully paid"} (amountPaidMinor ${paidAmount} of ${grand})`,
      )
    }
    const status = isPaid ? "paid" : (stated ?? "issued")
    const paymentStatus = isPaid ? "paid" : "unpaid"

    const lineInput = Array.isArray(record.lines) ? (record.lines as Row[]) : []
    const lines = lineInput.map((l, i) => {
      const total = minor(l.totalMinor, `lines[${i}].totalMinor`)
      return {
        position: i + 1,
        description: str(l.description) ?? "Item",
        quantity: String(l.quantity ?? "1"),
        unit_price_minor: minor(l.unitPriceMinor, `lines[${i}].unitPriceMinor`),
        tax_rate_bp: typeof l.taxRateBp === "number" ? Math.round(l.taxRateBp) : 0,
        subtotal_minor: total,
        tax_minor: "0",
        total_minor: total,
      }
    })

    // A number the issuer already used, by its integer or by its legal string.
    if (numberInt !== null) {
      const taken = (await ctx.db.findMany("documents", {
        where: { issuer_profile_id: issuerId, type, year_of_issue: year, number_int: numberInt },
        limit: 1,
      })) as Row[]
      if (taken.length > 0) {
        throw new Error(`numberTaken: ${type} ${numberInt} of ${year} is already used by this issuer`)
      }
    }
    if (number) {
      const taken = (await ctx.db.findMany("documents", {
        where: { issuer_profile_id: issuerId, number },
        limit: 1,
      })) as Row[]
      if (taken.length > 0) throw new Error(`numberTaken: ${number} is already used by this issuer`)
    }
    const claims = [
      ...(numberInt !== null ? [`int:${issuerId}:${type}:${year}:${numberInt}`] : []),
      ...(number ? [`str:${issuerId}:${number}`] : []),
    ]
    if (claims.some((c) => claimed.has(c))) {
      throw new Error(
        `numberTaken: ${number ?? `${type} ${numberInt} of ${year}`} is used by an earlier record of this import`,
      )
    }

    let originalId: string | null = null
    const originalRef = str(record.originalExternalRef)
    if (type === "credit_note" && originalRef) {
      const candidates = source ? [`${source}:${originalRef}`, originalRef] : [originalRef]
      for (const ref of candidates) {
        const found = (await ctx.db.findMany("documents", { where: { external_ref: ref }, limit: 1 })) as Row[]
        if (found[0]) {
          originalId = String(found[0].id)
          break
        }
      }
    }
    const originalNumber = str(record.originalNumber)
    if (type === "credit_note" && !originalId && originalNumber) {
      // An original imported by another tool, known by its number.
      const found = (await ctx.db.findMany("documents", {
        where: { issuer_profile_id: issuerId, type: "invoice", number: originalNumber },
        limit: 1,
      })) as Row[]
      if (found[0]) originalId = String(found[0].id)
    }

    const cp = (record.counterparty ?? {}) as Row
    const company = str(cp.company)
    const name = company ?? str(cp.name) ?? "Customer"
    const address = company
      ? [str(cp.name), str(cp.address)].filter(Boolean).join(", ") || null
      : str(cp.address)
    const sourceTag = `import:${source || "import"}`
    const lifecycle: Row[] = [{ ts: `${issueDate}T00:00:00.000Z`, event: "issued", source: sourceTag }]
    if (isPaid) lifecycle.push({ ts: `${issueDate}T00:00:00.000Z`, event: "marked_paid", source: sourceTag })
    // `import_source` marks the document imported: its PDF is the original,
    // never re-rendered (mutations/pdf.ts), and the legal-original backfill
    // reads the file the host records as `import_file_id`.
    const externalRefs: Row = { import_ref: dedupValue, import_source: dedupValue }
    if (str(record.orderNumber)) externalRefs.shopify_order_number = str(record.orderNumber)
    if (originalRef) externalRefs.original_document_ref = originalRef
    if (originalNumber) externalRefs.original_document_number = originalNumber

    const claim = () => {
      for (const c of claims) claimed.add(c)
    }
    const write = async (): Promise<ImportResult> => {
    const rows: Array<{ table: string; id: string }> = []
    try {
      const document = await ctx.db.insert("documents", {
        type,
        status,
        payment_status: paymentStatus,
        number,
        number_int: numberInt,
        year_of_issue: year,
        issuer_profile_id: issuerId,
        counterparty_name: name,
        counterparty_address: address,
        counterparty_vat_id: str(cp.vatId),
        counterparty_email: str(cp.email),
        counterparty_country: str(cp.country),
        currency: String(record.currency ?? "").toUpperCase(),
        subtotal_minor: subtotal,
        tax_total_minor: tax,
        grand_total_minor: grand,
        tax_treatment: str(record.taxTreatment),
        issued_at: issueDate,
        due_at: dueDate ?? (isPaid ? issueDate : null),
        paid_at: isPaid ? issueDate : null,
        tax_point_date: deliveryDate,
        pdf_status: "ready",
        shopify_order_number: str(record.orderNumber),
        po_number: str(record.poNumber),
        notes: str(record.notes),
        original_document_id: originalId,
        external_ref: dedupValue,
        external_refs: externalRefs,
        lifecycle_log: lifecycle,
      })
      rows.push({ table: "app_invoicing.documents", id: document.id })
      for (const line of lines) {
        const written = await ctx.db.insert("document_lines", { document_id: document.id, ...line })
        rows.push({ table: "app_invoicing.document_lines", id: written.id })
      }
      return {
        status: "created",
        rows,
        attachments: [{ fileId: pdfFileId, parent: "pdf", rowId: document.id, ref: "import_file_id" }],
        ...(numberInt !== null
          ? {
              sequenceFloors: [
                { key: `invoicing:doc_number:${issuerId}:${type}:${year}`, value: numberInt },
              ],
            }
          : {}),
      }
    } catch (err) {
      // A write failed midway: the rows already written are reported, so the
      // run ledgers them and undo removes them.
      return { status: "failed", rows, error: err instanceof Error ? err.message : String(err) }
    }
    }
    return { write, claim, claims }
  }
}

/** A record that passed every check: its write, and the numbers it would hold. */
interface PreparedDocument {
  write: () => Promise<ImportResult>
  /** Hold its numbers for the rest of the run (after it passed, or was created). */
  claim: () => void
  claims: string[]
}
