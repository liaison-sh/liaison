// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sending and booking through the bound PA provider, at the invoicing app's level, with the real
// Pennylane adapter over its recorded-shape fake behind a contract-call stub: eligibility and the
// approval binding re-derived from the database, staging (approval requests only), the prepared
// row, the job's one-step-per-row machine, monotonic statuses, the inbox drain with orphans, the
// daily booking batch under one approval, its summary, and the booked-must-not-be-e-invoiced
// invariant.
import { beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ContractEnvelope } from "@liaison/app-sdk/contracts"
import { createMockDb, type ManifestSchema } from "@liaison/test-helpers/mock-db"
import { LedgerDouble } from "../test-effects"
import { ciiXml } from "../../../pennylane/src/einvoicing/fake/fixtures"
import { PennylaneFake } from "../../../pennylane/src/einvoicing/fake/server"
import { recordStatusChange } from "../../../pennylane/src/einvoicing/inbox"
import * as plOps from "../../../pennylane/src/einvoicing/ops"
import { base64, utf8Bytes } from "../legal-originals/bytes"
import { bookDailyJob, bookingInvariantJob, einvoiceBookBatch, stepBook, summariseBatches } from "./booking"
import {
  drainStatusChanges,
  type EinvCtx,
  einvoiceSend,
  einvoiceSendRequest,
  refreshStatus,
  sendFacts,
  onOrAfterCutover,
  parisCivilDate,
  stageSendAfterIssue,
  stageSendApproval,
  transmitTick,
} from "./transmit"

const SCHEMA = (JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "app.manifest.json"), "utf8")) as { schema: ManifestSchema }).schema
const PL_SCHEMA = (JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "pennylane", "app.manifest.json"), "utf8")) as { schema: ManifestSchema }).schema

const SIREN = "900000001"
const CONTACT = "00000000-0000-4000-8000-00000000c001"
const OPS: Record<string, keyof typeof plOps> = {
  registration_status: "einvoicingRegistrationStatus",
  find_einvoice: "einvoicingFind",
  submit_einvoice: "einvoicingSubmit",
  advance_einvoice: "einvoicingAdvance",
  get_einvoice_status: "einvoicingStatus",
  list_status_changes: "einvoicingStatusChanges",
  find_booking: "einvoicingFindBooking",
  book_sale: "einvoicingBook",
}

type Row = Record<string, unknown>

function world() {
  const db = createMockDb({}, { ids: "uuid", stampCreatedAt: true, bridgeWhereOperators: true, orderByManifestSchema: SCHEMA })
  const plDb = createMockDb({}, { ids: "uuid", stampCreatedAt: true, bridgeWhereOperators: true, orderByManifestSchema: PL_SCHEMA })
  const fake = new PennylaneFake()
  fake.directory[SIREN] = [SIREN]
  const xmlByFile = new Map<string, string>()
  const plCtx = {
    orgId: "org",
    db: plDb,
    fetch: fake.sandboxFetch,
    connections: { pennylane: { getCredentials: async () => ({ apiToken: "tok", scope: "company" }) } },
  }
  const calls: Array<{ op: string; params: Row; provider: string }> = []
  // A second PA app installed beside it (an organisation may switch platform).
  const otherFake = new PennylaneFake()
  const otherCtx = {
    orgId: "org",
    db: createMockDb({}, { ids: "uuid", stampCreatedAt: true, bridgeWhereOperators: true, orderByManifestSchema: PL_SCHEMA }),
    fetch: otherFake.sandboxFetch,
    connections: { pennylane: { getCredentials: async () => ({ apiToken: "tok", scope: "company" }) } },
  }
  const kernel = { bound: "pennylane", history: [] as string[] }
  const approvals: Array<Record<string, unknown>> = []
  const approvalStatus = new Map<string, { status: string; expired: boolean }>()
  const events: Array<{ action: string; data: Row }> = []
  // The kernel's dispatch grants, as the contract bridge enforces them: an outbound op needs a
  // grant minted inside a person's decision, covering that op and the params it binds.
  const grants = new Map<string, { ops: string[]; subject: Record<string, string> }>()
  const refusedGrant = async () => ({ status: "error", error: { code: "contract_grant_refused", message: "not inside a person's approval" } })
  const mintGrant = async (_c: string, ops: string[], subject: Record<string, string>) => {
    const token = `grant-${grants.size + 1}`
    grants.set(token, { ops, subject })
    return JSON.stringify({ grant: token })
  }
  const ctx: EinvCtx = {
    db: db as unknown as EinvCtx["db"],
    contracts: {
      call: async (_contract, op, params, opts) => {
        // The kernel's routing: the bound provider, or a pinned one (outbound: only if still bound).
        const pinned = opts?.provider ?? null
        let target = kernel.bound
        if (pinned && pinned !== kernel.bound) {
          if (OUTBOUND.has(op)) return { status: "error", error: { code: "contract_provider_changed", message: "approved for another PA" } } as ContractEnvelope<unknown>
          if (!kernel.history.includes(pinned)) return { status: "error", error: { code: "contract_provider_unavailable", message: "never bound" } } as ContractEnvelope<unknown>
          target = pinned
        }
        if (OUTBOUND.has(op)) {
          const g = opts?.grant ? grants.get(opts.grant) : undefined
          if (!g) return { status: "error", error: { code: "contract_grant_required", message: "no grant" } } as ContractEnvelope<unknown>
          if (!g.ops.includes(op) || Object.entries(g.subject).some(([k, v]) => params[k] !== v)) {
            return { status: "error", error: { code: "contract_grant_mismatch", message: "grant does not cover the call" } } as ContractEnvelope<unknown>
          }
        }
        calls.push({ op, params, provider: target })
        const fn = plOps[OPS[op]!] as (p: unknown, c: unknown) => Promise<unknown>
        return { status: "completed", result: await fn(params, target === "pennylane" ? plCtx : otherCtx), provider: target } as ContractEnvelope<unknown>
      },
      grant: refusedGrant,
    },
    files_getAttachmentBytes: async (json) => {
      const { fileId } = JSON.parse(json) as { fileId: string }
      return JSON.stringify({ bytesBase64: base64(utf8Bytes(xmlByFile.get(fileId) ?? "")) })
    },
    emit: async (e) => {
      events.push({ action: e.action, data: e.data as Row })
    },
    getUserId: async () => "00000000-0000-4000-8000-0000000000u1",
    approval: null,
    requestApproval: async (input) => {
      approvals.push(input as unknown as Record<string, unknown>)
      approvalStatus.set(`appr-${approvals.length}`, { status: "pending", expired: false })
      return { approval_id: `appr-${approvals.length}` }
    },
    approvals: { statusOf: async (id) => JSON.stringify(approvalStatus.get(id) ?? { status: null }) },
  }
  let n = 0
  async function settings(over: Row = {}) {
    await db.insert("einvoicing_settings", {
      gate_mode: "enforce",
      gate_mode_source: "config",
      provider_app: "pennylane",
      cutover_date: "2026-11-01",
      send_enabled: true,
      book_enabled: true,
      changed_by: "00000000-0000-4000-8000-0000000000a1",
      ...over,
    })
  }
  async function identity(over: Row = {}) {
    await db.insert("counterparty_identities", {
      contact_id: CONTACT,
      customer_kind: "business",
      siren: SIREN,
      routing_address: SIREN,
      registry_name: "CLIENT EXEMPLE",
      registry_city: "Lyon",
      registry_status: "A",
      source: "registry",
      confirmed_via: "auto",
      ...over,
    })
  }
  /** An issued document with its legal original (and Factur-X XML for an e-invoice). */
  async function doc(over: Row = {}): Promise<Row> {
    n += 1
    const number = `FA-2026-${String(n).padStart(4, "0")}`
    const issued = (over.issued_at as string) ?? "2026-11-03"
    const regime = (over.regime as string) ?? "e_invoice"
    const loFile = `00000000-0000-4000-8000-${String(1000 + n).padStart(12, "0")}`
    const sha = n.toString(16).padStart(64, "c")
    const d = (await db.insert("documents", {
      type: "invoice",
      status: "issued",
      number,
      issued_at: issued,
      due_at: "2026-12-03",
      currency: "EUR",
      subtotal_minor: 10000,
      tax_total_minor: 2000,
      grand_total_minor: 12000,
      tax_treatment: regime === "e_invoice" ? "eu_domestic" : "eu_domestic",
      regime,
      customer_kind: regime === "e_invoice" ? "business" : "individual",
      counterparty_contact_id: regime === "e_invoice" ? CONTACT : null,
      counterparty_name: regime === "e_invoice" ? "Client Exemple" : "Celine Exemple",
      buyer_legal_name: regime === "e_invoice" ? "CLIENT EXEMPLE" : "Celine Exemple",
      buyer_siren: regime === "e_invoice" ? SIREN : null,
      buyer_routing_address: regime === "e_invoice" ? SIREN : null,
      billing_line1: "10 rue Domestic",
      billing_postcode: "69002",
      billing_city: "Lyon",
      billing_country_code: "FR",
      pdf_status: "ready",
      legal_original_sha256: sha,
      ...over,
    })) as Row
    const lo = (await db.insert("legal_originals", {
      document_id: d.id,
      kind: regime === "e_invoice" ? "facturx" : "issued_pdf",
      file_id: loFile,
      sha256: sha,
      recorded_at: "2026-11-03",
    })) as Row
    await db.update("documents", String(d.id), { legal_original_id: lo.id })
    await db.insert("document_lines", {
      document_id: d.id,
      position: 0,
      description: "Contrôleur",
      quantity: "1",
      unit_price_minor: 10000,
      subtotal_minor: 10000,
      tax_minor: 2000,
      tax_rate_bp: 2000,
      line_kind: "goods",
    })
    if (regime === "e_invoice") {
      const xmlFile = `00000000-0000-4000-8000-${String(5000 + n).padStart(12, "0")}`
      const fx = (await db.insert("facturx_files", { document_id: d.id, file_id: xmlFile, sha256: "x", profile: "EN 16931", generated_at: "2026-11-03" })) as Row
      xmlByFile.set(xmlFile, ciiXml({ number, date: issued, buyerSiren: SIREN }))
      void fx
    }
    fake.files.set(loFile, { sha256: sha, invoice_number: regime === "e_invoice" ? number : null, date: issued, buyer_siren: SIREN, valid: true })
    return { ...d, legal_original_id: lo.id, number }
  }
  const rows = async (entity: string, where: Row = {}) => (await db.findMany(entity, { where, limit: 1000 })) as Row[]
  /** The same ctx inside a person's decision (approved re-entry or an approver's click). */
  const deciding = (c: EinvCtx): EinvCtx => ({ ...c, contracts: { ...c.contracts!, grant: mintGrant } })
  /** The organisation switches its PA (kernel binding and the settings mirror). */
  async function switchProvider(to: string) {
    kernel.history.push(kernel.bound)
    kernel.bound = to
    const [st] = (await db.findMany("einvoicing_settings", { limit: 1 })) as Row[]
    await db.update("einvoicing_settings", String(st!.id), { provider_app: to })
  }
  return { db, plDb, plCtx, fake, otherFake, ctx, calls, approvals, approvalStatus, events, settings, identity, doc, rows, deciding, grants, switchProvider }
}

