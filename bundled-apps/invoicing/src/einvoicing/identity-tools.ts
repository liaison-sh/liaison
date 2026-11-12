// SPDX-License-Identifier: FSL-1.1-ALv2
// Counterparty identity tools: read the identity, look the buyer up in the business registry,
// record an identity, record a territory treatment.
//
// Write rule (D28): a SIREN is written without a human only when the registry, re-queried by that
// SIREN, returns it active under a name matching the counterparty's own (§4.4 rule). A name
// mismatch, a 0-result answer, a registry outage or rate limit, a ceased SIREN, or overwriting a
// confirmed SIREN with another value asks for an identity confirmation instead and writes nothing
// until it is approved. A web page is never the source of a SIREN by itself.
import type { CrossAppExecuteTool } from "../cross-app"
import { isSirenConfirmed, isValidSiren, isValidSiret, sirenFromFrVat } from "./identity"
import { readEinvoiceRowColumns } from "./issue-gate"
import {
  type RegistryCandidate,
  type RegistryFetchCtx,
  candidateMatchesName,
  registrySearch,
  registrySearchUrl,
} from "./lookup"

type Row = Record<string, unknown>

export interface IdentityToolsCtx extends RegistryFetchCtx {
  db: {
    findMany(entity: string, opts?: { where?: Record<string, unknown>; limit?: number }): Promise<unknown[]>
    insert(entity: string, data: Record<string, unknown>): Promise<unknown>
    update(entity: string, id: string, data: Record<string, unknown>): Promise<unknown>
  }
  executeTool?: CrossAppExecuteTool
  approval?: { approvalRequestId: string; approvalDeciderId: string; toolName: string } | null
  requestApproval?(input: {
    tool_name: string
    summary: string
    summary_detail?: { subtitle?: string; lines?: string[] }
    current_payload: unknown
    editable_fields?: string[]
    /** `auto_approved: true`: carry on now (a person's own call holding the deciding scope is
     *  granted inline, no approval row; or an org auto-approve policy approved it). */
  }): Promise<{ approval_id: string; auto_approved?: undefined } | { approval_id: string | null; auto_approved: true }>
  emit?(event: { entity: string; action: string; entityId?: string; data?: unknown }): Promise<void>
  getUserId?(): Promise<string>
}

type ToolError = { status: "error"; error: { code: string; message: string } }

function fail(code: string, message: string): ToolError {
  return { status: "error", error: { code, message } }
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t ? t : null
}

function digits(v: unknown): string | null {
  const s = str(v)
  return s ? s.replace(/[\s.]/g, "") : null
}

const KINDS = ["business", "individual", "public_entity", "non_registered_entity"] as const
const SOURCES = ["registry", "vat_derived", "agent_web", "manual"] as const
type Kind = (typeof KINDS)[number]

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null
}

async function identityRow(ctx: IdentityToolsCtx, contactId: string): Promise<Row | null> {
  const rows = (await ctx.db.findMany("counterparty_identities", { where: { contact_id: contactId }, limit: 1 })) as Row[]
  return rows[0] ?? null
}

async function documentRow(ctx: IdentityToolsCtx, id: string): Promise<Row | null> {
  const rows = (await ctx.db.findMany("documents", { where: { id }, limit: 1 })) as Row[]
  return rows[0] ?? null
}

/** Names the orders parked on this contact's identity carry (the checkout's billing company and
 *  customer name): the counterparty a waiting order is about. Bounded, filtered by contact. */
async function parkedOrderNames(ctx: IdentityToolsCtx, contactId: string): Promise<string[]> {
  let rows: Row[] = []
  try {
    rows = (await ctx.db.findMany("deferred_events", { where: { contact_id: contactId, status: "awaiting_data" }, limit: 10 })) as Row[]
  } catch {
    return []
  }
  return rows.flatMap((r) => {
    const customer = ((r.event_payload_json ?? {}) as Row).customer as Row | undefined
    const billing = (customer?.billing ?? null) as Row | null
    return [str(billing?.company), str(customer?.legal_name)].filter((n): n is string => !!n)
  })
}

/** The contact's documents (bounded): the names it was invoiced under and its billing country. */
async function contactDocuments(ctx: IdentityToolsCtx, contactId: string): Promise<Row[]> {
  return (await ctx.db.findMany("documents", { where: { counterparty_contact_id: contactId }, limit: 10 })) as Row[]
}

