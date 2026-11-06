// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Gated `supplier_invoice_upload`: books a received supplier bill (a PDF the caller can read, e.g.
// a mail attachment) into Pennylane's accounts payable, through the documented import path:
//   1. the supplier: `supplier_id`, else the one supplier whose name matches `supplier_name`
//      (Pennylane filters names by prefix only; the exact match is made here; none or several →
//      a refusal listing what was found, nothing is created);
//   2. a lookup by `external_reference` = `liaison-<file id>`: an earlier import of the same file
//      is adopted, never duplicated;
//   3. `POST /file_attachments` (multipart: the file's bytes, assembled host-side) then
//      `POST /supplier_invoices/import` with the dates, the amounts and one line (Pennylane does
//      no OCR: the caller states the figures); a 409 "already exists with such attachment" adopts
//      the id it names;
//   4. a local record of what was imported (`supplier_invoice_upload`, status `imported`).
// Supplier e-invoices received through the e-invoicing network are already in Pennylane (the
// invoicing app mirrors them): they are never uploaded again. The host refuses to send a file
// stored as one (`RECEIVED_EINVOICE_PARENT`), and the tool answers `received_einvoice_in_pennylane`.
import { minorAmountRefusal, readMinorAmount } from "@liaison/app-sdk"
import type { PennylaneToolCtx } from "./ctx"
import { opError, fromException, type OpError } from "./einvoicing/errors"
import { getClient } from "./lib/get-client"
import { PennylaneApiError, PennylaneClient } from "./lib/pennylane-client"

export interface UploadInput {
  file_id: string
  supplier_name: string
  invoice_date: string
  /** The bill's total including tax, minor units (412.60 EUR = "41260"). */
  amount_minor: string
  currency?: string
  /** The tax part of the total, minor units (default "0"). */
  tax_minor?: string
  due_date?: string
  invoice_number?: string
  /** Pennylane supplier id, when known (skips the name lookup). */
  supplier_id?: string
}

export interface UploadResult {
  disposition: "imported"
  posted_to_pennylane: true
  provider_ref: string
  supplier: { id: string; name: string }
  /** An earlier import of the same file was found and reused. */
  adopted: boolean
}

export type UploadCtx = Pick<PennylaneToolCtx, "db" | "fetch" | "connections" | "logger" | "__client">

const ZERO_DECIMAL = new Set(["JPY", "KRW", "CLP", "ISK", "HUF", "TWD", "UGX", "VND", "XAF", "XOF"])

/** "41260" (minor) → "412.60" in the currency's decimals. */
export function minorToDecimal(minor: string, currency: string): string | null {
  if (!/^-?\d+$/.test(minor.trim())) return null
  const n = BigInt(minor.trim())
  if (ZERO_DECIMAL.has(currency)) return n.toString()
  const neg = n < 0n
  const abs = neg ? -n : n
  const s = `${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`
  return neg ? `-${s}` : s
}