const OUTBOUND = new Set(["submit_einvoice", "advance_einvoice", "book_sale"])

let w: ReturnType<typeof world>
beforeEach(async () => {
  w = world()
  await w.settings()
  await w.identity()
})

const asApproved = (ctx: EinvCtx): EinvCtx => ({
  ...w.deciding(ctx),
  approval: { approvalRequestId: "appr-x", approvalDeciderId: "00000000-0000-4000-8000-0000000000d1", toolName: "invoicing:einvoice_send" },
})
/** An approver's own click in the document panel (the click is the approval). */
const asClick = (ctx: EinvCtx): EinvCtx => w.deciding(ctx)
const asBatchApproved = (ctx: EinvCtx, id = "appr-b"): EinvCtx => ({
  ...w.deciding(ctx),
  approval: { approvalRequestId: id, approvalDeciderId: "d", toolName: "invoicing:einvoice_book_batch" },
})

describe("the cut-over compares the civil date in France", () => {
  it("an invoice issued just after midnight in Paris on the cut-over day is on or after it (winter and summer time)", () => {
    expect(onOrAfterCutover("2026-10-31T23:30:00.000Z", "2026-11-01")).toBe(true) // 00:30 CET on 1 Nov
    expect(onOrAfterCutover("2026-10-31T22:59:00.000Z", "2026-11-01")).toBe(false) // 23:59 CET on 31 Oct
    expect(onOrAfterCutover("2026-10-31 23:30:00+00", "2026-11-01")).toBe(true) // the database's text form
    expect(parisCivilDate("2026-06-30T22:30:00Z")).toBe("2026-07-01") // CEST
    expect(parisCivilDate("2026-03-29T00:59:00Z")).toBe("2026-03-29") // still CET
    expect(parisCivilDate("2026-03-29T22:30:00Z")).toBe("2026-03-30") // CEST from 01:00 UTC
    expect(parisCivilDate("2026-10-25T22:30:00Z")).toBe("2026-10-25") // CET again
    expect(onOrAfterCutover("2026-11-01", "2026-11-01")).toBe(true)
    expect(onOrAfterCutover(null, "2026-11-01")).toBe(false)
  })

  it("the job asks for the send of an e-invoice issued at 00:30 Paris time on the cut-over day", async () => {
    const d = await w.doc({ issued_at: "2026-10-31T23:30:00.000Z" })
    const t = await transmitTick(w.ctx)
    expect(t.staged).toBe(1)
    expect((w.approvals[0] as { current_payload: Row }).current_payload.document_id).toBe(d.id)
  })
})