async function kernelContact(ctx: IdentityToolsCtx, contactId: string): Promise<{ name: string | null; company: string | null }> {
  if (!ctx.executeTool) return { name: null, company: null }
  try {
    const env = await ctx.executeTool("kernel:contacts_read", { contactId })
    if (env.status !== "completed") return { name: null, company: null }
    const c = (env.result as { contact?: { name?: unknown; company?: unknown } } | null | undefined)?.contact
    return { name: str(c?.name), company: str(c?.company) }
  } catch {
    return { name: null, company: null }
  }
}

interface Counterparty {
  contactId: string | null
  /** Contactless document target. */
  document: Row | null
  /** The names a registry name may match: the kernel contact's company, the names on its issued
   *  invoices and on orders parked on it, and the person's name for a sole trader only. */
  names: string[]
  /** The label shown on an approval card. */
  label: string
  /** The kernel contact's company name (null for a contactless draft). */
  company: string | null
  billingCountry: string | null
  vatId: string | null
}

function docNames(docs: Row[]): string[] {
  return docs.flatMap((d) => [str(d.buyer_legal_name), str(d.counterparty_name)]).filter((n): n is string => !!n)
}

/** An issued invoice: its buyer name went through the gated issue path (or the order-paid flow),
 *  so it may stand as a name the counterparty is known under. A draft, a quote or a proforma is
 *  named by whoever created it (drafts are ungated) and never counts. */
function isIssuedInvoice(d: Row): boolean {
  return d.type === "invoice" && typeof d.status === "string" && d.status !== "draft"
}

async function resolveCounterparty(
  ctx: IdentityToolsCtx,
  input: { contact_id?: string | null; document_id?: string | null },
): Promise<Counterparty | ToolError> {
  let contactId = str(input.contact_id)
  let document: Row | null = null
  if (!contactId && str(input.document_id)) {
    document = await documentRow(ctx, String(input.document_id))
    if (!document) return fail("row_not_found", `document ${input.document_id} not found`)
    contactId = str(document.counterparty_contact_id)
    if (contactId) document = null
  }
  if (!contactId && !document) return fail("invalid_input", "pass contact_id or document_id")
  if (document) {
    // A contactless target is a draft (issued ones are refused): its name is the creator's claim,
    // so nothing confirms a SIREN against it and a SIREN on it always asks a human.
    const shown = docNames([document])
    const names = isIssuedInvoice(document) ? shown : []
    return {
      contactId: null,
      document,
      names,
      label: shown[0] ?? "(unnamed counterparty)",
      company: null,
      billingCountry: str(document.billing_country_code) ?? str(document.counterparty_country),
      vatId: str(document.counterparty_vat_id),
    }
  }
  const id = contactId as string
  const [contact, docs, idn, parked] = await Promise.all([
    kernelContact(ctx, id),
    contactDocuments(ctx, id),
    identityRow(ctx, id),
    parkedOrderNames(ctx, id),
  ])
  const issued = docs.filter(isIssuedInvoice)
  const vatId = str(idn?.vat_id) ?? issued.map((d) => str(d.counterparty_vat_id)).find((v) => !!v) ?? null
  // The person's own name counts only for a sole trader: a contact with a company or a VAT id is
  // that company, and a homonym sole trader must never confirm it.
  const personName = contact.company || vatId ? null : contact.name
  const names = [...new Set([contact.company, ...docNames(issued), ...parked, personName].filter((n): n is string => !!n))]
  const billingCountry =
    issued.map((d) => str(d.billing_country_code) ?? str(d.counterparty_country)).find((c) => !!c) ?? null
  return {
    contactId: id,
    document: null,
    names,
    label: names[0] ?? contact.name ?? `contact ${id}`,
    company: contact.company,
    billingCountry,
    vatId,
  }
}

/** Every name a contact is known under (its kernel company, the names on its issued invoices, the
 *  orders parked on it, its own name for a sole trader): what a registry name must match (§4.4). */
export async function contactNames(ctx: IdentityToolsCtx, contactId: string): Promise<string[]> {
  const r = await resolveCounterparty(ctx, { contact_id: contactId })
  return isError(r) ? [] : r.names
}

function isError(v: unknown): v is ToolError {
  return !!v && typeof v === "object" && (v as { status?: unknown }).status === "error"
}

// ── counterparty_identity_get ────────────────────────────────────────────────

