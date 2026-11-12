// SPDX-License-Identifier: FSL-1.1-ALv2
//
// einvoicing-pa@1 emission ops over Pennylane v2:
//   submit_einvoice   eligibility from the CII → emission activated? → adopt an existing deposit
//                     (invoice_number + date) → buyer upsert + routing address → import the legal
//                     original (multipart, `send_to_pa:false`, pinned to its SHA-256) → adopt on 409
//   advance_einvoice  one step: already transmitted? → schematron pending / invalid / valid →
//                     emission still on? → send_to_pa (204 requested, 409 not ready, 422 re-read)
//   get_einvoice_status / find_einvoice / registration_status: reads.
// Pennylane has no idempotency key: every create is preceded by a lookup, and a re-import of the
// same bytes answers 409 with the existing id, which is adopted.
import type { EinvoiceBuyer } from "@liaison/app-sdk/contracts"
import type { PennylaneClient } from "../lib/pennylane-client"
import { ensureRoutingAddress, upsertCustomer } from "./customers"
import { eligibilityProblems } from "./eligibility"
import { fromException, type OpError, opError } from "./errors"
import { mapPennylaneStatus } from "./status-map"

export interface PennylaneInvoice {
  id: number
  invoice_number: string | null
  date: string | null
  status?: string | null
  factur_x?: boolean | null
  schematron_validation_status?: "pending" | "valid" | "invalid" | null
  external_reference?: string | null
  updated_at?: string | null
  customer?: { id: number } | null
  e_invoicing?: {
    status?: string | null
    reason?: string | null
    flow?: { id?: string } | null
  } | null
}

export interface RegistrationStatus {
  emission_activated: boolean
  registrations: Array<{
    siren: string | null
    siret: string | null
    status: string
    direction: string | null
  }>
}

export async function registrationStatus(client: PennylaneClient): Promise<RegistrationStatus> {
  const r = await client.get<{
    emission_activated?: boolean
    items?: Array<{
      siren?: string
      siret?: string | null
      status?: string
      exchange_direction?: string
    }>
  }>("/pa_registrations")
  return {
    emission_activated: r.emission_activated === true,
    registrations: (r.items ?? []).map((i) => ({
      siren: i.siren ?? null,
      siret: i.siret ?? null,
      status: i.status ?? "unknown",
      direction: i.exchange_direction ?? null,
    })),
  }
}

export async function findInvoiceByNumber(
  client: PennylaneClient,
  invoiceNumber: string,
  issueDate: string,
): Promise<PennylaneInvoice | null> {
  const page = await client.list<PennylaneInvoice>("/customer_invoices", {
    filter: [
      { field: "invoice_number", operator: "eq", value: invoiceNumber },
      { field: "date", operator: "eq", value: issueDate },
    ],
    limit: 5,
  })
  return page.items.find((i) => i.invoice_number === invoiceNumber && i.date === issueDate) ?? null
}

/** Our deposit state for a Pennylane invoice we hold. */
function depositState(
  inv: PennylaneInvoice,
): "imported" | "validation_pending" | "sent" | "failed" {
  if (inv.e_invoicing) return "sent"
  if (inv.schematron_validation_status === "invalid") return "failed"
  if (inv.schematron_validation_status === "valid") return "imported"
  return "validation_pending"
}

export async function findEinvoice(
  client: PennylaneClient,
  p: { invoice_number: string; issue_date: string },
): Promise<{ found: false } | { found: true; provider_ref: string; state: string } | OpError> {
  try {
    const inv = await findInvoiceByNumber(client, p.invoice_number, p.issue_date)
    return inv
      ? { found: true, provider_ref: String(inv.id), state: depositState(inv) }
      : { found: false }
  } catch (e) {
    return fromException(e, "find_einvoice")
  }
}

export interface SubmitParams {
  document_ref: string
  invoice_number: string
  issue_date: string
  facturx_file_id: string
  legal_original_sha256: string
  cii_xml: string
  buyer: EinvoiceBuyer
  idempotency_key: string
}

export type SubmitResult =
  | {
      provider_ref: string
      state: "imported" | "validation_pending" | "sent" | "failed"
      adopted: boolean
      uploaded_sha256?: string
    }
  | { provider_ref: null; state: "not_in_directory" | "routing_mismatch"; listed: string[] }
  | OpError