describe("eligibility and the approval binding (re-derived from the database)", () => {
  it("a domestic B2B e-invoice is eligible; its binding names the legal original, SIREN and routing", async () => {
    const d = await w.doc()
    const r = await sendFacts(w.ctx.db, String(d.id))
    expect(r).toMatchObject({ ok: true, facts: { binding: { document_id: d.id, buyer_siren: SIREN, routing_address: SIREN, legal_original_sha256: d.legal_original_sha256 } } })
  })

  it("a B2C document is refused with einvoice_not_eligible, whatever the params say", async () => {
    const d = await w.doc({ regime: "e_reporting" })
    const forged = { document_id: String(d.id), legal_original_sha256: String(d.legal_original_sha256), buyer_siren: SIREN, routing_address: SIREN }
    const r = await einvoiceSend(asApproved(w.ctx), forged)
    expect(r).toMatchObject({ status: "error", error: { code: "einvoice_not_eligible" } })
    expect(await w.rows("einvoice_transmissions")).toHaveLength(0)
    expect(w.calls).toHaveLength(0)
  })

  it("an identity edit between approval and execution → einvoice_approval_stale, nothing prepared", async () => {
    const d = await w.doc()
    const approved = { document_id: String(d.id), legal_original_sha256: String(d.legal_original_sha256), buyer_siren: SIREN, routing_address: SIREN }
    const [idRow] = await w.rows("counterparty_identities")
    await w.db.update("counterparty_identities", String(idRow!.id), { routing_address: `${SIREN}_OTHER` })
    expect(await einvoiceSend(asApproved(w.ctx), approved)).toMatchObject({ status: "error", error: { code: "einvoice_approval_stale" } })
    expect(await w.rows("einvoice_transmissions")).toHaveLength(0)
  })

  it("a ceased SIREN or a buyer outside France is not eligible", async () => {
    const [idRow] = await w.rows("counterparty_identities")
    await w.db.update("counterparty_identities", String(idRow!.id), { registry_status: "C" })
    const d1 = await w.doc()
    expect(await sendFacts(w.ctx.db, String(d1.id))).toMatchObject({ status: "error", error: { code: "einvoice_not_eligible" } })
    const d2 = await w.doc({ billing_country_code: "DE", billing_postcode: "10115" })
    const r2 = (await sendFacts(w.ctx.db, String(d2.id))) as { error: { message: string } }
    expect(r2.error.message).toContain("not established in France")
  })
})

describe("staging creates approval requests only", () => {
  it("asks once (deduped within a day) with the binding as payload and the registry identity on the card", async () => {
    const d = await w.doc()
    const r1 = await einvoiceSendRequest(w.ctx, { document_id: String(d.id) })
    const r2 = await stageSendApproval(w.ctx, String(d.id))
    expect(r1).toMatchObject({ status: "staged", approval_id: "appr-1", deduped: false })
    expect(r2).toMatchObject({ status: "staged", approval_id: "appr-1", deduped: true })
    expect(w.approvals).toHaveLength(1)
    const a = w.approvals[0] as { tool_name: string; current_payload: Row; editable_fields: string[]; summary_detail: { lines: string[] } }
    expect(a.tool_name).toBe("invoicing:einvoice_send")
    expect(a.editable_fields).toEqual([])
    expect(a.current_payload).toEqual({ document_id: d.id, legal_original_sha256: d.legal_original_sha256, buyer_siren: SIREN, routing_address: SIREN })
    expect(a.summary_detail.lines.join("\n")).toContain("CLIENT EXEMPLE")
    expect(a.summary_detail.lines.join("\n")).toContain(`SIREN: ${SIREN}`)
    expect(w.calls).toHaveLength(0)
  })

  it("a person who may decide the send asks for it: nothing is staged or blocked, they are told to send it themselves", async () => {
    // The kernel grants a person's own call inline when they hold the deciding scope: no row.
    w.ctx.requestApproval = async (input) => {
      w.approvals.push(input as unknown as Record<string, unknown>)
      return { approval_id: null, auto_approved: true }
    }
    const d = await w.doc()
    const r = await einvoiceSendRequest(w.ctx, { document_id: String(d.id) })
    expect(r).toMatchObject({ status: "approver_may_send", document_id: String(d.id) })
    expect((r as { message: string }).message).toContain("einvoice_send")
    // After an issue by such a person: no approval id, and the document is not marked blocked.
    expect(await stageSendAfterIssue(w.ctx, String(d.id))).toBeNull()
    const [doc] = await w.rows("documents", { id: d.id })
    expect(doc!.einvoice_send_approval_id ?? null).toBeNull()
    expect(doc!.einvoice_state ?? null).toBeNull()
    expect(w.calls).toHaveLength(0)
  })

  it("asked twice for a B2C invoice: zero approvals, zero provider calls", async () => {
    const d = await w.doc({ regime: "e_reporting" })
    for (let i = 0; i < 2; i++) {
      expect(await einvoiceSendRequest(w.ctx, { document_id: String(d.id) })).toMatchObject({ status: "error", error: { code: "einvoice_not_eligible" } })
    }
    expect(w.approvals).toHaveLength(0)
    expect(w.calls).toHaveLength(0)
  })

  it("the job stages documents issued on/after the cut-over only, when sending is on", async () => {
    await w.doc({ issued_at: "2026-10-20" })
    const after = await w.doc({ issued_at: "2026-11-02" })
    const t = await transmitTick(w.ctx)
    expect(t.staged).toBe(1)
    expect((w.approvals[0] as { current_payload: Row }).current_payload.document_id).toBe(after.id)
    expect(w.calls.filter((c) => c.op !== "list_status_changes")).toHaveLength(0)
  })
})