export async function counterpartyIdentityGet(
  ctx: IdentityToolsCtx,
  input: { contact_id?: string | null; document_id?: string | null },
): Promise<Row | ToolError> {
  let contactId = str(input?.contact_id)
  const documentId = str(input?.document_id)
  if (!contactId && documentId) {
    const doc = await documentRow(ctx, documentId)
    if (!doc) return fail("row_not_found", `document ${documentId} not found`)
    contactId = str(doc.counterparty_contact_id)
    if (!contactId) {
      const snapshot = readEinvoiceRowColumns(doc)
      return {
        status: "ok",
        target: "document",
        document_id: documentId,
        counterparty_name: str(doc.counterparty_name),
        snapshot,
        // A snapshot's own claim is not a registry confirmation for a new invoice; the identity
        // row is. A contactless document is linked to its contact with documents_update.
        confirmed: false,
      }
    }
  }
  if (!contactId) return fail("invalid_input", "pass contact_id or document_id")
  const identity = await identityRow(ctx, contactId)
  // The name the person recognises the customer by, for the editor's heading.
  const cp = await resolveCounterparty(ctx, { contact_id: contactId })
  return {
    status: "ok",
    target: "contact",
    contact_id: contactId,
    counterparty_name: isError(cp) ? null : (cp.names[0] ?? null),
    ...(documentId ? { document_id: documentId } : {}),
    identity,
    confirmed: !!identity && !!str(identity.siren) && isSirenConfirmed(identity as { confirmed_via?: string | null }),
    next_step:
      "This is the stored identity only. Whether an invoice to this counterparty is an e-invoice, and why, comes from einvoicing_classify (contact_id).",
  }
}

// ── counterparty_identity_lookup ─────────────────────────────────────────────

export async function counterpartyIdentityLookup(
  ctx: IdentityToolsCtx,
  input: { contact_id?: string | null; query?: string | null; siren?: string | null; postcode?: string | null },
): Promise<Row | ToolError> {
  const siren = digits(input?.siren)
  if (siren && !isValidSiren(siren)) return fail("siren_invalid", `SIREN ${siren} fails the checksum: it cannot be a registered company.`)
  let cp: Counterparty | null = null
  if (str(input?.contact_id)) {
    const r = await resolveCounterparty(ctx, { contact_id: input.contact_id })
    if (isError(r)) return r
    cp = r
  }
  // FR VAT id first (no network): the SIREN it encodes, never for a Monaco buyer.
  const derived = !siren && cp?.vatId ? sirenFromFrVat(cp.vatId, { billingCountry: cp.billingCountry }) : null
  let q = siren ?? derived ?? str(input?.query) ?? cp?.names[0] ?? null
  if (!q) return fail("invalid_input", "pass a query, a siren, or a contact_id whose name is known")
  let res = await registrySearch(ctx, siren || derived ? { siren: siren ?? derived } : { q, postcode: input?.postcode })
  // A free-text search for a known contact that finds nothing is retried under the name the
  // contact is recorded with: a caller's typo must not read as "the registry does not know it".
  const recorded = cp?.names[0] ?? null
  if (
    res.status === "registry_unconfirmed" &&
    res.reason === "no_result" &&
    !siren &&
    !derived &&
    recorded &&
    recorded.trim().toLowerCase() !== q.trim().toLowerCase()
  ) {
    q = recorded
    res = await registrySearch(ctx, { q, postcode: input?.postcode })
  }
  if (res.status !== "ok") {
    return {
      status: "registry_unconfirmed",
      reason: res.reason,
      query: q,
      ...(derived ? { derived_siren: derived } : {}),
      message:
        res.reason === "no_result"
          ? "The registry returned no company for this search (non-diffusible companies are not listed). Next: web_search the company name with SIREN and web_fetch the best result; a page is only a pointer, so look the SIREN it shows up here, then record it with counterparty_identity_set (source agent_web, source_url the page), which asks a person when the registry does not confirm it. If web_search or web_fetch is refused or blocked, stop there. Never invent a SIREN or guess one (never try made-up numbers here) and never change customer_kind to get past this: if nothing is found, tell the user the SIREN is missing."
          : "The business registry could not be reached. Retry later; a SIREN recorded now is confirmed by a human.",
    }
  }
  const billingPostcode = str(input?.postcode)
  return {
    status: "ok",
    query: q,
    ...(derived ? { derived_siren: derived } : {}),
    expected_names: cp?.names ?? [],
    candidates: res.candidates.map((c) => ({
      ...c,
      active: c.status === "A",
      name_match: cp ? candidateMatchesName(c, cp.names) : null,
      postcode_match: billingPostcode ? c.postcode === billingPostcode : null,
    })),
    next_step:
      "Pick the candidate that is this counterparty (never guess among several) and record it with counterparty_identity_set " +
      `(source "${derived ? "vat_derived" : "registry"}").`,
  }
}

