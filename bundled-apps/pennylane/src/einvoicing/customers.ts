// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Customer upsert, reachable only from inside an e-invoice deposit or a booking (never its own
// tool). Lookup first by `external_reference` (Pennylane enforces it unique: a second create with
// the same reference is a 422 "already been taken", which is answered by the lookup), create
// otherwise, update when the identity changed (re-sending `reg_no` / `customer_type` only on a
// change, because Pennylane clears the electronic billing address on either).
//
// For a company to be addressable on the PA network its electronic billing address must be one
// of the directory's entries for its SIREN (`GET /customers/{id}/electronic_billing_addresses`);
// the routing address the invoice carries (BT-49) is set on the customer when it is listed.
import type { PennylaneClient } from "../lib/pennylane-client"

export interface PennylaneCustomer {
  id: number
  customer_type: "company" | "individual"
  name: string
  reg_no?: string | null
  vat_number?: string | null
  electronic_billing_address?: string | null
  external_reference?: string | null
  billing_address?: { address: string; postal_code: string; city: string; country_alpha2: string }
}

export interface CustomerInput {
  external_reference: string
  kind: "company" | "individual"
  name: string
  first_name?: string | null
  last_name?: string | null
  reg_no?: string | null
  vat_number?: string | null
  address: {
    line1: string
    line2?: string | null
    postcode: string
    city: string
    country_code: string
  }
}

function billingAddress(a: CustomerInput["address"]) {
  return {
    address: [a.line1, a.line2].filter((x) => x && String(x).trim() !== "").join("\n"),
    postal_code: a.postcode,
    city: a.city,
    country_alpha2: a.country_code.toUpperCase(),
  }
}

/** Individuals need a first and last name: given names win, else the last word is the family
 *  name and the rest the given name ("Marie Claire Dupont" → "Marie Claire" / "Dupont"). */
export function splitPersonName(input: CustomerInput): { first_name: string; last_name: string } {
  if (input.first_name && input.last_name)
    return { first_name: input.first_name, last_name: input.last_name }
  const words = input.name.trim().split(/\s+/).filter(Boolean)
  if (words.length <= 1) return { first_name: words[0] ?? "-", last_name: words[0] ?? "-" }
  return { first_name: words.slice(0, -1).join(" "), last_name: words[words.length - 1]! }
}

async function findByExternalReference(
  client: PennylaneClient,
  ref: string,
): Promise<PennylaneCustomer | null> {
  const page = await client.list<PennylaneCustomer>("/customers", {
    filter: [{ field: "external_reference", operator: "eq", value: ref }],
    limit: 2,
  })
  return page.items[0] ?? null
}

function createBody(input: CustomerInput): Record<string, unknown> {
  const base = {
    customer_type: input.kind,
    external_reference: input.external_reference,
    billing_address: billingAddress(input.address),
  }
  if (input.kind === "individual") return { ...base, ...splitPersonName(input) }
  return {
    ...base,
    name: input.name,
    ...(input.reg_no ? { reg_no: input.reg_no } : {}),
    ...(input.vat_number ? { vat_number: input.vat_number } : {}),
  }
}

/** Fields that changed (what a PUT re-sends); `reg_no` / `customer_type` only when they differ. */
function changes(existing: PennylaneCustomer, input: CustomerInput): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (existing.customer_type !== input.kind) out.customer_type = input.kind
  if (input.kind === "company") {
    if (existing.name !== input.name) out.name = input.name
    if ((existing.reg_no ?? null) !== (input.reg_no ?? null) && input.reg_no)
      out.reg_no = input.reg_no
    if ((existing.vat_number ?? null) !== (input.vat_number ?? null) && input.vat_number)
      out.vat_number = input.vat_number
  }
  const want = billingAddress(input.address)
  const have = existing.billing_address
  if (
    !have ||
    have.address !== want.address ||
    have.postal_code !== want.postal_code ||
    have.city !== want.city ||
    have.country_alpha2 !== want.country_alpha2
  ) {
    out.billing_address = want
  }
  return out
}

export async function upsertCustomer(
  client: PennylaneClient,
  input: CustomerInput,
): Promise<PennylaneCustomer> {
  let existing = await findByExternalReference(client, input.external_reference)
  if (!existing) {
    try {
      return (await client.post<PennylaneCustomer>("/customers", createBody(input))).data
    } catch (e) {
      // Created concurrently (or by a run that crashed before recording it): adopt it.
      if (
        (e as { status?: number }).status === 422 &&
        /already been taken/i.test((e as { body?: string }).body ?? "")
      ) {
        existing = await findByExternalReference(client, input.external_reference)
        if (!existing) throw e
      } else {
        throw e
      }
    }
  }
  const patch = changes(existing, input)
  if (Object.keys(patch).length === 0) return existing
  return (await client.put<PennylaneCustomer>(`/customers/${existing.id}`, patch)).data
}

export type RoutingOutcome =
  | { ok: true; address: string }
  | { ok: false; state: "not_in_directory"; listed: string[] }
  | { ok: false; state: "routing_mismatch"; listed: string[] }

/**
 * Point the customer's electronic billing address at the invoice's routing address (BT-49) when
 * the directory lists it. An empty list means the buyer is not reachable on the network (the legal
 * fallback is reporting); a list without our address is a mismatch a person must look at.
 */
export async function ensureRoutingAddress(
  client: PennylaneClient,
  customer: PennylaneCustomer,
  routingAddress: string,
): Promise<RoutingOutcome> {
  const page = await client.list<{ electronic_billing_address: string }>(
    `/customers/${customer.id}/electronic_billing_addresses`,
    { limit: 100 },
  )
  const listed = page.items.map((i) => i.electronic_billing_address)
  if (listed.length === 0) return { ok: false, state: "not_in_directory", listed }
  if (!listed.includes(routingAddress)) return { ok: false, state: "routing_mismatch", listed }
  if (customer.electronic_billing_address !== routingAddress) {
    await client.put(`/customers/${customer.id}`, { electronic_billing_address: routingAddress })
  }
  return { ok: true, address: routingAddress }
}