describe("the send switches and the cut-over, at the request, the approved execution and the job", () => {
  const bindingOf = (d: Row) => ({ document_id: String(d.id), legal_original_sha256: String(d.legal_original_sha256), buyer_siren: SIREN, routing_address: SIREN })
  const setSettings = async (patch: Row) => {
    const [st] = await w.rows("einvoicing_settings")
    await w.db.update("einvoicing_settings", String(st!.id), patch)
  }

  it("sending switched off: the request asks nothing and the approved execution prepares nothing", async () => {
    const d = await w.doc()
    await setSettings({ send_enabled: false })
    expect(await einvoiceSendRequest(w.ctx, { document_id: String(d.id) })).toMatchObject({ status: "error", error: { code: "einvoice_send_disabled" } })
    expect(w.approvals).toHaveLength(0)
    expect(await einvoiceSend(asApproved(w.ctx), bindingOf(d))).toMatchObject({ status: "error", error: { code: "einvoice_send_disabled" } })
    expect(await w.rows("einvoice_transmissions")).toHaveLength(0)
    expect(w.calls).toHaveLength(0)
  })

  it("an e-invoice issued before the cut-over (already delivered the old way) is never asked for nor prepared", async () => {
    const d = await w.doc({ issued_at: "2026-10-28" })
    expect(await einvoiceSendRequest(w.ctx, { document_id: String(d.id) })).toMatchObject({ status: "error", error: { code: "einvoice_before_cutover" } })
    expect(w.approvals).toHaveLength(0)
    expect(await einvoiceSend(asApproved(w.ctx), bindingOf(d))).toMatchObject({ status: "error", error: { code: "einvoice_before_cutover" } })
    expect(await w.rows("einvoice_transmissions")).toHaveLength(0)
  })

  it("the job re-checks right before each provider call: switched off holds the prepared row (it resumes when back on); a cut-over moved past it fails the row; zero provider calls", async () => {
    const d = await w.doc()
    await einvoiceSend(asApproved(w.ctx), bindingOf(d))
    await setSettings({ send_enabled: false })
    await transmitTick(w.ctx)
    let [row] = await w.rows("einvoice_transmissions")
    expect(row).toMatchObject({ state: "prepared" })
    expect((row!.last_error as Row).code).toBe("einvoice_send_disabled")
    expect(w.calls.filter((c) => OUTBOUND.has(c.op))).toHaveLength(0)
    await setSettings({ send_enabled: true })
    await w.db.update("einvoice_transmissions", String(row!.id), { next_attempt_at: null })
    await transmitTick(w.ctx)
    ;[row] = await w.rows("einvoice_transmissions")
    expect(row!.state).toBe("validation_pending")
    // A second document, prepared, then the organisation moves its cut-over past its issue date.
    const d2 = await w.doc()
    await einvoiceSend(asApproved(w.ctx), bindingOf(d2))
    const before = w.calls.filter((c) => OUTBOUND.has(c.op)).length
    await setSettings({ cutover_date: "2026-12-01" })
    await transmitTick(w.ctx)
    const [row2] = await w.rows("einvoice_transmissions", { document_id: d2.id })
    expect(row2).toMatchObject({ state: "failed" })
    expect((row2!.last_error as Row).code).toBe("einvoice_before_cutover")
    expect(w.calls.filter((c) => OUTBOUND.has(c.op) && c.params.document_ref === d2.id)).toHaveLength(0)
    void before
  })
})

describe("prepare then execute", () => {
  it("one prepared row per approval (a replay adopts it); the job deposits, waits, transmits once and records the status", async () => {
    const d = await w.doc()
    const binding = { document_id: String(d.id), legal_original_sha256: String(d.legal_original_sha256), buyer_siren: SIREN, routing_address: SIREN }
    const p1 = await einvoiceSend(asApproved(w.ctx), binding)
    const p2 = await einvoiceSend(asApproved(w.ctx), binding)
    expect(p1).toMatchObject({ status: "ok", state: "prepared", replay: false })
    expect(p2).toMatchObject({ status: "ok", replay: true, transmission_id: (p1 as Row).transmission_id })
    const [tx] = await w.rows("einvoice_transmissions")
    expect(tx).toMatchObject({ action: "send_einvoice", state: "prepared", approval_method: "approval", approval_request_id: "appr-x", provider_app: "pennylane" })
    expect(w.calls).toHaveLength(0) // prepare never calls the provider

    await transmitTick(w.ctx) // submit → deposited (validation pending)
    let [row] = await w.rows("einvoice_transmissions")
    expect(row!.state).toBe("validation_pending")
    expect(row!.provider_ref).toBeTruthy()
    await transmitTick(w.ctx) // advance → send requested
    ;[row] = await w.rows("einvoice_transmissions")
    expect(row!.state).toBe("send_requested")
    await transmitTick(w.ctx) // advance → sent, status read
    ;[row] = await w.rows("einvoice_transmissions")
    expect(row!.state).toBe("sent")
    expect(row!.lifecycle_state).toBe("deposited")
    expect(w.fake.creates("einvoice_import")).toBe(1)
    expect(w.fake.creates("send_to_pa")).toBe(1)
    const imp = w.fake.calls.find((c) => c.path === "/customer_invoices/e_invoices/imports")!
    expect(imp.parts!.find((p) => p.name === "file")!.sha256).toBe(String(d.legal_original_sha256)) // the legal original
  })

  it("outside a person's decision no grant is minted, so nothing is prepared; the job's calls carry the grant, bound to the document", async () => {
    const d = await w.doc()
    const binding = { document_id: String(d.id), legal_original_sha256: String(d.legal_original_sha256), buyer_siren: SIREN, routing_address: SIREN }
    // E.g. an event handler or a job calling the handler directly: the kernel refuses the grant.
    expect(await einvoiceSend(w.ctx, binding)).toMatchObject({ status: "error", error: { code: "contract_grant_refused" } })
    expect(await w.rows("einvoice_transmissions")).toHaveLength(0)
    await einvoiceSend(asApproved(w.ctx), binding)
    const [row] = await w.rows("einvoice_transmissions")
    expect(w.grants.get(String(row!.dispatch_grant))).toEqual({
      ops: ["submit_einvoice", "advance_einvoice"],
      subject: { document_ref: String(d.id), invoice_number: String(d.number), legal_original_sha256: String(d.legal_original_sha256) },
    })
    for (let i = 0; i < 3; i++) await transmitTick(w.ctx)
    expect((await w.rows("einvoice_transmissions"))[0]!.state).toBe("sent")
    expect(w.calls.filter((c) => OUTBOUND.has(c.op)).map((c) => c.params.document_ref)).toEqual([String(d.id), String(d.id), String(d.id)])
  })

  it("a 422 on the transmission request while the platform does not show it yet: kept requested and re-read, never recorded as failed", async () => {
    const d = await w.doc()
    await einvoiceSend(asApproved(w.ctx), { document_id: String(d.id), legal_original_sha256: String(d.legal_original_sha256), buyer_siren: SIREN, routing_address: SIREN })
    await transmitTick(w.ctx) // deposited
    w.fake.fail((c) => c.path.endsWith("/send_to_pa"), "replace", { status: 422, body: { status: 422, error: "Already processing" } })
    await transmitTick(w.ctx)
    let [row] = await w.rows("einvoice_transmissions")
    expect(row!.state).toBe("send_requested")
    expect((row!.last_error as Row).code).toBe("send_unconfirmed")
    expect(row!.next_attempt_at).toBeTruthy()
    expect(w.events.some((e) => e.action === "transmission_failed")).toBe(false)
    // Later: re-read, requested again (the platform accepts it now), then shown as sent.
    await w.db.update("einvoice_transmissions", String(row!.id), { next_attempt_at: null })
    await transmitTick(w.ctx)
    await transmitTick(w.ctx)
    ;[row] = await w.rows("einvoice_transmissions")
    expect(row!.state).toBe("sent")
  })

  it("a direct click by an approver is recorded as such", async () => {
    const d = await w.doc()
    await einvoiceSend(asClick(w.ctx), { document_id: String(d.id), legal_original_sha256: String(d.legal_original_sha256), buyer_siren: SIREN, routing_address: SIREN })
    expect((await w.rows("einvoice_transmissions"))[0]).toMatchObject({ approval_method: "direct_click", approved_by: "00000000-0000-4000-8000-0000000000u1" })
  })

  it("a rate limit stops the tick and the row waits; a buyer outside the directory raises an attention item", async () => {
    const d = await w.doc()
    await einvoiceSend(asApproved(w.ctx), { document_id: String(d.id), legal_original_sha256: String(d.legal_original_sha256), buyer_siren: SIREN, routing_address: SIREN })
    w.fake.remaining = 0
    const t = await transmitTick(w.ctx)
    expect(t.stopped_for_rate_limit).toBe(true)
    let [row] = await w.rows("einvoice_transmissions")
    expect(row).toMatchObject({ state: "prepared", attempts: 1 })
    expect((row!.last_error as Row).code).toBe("provider_rate_limited")
    expect(row!.next_attempt_at).toBeTruthy()
    w.fake.remaining = 25
    await w.db.update("einvoice_transmissions", String(row!.id), { next_attempt_at: null })
    w.fake.directory[SIREN] = []
    await transmitTick(w.ctx)
    ;[row] = await w.rows("einvoice_transmissions")
    expect(row!.state).toBe("not_in_directory")
    expect(w.events.map((e) => e.action)).toContain("not_in_directory")
    expect(w.fake.creates("einvoice_import")).toBe(0)
  })
})