// ── counterparty_identity_set ────────────────────────────────────────────────

export interface IdentitySetInput {
  contact_id?: string | null
  document_id?: string | null
  customer_kind?: string | null
  siren?: string | null
  siret?: string | null
  source?: string | null
  source_url?: string | null
  billing_line1?: string | null
  billing_line2?: string | null
  billing_postcode?: string | null
  billing_city?: string | null
  billing_country_code?: string | null
  notes?: string | null
}

const BILLING_FIELDS = ["billing_line1", "billing_line2", "billing_postcode", "billing_city", "billing_country_code"] as const

interface Flags {
  registry: "ok" | "no_result" | "unreachable" | "rate_limited"
  name_mismatch: boolean
  ceased: boolean
  overwrites_confirmed_siren: boolean
}

export function registryColumns(c: RegistryCandidate | null, now: Date): Row {
  if (!c) return {}
  return {
    registry_name: c.legal_name ?? c.name,
    registry_nature_juridique: c.nature_juridique,
    registry_line1: c.line1,
    registry_postcode: c.postcode,
    registry_city: c.city,
    registry_country_code: c.country_code,
    registry_status: c.status,
    registry_checked_at: now,
  }
}

function proposalFor(c: RegistryCandidate | null, kind: string | null): Row | undefined {
  const nj = c?.nature_juridique ?? ""
  if (nj.startsWith("7") && kind !== "public_entity") {
    return {
      customer_kind: "public_entity",
      note: "The registry lists this SIREN as a public body (legal category 7xxx): public entities are invoiced through Chorus Pro, not as e-invoices. Confirm with counterparty_identity_set customer_kind public_entity.",
    }
  }
  if (nj.startsWith("92")) {
    return {
      customer_kind: null,
      note: "The registry lists this SIREN as an association: confirm whether it is a business (VAT registered) or a non-registered entity.",
    }
  }
  return undefined
}

async function emitResolved(ctx: IdentityToolsCtx, contactId: string): Promise<void> {
  if (!ctx.emit) return
  await ctx.emit({
    entity: "einvoicing",
    action: "identity_missing",
    entityId: contactId,
    data: { contact_id: contactId, resolved: true },
  })
}

/** Insert or update the contact's identity row; every write bumps `changed_at`, which is what
 *  re-drives the parks waiting on this contact (deferred-retry). */
async function upsertIdentity(ctx: IdentityToolsCtx, contactId: string, existing: Row | null, data: Row): Promise<Row> {
  const row = { ...data, changed_at: new Date() }
  if (existing) {
    await ctx.db.update("counterparty_identities", String(existing.id), row)
    return { ...existing, ...row }
  }
  const inserted = (await ctx.db.insert("counterparty_identities", { contact_id: contactId, ...row })) as Row
  return { contact_id: contactId, ...row, ...(inserted ?? {}) }
}

