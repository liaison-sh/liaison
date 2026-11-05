// SPDX-License-Identifier: FSL-1.1-ALv2
// Regime classifier for the French e-invoicing reform. Pure: callers supply every input.
import { isValidSiren } from "./identity"
import { buyerTerritory } from "./territory"

export type Regime = "e_invoice" | "e_reporting" | "out_of_scope" | "needs_review"
export type CustomerKind = "business" | "individual" | "public_entity" | "non_registered_entity"

export interface ClassifyInput {
  docType: string
  issuerCountry: string | null | undefined
  /** Callers pass `!!issuer.vat_id`. */
  issuerVatRegistered: boolean
  customerKind: CustomerKind | null | undefined
  billingCountry: string | null | undefined
  billingPostcode: string | null | undefined
  vatId: string | null | undefined
  buyerSiren: string | null | undefined
  /** Registry status: A active, C ceased. */
  sirenStatus: "A" | "C" | null | undefined
  territoryTreatment: "as_fr" | "as_foreign" | null | undefined
  /** The credit note's original: its stored regime (null for a legacy original) and transmission status. */
  original?: { regime: Regime | null; transmissionStatus?: string | null } | null
}

export interface RegimeReason {
  code: string
  en: string
  fr: string
}

export type ClassifyErrorCode =
  | "customer_kind_missing"
  | "einvoice_data_missing"
  | "siren_invalid"
  | "siren_inactive"

export type ClassifyResult =
  | { regime: Regime; reasons: RegimeReason[]; internalCancellation?: boolean }
  | { regime: null; error: { code: ClassifyErrorCode }; reasons: RegimeReason[]; internalCancellation?: undefined }

const R = {
  not_invoice: {
    code: "not_invoice_document",
    en: "Only invoices and credit notes are in scope of e-invoicing.",
    fr: "Seuls les factures et avoirs relèvent de la facturation électronique.",
  },
  issuer_out: {
    code: "issuer_out_of_scope",
    en: "The issuer is not established in France or is not registered for VAT.",
    fr: "L'émetteur n'est pas établi en France ou n'est pas assujetti à la TVA.",
  },
  credit_follows: {
    code: "credit_note_follows_original",
    en: "A credit note follows the regime of its original invoice.",
    fr: "Un avoir suit le régime de sa facture d'origine.",
  },
  internal_cancel: {
    code: "internal_cancellation",
    en: "The original was refused or rejected: the credit note is booked but never transmitted.",
    fr: "La facture d'origine a été refusée ou rejetée : l'avoir est comptabilisé mais jamais transmis.",
  },
  needs_review: (code: string) => ({
    code,
    en: "The buyer's establishment is not decided automatically: an administrator must record a territory treatment.",
    fr: "L'établissement de l'acheteur n'est pas tranché automatiquement : un administrateur doit enregistrer un traitement du territoire.",
  }),
  foreign: {
    code: "buyer_not_in_france",
    en: "The buyer is established outside France: e-reporting.",
    fr: "L'acheteur est établi hors de France : e-reporting.",
  },
  not_business: {
    code: "buyer_not_business",
    en: "The buyer is a consumer or a non-registered entity: e-reporting.",
    fr: "L'acheteur est un particulier ou une entité non assujettie : e-reporting.",
  },
  public_entity: {
    code: "public_entity_chorus_pro",
    en: "Public entities are invoiced through Chorus Pro: out of scope.",
    fr: "Les entités publiques sont facturées via Chorus Pro : hors périmètre.",
  },
  e_invoice: {
    code: "fr_business_with_siren",
    en: "French business buyer with an active SIREN: e-invoicing.",
    fr: "Acheteur professionnel français avec un SIREN actif : facturation électronique.",
  },
} as const

function err(code: ClassifyErrorCode, en: string, fr: string): ClassifyResult {
  return { regime: null, error: { code }, reasons: [{ code, en, fr }] }
}

export function classifyRegime(input: ClassifyInput): ClassifyResult {
  // 1
  if (input.docType !== "invoice" && input.docType !== "credit_note") {
    return { regime: "out_of_scope", reasons: [R.not_invoice] }
  }
  // 2
  if ((input.issuerCountry ?? "").trim().toUpperCase() !== "FR" || !input.issuerVatRegistered) {
    return { regime: "out_of_scope", reasons: [R.issuer_out] }
  }
  // 3
  if (input.docType === "credit_note" && input.original?.regime) {
    const cancelled = ["refused", "rejected"].includes(input.original.transmissionStatus ?? "")
    return {
      regime: input.original.regime,
      reasons: cancelled ? [R.credit_follows, R.internal_cancel] : [R.credit_follows],
      ...(cancelled ? { internalCancellation: true } : {}),
    }
  }
  // 4
  const terr = buyerTerritory(input)
  let french = terr.territory === "FR"
  if (terr.territory === "needs_review") {
    if (input.territoryTreatment === "as_fr") french = true
    else if (input.territoryTreatment !== "as_foreign") {
      return { regime: "needs_review", reasons: [R.needs_review(terr.code ?? "buyer_country_missing")] }
    }
  }
  // 5
  if (!french) return { regime: "e_reporting", reasons: [R.foreign] }
  // 6
  const kind = input.customerKind
  if (!kind) {
    return err(
      "customer_kind_missing",
      "The customer kind (business, individual, ...) is required for a French buyer.",
      "Le type de client (professionnel, particulier, ...) est requis pour un acheteur français.",
    )
  }
  // 7
  if (kind === "individual" || kind === "non_registered_entity") return { regime: "e_reporting", reasons: [R.not_business] }
  if (kind === "public_entity") return { regime: "out_of_scope", reasons: [R.public_entity] }
  // 8
  const siren = (input.buyerSiren ?? "").trim()
  if (!siren) {
    return err(
      "einvoice_data_missing",
      "A French business buyer needs a SIREN.",
      "Un acheteur professionnel français doit avoir un SIREN.",
    )
  }
  if (!isValidSiren(siren)) {
    return err("siren_invalid", "The buyer's SIREN is not valid.", "Le SIREN de l'acheteur n'est pas valide.")
  }
  if (input.sirenStatus === "C") {
    return err(
      "siren_inactive",
      "The buyer's SIREN is ceased in the business registry.",
      "Le SIREN de l'acheteur est radié du registre des entreprises.",
    )
  }
  // 9
  return { regime: "e_invoice", reasons: [R.e_invoice] }
}