/** What is wrong with the amounts of a bill, before anything parks and again at execution. */
export function minorAmountsRefusal(input: { amount_minor?: unknown; tax_minor?: unknown }): string | null {
  for (const [field, value] of [
    ["amount_minor", input.amount_minor],
    ["tax_minor", input.tax_minor ?? "0"],
  ] as const) {
    if (value !== undefined && readMinorAmount(value) === null) return minorAmountRefusal(field, value)
  }
  return null
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Where the invoicing app stores the files of supplier e-invoices received through the platform. */
export const RECEIVED_EINVOICE_PARENT = { app: "invoicing", entityType: "received_file" } as const

function receivedEinvoiceRefusal(fileId: string): OpError {
  return opError(
    "received_einvoice_in_pennylane",
    `File ${fileId} is a supplier e-invoice received through the e-invoicing platform: it is already in Pennylane, so it is not uploaded again. Open it in Invoicing > Received (received_einvoices_get) to read, refuse or dispute it.`,
    false,
  )
}

interface Supplier {
  id: number
  name?: string | null
}

async function resolveSupplier(c: PennylaneClient, input: UploadInput): Promise<Supplier | OpError> {
  if (input.supplier_id) {
    if (!/^\d+$/.test(input.supplier_id)) return opError("invalid_input", "supplier_id must be a Pennylane supplier id")
    try {
      return await c.get<Supplier>(`/suppliers/${input.supplier_id}`)
    } catch (e) {
      if (e instanceof PennylaneApiError && e.status === 404) return opError("supplier_not_found", `Pennylane has no supplier ${input.supplier_id}`)
      throw e
    }
  }
  const name = input.supplier_name.trim()
  const page = await c.list<Supplier>("/suppliers", { filter: [{ field: "name", operator: "start_with", value: name }], limit: 100 })
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase()
  const exact = page.items.filter((s) => norm(s.name) === norm(name))
  if (exact.length === 1) return exact[0]!
  const found = (exact.length > 1 ? exact : page.items).slice(0, 10).map((s) => ({ supplier_id: String(s.id), name: s.name ?? "" }))
  if (exact.length > 1) {
    return opError("supplier_ambiguous", `Several Pennylane suppliers are named "${name}": pass supplier_id`, false, { candidates: found })
  }
  return opError(
    "supplier_not_found",
    found.length > 0
      ? `No Pennylane supplier is named exactly "${name}": pass supplier_id of one of the suppliers found, or create the supplier in Pennylane first`
      : `No Pennylane supplier is named "${name}": create the supplier in Pennylane first, or pass supplier_id`,
    false,
    { candidates: found },
  )
}

export async function supplierInvoiceUpload(ctx: UploadCtx, input: UploadInput): Promise<UploadResult | OpError> {
  const currency = (input.currency ?? "EUR").trim().toUpperCase()
  if (!input.file_id || !input.supplier_name?.trim()) return opError("invalid_input", "file_id and supplier_name are required")
  if (!DATE.test(input.invoice_date ?? "")) return opError("invalid_input", "invoice_date must be YYYY-MM-DD")
  if (input.due_date && !DATE.test(input.due_date)) return opError("invalid_input", "due_date must be YYYY-MM-DD")
  if (!/^[A-Z]{3}$/.test(currency)) return opError("invalid_input", "currency must be a 3-letter code")
  const total = minorToDecimal(String(input.amount_minor ?? ""), currency)
  const tax = minorToDecimal(String(input.tax_minor ?? "0"), currency)
  const refused = minorAmountsRefusal(input)
  if (refused || total === null || tax === null) return opError("invalid_amount", refused ?? "amount_minor is required")
  const beforeTax = minorToDecimal(String(BigInt(String(input.amount_minor).trim()) - BigInt(String(input.tax_minor ?? "0").trim())), currency)!
  const externalReference = `liaison-${input.file_id}`
  try {
    const c = ctx.__client instanceof PennylaneClient ? ctx.__client : (await getClient(ctx)).client
    const supplier = await resolveSupplier(c, input)
    if ("status" in supplier && (supplier as OpError).status === "error") return supplier as OpError
    const sup = supplier as Supplier
    const record = async (providerRef: string, adopted: boolean): Promise<UploadResult> => {
      await ctx.db.insert("supplier_invoice_upload", {
        supplier_name: sup.name ?? input.supplier_name,
        invoice_date: input.invoice_date,
        amount_minor: String(input.amount_minor),
        currency,
        source_file_id: input.file_id,
        status: "imported",
        provider_ref: providerRef,
        invoice_number: input.invoice_number ?? null,
      })
      return {
        disposition: "imported",
        posted_to_pennylane: true,
        provider_ref: providerRef,
        supplier: { id: String(sup.id), name: sup.name ?? input.supplier_name },
        adopted,
      }
    }
    // An earlier import of this very file (a retried approval): adopt it.
    const prior = await c.list<{ id: number }>("/supplier_invoices", {
      filter: [{ field: "external_reference", operator: "eq", value: externalReference }],
      limit: 1,
    })
    if (prior.items[0]) return await record(String(prior.items[0].id), true)
    const filename = `${(input.invoice_number ?? "supplier-invoice").replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`
    const att = await c.postMultipart<{ id: number }>("/file_attachments", [
      { name: "file", fileId: input.file_id, filename, contentType: "application/pdf", refuseParents: [RECEIVED_EINVOICE_PARENT] },
      { name: "filename", value: filename },
    ])
    try {
      const created = await c.post<{ id: number }>("/supplier_invoices/import", {
        file_attachment_id: att.data.id,
        supplier_id: sup.id,
        date: input.invoice_date,
        deadline: input.due_date ?? input.invoice_date,
        ...(input.invoice_number ? { invoice_number: input.invoice_number } : {}),
        currency,
        currency_amount_before_tax: beforeTax,
        currency_amount: total,
        currency_tax: tax,
        external_reference: externalReference,
        invoice_lines: [{ currency_amount: total, currency_tax: tax, label: input.invoice_number ? `Invoice ${input.invoice_number}` : "Supplier invoice" }],
      })
      return await record(String(created.data.id), false)
    } catch (e) {
      const existing = e instanceof PennylaneApiError && e.status === 409 ? /document with ID (\d+)/.exec(e.body)?.[1] : null
      if (existing) return await record(existing, true)
      throw e
    }
  } catch (e) {
    if (isParentRefusal(e)) return receivedEinvoiceRefusal(input.file_id)
    return fromException(e, "supplier_invoice_upload")
  }
}

/** The host's `file_parent_refused` (it crosses the sandbox as an error or an error-shaped value). */
function isParentRefusal(e: unknown): boolean {
  const o = e as { code?: unknown; message?: unknown } | null
  return o?.code === "file_parent_refused" || /file_parent_refused|which this upload refuses/.test(String(o?.message ?? e ?? ""))
}
