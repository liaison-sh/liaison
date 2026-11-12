// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pennylane's received-invoice status words and reason slugs, mapped onto the contract's received
// states and the official reason codes (annexe 7 "Tableau des motifs de refus"). The reason
// slugs and the per-status lists are Pennylane's documented `PUT
// /supplier_invoices/{id}/e_invoice_status` enums; the code each maps to is inferred from the
// slug's meaning (no Pennylane document states it) and is on the accountant sign-off list. A slug
// with no specific official code maps to AUTRE.
import type { AfnorReasonCode, ReceivedReason, ReceivedState } from "@liaison/app-sdk/contracts"
import { AFNOR_REASON_CODES } from "@liaison/app-sdk/contracts"

/** `e_invoicing.status` on a supplier invoice → received state. null = implicitly approved by
 *  nobody yet: received. */
export const PENNYLANE_RECEIVED_STATUS: Readonly<Record<string, ReceivedState>> = {
  waiting_for_validation: "received",
  approved: "approved",
  disputed: "in_dispute",
  refused: "refused",
  rejected: "rejected",
  partially_collected: "partially_collected",
  collected: "collected",
}

/** The status word Pennylane takes for each contract status. */
export const PENNYLANE_STATUS_FOR: Readonly<Record<"refused" | "in_dispute" | "approved", string>> =
  {
    refused: "refused",
    in_dispute: "disputed",
    approved: "approved",
  }

const r = (
  reason: string,
  afnor_code: AfnorReasonCode,
  label_en: string,
  label_fr: string,
): ReceivedReason => ({
  reason,
  afnor_code,
  label_en,
  label_fr,
})

/** Refusal reasons (terminal; Pennylane archives the invoice). */
export const REFUSE_REASONS: readonly ReceivedReason[] = [
  r("incorrect_vat_rate", "TX_TVA_ERR", "Incorrect VAT rate", "Taux de TVA erroné"),
  r("incorrect_prices", "PU_ERR", "Incorrect prices", "Prix erronés"),
  r("duplicate_invoice", "DOUBLON", "Duplicate invoice", "Facture en double"),
  r("recipient_error", "DEST_ERR", "Not addressed to us", "Erreur de destinataire"),
  r("non_compliant_invoice", "NON_CONFORME", "Non-compliant invoice", "Facture non conforme"),
  r("contract_completed", "AUTRE", "The contract has ended", "Contrat terminé"),
]

/** Dispute reasons (the invoice stays open; the dispute can be withdrawn). */
export const DISPUTE_REASONS: readonly ReceivedReason[] = [
  r("incorrect_vat_rate", "TX_TVA_ERR", "Incorrect VAT rate", "Taux de TVA erroné"),
  r("incorrect_unit_prices", "PU_ERR", "Incorrect unit prices", "Prix unitaires erronés"),
  r(
    "incorrect_billed_quantity",
    "QTE_ERR",
    "Incorrect quantity billed",
    "Quantité facturée erronée",
  ),
  r("incorrect_billed_item", "ART_ERR", "Wrong item billed", "Article facturé erroné"),
  r(
    "defective_delivered_item",
    "QUALITE_ERR",
    "Defective item delivered",
    "Article livré défectueux",
  ),
  r("delivery_issue", "LIVR_INCOMP", "Delivery issue", "Problème de livraison"),
  r(
    "missing_legal_notice",
    "NON_CONFORME",
    "A legal mention is missing",
    "Mention légale manquante",
  ),
  r("recipient_error", "DEST_ERR", "Not addressed to us", "Erreur de destinataire"),
  r("bank_details_error", "AUTRE", "Wrong bank details", "Coordonnées bancaires erronées"),
  r(
    "incorrect_payment_terms",
    "AUTRE",
    "Incorrect payment terms",
    "Conditions de paiement erronées",
  ),
  r(
    "missing_contractual_reference",
    "AUTRE",
    "Contract reference missing",
    "Référence contractuelle manquante",
  ),
]

/** Official reason codes no Pennylane reason reaches (not observable through this provider). */
export const NOT_OBSERVABLE_REASON_CODES: readonly AfnorReasonCode[] = AFNOR_REASON_CODES.filter(
  (c) =>
    !REFUSE_REASONS.some((x) => x.afnor_code === c) &&
    !DISPUTE_REASONS.some((x) => x.afnor_code === c),
)
