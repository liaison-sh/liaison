// SPDX-License-Identifier: FSL-1.1-ALv2
// `einvoicing_readiness` (read only): every counterparty and draft that would stop an e-invoice,
// each blocker with the one tool that fixes it. Computed by the issue gate itself over what is on
// file (the contact's identity, its latest document, its open drafts, the orders parked on it), so
// the blocker codes are the gate's codes and the actions are the gate's own fix tools.
import { type CustomerKind } from "./classify"
import {
  type BuyerSnapshot,
  GATE_BLOCKER_TOOLS,
  type GateCode,
  type GateIssuer,
  type MissingItem,
  EINVOICE_IDENTITY_PARK_KIND,
  evaluateEinvoiceGate,
  resolveBuyerFacts,
} from "./gate"
import { sirenFromFrVat } from "./identity"
import { deriveKind } from "./identity-derive"
import { readEinvoiceRowColumns } from "./issue-gate"
import { issuerTimezoneUnset } from "../issue-date"

type Row = Record<string, unknown>

interface ReadDb {
  findMany(
    entity: string,
    opts?: { where?: Record<string, unknown>; limit?: number; offset?: number; orderBy?: Record<string, "asc" | "desc"> },
  ): Promise<unknown[]>
}

export interface ReadinessCtx {
  db: ReadDb
}

export const READINESS_EMPTY =
  "Nothing blocks e-invoicing: every French business customer has what an e-invoice needs."

const ACTION_LABELS: Record<string, string> = {
  customer_kind: "Record the customer type",
  siren_missing: "Look up the SIREN in the business registry",
  siren_invalid: "Look up the registered SIREN",
  siren_inactive: "Look up the active SIREN",
  registry_unconfirmed: "Confirm the SIREN in the business registry",
  billing_address: "Add the billing postcode and city",
  siren_missing_contactless_original: "Link the original invoice to its customer",
  territory_treatment: "Decide the territory",
  operation_category: "Set the operation type",
  imported_original: "Restore the imported original",
}

export interface ReadinessBlockerType {
  key: string
  blocker_code: GateCode
  field: string
  tool: string
  label: string
}

/**
 * Every blocker type the readiness list can report, with its one fixing tool: the gate's own
 * (code, field, fix tool) triples, plus the imported-original guard's code, fixed by restoring
 * the legacy originals.
 */
export const READINESS_TAXONOMY: readonly ReadinessBlockerType[] = [
  ...GATE_BLOCKER_TOOLS.map((g) => ({
    key: g.key,
    blocker_code: g.code,
    field: g.field,
    tool: g.fix_tool,
    label: ACTION_LABELS[g.key] ?? "Open the customer identity",
  })),
  {
    key: "imported_original",
    blocker_code: "imported_original_missing",
    field: "legal_original",
    tool: "einvoicing_backfill_legacy_originals",
    label: ACTION_LABELS.imported_original as string,
  },
]

export interface ReadinessItem {
  subject: { contact_id?: string; document_id?: string; label?: string }
  blocker_code: GateCode
  field: string
  action: { tool: string; label: string; params_hint: Record<string, unknown> }
  last_document_date: string | null
}

const PAGE = 500
const MAX_ROWS = 5000
export const READINESS_DEFAULT_LIMIT = 50
export const READINESS_MAX_LIMIT = 200

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t ? t : null
}

function upper(v: unknown): string | null {
  return str(v)?.toUpperCase() ?? null
}

function dateOf(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10)
  const s = str(v)
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s.slice(0, 10) : d.toISOString().slice(0, 10)
}

function docTime(d: Row): string {
  const v = d.issued_at ?? d.created_at ?? null
  if (v instanceof Date) return v.toISOString()
  return typeof v === "string" ? v : ""
}

async function readAll(db: ReadDb, entity: string, where?: Record<string, unknown>): Promise<{ rows: Row[]; truncated: boolean }> {
  const rows: Row[] = []
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const page = (await db.findMany(entity, { ...(where ? { where } : {}), orderBy: { id: "asc" }, limit: PAGE, offset })) as Row[]
    rows.push(...page)
    if (page.length < PAGE) return { rows, truncated: false }
  }
  return { rows, truncated: true }
}