describe("a deliberate retry after a terminal failure", () => {
  const bindingOf = (d: Row) => ({ document_id: String(d.id), legal_original_sha256: String(d.legal_original_sha256), buyer_siren: SIREN, routing_address: SIREN })

  it("not in the directory: asking again stages a FRESH approval for attempt 2; approving appends a new row; the first stays as it was; one import", async () => {
    const d = await w.doc()
    w.fake.directory[SIREN] = []
    await einvoiceSend(asApproved(w.ctx), bindingOf(d))
    await transmitTick(w.ctx)
    const [first] = await w.rows("einvoice_transmissions")
    expect(first!.state).toBe("not_in_directory")
    // Asked again (the buyer is now listed): a new approval, bound to attempt 2.
    w.fake.directory[SIREN] = [SIREN]
    const staged = await einvoiceSendRequest(w.ctx, { document_id: String(d.id) })
    expect(staged).toMatchObject({ status: "staged", deduped: false })
    const card = w.approvals[w.approvals.length - 1] as { current_payload: Row; summary: string }
    expect(card.current_payload).toEqual({ ...bindingOf(d), attempt: 2 })
    expect(card.summary).toContain("Send again")
    // Asked a second time the same day: the same pending approval, not a new card.
    expect(await einvoiceSendRequest(w.ctx, { document_id: String(d.id) })).toMatchObject({ deduped: true })
    // A direct call without the approval's attempt is refused (it would replay attempt 1's key).
    expect(await einvoiceSend(asApproved(w.ctx), { ...bindingOf(d), attempt: 3 })).toMatchObject({ status: "error", error: { code: "einvoice_retry_not_allowed" } })
    const p2 = await einvoiceSend(asApproved(w.ctx), card.current_payload as never)
    expect(p2).toMatchObject({ status: "ok", state: "prepared", replay: false })
    const rows = await w.rows("einvoice_transmissions")
    expect(rows).toHaveLength(2)
    const second = rows.find((r) => r.attempt === 2)!
    expect(second.idempotency_key).not.toBe(first!.idempotency_key)
    expect(rows.find((r) => r.id === first!.id)).toMatchObject({ state: "not_in_directory", attempt: 1 })
    for (let i = 0; i < 3; i++) await transmitTick(w.ctx)
    expect((await w.rows("einvoice_transmissions", { id: second.id }))[0]!.state).toBe("sent")
    expect(w.fake.creates("einvoice_import")).toBe(1)
    expect(w.fake.creates("send_to_pa")).toBe(1)
  })

  it("a failure recorded although the platform had the deposit: the retry finds it by invoice number and adopts it (no second import)", async () => {
    const d = await w.doc()
    await einvoiceSend(asApproved(w.ctx), bindingOf(d))
    await transmitTick(w.ctx) // deposited
    const [first] = await w.rows("einvoice_transmissions")
    expect(w.fake.creates("einvoice_import")).toBe(1)
    await w.db.update("einvoice_transmissions", String(first!.id), { state: "failed" }) // e.g. a lost answer judged final
    const staged = await stageSendApproval(w.ctx, String(d.id))
    expect(staged).toMatchObject({ status: "staged" })
    const card = w.approvals[w.approvals.length - 1] as { current_payload: Row }
    await einvoiceSend(asApproved(w.ctx), card.current_payload as never)
    for (let i = 0; i < 3; i++) await transmitTick(w.ctx)
    const second = (await w.rows("einvoice_transmissions")).find((r) => r.attempt === 2)!
    expect(second).toMatchObject({ state: "sent", provider_ref: first!.provider_ref })
    expect(w.calls.some((c) => c.op === "find_einvoice")).toBe(true)
    expect(w.fake.creates("einvoice_import")).toBe(1)
    expect(w.fake.creates("send_to_pa")).toBe(1)
  })

  it("never beside a live attempt: no retry request, no attempt 2 while attempt 1 is in flight", async () => {
    const d = await w.doc()
    await einvoiceSend(asApproved(w.ctx), bindingOf(d))
    expect(await einvoiceSendRequest(w.ctx, { document_id: String(d.id) })).toMatchObject({ status: "error", error: { code: "einvoice_already_sent" } })
    expect(await einvoiceSend(asApproved(w.ctx), { ...bindingOf(d), attempt: 2 })).toMatchObject({ status: "error", error: { code: "einvoice_already_sent" } })
    expect(await w.rows("einvoice_transmissions")).toHaveLength(1)
  })
})