export async function counterpartyIdentitySet(
  ctx: IdentityToolsCtx,
  input: IdentitySetInput,
): Promise<Row | ToolError> {
  const source = oneOf(input?.source, SOURCES)
  if (!source) return fail("invalid_input", `source must be one of ${SOURCES.join(", ")}`)
  const kindRaw = str(input.customer_kind)
  const kind = kindRaw ? oneOf(kindRaw, KINDS) : null
  if (kindRaw && !kind) return fail("invalid_input", `customer_kind must be one of ${KINDS.join(", ")}`)
  const siren = digits(input.siren)
  if (siren && !isValidSiren(siren)) {
    return fail("siren_invalid", `SIREN ${siren} fails the checksum: look the buyer up with counterparty_identity_lookup.`)
  }
  const siret = digits(input.siret)

  const cp = await resolveCounterparty(ctx, input)
  if (isError(cp)) return cp
  const billing: Row = {}
  for (const f of BILLING_FIELDS) if (str(input[f])) billing[f] = str(input[f])
  if (cp.contactId && Object.keys(billing).length > 0) {
    return fail(
      "invalid_input",
      "A contact's identity holds no billing address: the billing address travels on the document. Pass it on the issuing call's counterparty, or set it on the draft with drafts_update.",
    )
  }
  if (cp.document && cp.document.status !== "draft") {
    return fail(
      "document_not_editable",
      "This issued document is linked to no contact, and an issued document's buyer is never rewritten. Link it to its buyer's contact with documents_update (counterparty_contact_id), then record the identity on that contact.",
    )
  }
  const existing = cp.contactId ? await identityRow(ctx, cp.contactId) : null
  const effectiveSiren = siren ?? str(existing?.siren) ?? str(cp.document?.buyer_siren)
  if (siret && (!isValidSiret(siret) || !effectiveSiren || !siret.startsWith(effectiveSiren))) {
    return fail("siren_invalid", `SIRET ${siret} is not a valid establishment number of SIREN ${effectiveSiren ?? "(none)"}.`)
  }
  const notes = str(input.notes)

  // No SIREN: kind / SIRET / notes / billing only. No registry decision involved.
  if (!siren) {
    if (cp.document) {
      const patch: Row = { ...billing, ...(kind ? { customer_kind: kind } : {}), ...(siret ? { buyer_siret: siret } : {}) }
      await ctx.db.update("documents", String(cp.document.id), patch)
      return { status: "ok", target: "document", document_id: String(cp.document.id), written: patch }
    }
    const contactId = cp.contactId as string
    // Who the buyer is decides whether its invoices are e-invoices: recording a company (or a
    // buyer already recorded as a business) as anything else takes a person's confirmation.
    const leavesBusiness =
      !!kind && kind !== "business" && (!!cp.company || str(existing?.customer_kind) === "business")
    if (leavesBusiness && !ctx.approval) {
      if (!ctx.requestApproval) return fail("approval_required", "Changing this buyer's kind away from business needs a person's confirmation.")
      const approval = await ctx.requestApproval({
        tool_name: "invoicing:counterparty_identity_set",
        summary: `Confirm ${cp.label} is not a business (${kind})`,
        summary_detail: {
          subtitle: "Customer kind change: a business buyer is invoiced electronically, any other kind is not",
          lines: [
            `Counterparty: ${cp.label}`,
            `Company on the contact: ${cp.company ?? "(none)"}`,
            `Recorded kind: ${str(existing?.customer_kind) ?? "(none)"}`,
            `New kind: ${kind}`,
            `Source: ${source}${notes ? `, note: ${notes}` : ""}`,
          ],
        },
        current_payload: input,
        editable_fields: [],
      })
      if (!approval.auto_approved) return {
        status: "pending_approval",
        approval_id: approval.approval_id,
        message: `Nothing was recorded: ${cp.label} is known as a company, so recording it as ${kind} needs a person's confirmation. Do not issue its invoice under another kind meanwhile.`,
      }
    }
    const data: Row = {
      ...(kind ? { customer_kind: kind } : {}),
      ...(siret ? { siret } : {}),
      ...(notes ? { notes } : {}),
      ...(existing ? {} : { source }),
    }
    const identity = await upsertIdentity(ctx, contactId, existing, data)
    const settled = (kind && kind !== "business") || isSirenConfirmed(identity as { confirmed_via?: string | null })
    if (settled) await emitResolved(ctx, contactId)
    return { status: "ok", target: "contact", contact_id: contactId, identity, confirmed_via: identity.confirmed_via ?? null }
  }

  const now = new Date()
  const res = await registrySearch(ctx, { siren })
  const candidate = res.status === "ok" ? (res.candidates[0] ?? null) : null
  const approved = !!ctx.approval
  const flags: Flags = {
    registry: res.status === "ok" ? "ok" : res.reason,
    name_mismatch: !!candidate && !candidateMatchesName(candidate, cp.names),
    ceased: candidate?.status === "C",
    overwrites_confirmed_siren:
      !!existing && !!str(existing.siren) && str(existing.siren) !== siren && isSirenConfirmed(existing as { confirmed_via?: string | null }),
  }
  const confirmedByRegistry =
    flags.registry === "ok" && candidate?.status === "A" && !flags.name_mismatch && !flags.overwrites_confirmed_siren

  if (!confirmedByRegistry && !approved) {
    if (!ctx.requestApproval) return fail("registry_unconfirmed", "The SIREN could not be confirmed against the registry.")
    const why: string[] = []
    if (flags.registry !== "ok") why.push(`registry ${flags.registry === "no_result" ? "returned no company for this SIREN" : `was ${flags.registry.replace("_", " ")}`}`)
    if (flags.name_mismatch) why.push("the registered name does not match the counterparty")
    if (flags.ceased) why.push("the company is ceased in the registry")
    if (flags.overwrites_confirmed_siren) why.push(`it replaces the confirmed SIREN ${String(existing?.siren)}`)
    const approval = await ctx.requestApproval({
      tool_name: "invoicing:counterparty_identity_set",
      summary: `Confirm SIREN ${siren} for ${cp.label}`,
      summary_detail: {
        subtitle: `Identity confirmation: ${why.join("; ")}`,
        lines: [
          `Counterparty: ${cp.label}`,
          `Registry name: ${candidate ? (candidate.name ?? candidate.legal_name ?? "(none)") : "(no registry answer)"}`,
          `SIREN: ${siren}`,
          `Head office city: ${candidate?.city ?? "(unknown)"}`,
          `Source: ${source}${str(input.source_url) ? ` ${str(input.source_url)}` : ""}`,
          flags.name_mismatch ? "Name check: the registered name does not match the counterparty" : `Name check: ${candidate ? "matches" : "not possible"}`,
        ],
      },
      current_payload: input,
      editable_fields: [],
    })
    // Granted inline (a person's own call holding the deciding scope): their call is the
    // confirmation, recorded below as confirmed by approval.
    if (!approval.auto_approved) return {
      status: "pending_approval",
      approval_id: approval.approval_id,
      flags,
      message: `Nothing was recorded: SIREN ${siren} needs a human confirmation (${why.join("; ")}).`,
    }
  }

  const confirmedVia = confirmedByRegistry && !approved ? "auto" : "approval"
  const confirmation: Row = {
    confirmed_via: confirmedVia,
    ...(confirmedVia === "approval"
      ? { approval_request_id: ctx.approval?.approvalRequestId ?? null, verified_by: ctx.approval?.approvalDeciderId ?? null }
      : {}),
  }
  const proposal = proposalFor(candidate, kind ?? str(existing?.customer_kind))

  if (cp.document) {
    const patch: Row = {
      ...billing,
      customer_kind: kind ?? str(cp.document.customer_kind) ?? "business",
      buyer_siren: siren,
      buyer_siret: siret ?? null,
      buyer_siren_confirmed_via: confirmedVia,
    }
    await ctx.db.update("documents", String(cp.document.id), patch)
    return { status: "ok", target: "document", document_id: String(cp.document.id), written: patch, flags, ...(proposal ? { proposal } : {}) }
  }

  const contactId = cp.contactId as string
  const sirenChanged = str(existing?.siren) !== siren
  const identity = await upsertIdentity(ctx, contactId, existing, {
    customer_kind: kind ?? str(existing?.customer_kind) ?? "business",
    siren,
    siret: siret ?? (sirenChanged ? null : (existing?.siret ?? null)),
    ...registryColumns(candidate, now),
    source,
    // A SIREN taken from the registry keeps the registry answer that confirmed it as provenance.
    source_url: str(input.source_url) ?? (source === "registry" && candidate ? registrySearchUrl({ siren }) : null),
    ...(notes ? { notes } : {}),
    ...confirmation,
  })
  await emitResolved(ctx, contactId)
  return {
    status: "ok",
    target: "contact",
    contact_id: contactId,
    identity,
    confirmed_via: confirmedVia,
    flags,
    ...(proposal ? { proposal } : {}),
  }
}

// ── counterparty_territory_set (gated by the kernel) ────────────────────────

export async function counterpartyTerritorySet(
  ctx: IdentityToolsCtx,
  input: { contact_id?: string | null; treatment?: string | null; reason?: string | null },
): Promise<Row | ToolError> {
  const contactId = str(input?.contact_id)
  if (!contactId) return fail("invalid_input", "contact_id is required")
  const treatment = oneOf(input.treatment, ["as_fr", "as_foreign"] as const)
  if (!treatment) return fail("invalid_input", "treatment must be as_fr or as_foreign")
  const reason = str(input.reason)
  if (!reason) return fail("invalid_input", "reason is required: say why this territory is treated this way")
  const existing = await identityRow(ctx, contactId)
  const identity = await upsertIdentity(ctx, contactId, existing, {
    territory_treatment: treatment,
    territory_reason: reason,
    ...(existing ? {} : { source: "manual" }),
  })
  await emitResolved(ctx, contactId)
  return { status: "ok", contact_id: contactId, identity }
}