function issuerOf(row: Row | undefined): GateIssuer | null {
  if (!row) return null
  return { country: str(row.country), country_code: str(row.country_code), vat_id: str(row.vat_id) }
}

function taxonomyFor(code: GateCode, item: MissingItem): ReadinessBlockerType {
  return (
    READINESS_TAXONOMY.find((t) => t.blocker_code === code && t.field === item.field && t.tool === item.fix_tool) ?? {
      key: item.field,
      blocker_code: code,
      field: item.field,
      tool: item.fix_tool,
      label: ACTION_LABELS[item.field] ?? "Open the customer identity",
    }
  )
}

/** The gate's blockers for an invoice to this buyer, read as the issue site would read them
 *  (identity row first, then the snapshot; kind derived from the snapshot's signals). */
async function blockersFor(args: {
  identities: Map<string, Row>
  issuer: GateIssuer
  contactId: string | null
  snapshot: BuyerSnapshot
  company: string | null
  origin: "shopify" | "manual"
  operationCategory: string | null
}): Promise<Array<{ code: GateCode; item: MissingItem }>> {
  const idDb: ReadDb = {
    findMany: async (entity, opts) => {
      if (entity !== "counterparty_identities") return []
      const id = str(opts?.where?.contact_id)
      const row = id ? args.identities.get(id) : undefined
      return row ? [row] : []
    },
  }
  const buyer = await resolveBuyerFacts(idDb, { docType: "invoice", contact_id: args.contactId, snapshot: args.snapshot })
  if (!buyer.customerKind) {
    const kind: CustomerKind | null = deriveKind({
      vat_id: buyer.vatId,
      company: buyer.vatId ? null : args.company,
      legal_name: args.snapshot.buyer_legal_name ?? null,
      country: buyer.billing.countryCode,
      origin: args.origin,
    })
    if (kind) {
      buyer.customerKind = kind
      if (kind === "business" && !buyer.siren) {
        const fromVat = sirenFromFrVat(buyer.vatId, { billingCountry: buyer.billing.countryCode })
        if (fromVat) {
          buyer.siren = fromVat
          buyer.sirenConfirmed = false
          buyer.confirmedVia = null
        }
      }
    }
  }
  const category = args.operationCategory === "goods" || args.operationCategory === "services" || args.operationCategory === "mixed"
    ? args.operationCategory
    : null
  const ev = evaluateEinvoiceGate({
    docType: "invoice",
    issuer: args.issuer,
    buyer,
    lines: [],
    operationCategory: category,
    operationSource: category ? "explicit" : null,
    paymentState: null,
    original: null,
    mode: "enforce",
  })
  return ev.blockers
}

function documentSnapshot(doc: Row): BuyerSnapshot {
  const cols = readEinvoiceRowColumns(doc)
  return {
    customer_kind: cols.customer_kind ?? null,
    buyer_legal_name: cols.buyer_legal_name ?? str(doc.counterparty_name),
    buyer_siren: cols.buyer_siren ?? null,
    buyer_siret: cols.buyer_siret ?? null,
    // A stored snapshot is not a registry confirmation for a new invoice.
    buyer_siren_confirmed_via: null,
    counterparty_vat_id: cols.counterparty_vat_id ?? null,
    billing_line1: cols.billing_line1 ?? null,
    billing_line2: cols.billing_line2 ?? null,
    billing_postcode: cols.billing_postcode ?? null,
    billing_city: cols.billing_city ?? null,
    billing_country_code: upper(cols.billing_country_code) ?? upper(doc.counterparty_country),
  }
}

