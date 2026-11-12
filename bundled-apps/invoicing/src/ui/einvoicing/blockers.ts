// SPDX-License-Identifier: FSL-1.1-ALv2
//
// E-invoicing blockers as the operator sees them. The issue gate and `einvoicing_classify` name
// each missing item with the tool that fixes it (`fix_tool`); on screen every blocker gets
// exactly ONE action: the field right here in the Editor, or the tab where it is fixed. Pure,
// shared by the Editor, the document's regime line and the readiness tab.
import { tr } from "../i18n"

export type Regime = "e_invoice" | "e_reporting" | "out_of_scope" | "needs_review"
export type GateMode = "warn" | "enforce"
export type CustomerKind = "business" | "individual" | "public_entity" | "non_registered_entity"
export type OperationCategory = "goods" | "services" | "mixed"

export interface MissingItem {
  field: string
  why?: string
  fix_tool: string
  fix_hint?: string
}

export interface RegimeReason {
  code: string
  en?: string
  fr?: string
  missing?: string[]
}

/** The part of an `einvoicing_classify` result the screens read. */
export interface ClassifyVerdict {
  status?: string
  regime?: Regime | null
  reasons?: RegimeReason[]
  gate_mode?: GateMode
  source?: "computed" | "recorded"
  would_refuse?: { code: string; message: string; missing: MissingItem[] } | null
  buyer?: {
    source?: string
    customer_kind?: CustomerKind | null
    legal_name?: string | null
    siren?: string | null
    siren_confirmed?: boolean
  } | null
}

/** The four customer kinds, with the plain-word help shown beside each. */
export const CUSTOMER_KIND_OPTIONS: ReadonlyArray<{
  value: CustomerKind
  label: string
  help: string
}> = [
  { value: "business", label: "Business", help: "A company or a registered professional." },
  { value: "individual", label: "Individual", help: "A private person buying for themselves." },
  {
    value: "public_entity",
    label: "Public entity",
    help: "A public body, invoiced through Chorus Pro.",
  },
  {
    value: "non_registered_entity",
    label: "Non-registered entity",
    help: "An association or body not registered for VAT.",
  },
]

export const OPERATION_CATEGORY_OPTIONS: ReadonlyArray<{
  value: OperationCategory
  label: string
}> = [
  { value: "goods", label: "Goods" },
  { value: "services", label: "Services" },
  { value: "mixed", label: "Goods and services" },
]

/** Plain words for a missing field (never the raw column name). */
const FIELD_LABEL: Record<string, string> = {
  customer_kind: "customer type",
  buyer_siren: "SIREN",
  billing_address: "billing address",
  territory_treatment: "territory treatment",
  operation_category: "operation type",
}

export function missingFieldLabel(field: string): string {
  return tr(FIELD_LABEL[field] ?? field.replace(/_/g, " "))
}

/** Where a blocker is fixed. `field` = an input on the Editor itself; `open` = another tab. */
export type BlockerAction =
  | { kind: "field"; field: string; label: string }
  | { kind: "open"; href: string; label: string }

export interface BlockerContext {
  documentId?: string | null
  contactId?: string | null
  /** Credit note: the invoice it corrects. */
  originalDocumentId?: string | null
  /** True on the Editor, where draft fields are edited in place. */
  inEditor?: boolean
}

/** The identity tab of a counterparty: its contact, or the draft itself when it has no contact. */
export function identityHref(ctx: {
  contactId?: string | null
  documentId?: string | null
}): string | null {
  if (ctx.contactId) return `/invoicing/identity/${ctx.contactId}`
  if (ctx.documentId) return `/invoicing/identity/document:${ctx.documentId}`
  return null
}

/** Exactly one action for a missing item. */
export function blockerAction(item: MissingItem, ctx: BlockerContext): BlockerAction {
  const identity = identityHref(ctx)
  const documentHref = ctx.documentId ? `/invoicing/editor/${ctx.documentId}` : null
  switch (item.fix_tool) {
    case "drafts_update":
      if (ctx.inEditor) {
        const field = item.field === "billing_address" ? "billing_postcode" : item.field
        return { kind: "field", field, label: tr("Fill in this field") }
      }
      if (documentHref) return { kind: "open", href: documentHref, label: tr("Open the draft") }
      break
    case "documents_update": {
      const target = ctx.originalDocumentId ?? ctx.documentId
      if (target)
        return {
          kind: "open",
          href: `/invoicing/document/${target}`,
          label: tr("Open the original invoice"),
        }
      break
    }
    case "counterparty_identity_set":
      if (ctx.inEditor && item.field === "customer_kind") {
        return { kind: "field", field: "customer_kind", label: tr("Fill in this field") }
      }
      break
    default:
      break
  }
  if (identity) return { kind: "open", href: identity, label: tr("Open the customer identity") }
  if (documentHref) return { kind: "open", href: documentHref, label: tr("Open the draft") }
  return { kind: "open", href: "/invoicing/readiness", label: tr("Open e-invoicing readiness") }
}

/** One line naming every missing field in plain words. */
export function missingSummary(missing: MissingItem[]): string {
  return [...new Set(missing.map((m) => missingFieldLabel(m.field)))].join(", ")
}
