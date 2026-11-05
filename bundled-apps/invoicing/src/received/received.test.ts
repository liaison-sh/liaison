// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Received mirror at the invoicing app's level, with the real Pennylane adapter over its fake
// behind a contract-call stub: an arrival announced by the webhook inbox is mirrored by the
// e-invoicing job's drain before the batch is acknowledged; files land in their own rows with
// their sha256; the original XML's figures are read safely and a disagreeing total is flagged; the
// catch-up lists from a stored cursor and re-reads open invoices; refuse / dispute go through ONE
// approval request, are re-checked against the platform at execution, and never run twice.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ContractEnvelope } from "@liaison/app-sdk/contracts"
import { createMockDb, type ManifestSchema } from "@liaison/test-helpers/mock-db"
import { PennylaneFake } from "../../../pennylane/src/einvoicing/fake/server"
import { recordStatusChange } from "../../../pennylane/src/einvoicing/inbox"
import * as plOps from "../../../pennylane/src/einvoicing/ops"
import { base64 } from "../legal-originals/bytes"
import { drainStatusChanges, type EinvCtx } from "../einvoicing/transmit"
import { ingestOrQueue, ingestReceived, receivedCatchUp } from "./ingest"
import { receivedActionRequest, receivedGet, receivedList, receivedRefresh, receivedSetStatus, receivedSetStatusPreflight, type ReceivedToolCtx } from "./tools"

const SCHEMA = (JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "app.manifest.json"), "utf8")) as { schema: ManifestSchema }).schema
const PL_SCHEMA = (JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "pennylane", "app.manifest.json"), "utf8")) as { schema: ManifestSchema }).schema

const OPS: Record<string, keyof typeof plOps> = {
  list_status_changes: "einvoicingStatusChanges",
  get_einvoice_status: "einvoicingStatus",
  list_received: "einvoicingReceivedList",
  get_received: "einvoicingReceivedGet",
  fetch_received_file: "einvoicingReceivedFile",
  set_received_status: "einvoicingReceivedSetStatus",
}

const CII = (total = "120.00") =>
  `<?xml version="1.0" encoding="UTF-8"?><rsm:CrossIndustryInvoice xmlns:rsm="urn:x" xmlns:ram="urn:y" xmlns:udt="urn:z"><rsm:ExchangedDocument><ram:ID>FS-1</ram:ID><ram:TypeCode>380</ram:TypeCode><ram:IssueDateTime><udt:DateTimeString format="102">20261103</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument><rsm:SupplyChainTradeTransaction><ram:ApplicableHeaderTradeAgreement><ram:SellerTradeParty><ram:Name>Fournisseur Exemple</ram:Name></ram:SellerTradeParty></ram:ApplicableHeaderTradeAgreement><ram:ApplicableHeaderTradeSettlement><ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode><ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:TaxBasisTotalAmount>100.00</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="EUR">20.00</ram:TaxTotalAmount><ram:GrandTotalAmount>${total}</ram:GrandTotalAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation></ram:ApplicableHeaderTradeSettlement></rsm:SupplyChainTradeTransaction></rsm:CrossIndustryInvoice>`

type Row = Record<string, any>