function parkSnapshot(payload: Row): { snapshot: BuyerSnapshot; company: string | null; label: string | null } {
  const customer = (payload.customer ?? {}) as Row
  const billing = (customer.billing ?? {}) as Row
  const company = str(billing.company)
  return {
    company,
    label: company ?? str(customer.legal_name) ?? str(customer.email),
    snapshot: {
      customer_kind: null,
      buyer_legal_name: str(customer.legal_name) ?? company,
      buyer_siren: null,
      buyer_siret: null,
      buyer_siren_confirmed_via: null,
      counterparty_vat_id: str(customer.vat_id),
      billing_line1: str(billing.line1),
      billing_line2: str(billing.line2),
      billing_postcode: str(billing.postcode) ?? str(billing.zip),
      billing_city: str(billing.city),
      billing_country_code: upper(billing.country_code) ?? upper(customer.country),
    },
  }
}

export async function einvoicingReadiness(
  ctx: ReadinessCtx,
  input: { limit?: number | null } = {},
): Promise<Row> {
  const requested = Number(input?.limit ?? READINESS_DEFAULT_LIMIT)
  const limit = Math.min(READINESS_MAX_LIMIT, Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : READINESS_DEFAULT_LIMIT))

  const issuerRows = (await ctx.db.findMany("issuer_profiles", { limit: 50 })) as Row[]
  const issuers = new Map(issuerRows.map((r) => [String(r.id), r]))
  const defaultIssuer = issuerOf(issuerRows.find((r) => !r.archived_at) ?? issuerRows[0])
  if (!defaultIssuer) {
    return { status: "ok", items: [], count: 0, message: "No issuer profile is configured: nothing is invoiced yet." }
  }

  const [docsRead, idsRead, parks] = await Promise.all([
    readAll(ctx.db, "documents"),
    readAll(ctx.db, "counterparty_identities"),
    ctx.db.findMany("deferred_events", { where: { status: "awaiting_data" }, limit: PAGE }) as Promise<Row[]>,
  ])
  const identities = new Map<string, Row>()
  for (const r of idsRead.rows) if (str(r.contact_id)) identities.set(String(r.contact_id), r)

  const byContact = new Map<string, Row[]>()
  const contactlessDrafts: Row[] = []
  for (const d of docsRead.rows) {
    const c = str(d.counterparty_contact_id)
    if (c) byContact.set(c, [...(byContact.get(c) ?? []), d])
    else if (d.status === "draft" && d.type === "invoice") contactlessDrafts.push(d)
  }

  const items: ReadinessItem[] = []
  const seen = new Set<string>()
  const push = (item: ReadinessItem) => {
    const key = `${item.subject.contact_id ?? ""}|${item.subject.document_id ?? ""}|${item.blocker_code}|${item.action.tool}|${item.field}`
    if (seen.has(key)) return
    seen.add(key)
    items.push(item)
  }
  const itemFor = (
    b: { code: GateCode; item: MissingItem },
    subject: ReadinessItem["subject"],
    lastDate: string | null,
  ): ReadinessItem => {
    const t = taxonomyFor(b.code, b.item)
    const hint: Record<string, unknown> =
      subject.document_id && (t.tool === "drafts_update" || t.tool === "documents_update" || !subject.contact_id)
        ? { document_id: subject.document_id }
        : { contact_id: subject.contact_id }
    return {
      subject,
      blocker_code: b.code,
      field: t.field,
      action: { tool: t.tool, label: t.label, params_hint: hint },
      last_document_date: lastDate,
    }
  }

  // Counterparties with documents: an invoice to them, as on file.
  for (const [contactId, docs] of byContact) {
    const sorted = [...docs].sort((a, b) => (docTime(a) < docTime(b) ? 1 : docTime(a) > docTime(b) ? -1 : 0))
    const latest = sorted.find((d) => d.status !== "draft") ?? sorted[0]
    if (!latest) continue
    const issuer = issuerOf(issuers.get(String(latest.issuer_profile_id))) ?? defaultIssuer
    const idn = identities.get(contactId)
    const label = str(idn?.registry_name) ?? str(latest.buyer_legal_name) ?? str(latest.counterparty_name) ?? undefined
    const lastDate = dateOf(latest.issued_at ?? latest.created_at)
    const drafts = sorted.filter((d) => d.status === "draft" && d.type === "invoice")
    const blockers = await blockersFor({
      identities,
      issuer,
      contactId,
      snapshot: documentSnapshot(latest),
      company: null,
      origin: docs.some((d) => str(d.shopify_order_id)) ? "shopify" : "manual",
      operationCategory: "goods",
    })
    for (const b of blockers) {
      // A gap fixed on a draft points at the open draft when there is one.
      const draft = b.item.fix_tool === "drafts_update" ? drafts[0] : undefined
      push(itemFor(b, { contact_id: contactId, ...(draft ? { document_id: String(draft.id) } : {}), ...(label ? { label } : {}) }, lastDate))
    }
    // Each open draft's own gaps (operation type, billing): the identity's are listed above.
    for (const draft of drafts) {
      const own = await blockersFor({
        identities,
        issuer: issuerOf(issuers.get(String(draft.issuer_profile_id))) ?? issuer,
        contactId,
        snapshot: documentSnapshot(draft),
        company: null,
        origin: "manual",
        operationCategory: str(draft.operation_category),
      })
      for (const b of own) {
        if (b.item.fix_tool !== "drafts_update") continue
        push(itemFor(b, { contact_id: contactId, document_id: String(draft.id), ...(label ? { label } : {}) }, dateOf(draft.created_at)))
      }
    }
  }

  // Contactless drafts: every gap is fixed on the draft (identity tools accept its document_id).
  for (const draft of contactlessDrafts) {
    const own = await blockersFor({
      identities,
      issuer: issuerOf(issuers.get(String(draft.issuer_profile_id))) ?? defaultIssuer,
      contactId: null,
      snapshot: documentSnapshot(draft),
      company: null,
      origin: "manual",
      operationCategory: str(draft.operation_category),
    })
    const label = str(draft.buyer_legal_name) ?? str(draft.counterparty_name) ?? undefined
    for (const b of own) push(itemFor(b, { document_id: String(draft.id), ...(label ? { label } : {}) }, dateOf(draft.created_at)))
  }

  // Buyers known only from an order parked on their identity (no document yet).
  for (const park of parks) {
    const blockedOn = (park.blocked_on ?? {}) as Row
    if (blockedOn.kind !== EINVOICE_IDENTITY_PARK_KIND) continue
    const contactId = str(park.contact_id) ?? str(blockedOn.contact_id)
    if (!contactId || byContact.has(contactId)) continue
    const p = parkSnapshot((park.event_payload_json ?? {}) as Row)
    const blockers = await blockersFor({
      identities,
      issuer: defaultIssuer,
      contactId,
      snapshot: p.snapshot,
      company: p.company,
      origin: "shopify",
      operationCategory: "goods",
    })
    for (const b of blockers) push(itemFor(b, { contact_id: contactId, ...(p.label ? { label: p.label } : {}) }, null))
  }

  // Never a blocker: documents keep issuing. One line per live issuer, gone once a zone is chosen.
  const unsetZones = issuerRows
    .filter((r) => !r.archived_at && issuerTimezoneUnset(r))
    .map((r) => ({
      issuer_profile_id: String(r.id),
      legal_name: str(r.legal_name),
      message:
        "No time zone was chosen for this issuer. Its issue dates and number years follow the organization's " +
        "time zone, or UTC when the organization has none. Ask which zone it issues in, once.",
      action: {
        tool: "settings_issuer_profile_update",
        label: "Choose the issuer's time zone",
        params_hint: { id: String(r.id), timezone: "Europe/Paris" },
      },
    }))

  items.sort((a, b) => {
    const da = a.last_document_date ?? ""
    const db = b.last_document_date ?? ""
    return da < db ? 1 : da > db ? -1 : 0
  })
  return {
    status: "ok",
    items: items.slice(0, limit),
    count: items.length,
    ...(docsRead.truncated || idsRead.truncated ? { truncated: true } : {}),
    ...(items.length === 0 ? { message: READINESS_EMPTY } : {}),
    ...(unsetZones.length > 0 ? { issuer_time_zones_to_choose: unsetZones } : {}),
  }
}