export async function submitEinvoice(
  client: PennylaneClient,
  p: SubmitParams,
): Promise<SubmitResult> {
  const problems = eligibilityProblems(p.cii_xml, {
    invoice_number: p.invoice_number,
    issue_date: p.issue_date,
    buyer_siren: p.buyer?.siren ?? "",
  })
  if (problems.length > 0) {
    return opError(
      "einvoice_not_eligible",
      `Not a domestic B2B e-invoice for this document: ${problems.join("; ")}`,
      false,
      { problems },
    )
  }
  if (!/^[0-9a-f]{64}$/i.test(p.legal_original_sha256 ?? "")) {
    return opError("invalid_input", "legal_original_sha256 must be the legal original's SHA-256")
  }
  try {
    const reg = await registrationStatus(client)
    if (!reg.emission_activated) {
      return opError(
        "pa_emission_not_activated",
        "E-invoice emission is not activated on the Pennylane account: an administrator switches it on in Pennylane (Paramètres › Transmission de factures) before anything can be sent.",
      )
    }
    const existing = await findInvoiceByNumber(client, p.invoice_number, p.issue_date)
    if (existing)
      return { provider_ref: String(existing.id), state: depositState(existing), adopted: true }

    const customer = await upsertCustomer(client, {
      external_reference: p.buyer.contact_ref
        ? `contact:${p.buyer.contact_ref}`
        : `siren:${p.buyer.siren}`,
      kind: "company",
      name: p.buyer.legal_name,
      reg_no: p.buyer.siren,
      vat_number: p.buyer.vat_id,
      address: p.buyer.address,
    })
    const routing = await ensureRoutingAddress(client, customer, p.buyer.routing_address)
    if (!routing.ok) return { provider_ref: null, state: routing.state, listed: routing.listed }

    let created: { id: number } | null = null
    let uploadedSha: string | undefined
    try {
      const res = await client.postMultipart<{ id: number }>(
        "/customer_invoices/e_invoices/imports",
        [
          {
            name: "file",
            fileId: p.facturx_file_id,
            filename: `${p.invoice_number.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`,
            contentType: "application/pdf",
            expectSha256: p.legal_original_sha256,
            // What was checked above is what leaves: the host extracts the CII embedded in these
            // exact bytes and refuses the upload unless it is the XML the eligibility check read.
            expectEmbeddedFile: { name: "factur-x.xml", text: p.cii_xml },
          },
          { name: "send_to_pa", value: "false" },
          { name: "invoice_options[customer_id]", value: String(customer.id) },
        ],
      )
      created = res.data
      uploadedSha = res.upload?.parts.find((x) => x.name === "file")?.sha256
    } catch (e) {
      // The same bytes were already imported (a crash after the 201): Pennylane names the id.
      const body = (e as { body?: string }).body ?? ""
      const m =
        (e as { status?: number }).status === 409 ? /ID (\d+) already exists/.exec(body) : null
      if (!m) throw e
      return { provider_ref: m[1]!, state: "validation_pending", adopted: true }
    }
    if (!created?.id)
      return opError("provider_rejected", "Pennylane accepted the import without returning an id")
    // Tag the import with our key (proven not to disturb factur_x / validation); best effort.
    try {
      await client.put(`/customer_invoices/${created.id}/update_imported`, {
        external_reference: p.idempotency_key,
      })
    } catch {
      /* the invoice number stays the lookup key */
    }
    return {
      provider_ref: String(created.id),
      state: "validation_pending",
      adopted: false,
      ...(uploadedSha ? { uploaded_sha256: uploadedSha } : {}),
    }
  } catch (e) {
    if (
      (e as { code?: string }).code === "embedded_file_mismatch" ||
      /does not embed exactly/.test(String((e as Error)?.message))
    ) {
      return opError(
        "einvoice_cii_mismatch",
        "The legal original to upload does not embed the CII that was checked for eligibility; nothing was sent",
      )
    }
    if (
      (e as { code?: string }).code === "part_sha256_mismatch" ||
      /fingerprint/.test(String((e as Error)?.message))
    ) {
      return opError(
        "legal_original_mismatch",
        "The file to upload is not the approved legal original (fingerprint differs); nothing was sent",
      )
    }
    return fromException(e, "submit_einvoice")
  }
}