describe("a switch of PA: each row stays with the provider it went through", () => {
  const bindingOf = (d: Row) => ({ document_id: String(d.id), legal_original_sha256: String(d.legal_original_sha256), buyer_siren: SIREN, routing_address: SIREN })

  it("statuses are read through the pinned provider; the new PA is never asked about the old one's refs", async () => {
    const d = await w.doc()
    await einvoiceSend(asApproved(w.ctx), bindingOf(d))
    for (let i = 0; i < 3; i++) await transmitTick(w.ctx)
    const [row] = await w.rows("einvoice_transmissions")
    expect(row!.state).toBe("sent")
    await w.switchProvider("otherpa")
    // The new PA happens to hold an unrelated invoice under the same number, refused.
    w.otherFake.invoices.set(Number(row!.provider_ref), { ...w.fake.invoices.get(Number(row!.provider_ref))!, e_invoicing: { status: "refused", reason: "not ours" } } as never)
    w.fake.setEinvoicingStatus(Number(row!.provider_ref), "accepted")
    const r = (await refreshStatus(w.ctx, row!, "refresh")) as Row
    expect(r.lifecycle_state).toBe("accepted")
    expect(w.events.some((e) => e.action === "transmission_refused")).toBe(false)
    expect(w.calls.filter((c) => c.provider === "otherpa" && c.op === "get_einvoice_status")).toHaveLength(0)
  })

  it("a prepared row approved through the old PA is not sent through the new one", async () => {
    const d = await w.doc()
    await einvoiceSend(asApproved(w.ctx), bindingOf(d))
    await w.switchProvider("otherpa")
    await transmitTick(w.ctx)
    const [row] = await w.rows("einvoice_transmissions")
    expect(row).toMatchObject({ state: "failed", provider_app: "pennylane" })
    expect((row!.last_error as Row).code).toBe("contract_provider_changed")
    expect(w.calls.filter((c) => OUTBOUND.has(c.op))).toHaveLength(0)
  })

  it("the booking invariant reads booked sales at the PA they were booked with: a switch never flips booking off", async () => {
    await w.doc({ regime: "e_reporting", issued_at: "2026-11-02" })
    await bookDailyJob(w.ctx)
    const [batch] = await w.rows("einvoice_book_batches")
    await einvoiceBookBatch(asBatchApproved(w.ctx, "a"), { batch_id: String(batch!.id) })
    await transmitTick(w.ctx, { stepBook })
    const [booked] = await w.rows("einvoice_transmissions", { action: "book_sale" })
    expect(booked!.state).toBe("booked")
    await w.switchProvider("otherpa")
    // At the new PA the same numeric id is someone else's e-invoice.
    w.otherFake.invoices.set(Number(booked!.provider_ref), { ...w.fake.invoices.get(Number(booked!.provider_ref))!, e_invoicing: { status: "submitted" } } as never)
    expect(await bookingInvariantJob(w.ctx)).toEqual({ checked: 1, breaches: 0 })
    expect((await w.rows("einvoicing_settings"))[0]!.book_enabled).toBe(true)
  })
})

describe("statuses", () => {
  async function sent() {
    const d = await w.doc()
    await einvoiceSend(asApproved(w.ctx), { document_id: String(d.id), legal_original_sha256: String(d.legal_original_sha256), buyer_siren: SIREN, routing_address: SIREN })
    for (let i = 0; i < 3; i++) await transmitTick(w.ctx)
    const [row] = await w.rows("einvoice_transmissions")
    return { d, row: row! }
  }

  it("move forward only; refused is terminal and raises an attention item with the reason; raw, code and times are logged", async () => {
    const { row } = await sent()
    const ref = Number(row.provider_ref)
    w.fake.setEinvoicingStatus(ref, "accepted")
    let r = (await refreshStatus(w.ctx, row, "refresh")) as Row
    expect(r.lifecycle_state).toBe("accepted")
    w.fake.setEinvoicingStatus(ref, "submitted") // an out-of-order, older observation
    r = (await refreshStatus(w.ctx, r, "webhook")) as Row
    expect(r.lifecycle_state).toBe("accepted")
    w.fake.setEinvoicingStatus(ref, "refused", "Prix erroné")
    r = (await refreshStatus(w.ctx, r, "webhook")) as Row
    expect(r).toMatchObject({ lifecycle_state: "refused", lifecycle_code: 210, lifecycle_reason: "Prix erroné" })
    w.fake.setEinvoicingStatus(ref, "collected")
    r = (await refreshStatus(w.ctx, r, "catch_up")) as Row
    expect(r.lifecycle_state).toBe("refused")
    const refusal = w.events.find((e) => e.action === "transmission_refused")
    expect(refusal?.data).toMatchObject({ state: "refused", code: 210, reason: "Prix erroné" })
    const log = r.lifecycle_log as Row[]
    expect(log.map((l) => l.raw)).toEqual(["submitted", "accepted", "submitted", "refused", "collected"])
    expect(log[2]).toMatchObject({ ignored: "lower than the current state", source: "webhook" })
    expect(log.every((l) => typeof l.observed_at === "string")).toBe(true)
  })

  it("the inbox drain re-reads changed deposits (a duplicate webhook is harmless) and records an unknown one as an orphan", async () => {
    const { row } = await sent()
    w.fake.setEinvoicingStatus(Number(row.provider_ref), "approved")
    for (const env of ["e1", "e1", "e2"]) {
      await recordStatusChange(w.plCtx as never, { provider_ref: String(row.provider_ref), kind: "customer_invoice", event_type: "customer_invoice.e_invoicing_status_updated", envelope_id: env })
    }
    await recordStatusChange(w.plCtx as never, { provider_ref: "999999", kind: "customer_invoice", event_type: "x", envelope_id: "e3" })
    const r = await drainStatusChanges(w.ctx)
    expect(r).toMatchObject({ refreshed: 1, orphans: 1 })
    expect((await w.rows("einvoice_transmissions"))[0]!.lifecycle_state).toBe("approved")
    expect(await w.rows("einvoicing_orphan_events")).toHaveLength(1)
    expect(w.events.some((e) => e.action === "orphan_event")).toBe(true)
    // Acknowledged: nothing pending any more.
    const again = await drainStatusChanges(w.ctx)
    expect(again).toMatchObject({ refreshed: 0, orphans: 0 })
  })

  it("acknowledges only what it handled: a received invoice's change and a ref whose re-read failed stay pending", async () => {
    const { row } = await sent()
    const ref = String(row.provider_ref)
    w.fake.setEinvoicingStatus(Number(ref), "approved")
    await recordStatusChange(w.plCtx as never, { provider_ref: ref, kind: "customer_invoice", event_type: "x", envelope_id: "c1" })
    await recordStatusChange(w.plCtx as never, { provider_ref: "5150", kind: "supplier_invoice", event_type: "supplier_invoice.e_invoicing_received", envelope_id: "s1" })
    // The re-read fails this time (the platform answers 503).
    w.fake.fail((c) => c.method === "GET" && c.path === `/customer_invoices/${ref}`, "replace", { status: 503, body: { error: "unavailable" } })
    expect(await drainStatusChanges(w.ctx)).toMatchObject({ refreshed: 0 })
    const pending = async () =>
      ((await w.plDb.findMany("einvoicing_inbox", { where: { delivered_at: null }, limit: 50 })) as Row[]).map((r) => `${r.kind}:${r.provider_ref}`).sort()
    expect(await pending()).toEqual([`customer_invoice:${ref}`, "supplier_invoice:5150"])
    // Next tick, the platform answers: re-read and acknowledged; the received invoice's row is left for its consumer.
    expect(await drainStatusChanges(w.ctx)).toMatchObject({ refreshed: 1 })
    expect((await w.rows("einvoice_transmissions"))[0]!.lifecycle_state).toBe("approved")
    expect(await pending()).toEqual(["supplier_invoice:5150"])
  })
})