function world() {
  const db = createMockDb({}, { ids: "uuid", stampCreatedAt: true, bridgeWhereOperators: true, orderByManifestSchema: SCHEMA })
  const plDb = createMockDb({}, { ids: "uuid", stampCreatedAt: true, bridgeWhereOperators: true, orderByManifestSchema: PL_SCHEMA })
  const fake = new PennylaneFake()
  fake.registrations = [{ siren: "902000009", status: "activated", exchange_direction: "emission_and_reception" }]
  const stored = new Map<string, Uint8Array>()
  const imports: Row[] = []
  const plCtx = {
    orgId: "org",
    db: plDb,
    fetch: fake.sandboxFetch,
    connections: { pennylane: { getCredentials: async () => ({ apiToken: "tok", scope: "company" }) } },
    // The kernel's first-hop-only import, keeping the stored bytes so the caller can read them.
    files_importFromUrl: async (json: string) => {
      const args = JSON.parse(json) as Row
      imports.push(args)
      const out = JSON.parse(await fake.importFromUrl(json)) as Row
      const key = /blobs\/redirect\/([^/]+)\//.exec(args.url)?.[1] ?? new URL(args.url).searchParams.get("encrypted_id") ?? new URL(args.url).pathname.slice(1)
      stored.set(out.id, fake.blobs.get(key)!.bytes)
      return JSON.stringify(out)
    },
  }
  const calls: Array<{ op: string; params: Row }> = []
  const approvals: Row[] = []
  // The kernel's live approval states (approvals.statusOf); a request is pending until set here.
  // "past_deadline": still pending at the kernel but past its deadline (the sweep has not run).
  const approvalStates = new Map<string, string>()
  const ctx: ReceivedToolCtx & EinvCtx = {
    db: db as unknown as EinvCtx["db"],
    contracts: {
      call: async (_contract, op, params) => {
        calls.push({ op, params })
        const fn = plOps[OPS[op]!] as (p: unknown, c: unknown) => Promise<unknown>
        return { status: "completed", result: await fn(params, plCtx), provider: "pennylane" } as ContractEnvelope<unknown>
      },
    },
    files_getAttachmentBytes: async (json) => {
      const { fileId } = JSON.parse(json) as { fileId: string }
      return JSON.stringify({ bytesBase64: base64(stored.get(fileId) ?? new Uint8Array()) })
    },
    getUserId: async () => "00000000-0000-4000-8000-0000000000u1",
    approval: null,
    approvals: {
      statusOf: async (id: string) => {
        const st = approvalStates.get(id) ?? "pending"
        return JSON.stringify(st === "past_deadline" ? { status: "pending", expired: true } : { status: st, expired: false })
      },
    },
    requestApproval: async (input) => {
      approvals.push(input as unknown as Row)
      return { approval_id: `appr-${approvals.length}` }
    },
  }
  const enc = (s: string) => new TextEncoder().encode(s)
  const arrive = async (o: Parameters<PennylaneFake["receive"]>[0] = {}) => {
    const id = fake.receive({ original: enc(CII(o?.total ?? "120.0")), ...o })
    await recordStatusChange(plCtx as never, { provider_ref: String(id), kind: "supplier_invoice", event_type: "supplier_invoice.e_invoicing_received", envelope_id: `env-${id}` })
    return id
  }
  const rows = async () => (await db.findMany("received_einvoices", {})) as [Row, ...Row[]]
  return { db, fake, ctx, calls, approvals, approvalStates, imports, arrive, rows }
}

