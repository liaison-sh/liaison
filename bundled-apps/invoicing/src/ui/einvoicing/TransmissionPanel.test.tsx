// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The e-invoicing panel on a document: status in plain words with the official code, the status
// history with inferred states marked, a send button only for an eligible e-invoice whose
// confirmation shows the registry identity next to the contact (and flags a name mismatch), a
// refresh once transmitted, a worded (never alarm-coloured) note on refusal, and nothing at all
// on a document that is neither an e-invoice nor booked.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type TransmissionData, transmissionPanelView } from "./TransmissionPanel"

const source = readFileSync(join(import.meta.dir, "TransmissionPanel.tsx"), "utf-8")

const base: TransmissionData = {
  status: "ok",
  regime: "e_invoice",
  einvoice_state: null,
  send_approval_id: null,
  provider_app: "pennylane",
  send_enabled: true,
  send_preview: {
    binding: { document_id: "d1", legal_original_sha256: "a".repeat(64), buyer_siren: "900000001", routing_address: "900000001" },
    registry_name: "CLIENT EXEMPLE",
    registry_city: "Lyon",
    contact_name: "Client Exemple",
    name_mismatch: false,
  },
  send_blocked: null,
  transmissions: [],
}

const sendRow = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  action: "send_einvoice" as const,
  state: "sent",
  provider_app: "pennylane",
  provider_ref: "42",
  lifecycle_state: null,
  lifecycle_code: null,
  lifecycle_reason: null,
  lifecycle_log: [],
  approval_method: "approval",
  last_error: null,
  ...over,
})

describe("TransmissionPanel", () => {
  it("an eligible e-invoice not yet sent offers Send; the confirmation names the registry identity it binds", () => {
    const v = transmissionPanelView(base)
    expect(v.visible).toBe(true)
    expect(v.status).toBe("Not sent yet")
    expect(v.canSend).toBe(true)
    expect(v.canRefresh).toBe(false)
    expect(v.confirmBody).toContain("Registry name: CLIENT EXEMPLE")
    expect(v.confirmBody).toContain("SIREN: 900000001")
    expect(v.confirmBody).toContain("Registered office: Lyon")
    expect(v.confirmBody).toContain("Routing address: 900000001")
    expect(v.confirmBody).toContain("Liaison contact: Client Exemple")
    expect(v.confirmBody).not.toContain("names differ")
    expect(transmissionPanelView({ ...base, send_preview: { ...base.send_preview!, name_mismatch: true } }).confirmBody).toContain(
      "The names differ",
    )
  })

  it("after a terminal failure the latest attempt stands and Send is offered again (a new attempt); never beside a live one", () => {
    const failed = sendRow({ state: "not_in_directory", provider_ref: null, attempt: 1, last_error: { message: "not listed" } })
    const retry = transmissionPanelView({
      ...base,
      send_preview: { ...base.send_preview!, binding: { ...base.send_preview!.binding, attempt: 2 } },
      transmissions: [failed],
    })
    expect(retry.canSend).toBe(true)
    expect(retry.attention).toBe("not listed")
    // Attempt 2 in flight: the panel follows it and offers no second send.
    const live = transmissionPanelView({ ...base, transmissions: [failed, sendRow({ id: "t2", state: "validation_pending", attempt: 2 })] })
    expect(live.canSend).toBe(false)
    expect(live.attention).toBeNull()
  })

  it("never offers Send on a document that is not an e-invoice, nor when the send is blocked (it says why)", () => {
    expect(transmissionPanelView({ ...base, regime: "e_reporting", send_preview: null }).visible).toBe(false)
    const blocked = transmissionPanelView({ ...base, send_preview: null, send_blocked: "the buyer SIREN is missing or invalid" })
    expect(blocked.canSend).toBe(false)
    expect(blocked.blocked).toContain("SIREN")
    expect(transmissionPanelView({ ...base, provider_app: null }).canSend).toBe(false)
  })

  it("shows the buyer's platform status with its official code and the history, inferred states marked; refresh once sent", () => {
    const v = transmissionPanelView({
      ...base,
      send_preview: null,
      transmissions: [
        sendRow({
          lifecycle_state: "accepted",
          lifecycle_code: 204,
          lifecycle_log: [
            { raw: "submitted", mapped: "deposited", code: 200, provider_ts: "2026-11-03T10:00:00Z", observed_at: "2026-11-03T10:00:05Z", source: "transmit" },
            { raw: "accepted", mapped: "accepted", code: 204, provider_ts: "2026-11-04T09:00:00Z", observed_at: "2026-11-04T09:00:02Z", source: "webhook" },
            { raw: "submitted", mapped: "deposited", code: 200, provider_ts: null, observed_at: "2026-11-04T09:01:00Z", source: "webhook", ignored: "lower than the current state" },
          ],
        }),
      ],
    })
    expect(v.status).toBe("Taken in charge by the buyer (204)")
    expect(v.canSend).toBe(false)
    expect(v.canRefresh).toBe(true)
    expect(v.attention).toBeNull()
    expect(v.timeline.map((e) => [e.label, e.code, e.inferred])).toEqual([
      ["Deposited", 200, true],
      ["Taken in charge by the buyer", 204, true],
    ])
  })

  it("a refusal is worded with the buyer's reason and the decision left to a person; collected is not inferred", () => {
    const v = transmissionPanelView({
      ...base,
      transmissions: [sendRow({ lifecycle_state: "refused", lifecycle_code: 210, lifecycle_reason: "Prix erroné" })],
    })
    expect(v.status).toBe("Refused by the buyer (210)")
    expect(v.attention).toContain("Prix erroné")
    expect(v.attention).toContain("credit note")
    const paid = transmissionPanelView({
      ...base,
      transmissions: [sendRow({ lifecycle_state: "collected", lifecycle_code: 212, lifecycle_log: [{ raw: "collected", mapped: "collected", code: 212, provider_ts: null, observed_at: "2026-11-09T00:00:00Z", source: "catch_up" }] })],
    })
    expect(paid.timeline[0]?.inferred).toBe(false)
  })

  it("a booked sale shows its booking; the panel is calm (no alarm colours) and testids are stable", () => {
    const v = transmissionPanelView({ ...base, regime: "e_reporting", send_preview: null, transmissions: [{ ...sendRow({ state: "booked", provider_ref: "7" }), action: "book_sale" }] })
    expect(v.visible).toBe(true)
    expect(v.status).toBe("Booked in the platform's ledger")
    expect(v.canSend).toBe(false)
    expect(source).not.toMatch(/text-(danger|error|red)/)
    for (const id of ["document-detail-einvoice-panel", "einvoice-panel-status", "einvoice-panel-send", "einvoice-panel-refresh", "einvoice-panel-timeline"]) {
      expect(source).toContain(id)
    }
  })
})
