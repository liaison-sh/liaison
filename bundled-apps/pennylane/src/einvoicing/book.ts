// SPDX-License-Identifier: FSL-1.1-ALv2
//
// einvoicing-pa@1 booking ops over Pennylane v2: a sale that is reported, not e-invoiced (B2C,
// exports, intra-EU, non-registered buyers), booked as an ordinary customer invoice in the
// ledger. `POST /file_attachments` (the legal original, pinned to its SHA-256) then
// `POST /customer_invoices/import` with `external_reference` = the idempotency key. Never
// `convert_to_e_invoice`, never a send. Pennylane rejects a second import with the same
// `external_reference` (422 "already been taken"), so a replay is adopted, never duplicated.
// Foreign-currency invoices carry the EUR `amount` / `tax` from the stored reference rate beside
// the `currency_*` amounts (verified in the sandbox; `exchange_rate` is not a field).
import type { BookingData, BookingLine } from "@liaison/app-sdk/contracts"
import type { PennylaneClient } from "../lib/pennylane-client"
import { upsertCustomer } from "./customers"
import { fromException, type OpError, opError } from "./errors"
import type { PennylaneInvoice } from "./send"
import { pennylaneVatRate } from "./vat-rate"

const MINOR_EXPONENT: Readonly<Record<string, number>> = { JPY: 0, KRW: 0, CLP: 0, ISK: 0, HUF: 2 }

function money(minor: number, currency: string): string {
  const exp = MINOR_EXPONENT[currency.toUpperCase()] ?? 2
  const neg = minor < 0
  const abs = Math.abs(Math.round(minor))
  const units = Math.floor(abs / 10 ** exp)
  const frac = exp === 0 ? "" : `.${String(abs % 10 ** exp).padStart(exp, "0")}`
  return `${neg ? "-" : ""}${units}${frac}`
}

/** EUR value of a foreign-currency minor amount at `rate` (units of currency per 1 EUR). */
function eurOf(minor: number, currency: string, rate: number): string {
  const exp = MINOR_EXPONENT[currency.toUpperCase()] ?? 2
  const eurCents = Math.round((minor / 10 ** exp / rate) * 100)
  return money(eurCents, "EUR")
}

export async function findBooking(
  client: PennylaneClient,
  p: { idempotency_key: string },
): Promise<
  { found: false } | { found: true; provider_ref: string; e_invoicing: boolean } | OpError
> {
  try {
    const page = await client.list<PennylaneInvoice>("/customer_invoices", {
      filter: [{ field: "external_reference", operator: "eq", value: p.idempotency_key }],
      limit: 2,
    })
    const hit = page.items[0]
    return hit
      ? { found: true, provider_ref: String(hit.id), e_invoicing: hit.e_invoicing != null }
      : { found: false }
  } catch (e) {
    return fromException(e, "find_booking")
  }
}

export interface BookParams {
  document_ref: string
  pdf_file_id: string
  legal_original_sha256: string
  data: BookingData
  idempotency_key: string
}

export type BookResult = { provider_ref: string; state: "booked"; adopted: boolean } | OpError

function lineRates(
  lines: BookingLine[],
): { ok: true; rates: string[] } | { ok: false; problems: string[] } {
  const rates: string[] = []
  const problems: string[] = []
  lines.forEach((l, i) => {
    const r = pennylaneVatRate(l)
    if (r.ok) rates.push(r.vat_rate)
    else problems.push(`line ${i + 1} (${l.label}): ${r.reason}`)
  })
  return problems.length ? { ok: false, problems } : { ok: true, rates }
}