describe("arrival through the webhook inbox", () => {
  it("the e-invoicing job's drain mirrors the arrival before acknowledging it: facts, status, files with sha256, the file's own figures", async () => {
    const w = world()
    const ref = await w.arrive({ supplier: "Fournisseur Exemple", number: "FS-1", total: "120.0", tax: "20.0" })
    await drainStatusChanges(w.ctx, { onReceived: (c, r) => ingestReceived(c as never, r, "webhook") })
    const [row] = await w.rows()
    expect(row).toMatchObject({
      provider_app: "pennylane",
      provider_ref: String(ref),
      supplier_name: "Fournisseur Exemple",
      invoice_number: "FS-1",
      issue_date: "2026-11-03",
      currency: "EUR",
      total: "120.0",
      status: "received",
      status_code: null,
      parse_status: "parsed",
      totals_mismatch: null,
      files_pending: false,
    })
    expect(row.lifecycle_log).toEqual([expect.objectContaining({ raw: null, mapped: "received", source: "webhook" })])
    const files = (await w.db.findMany("received_einvoice_files", {})) as Row[]
    expect(files.map((f) => f.kind).sort()).toEqual(["original", "rendering"])
    const original = files.find((f) => f.kind === "original")!
    expect(original.sha256).toBe(w.fake.originalSha256(ref))
    expect(w.imports.every((i) => i.credentials === "first-hop-only" && i.targetApp === "invoicing" && i.targetEntityType === "received_file")).toBe(true)
    // Acknowledged: a second drain finds nothing.
    const before = w.calls.filter((c) => c.op === "get_received").length
    await drainStatusChanges(w.ctx, { onReceived: (c, r) => ingestReceived(c as never, r, "webhook") })
    expect(w.calls.filter((c) => c.op === "get_received").length).toBe(before)
  })

  it("a total in the file that differs from the platform's is flagged", async () => {
    const w = world()
    const ref = await w.arrive({ total: "121.0" })
    // The file says 120.00 (its XML), the platform 121.0.
    w.fake.blobs.set(`blob${ref}o`, { bytes: new TextEncoder().encode(CII("120.00")), mime: "application/xml" })
    await ingestReceived(w.ctx, String(ref), "webhook")
    const [row] = await w.rows()
    expect(row.totals_mismatch).toEqual(["before_tax", "total"])
    const got = (await receivedGet(w.ctx, { received_id: row.id })) as Row
    expect(got.invoice.file_facts.totals.total).toBe("120.00")
  })

  it("a hostile original is stored (it is the legal original) but never parsed", async () => {
    const w = world()
    const ref = w.fake.receive({ original: new TextEncoder().encode(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>`) })
    await ingestReceived(w.ctx, String(ref), "catch_up")
    const [row] = await w.rows()
    expect(row.parse_status).toBe("refused_unsafe")
    expect(row.parsed).toMatchObject({ code: "xml_dtd_refused" })
    const files = (await w.db.findMany("received_einvoice_files", {})) as Row[]
    expect(files.find((f) => f.kind === "original")!.sha256).toBe(w.fake.originalSha256(ref))
  })

  it("a file the platform cannot hand over leaves the invoice listed with files pending, retried later", async () => {
    const w = world()
    const ref = w.fake.receive()
    w.fake.supplierInvoices.get(ref)!.e_invoicing.source_file_url = "https://files.elsewhere.example/x.xml"
    await ingestReceived(w.ctx, String(ref), "catch_up")
    let [row] = await w.rows()
    expect(row.files_pending).toBe(true)
    expect(row.last_error.code).toBe("received_file_download_refused")
    w.fake.supplierInvoices.get(ref)!.e_invoicing.source_file_url = `https://app.pennylane.com/rails/active_storage/blobs/redirect/blob${ref}o/x.xml`
    await receivedCatchUp(w.ctx)
    ;[row] = await w.rows()
    expect(row.files_pending).toBe(false)
  })
})

describe("catch-up and refresh", () => {
  it("lists from the stored cursor, ingests each once, and re-reads open invoices for status changes", async () => {
    const w = world()
    const a = w.fake.receive()
    const b = w.fake.receive()
    const first = await receivedCatchUp(w.ctx)
    expect(first).toMatchObject({ listed: 2, ingested: 2 })
    // The platform changes a status without any push: the next catch-up sees it.
    w.fake.supplierInvoices.get(a)!.e_invoicing.status = "approved"
    const c = w.fake.receive()
    const second = await receivedCatchUp(w.ctx)
    expect(second).toMatchObject({ listed: 1, ingested: 1 })
    const rows = await w.rows()
    expect(rows.map((r) => r.provider_ref).sort()).toEqual([a, b, c].map(String).sort())
    expect(rows.find((r) => r.provider_ref === String(a))!.status).toBe("approved")
    const listed = (await receivedList(w.ctx, { status: "approved" })) as Row
    expect(listed.items.map((i: Row) => i.status)).toEqual(["approved"])
    expect(listed.last_refreshed_at).toBeTruthy()
  })

  it("a read that fails once (503) is not lost: the cursor moves on, the ref is queued, and the next run stores it", async () => {
    const w = world()
    const ref = w.fake.receive()
    const healthy = w.ctx.contracts!.call
    w.ctx.contracts = {
      call: async (contract, op, params) =>
        op === "get_received"
          ? ({ status: "completed", result: { status: "error", error: { code: "provider_unavailable", message: "503 from the platform", retryable: true } }, provider: "pennylane" } as ContractEnvelope<unknown>)
          : healthy(contract, op, params),
    }
    const first = await receivedCatchUp(w.ctx)
    expect(first).toMatchObject({ listed: 1, ingested: 0, failed: 1 })
    expect(await w.db.findMany("received_einvoices", {})).toHaveLength(0)
    expect(await w.db.findMany("received_retry", {})).toEqual([expect.objectContaining({ provider_ref: String(ref), attempts: 1 })])
    w.ctx.contracts = { call: healthy }
    const second = await receivedCatchUp(w.ctx)
    expect(second).toMatchObject({ listed: 0, ingested: 1, failed: 0 })
    const rows = await w.rows()
    expect(rows.map((r) => r.provider_ref)).toEqual([String(ref)])
    expect(rows[0]!.files_pending).toBe(false)
    expect(await w.db.findMany("received_retry", {})).toHaveLength(0)
  })

  it("a rate limit (429) stops the reads of the run; every listed ref is queued and stored by the next run", async () => {
    const w = world()
    const refs = [w.fake.receive(), w.fake.receive(), w.fake.receive()].map(String)
    const healthy = w.ctx.contracts!.call
    let gets = 0
    w.ctx.contracts = {
      call: async (contract, op, params) => {
        if (op === "get_received" && ++gets >= 2) {
          return { status: "error", error: { code: "provider_rate_limited", message: "429" }, provider: "pennylane" } as unknown as ContractEnvelope<unknown>
        }
        return healthy(contract, op, params)
      },
    }
    const first = await receivedCatchUp(w.ctx)
    expect(first).toMatchObject({ listed: 3, ingested: 1, failed: 2 })
    expect(gets).toBe(2) // the third ref is queued without another call
    w.ctx.contracts = { call: healthy }
    const second = await receivedCatchUp(w.ctx)
    expect(second).toMatchObject({ listed: 0, ingested: 2 })
    expect((await w.rows()).map((r) => r.provider_ref).sort()).toEqual(refs.sort())
  })

  it("an arrival whose read fails during the webhook drain is queued, and the catch-up stores it", async () => {
    const w = world()
    const ref = await w.arrive()
    const healthy = w.ctx.contracts!.call
    w.ctx.contracts = {
      call: async (contract, op, params) =>
        op === "get_received" ? ({ status: "error", error: { code: "provider_unavailable", message: "503" } } as unknown as ContractEnvelope<unknown>) : healthy(contract, op, params),
    }
    await drainStatusChanges(w.ctx, { onReceived: (c, r) => ingestOrQueue(c as never, r, "webhook") })
    expect(await w.db.findMany("received_einvoices", {})).toHaveLength(0)
    expect(await w.db.findMany("received_retry", {})).toEqual([expect.objectContaining({ provider_ref: String(ref) })])
    w.ctx.contracts = { call: healthy }
    await receivedCatchUp(w.ctx)
    expect((await w.rows()).map((r) => r.provider_ref)).toContain(String(ref))
  })

  it("Refresh re-reads one invoice, or runs the catch-up; without a bound provider it says so", async () => {
    const w = world()
    w.fake.receive()
    const all = (await receivedRefresh(w.ctx, {})) as Row
    expect(all).toMatchObject({ status: "ok", ingested: 1 })
    const [row] = await w.rows()
    w.fake.supplierInvoices.get(Number(row.provider_ref))!.e_invoicing.status = "collected"
    const one = (await receivedRefresh(w.ctx, { received_id: row.id })) as Row
    expect(one.refreshed).toBe(1)
    expect((await w.rows())[0]!.status).toBe("collected")
    const none: ReceivedToolCtx = { ...w.ctx, contracts: { call: async () => ({ status: "error", error: { code: "contract_provider_not_configured", message: "x" } }) } }
    expect(((await receivedRefresh(none, {})) as Row).error.code).toBe("contract_provider_not_configured")
  })

  it("a status never moves back; a terminal one is kept and offers nothing", async () => {
    const w = world()
    const ref = w.fake.receive()
    w.fake.supplierInvoices.get(ref)!.e_invoicing.status = "collected"
    await ingestReceived(w.ctx, String(ref), "catch_up")
    w.fake.supplierInvoices.get(ref)!.e_invoicing.status = "approved"
    await ingestReceived(w.ctx, String(ref), "catch_up")
    let [row] = await w.rows()
    expect(row.status).toBe("collected")
    expect(row.lifecycle_log.at(-1)).toMatchObject({ mapped: "approved", ignored: "lower than the current state" })
    w.fake.supplierInvoices.get(ref)!.e_invoicing.status = "rejected"
    await ingestReceived(w.ctx, String(ref), "catch_up")
    ;[row] = await w.rows()
    expect(row).toMatchObject({ status: "rejected", status_code: 213, actions: [] })
  })
})

describe("refuse / dispute", () => {
  async function received(w: ReturnType<typeof world>, o: Parameters<PennylaneFake["receive"]>[0] = {}) {
    const ref = w.fake.receive(o)
    const r = (await ingestReceived(w.ctx, String(ref), "webhook")) as Row
    return { ref, id: r.received_id as string }
  }

  it("a request creates ONE approval (no platform write), recorded on the invoice; asking again dedupes", async () => {
    const w = world()
    const { id } = await received(w)
    const r = (await receivedActionRequest(w.ctx, { received_id: id, action: "refuse", reason: "duplicate_invoice", comment: "Already paid under FS-0" })) as Row
    expect(r).toMatchObject({ status: "staged", approval_id: "appr-1", deduped: false })
    expect(w.approvals).toHaveLength(1)
    expect(w.approvals[0]).toMatchObject({
      tool_name: "invoicing:received_einvoice_set_status",
      current_payload: { received_id: id, action: "refuse", reason: "duplicate_invoice", comment: "Already paid under FS-0" },
      editable_fields: [],
    })
    expect(w.approvals[0]!.summary_detail.lines.join("\n")).toContain("Duplicate invoice (official code DOUBLON)")
    expect(w.fake.calls.some((c) => c.method === "PUT")).toBe(false)
    const again = (await receivedActionRequest(w.ctx, { received_id: id, action: "refuse", reason: "duplicate_invoice" })) as Row
    expect(again).toMatchObject({ deduped: true, approval_id: "appr-1" })
    const other = (await receivedActionRequest(w.ctx, { received_id: id, action: "dispute", reason: "delivery_issue" })) as Row
    expect(other.error.code).toBe("received_action_pending")
    expect(w.approvals).toHaveLength(1)
    const got = (await receivedGet(w.ctx, { received_id: id })) as Row
    expect(got.pending_action).toMatchObject({ action: "refuse", approval_id: "appr-1" })
  })

  for (const closed of ["denied", "expired", "cancelled", "past_deadline"]) {
    it(`a ${closed} approval no longer blocks: the same or another action can be asked for right away`, async () => {
      const w = world()
      const { id } = await received(w)
      await receivedActionRequest(w.ctx, { received_id: id, action: "refuse", reason: "duplicate_invoice" })
      w.approvalStates.set("appr-1", closed)
      // What the tab shows: nothing awaits approval any more, the actions are back.
      const got = (await receivedGet(w.ctx, { received_id: id })) as Row
      expect(got.pending_action).toBeNull()
      expect(((await receivedList(w.ctx, {})) as Row).items[0].awaiting_approval).toBeNull()
      // The same request again creates a new approval instead of pointing at the closed one.
      const same = (await receivedActionRequest(w.ctx, { received_id: id, action: "refuse", reason: "duplicate_invoice" })) as Row
      expect(same).toMatchObject({ status: "staged", approval_id: "appr-2", deduped: false })
      // And once that one is closed too, a different action is possible.
      w.approvalStates.set("appr-2", closed)
      const other = (await receivedActionRequest(w.ctx, { received_id: id, action: "dispute", reason: "delivery_issue" })) as Row
      expect(other).toMatchObject({ status: "staged", approval_id: "appr-3", deduped: false })
      expect(w.approvals).toHaveLength(3)
      const [row] = await w.rows()
      expect(row.pending_action).toMatchObject({ action: "dispute", approval_id: "appr-3" })
    })
  }

  it("a still-pending approval keeps blocking another action and the list says it awaits approval", async () => {
    const w = world()
    const { id } = await received(w)
    await receivedActionRequest(w.ctx, { received_id: id, action: "refuse", reason: "duplicate_invoice" })
    expect(((await receivedList(w.ctx, {})) as Row).items[0].awaiting_approval).toBe("refuse")
    expect(((await receivedActionRequest(w.ctx, { received_id: id, action: "dispute", reason: "delivery_issue" })) as Row).error.code).toBe("received_action_pending")
  })

  it("the reads say whether the caller may act (invoicing:received:write)", async () => {
    const w = world()
    const { id } = await received(w)
    const asked: string[] = []
    const reader: ReceivedToolCtx = { ...w.ctx, callerHasScope: (s: string) => (asked.push(s), false) }
    expect(((await receivedGet(reader, { received_id: id })) as Row).can_act).toBe(false)
    expect(((await receivedList(reader, {})) as Row).can_act).toBe(false)
    expect(asked.every((s) => s === "invoicing:received:write")).toBe(true)
    const writer: ReceivedToolCtx = { ...w.ctx, callerHasScope: () => true }
    expect(((await receivedGet(writer, { received_id: id })) as Row).can_act).toBe(true)
  })

  it("an unoffered reason or action is refused at request and at stage time, before any approval", async () => {
    const w = world()
    const { id } = await received(w)
    expect(((await receivedActionRequest(w.ctx, { received_id: id, action: "refuse", reason: "delivery_issue" })) as Row).error.code).toBe("received_reason_invalid")
    expect(((await receivedActionRequest(w.ctx, { received_id: id, action: "undispute" })) as Row).error.code).toBe("received_action_not_allowed")
    expect(((await receivedSetStatusPreflight(w.ctx, { received_id: id, action: "refuse", reason: "nope" })) as Row).error.code).toBe("received_reason_invalid")
    expect(((await receivedSetStatusPreflight(w.ctx, { received_id: id, action: "refuse", reason: "duplicate_invoice" })) as Row).ok).toBe(true)
    expect(w.approvals).toHaveLength(0)
  })

  it("the approved action re-reads the platform, sends once, records the outcome; a replay is refused", async () => {
    const w = world()
    const { ref, id } = await received(w)
    await receivedActionRequest(w.ctx, { received_id: id, action: "refuse", reason: "duplicate_invoice", comment: "dup" })
    const approved: ReceivedToolCtx = { ...w.ctx, approval: { approvalRequestId: "appr-1", approvalDeciderId: "user-approver", toolName: "invoicing:received_einvoice_set_status" } }
    const r = (await receivedSetStatus(approved, { received_id: id, action: "refuse", reason: "duplicate_invoice", comment: "dup" })) as Row
    expect(r).toMatchObject({ status: "ok", state: "refused", code: 210 })
    expect(w.fake.supplierInvoices.get(ref)!.e_invoicing).toMatchObject({ status: "refused", reason: "duplicate_invoice" })
    const [row] = await w.rows()
    expect(row.pending_action).toBeNull()
    expect(row.actions).toEqual([])
    const log = row.lifecycle_log as Row[]
    expect(log.find((e) => e.source === "action")).toMatchObject({ action: "refuse", code: "DOUBLON", by: "user-approver", approval_request_id: "appr-1", outcome: "sent", comment: "dup" })
    expect(log.at(-1)).toMatchObject({ mapped: "refused", code: 210 })
    const replay = (await receivedSetStatus(approved, { received_id: id, action: "refuse", reason: "duplicate_invoice" })) as Row
    expect(replay.error.code).toBe("received_action_not_allowed")
    expect(w.fake.calls.filter((c) => c.method === "PUT")).toHaveLength(1)
  })

  it("a person's own request, made by someone who may decide it, runs at once: no approval, the platform is told", async () => {
    const w = world()
    const { ref, id } = await received(w)
    // The kernel grants a person's own call inline when they hold the deciding scope.
    w.ctx.requestApproval = async (input) => {
      w.approvals.push(input as unknown as Row)
      return { approval_id: null, auto_approved: true }
    }
    const r = (await receivedActionRequest(w.ctx, { received_id: id, action: "refuse", reason: "duplicate_invoice", comment: "dup" })) as Row
    expect(r).toMatchObject({ status: "ok", state: "refused", code: 210 })
    expect(w.fake.supplierInvoices.get(ref)!.e_invoicing).toMatchObject({ status: "refused", reason: "duplicate_invoice" })
    const [row] = await w.rows()
    expect(row.pending_action).toBeNull()
    const log = row.lifecycle_log as Row[]
    expect(log.find((e) => e.source === "action")).toMatchObject({ action: "refuse", by: "00000000-0000-4000-8000-0000000000u1", approval_request_id: null, outcome: "sent" })
    expect(w.fake.calls.filter((c) => c.method === "PUT")).toHaveLength(1)
  })

  it("a payment linked between the request and the approval: refused at execution, nothing sent", async () => {
    const w = world()
    const { ref, id } = await received(w)
    await receivedActionRequest(w.ctx, { received_id: id, action: "dispute", reason: "delivery_issue" })
    w.fake.supplierInvoices.get(ref)!.paid = true
    const r = (await receivedSetStatus(w.ctx, { received_id: id, action: "dispute", reason: "delivery_issue" })) as Row
    expect(r.error.code).toBe("received_action_not_allowed")
    expect(w.fake.calls.some((c) => c.method === "PUT")).toBe(false)
    const [row] = await w.rows()
    expect(row).toMatchObject({ payment_linked: true, actions: [], pending_action: null })
  })

  it("a dispute can be withdrawn", async () => {
    const w = world()
    const { id } = await received(w)
    await receivedSetStatus(w.ctx, { received_id: id, action: "dispute", reason: "incorrect_unit_prices" })
    let [row] = await w.rows()
    expect(row.status).toBe("in_dispute")
    expect((row.actions as Row[]).map((a) => a.action)).toEqual(["refuse", "undispute"])
    await receivedSetStatus(w.ctx, { received_id: id, action: "undispute" })
    ;[row] = await w.rows()
    expect(row.status).toBe("approved")
  })
})
