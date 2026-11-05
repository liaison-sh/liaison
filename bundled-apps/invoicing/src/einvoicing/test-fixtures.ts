// SPDX-License-Identifier: FSL-1.1-ALv2
// Shared e-invoicing fixtures: fictional, Luhn-valid SIRENs and fictional names only.
import type { BuyerSnapshot } from "./gate"

/** Fictional Luhn-valid SIRENs. */
export const FICTIONAL_SIRENS = ["900000001", "902000009", "903000008"] as const

/** The seller identity a French e-invoice (Factur-X) needs, for issuer fixtures. */
export const FR_SELLER_IDENTITY = {
  siren: FICTIONAL_SIRENS[1],
  routing_address: FICTIONAL_SIRENS[1],
  address_line1: "1 rue de Test",
  postcode: "75001",
  city: "Paris",
  country_code: "FR",
} as const

interface IdentityDb {
  insert(entity: string, data: Record<string, unknown>): Promise<unknown>
}

/**
 * Seed a registry-confirmed French business buyer. With `contact_id`, a
 * `counterparty_identities` row is inserted; without one (contactless), the
 * confirmation travels on the snapshot (`buyer_siren_confirmed_via`).
 * Returns the matching structured-billing snapshot either way.
 */
export async function seedConfirmedIdentity(
  db: IdentityDb,
  input: {
    contact_id?: string | null
    siren: string
    name: string
    postcode: string
    city: string
    line1?: string
  },
): Promise<{ identityId: string | null; snapshot: BuyerSnapshot }> {
  const line1 = input.line1 ?? "1 rue de l'Exemple"
  let identityId: string | null = null
  if (input.contact_id) {
    const row = (await db.insert("counterparty_identities", {
      contact_id: input.contact_id,
      customer_kind: "business",
      siren: input.siren,
      registry_name: input.name,
      registry_line1: line1,
      registry_postcode: input.postcode,
      registry_city: input.city,
      registry_country_code: "FR",
      registry_status: "A",
      registry_checked_at: new Date("2026-10-01T00:00:00Z"),
      source: "registry",
      confirmed_via: "auto",
      changed_at: new Date("2026-10-01T00:00:00Z"),
    })) as { id: string }
    identityId = String(row.id)
  }
  return {
    identityId,
    snapshot: {
      customer_kind: "business",
      buyer_legal_name: input.name,
      buyer_siren: input.siren,
      buyer_siren_confirmed_via: input.contact_id ? null : "auto",
      billing_line1: line1,
      billing_postcode: input.postcode,
      billing_city: input.city,
      billing_country_code: "FR",
    },
  }
}

/** A French consumer: explicit `individual` kind, structured billing. */
export const FR_INDIVIDUAL: BuyerSnapshot = {
  customer_kind: "individual",
  buyer_legal_name: "Celine Exemple",
  billing_line1: "2 avenue du Test",
  billing_postcode: "69002",
  billing_city: "Lyon",
  billing_country_code: "FR",
}

/** A French business buyer's snapshot carrying a confirmation claim. The gate never trusts a
 *  snapshot's claim (contactless: registry_unconfirmed); a confirmed buyer needs an identity
 *  row, see `seedConfirmedIdentity` with a `contact_id`. */
export const FR_BUSINESS_CONFIRMED: BuyerSnapshot = {
  customer_kind: "business",
  buyer_legal_name: "Exemple Industries SAS",
  buyer_siren: "900000001",
  buyer_siren_confirmed_via: "auto",
  billing_line1: "1 rue de l'Exemple",
  billing_postcode: "75002",
  billing_city: "Paris",
  billing_country_code: "FR",
}