describe("booking", () => {
  it("nothing before the cut-over or with booking off; after: ONE batch approval listing the documents", async () => {
    await w.doc({ regime: "e_reporting", issued_at: "2026-10-30" })
    const off = world()
    await off.settings({ book_enabled: false })
    await off.doc({ regime: "e_reporting", issued_at: "2026-11-04" })
    expect(await bookDailyJob(off.ctx)).toMatchObject({ status: "skipped_booking_disabled" })
    expect(off.approvals).toHaveLength(0)

    expect(await bookDailyJob(w.ctx)).toMatchObject({ status: "nothing_to_book" })
    const a = await w.doc({ regime: "e_reporting", issued_at: "2026-11-02" })
    const b = await w.doc({ regime: "e_reporting", issued_at: "2026-11-03", type: "credit_note" })
    const r = await bookDailyJob(w.ctx)
    expect(r).toMatchObject({ status: "batch_requested", documents: 2 })
    expect(w.approvals).toHaveLength(1)
    const card = w.approvals[0] as { tool_name: string; summary: string; summary_detail: { lines: string[] }; on_behalf_of: string }
    expect(card.tool_name).toBe("invoicing:einvoice_book_batch")
    expect(card.on_behalf_of).toBe("00000000-0000-4000-8000-0000000000a1")
    const text = card.summary_detail.lines.join("\n")
    expect(text).toContain(String(a.number))
    expect(text).toContain(String(b.number))
    expect(text).toContain("Reported sales")
    // A second run the same day does not re-ask for the same documents.
    expect(await bookDailyJob(w.ctx)).toMatchObject({ status: "nothing_to_book" })
    expect(w.calls.filter((c) => c.op === "book_sale")).toHaveLength(0) // zero provider calls before approval
  })

  it("a declined or expired batch releases its documents into the next batch (a fresh card); the released batch can no longer be booked", async () => {
    const a = await w.doc({ regime: "e_reporting", issued_at: "2026-11-02" })
    await bookDailyJob(w.ctx)
    const [first] = await w.rows("einvoice_book_batches")
    w.approvalStatus.set(String(first!.approval_request_id), { status: "denied", expired: false })
    const r = await bookDailyJob(w.ctx)
    expect(r).toMatchObject({ status: "batch_requested", documents: 1 })
    expect((await w.rows("einvoice_book_batches", { id: first!.id }))[0]!.state).toBe("released")
    expect(w.approvals).toHaveLength(2)
    expect((w.approvals[1] as { summary_detail: { lines: string[] } }).summary_detail.lines.join(" ")).toContain(String(a.number))
    // A late approval of the released batch books nothing.
    expect(await einvoiceBookBatch(asBatchApproved(w.ctx, String(first!.approval_request_id)), { batch_id: String(first!.id) })).toMatchObject({ prepared: 0 })
    // The second one expires unanswered: released too, and the document is asked for once more.
    const second = (await w.rows("einvoice_book_batches", { state: "pending" }))[0]!
    w.approvalStatus.set(String(second.approval_request_id), { status: "pending", expired: true })
    expect(await bookDailyJob(w.ctx)).toMatchObject({ status: "batch_requested", documents: 1 })
    expect(w.approvals).toHaveLength(3)
  })

  it("with several batches awaiting approval, none of their documents is put on another card", async () => {
    await w.doc({ regime: "e_reporting", issued_at: "2026-11-02" })
    await bookDailyJob(w.ctx) // batch 1
    await w.doc({ regime: "e_reporting", issued_at: "2026-11-03" })
    await bookDailyJob(w.ctx) // batch 2 (only the new document)
    const c = await w.doc({ regime: "e_reporting", issued_at: "2026-11-04" })
    const r = await bookDailyJob(w.ctx) // batch 3: only the newest, never batch 1's or 2's documents again
    expect(r).toMatchObject({ status: "batch_requested", documents: 1 })
    const batches = await w.rows("einvoice_book_batches")
    expect(batches).toHaveLength(3)
    const ids = batches.flatMap((b) => b.document_ids as string[])
    expect(new Set(ids).size).toBe(ids.length) // no document in two batches
    expect(batches.find((b) => (b.document_ids as string[]).includes(String(c.id)))!.document_ids).toEqual([String(c.id)])
    expect(await bookDailyJob(w.ctx)).toMatchObject({ status: "nothing_to_book" })
  })

  it("approving the batch prepares one row per document; the job books each once with the legal original; a summary follows", async () => {
    const a = await w.doc({ regime: "e_reporting", issued_at: "2026-11-02" })
    await bookDailyJob(w.ctx)
    const [batch] = await w.rows("einvoice_book_batches")
    const approved = asBatchApproved(w.ctx)
    expect(await einvoiceBookBatch(approved, { batch_id: String(batch!.id) })).toMatchObject({ status: "ok", prepared: 1 })
    expect(await einvoiceBookBatch(approved, { batch_id: String(batch!.id) })).toMatchObject({ replay: true })
    const tick = () => transmitTick(w.ctx, { stepBook, afterTick: async (c) => void (await summariseBatches(c)) })
    await tick()
    await tick()
    const [row] = await w.rows("einvoice_transmissions", { action: "book_sale" })
    expect(row).toMatchObject({ state: "booked", batch_id: batch!.id, approval_request_id: "appr-b" })
    expect(w.fake.createdInvoices("booking")).toHaveLength(1)
    const att = w.fake.calls.find((c) => c.path === "/file_attachments")!
    expect(att.parts!.find((p) => p.name === "file")!.sha256).toBe(String(a.legal_original_sha256))
    expect(w.fake.calls.some((c) => c.path.includes("e_invoices") || c.path.endsWith("/send_to_pa"))).toBe(false)
    expect(w.events.find((e) => e.action === "booking_summary")?.data).toMatchObject({ booked: 1, failed: 0 })
  })

  it("an unmappable VAT rate refuses that booking with vat_rate_unmappable (no provider write)", async () => {
    await w.doc({ regime: "e_reporting", issued_at: "2026-11-02", tax_treatment: "unconfigured" })
    await bookDailyJob(w.ctx)
    const [batch] = await w.rows("einvoice_book_batches")
    await einvoiceBookBatch(asBatchApproved(w.ctx, "a"), { batch_id: String(batch!.id) })
    await transmitTick(w.ctx, { stepBook })
    const [row] = await w.rows("einvoice_transmissions", { action: "book_sale" })
    expect(row).toMatchObject({ state: "failed" })
    expect((row!.last_error as Row).code).toBe("vat_rate_unmappable")
    expect(w.fake.creates("booking")).toBe(0)
  })

  it("invariant: a booked invoice showing an e-invoicing status raises a high-priority item and switches booking off", async () => {
    await w.doc({ regime: "e_reporting", issued_at: "2026-11-02" })
    await bookDailyJob(w.ctx)
    const [batch] = await w.rows("einvoice_book_batches")
    await einvoiceBookBatch(asBatchApproved(w.ctx, "a"), { batch_id: String(batch!.id) })
    await transmitTick(w.ctx, { stepBook })
    expect(await bookingInvariantJob(w.ctx)).toEqual({ checked: 1, breaches: 0 })
    const [row] = await w.rows("einvoice_transmissions", { action: "book_sale" })
    w.fake.setEinvoicingStatus(Number(row!.provider_ref), "submitted")
    expect(await bookingInvariantJob(w.ctx)).toEqual({ checked: 1, breaches: 1 })
    expect((await w.rows("einvoicing_settings"))[0]!.book_enabled).toBe(false)
    expect(w.events.some((e) => e.action === "booking_invariant_breach")).toBe(true)
  })
})

