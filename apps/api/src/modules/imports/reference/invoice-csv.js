// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reference transform: an invoice CSV into invoicing.document. AN EXAMPLE TO
// ADAPT, not any product's format: its columns are made up to show the usual
// shape of an invoicing tool's export. Map the person's own columns onto the
// same steps (look at them with kernel__import_sample first).
//
// Input (uploads): a zip holding the CSV and the original PDFs, e.g.
//   invoices.csv
//   pdfs/FAB-2025-0001.pdf ...
// Preview and start it with files: [{ match: "*.csv" }] (the PDFs are not read
// as records; each row names its PDF, declared with ctx.declareFile).
//
// The CSV has one row per line item; the rows of one document follow each
// other and repeat its header columns:
//   type          invoice | credit_note
//   number        the document's own number (also its dedup key)
//   issued_on, due_on   DD/MM/YYYY
//   currency      ISO 4217 code
//   customer_name, customer_company, customer_email, customer_address,
//   customer_country, customer_vat
//   order_ref     the shop order it belongs to
//   corrects      a credit note: the number of the invoice it corrects
//   state         paid | open | void | refunded
//   paid_amount   what was paid on the document
//   item, qty, unit_price, vat_percent, line_net, line_vat   the line
//   pdf           the path of its PDF inside the zip
//
// Amounts are decimal strings ("1100.00") turned into minor units without
// floating point; a credit note's amounts are positive in the CSV and negative
// on the document. Totals are the sums of the lines. A document's rows may
// span two batches: the open document travels in `state` and `finish` emits
// the last one. Invoices come before the credit notes that correct them, so
// the credit note links to the invoice (originalExternalRef).

const ZERO_DECIMAL = { JPY: true, KRW: true, CLP: true, ISK: true, VND: true }

/** "1,100.50" or "1100.5" in minor units, as a string (no float rounding). */
function minor(value, currency, negate) {
  const text = String(value || "0")
    .trim()
    .replace(/[\s,]/g, "")
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text)
  if (!m) throw new Error(`not an amount: "${value}"`)
  const digits = ZERO_DECIMAL[currency] ? 0 : 2
  const frac = `${m[3] || ""}${"0".repeat(digits)}`.slice(0, digits)
  const n = BigInt(`${m[2] || "0"}${frac}`)
  const signed = (m[1] === "-") !== Boolean(negate) ? -n : n
  return signed.toString()
}

/** DD/MM/YYYY as YYYY-MM-DD, or undefined. */
function isoDate(value) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value || "").trim())
  if (!m) return undefined
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`
}

function text(value) {
  const s = String(value === undefined || value === null ? "" : value).trim()
  return s || undefined
}

/** A document's header from its first row. */
function openDocument(row) {
  return { header: row, lines: [] }
}

function lineOf(row, currency, negate) {
  const line = {
    description: text(row.item) || "Item",
    quantity: text(row.qty) || "1",
    unitPriceMinor: minor(row.unit_price, currency, negate),
    totalMinor: minor(row.line_net, currency, negate),
  }
  const rate = Number(text(row.vat_percent) || "0")
  if (Number.isFinite(rate)) line.taxRateBp = Math.round(rate * 100)
  return line
}

async function recordOf(doc, ctx) {
  const h = doc.header
  const currency = String(h.currency || "").toUpperCase()
  const credit = h.type === "credit_note"
  let net = 0n
  let tax = 0n
  const lines = []
  for (let i = 0; i < doc.lines.length; i++) {
    const row = doc.lines[i]
    const line = lineOf(row, currency, credit)
    lines.push(line)
    net += BigInt(line.totalMinor)
    tax += BigInt(minor(row.line_vat, currency, credit))
  }
  const counterparty = {}
  if (text(h.customer_name)) counterparty.name = text(h.customer_name)
  if (text(h.customer_company)) counterparty.company = text(h.customer_company)
  if (text(h.customer_email)) counterparty.email = text(h.customer_email)
  if (text(h.customer_address)) counterparty.address = text(h.customer_address)
  if (text(h.customer_country)) counterparty.country = text(h.customer_country)
  if (text(h.customer_vat)) counterparty.vatId = text(h.customer_vat)
  const record = {
    externalRef: h.number,
    type: credit ? "credit_note" : "invoice",
    number: h.number,
    issueDate: isoDate(h.issued_on),
    currency: currency,
    counterparty: counterparty,
    lines: lines,
    subtotalMinor: net.toString(),
    taxTotalMinor: tax.toString(),
    grandTotalMinor: (net + tax).toString(),
    pdf: { fileId: await ctx.declareFile(h.pdf) },
  }
  const digits = /(\d+)$/.exec(h.number)
  if (digits) record.numberInt = Number(digits[1])
  const due = isoDate(h.due_on)
  if (due) record.dueDate = due
  if (text(h.order_ref)) record.orderNumber = text(h.order_ref)
  if (credit && text(h.corrects)) {
    record.originalExternalRef = text(h.corrects)
    record.originalNumber = text(h.corrects)
  }
  // Payment drives "paid"; the other states are stated as they are.
  if (!credit) record.amountPaidMinor = minor(h.paid_amount, currency, false)
  if (h.state === "void") record.status = "voided"
  else if (h.state === "refunded") record.status = "refunded"
  return record
}

async function emit(docs, ctx) {
  if (docs.length === 0) return
  const records = []
  for (let i = 0; i < docs.length; i++) records.push(await recordOf(docs[i], ctx))
  await ctx.emitRecords("invoicing.document", records)
}

async function transform(batch, ctx) {
  let open = batch.state ? batch.state.open : null
  const done = []
  for (let i = 0; i < batch.records.length; i++) {
    const row = batch.records[i]
    if (!text(row.number)) continue
    if (open && open.header.number !== row.number) {
      done.push(open)
      open = null
    }
    if (!open) open = openDocument(row)
    open.lines.push(row)
  }
  await emit(done, ctx)
  return { state: { open: open } }
}

async function finish(batch, ctx) {
  if (batch.state?.open) await emit([batch.state.open], ctx)
  return {}
}