export async function bookSale(client: PennylaneClient, p: BookParams): Promise<BookResult> {
  const d = p.data
  if (!d || !Array.isArray(d.lines) || d.lines.length === 0)
    return opError("invalid_input", "booking data with lines is required")
  if (!/^[0-9a-f]{64}$/i.test(p.legal_original_sha256 ?? "")) {
    return opError("invalid_input", "legal_original_sha256 must be the legal original's SHA-256")
  }
  const rates = lineRates(d.lines)
  if (!rates.ok) {
    return opError(
      "vat_rate_unmappable",
      `No Pennylane VAT rate for: ${rates.problems.join("; ")}`,
      false,
      { problems: rates.problems },
    )
  }
  const foreign = d.currency.toUpperCase() !== "EUR"
  const fx = foreign ? Number(d.fx_rate) : 1
  if (foreign && !(fx > 0))
    return opError("fx_rate_missing", `A ${d.currency} booking needs the stored EUR reference rate`)
  try {
    const existing = await findBooking(client, { idempotency_key: p.idempotency_key })
    if ("status" in existing) return existing
    if (existing.found)
      return { provider_ref: existing.provider_ref, state: "booked", adopted: true }

    const c = d.customer
    const individual = c.kind !== "business"
    const customer = await upsertCustomer(client, {
      external_reference: c.contact_ref ? `contact:${c.contact_ref}` : `doc:${p.document_ref}`,
      kind: individual ? "individual" : "company",
      name: c.legal_name,
      first_name: c.first_name ?? null,
      last_name: c.last_name ?? null,
      reg_no: null,
      vat_number: individual ? null : (c.vat_id ?? null),
      address: c.address,
    })

    let attachmentId: number
    try {
      const att = await client.postMultipart<{ id: number }>("/file_attachments", [
        {
          name: "file",
          fileId: p.pdf_file_id,
          filename: `${d.invoice_number.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`,
          contentType: "application/pdf",
          expectSha256: p.legal_original_sha256,
        },
        { name: "filename", value: `${d.invoice_number.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf` },
      ])
      attachmentId = att.data.id
    } catch (e) {
      if (/fingerprint/.test(String((e as Error)?.message))) {
        return opError(
          "legal_original_mismatch",
          "The file to book is not the legal original (fingerprint differs); nothing was booked",
        )
      }
      throw e
    }

    const cur = d.currency.toUpperCase()
    const body: Record<string, unknown> = {
      file_attachment_id: attachmentId,
      date: d.issue_date,
      deadline: d.due_date,
      customer_id: customer.id,
      currency: cur,
      invoice_number: d.invoice_number,
      external_reference: p.idempotency_key,
      currency_amount_before_tax: money(d.subtotal_minor, cur),
      currency_amount: money(d.total_minor, cur),
      currency_tax: money(d.tax_minor, cur),
      ...(foreign
        ? { amount: eurOf(d.total_minor, cur, fx), tax: eurOf(d.tax_minor, cur, fx) }
        : {}),
      ...(d.credit_of?.provider_ref && /^\d+$/.test(d.credit_of.provider_ref)
        ? { credited_invoice_id: Number(d.credit_of.provider_ref) }
        : {}),
      invoice_lines: d.lines.map((l, i) => ({
        label: l.label.slice(0, 255),
        quantity: Number(l.quantity),
        raw_currency_unit_price: money(l.unit_price_minor, cur),
        unit: "piece",
        vat_rate: (rates as { rates: string[] }).rates[i],
        currency_amount: money(l.subtotal_minor + l.tax_minor, cur),
        currency_tax: money(l.tax_minor, cur),
        ...(foreign
          ? {
              amount: eurOf(l.subtotal_minor + l.tax_minor, cur, fx),
              tax: eurOf(l.tax_minor, cur, fx),
            }
          : {}),
      })),
    }
    try {
      const res = await client.post<{ id: number }>("/customer_invoices/import", body)
      return { provider_ref: String(res.data.id), state: "booked", adopted: false }
    } catch (e) {
      const status = (e as { status?: number }).status
      const text = (e as { body?: string }).body ?? ""
      if ((status === 422 && /already been taken/i.test(text)) || status === 409) {
        // Booked by a run that crashed before recording it: adopt the one Pennylane holds.
        const again = await findBooking(client, { idempotency_key: p.idempotency_key })
        if (!("status" in again) && again.found)
          return { provider_ref: again.provider_ref, state: "booked", adopted: true }
        const m = /ID (\d+) already exists/.exec(text)
        if (m) return { provider_ref: m[1]!, state: "booked", adopted: true }
      }
      throw e
    }
  } catch (e) {
    return fromException(e, "book_sale")
  }
}