describe("the deposit happens once through ctx.effects (the kernel's effect ledger)", () => {
  const bindingOf = (d: Row) => ({ document_id: String(d.id), legal_original_sha256: String(d.legal_original_sha256), buyer_siren: SIREN, routing_address: SIREN })
  const submits = () => w.calls.filter((c) => c.op === "submit_einvoice").length

  it("the step run twice for the same row deposits once: the re-run replays the stored answer", async () => {
    const ledger = new LedgerDouble()
    const ctx: EinvCtx = { ...w.ctx, effects: ledger }
    const d = await w.doc()
    await einvoiceSend(asApproved(ctx), bindingOf(d))
    await transmitTick(ctx)
    const [row] = await w.rows("einvoice_transmissions")
    expect(row!.state).toBe("validation_pending")
    // A re-run that never saw the first run's write (the row handed back as prepared).
    await w.db.update("einvoice_transmissions", String(row!.id), { state: "prepared", provider_ref: null, lease_until: null })
    await transmitTick(ctx)
    expect(submits()).toBe(1)
    expect(w.fake.creates("einvoice_import")).toBe(1)
    const [after] = await w.rows("einvoice_transmissions")
    expect(after).toMatchObject({ state: "validation_pending", provider_ref: row!.provider_ref })
  })

  it("a claim, then a crash before complete, gives unknown on the re-run and onUnknown decides: the platform's deposit is adopted", async () => {
    const ledger = new LedgerDouble()
    const ctx: EinvCtx = { ...w.ctx, effects: ledger }
    const d = await w.doc()
    await einvoiceSend(asApproved(ctx), bindingOf(d))
    ledger.crashBeforeComplete = true
    await transmitTick(ctx).catch(() => {})
    expect(submits()).toBe(1)
    // The process is gone; another worker picks the row up once its lease is cleared.
    ledger.crashBeforeComplete = false
    ledger.die()
    const [row] = await w.rows("einvoice_transmissions")
    expect(row!.state).toBe("prepared")
    await w.db.update("einvoice_transmissions", String(row!.id), { lease_until: null })
    await transmitTick(ctx)
    expect(submits()).toBe(1)
    expect(w.calls.some((c) => c.op === "find_einvoice")).toBe(true)
    expect(w.fake.creates("einvoice_import")).toBe(1)
    const [after] = await w.rows("einvoice_transmissions")
    expect(after!.state).toBe("validation_pending")
    expect(after!.provider_ref).toBeTruthy()
  })

  it("an unknown claim the platform does not hold is deposited, once", async () => {
    const ledger = new LedgerDouble()
    const ctx: EinvCtx = { ...w.ctx, effects: ledger }
    const d = await w.doc()
    await einvoiceSend(asApproved(ctx), bindingOf(d))
    const [row] = await w.rows("einvoice_transmissions")
    ledger.rows.set(`einv:${String(row!.idempotency_key)}:submit`, { state: "unknown", result: null })
    await transmitTick(ctx)
    expect(submits()).toBe(1)
    expect(w.fake.creates("einvoice_import")).toBe(1)
    expect((await w.rows("einvoice_transmissions"))[0]!.state).toBe("validation_pending")
  })

  it("a deposit that timed out after the platform took it is looked up on the next tick, never deposited again", async () => {
    const ledger = new LedgerDouble()
    const real = w.ctx.contracts!
    let timedOut = false
    // The platform takes the deposit, and the answer is lost (a timeout, retryable).
    const contracts: NonNullable<EinvCtx["contracts"]> = {
      ...real,
      call: async (contract, op, params, opts) => {
        const env = await real.call(contract, op, params, opts)
        if (op === "submit_einvoice" && !timedOut) {
          timedOut = true
          return { status: "error", error: { code: "provider_timeout", message: "timed out", retryable: true } } as ContractEnvelope<unknown>
        }
        return env
      },
    }
    const ctx: EinvCtx = { ...w.ctx, contracts, effects: ledger }
    const d = await w.doc()
    await einvoiceSend(asApproved(ctx), bindingOf(d))
    await transmitTick(ctx)
    expect(submits()).toBe(1)
    const [row] = await w.rows("einvoice_transmissions")
    expect(row!.state).toBe("prepared")
    expect(ledger.rows.get(`einv:${String(row!.idempotency_key)}:submit`)?.state).toBe("unknown")
    await w.db.update("einvoice_transmissions", String(row!.id), { lease_until: null, next_attempt_at: null })
    await transmitTick(ctx)
    expect(w.calls.some((c) => c.op === "find_einvoice")).toBe(true)
    expect(submits()).toBe(1)
    expect(w.fake.creates("einvoice_import")).toBe(1)
    const [after] = await w.rows("einvoice_transmissions")
    expect(after!.state).toBe("validation_pending")
    expect(after!.provider_ref).toBeTruthy()
  })

  it("a definite refusal releases the claim: the next tick deposits without a lookup", async () => {
    const ledger = new LedgerDouble()
    const real = w.ctx.contracts!
    let refused = false
    const contracts: NonNullable<EinvCtx["contracts"]> = {
      ...real,
      call: async (contract, op, params, opts) => {
        if (op === "submit_einvoice" && !refused) {
          refused = true
          return { status: "error", error: { code: "provider_rate_limited", message: "slow down", retryable: true } } as ContractEnvelope<unknown>
        }
        return real.call(contract, op, params, opts)
      },
    }
    const ctx: EinvCtx = { ...w.ctx, contracts, effects: ledger }
    const d = await w.doc()
    await einvoiceSend(asApproved(ctx), bindingOf(d))
    await transmitTick(ctx)
    const [row] = await w.rows("einvoice_transmissions")
    expect(ledger.rows.has(`einv:${String(row!.idempotency_key)}:submit`)).toBe(false)
    await w.db.update("einvoice_transmissions", String(row!.id), { lease_until: null, next_attempt_at: null })
    await transmitTick(ctx)
    expect(w.calls.some((c) => c.op === "find_einvoice")).toBe(false)
    expect(submits()).toBe(1)
    expect((await w.rows("einvoice_transmissions"))[0]!.state).toBe("validation_pending")
  })

  it("a claim held by a live worker: the tick leaves the row for later, no deposit", async () => {
    const ledger = new LedgerDouble()
    const ctx: EinvCtx = { ...w.ctx, effects: ledger }
    const d = await w.doc()
    await einvoiceSend(asApproved(ctx), bindingOf(d))
    const [row] = await w.rows("einvoice_transmissions")
    ledger.rows.set(`einv:${String(row!.idempotency_key)}:submit`, { state: "pending", result: null })
    await transmitTick(ctx)
    expect(submits()).toBe(0)
    expect((await w.rows("einvoice_transmissions"))[0]).toMatchObject({ state: "prepared", lease_until: null })
  })
})