export type AdvanceResult =
  | {
      provider_ref: string
      state: "validation_pending" | "send_requested" | "sent" | "failed"
      detail?: unknown
      raw?: string | null
    }
  | OpError

export async function advanceEinvoice(
  client: PennylaneClient,
  // document_ref / legal_original_sha256 are bound by the kernel's dispatch grant; unused here.
  p: {
    provider_ref: string
    invoice_number: string
    issue_date: string
    document_ref?: string
    legal_original_sha256?: string
  },
): Promise<AdvanceResult> {
  const ref = String(p.provider_ref ?? "")
  if (!/^\d+$/.test(ref))
    return opError("invalid_input", "provider_ref must be a Pennylane invoice id")
  try {
    const inv = await client.get<PennylaneInvoice>(`/customer_invoices/${ref}`)
    if (inv.invoice_number !== p.invoice_number) {
      return opError(
        "provider_ref_mismatch",
        `Pennylane invoice ${ref} is ${inv.invoice_number}, not ${p.invoice_number}`,
      )
    }
    if (inv.e_invoicing)
      return { provider_ref: ref, state: "sent", raw: inv.e_invoicing.status ?? null }
    if (inv.factur_x === false) {
      return {
        provider_ref: ref,
        state: "failed",
        detail: { reason: "not_recognised_as_einvoice" },
      }
    }
    if (inv.schematron_validation_status === "invalid") {
      return { provider_ref: ref, state: "failed", detail: { reason: "schematron_invalid" } }
    }
    if (inv.schematron_validation_status !== "valid")
      return { provider_ref: ref, state: "validation_pending" }
    const reg = await registrationStatus(client)
    if (!reg.emission_activated) {
      return opError(
        "pa_emission_not_activated",
        "E-invoice emission is not activated on the Pennylane account; nothing was sent.",
      )
    }
    try {
      const res = await client.postEmpty(`/customer_invoices/${ref}/send_to_pa`)
      if (res.status === 204 || res.status === 200)
        return { provider_ref: ref, state: "send_requested" }
      return { provider_ref: ref, state: "validation_pending", detail: { status: res.status } }
    } catch (e) {
      const status = (e as { status?: number }).status
      if (status === 409)
        return {
          provider_ref: ref,
          state: "validation_pending",
          detail: { reason: "import_still_processing" },
        }
      if (status === 422) {
        // Never inferred either way: "sent" only when Pennylane shows the transmission, and a 422
        // whose re-read does not show it yet is NOT a failure (a transmission requested by an
        // earlier call, e.g. before a crash, may not be visible yet). It stays requested: the
        // next step re-reads it, and nothing is ever recorded as failed (final) on this answer.
        const again = await client.get<PennylaneInvoice>(`/customer_invoices/${ref}`)
        if (again.e_invoicing)
          return { provider_ref: ref, state: "sent", raw: again.e_invoicing.status ?? null }
        return {
          provider_ref: ref,
          state: "send_requested",
          detail: { status: 422, body: (e as { body?: string }).body ?? "", unconfirmed: true },
        }
      }
      throw e
    }
  } catch (e) {
    return fromException(e, "advance_einvoice")
  }
}

export async function getEinvoiceStatus(client: PennylaneClient, p: { provider_ref: string }) {
  const ref = String(p.provider_ref ?? "")
  if (!/^\d+$/.test(ref))
    return opError("invalid_input", "provider_ref must be a Pennylane invoice id")
  try {
    const inv = await client.get<PennylaneInvoice>(`/customer_invoices/${ref}`)
    const raw = inv.e_invoicing?.status ?? null
    const { mapped, code } = mapPennylaneStatus(raw)
    return {
      provider_ref: ref,
      raw,
      mapped: inv.e_invoicing ? mapped : ("imported" as const),
      code,
      provider_ts: inv.updated_at ?? null,
      reason_text: inv.e_invoicing?.reason ?? null,
      e_invoicing: inv.e_invoicing ? true : false,
      flow_id: inv.e_invoicing?.flow?.id ?? null,
      schematron: inv.schematron_validation_status ?? null,
    }
  } catch (e) {
    return fromException(e, "get_einvoice_status")
  }
}
