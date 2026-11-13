// SPDX-License-Identifier: FSL-1.1-ALv2
//
// einvoicing-pa@1 conformance: the SDK's provider-agnostic cases, run against the Pennylane
// adapter over the recorded-shape fake.
import { describe, it } from "bun:test"
import {
  type EinvoicingPaHarness,
  einvoicingPaConformance,
  einvoicingPaReceptionConformance,
  type LifecycleState,
  type ReceptionHarness,
} from "@liaison/app-sdk/contracts"
import { createMockDb } from "@liaison/test-helpers/mock-db"
import type { PennylaneToolCtx } from "../ctx"
import { BUYER, BUYER_SIREN, bookingData, ciiXml } from "./fake/fixtures"
import { PennylaneFake } from "./fake/server"
import { recordStatusChange } from "./inbox"
import * as ops from "./ops"
import { PENNYLANE_STATUS_MAP } from "./status-map"

const WORD_FOR: Record<string, string> = Object.fromEntries(
  Object.entries(PENNYLANE_STATUS_MAP).map(([w, s]) => [s, w]),
)

function harness(): EinvoicingPaHarness {
  const fake = new PennylaneFake()
  fake.directory[BUYER_SIREN] = [BUYER_SIREN, `${BUYER_SIREN}_SVC1`]
  const ctx = {
    orgId: "org",
    db: createMockDb({}, { bridgeWhereOperators: true, ids: "uuid", stampCreatedAt: true }),
    fetch: fake.sandboxFetch,
    connections: {
      pennylane: { getSettings: async () => ({ values: { scope: "company" }, missing: [] }) },
    },
  } as unknown as PennylaneToolCtx
  let n = 0
  const file = (invoice_number: string | null, date: string | null) => {
    n += 1
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
    const sha256 = n.toString(16).padStart(64, "a")
    fake.files.set(id, { sha256, invoice_number, date, buyer_siren: BUYER_SIREN, valid: true })
    return { id, sha256 }
  }
  const submitInput = (over: { bar?: string; wrongSha?: boolean } = {}) => {
    const number = `FA-2026-${1000 + n}`
    const date = "2026-11-03"
    const f = file(number, date)
    return {
      document_ref: `doc-${n}`,
      invoice_number: number,
      issue_date: date,
      facturx_file_id: f.id,
      legal_original_sha256: over.wrongSha ? "f".repeat(64) : f.sha256,
      cii_xml: ciiXml({ number, date, bar: over.bar }),
      buyer: BUYER,
      idempotency_key: `key-${number}`,
    }
  }
  const handlers: Record<string, (p: never, c: PennylaneToolCtx) => Promise<unknown>> = {
    registration_status: ops.einvoicingRegistrationStatus as never,
    find_einvoice: ops.einvoicingFind as never,
    submit_einvoice: ops.einvoicingSubmit as never,
    advance_einvoice: ops.einvoicingAdvance as never,
    get_einvoice_status: ops.einvoicingStatus as never,
    list_status_changes: ops.einvoicingStatusChanges as never,
    find_booking: ops.einvoicingFindBooking as never,
    book_sale: ops.einvoicingBook as never,
  }
  return {
    call: async (op, params) =>
      (await handlers[op]!(params as never, ctx)) as Record<string, unknown>,
    inputs: {
      eligible: () => submitInput(),
      b2c: () => submitInput({ bar: "B2C" }),
      wrongFile: () => submitInput({ wrongSha: true }),
      booking: () => {
        const f = file(null, null)
        const number = `FA-2026-B${n}`
        return {
          document_ref: `doc-${n}`,
          pdf_file_id: f.id,
          legal_original_sha256: f.sha256,
          data: bookingData({ number }),
          idempotency_key: `book-${number}`,
        }
      },
      unmappableBooking: () => {
        const f = file(null, null)
        const number = `FA-2026-U${n}`
        return {
          document_ref: `doc-${n}`,
          pdf_file_id: f.id,
          legal_original_sha256: f.sha256,
          data: bookingData({ number, treatment: "unconfigured" }),
          idempotency_key: `book-${number}`,
        }
      },
    },
    provider: {
      creates: (kind) => fake.creates(kind),
      setEmission: (on) => {
        fake.emission = on
      },
      setLifecycle: async (ref: string, state: LifecycleState, reason?: string) => {
        fake.setEinvoicingStatus(Number(ref), WORD_FOR[state]!, reason ?? null)
        await recordStatusChange(ctx, {
          provider_ref: ref,
          kind: "customer_invoice",
          event_type: "customer_invoice.e_invoicing_status_updated",
          envelope_id: `env-${ref}-${state}`,
        })
      },
    },
  }
}

describe("einvoicing-pa@1 conformance — Pennylane adapter over the recorded fake", () => {
  for (const c of einvoicingPaConformance) {
    it(c.name, () => c.run(harness()))
  }
})

function receptionHarness(): ReceptionHarness {
  const fake = new PennylaneFake()
  fake.registrations = [
    { siren: "902000009", status: "activated", exchange_direction: "emission_and_reception" },
  ]
  const ctx = {
    orgId: "org",
    db: createMockDb({}, { bridgeWhereOperators: true, ids: "uuid", stampCreatedAt: true }),
    fetch: fake.sandboxFetch,
    files_importFromUrl: fake.importFromUrl,
    connections: {
      pennylane: { getSettings: async () => ({ values: { scope: "company" }, missing: [] }) },
    },
  } as unknown as PennylaneToolCtx
  const handlers: Record<string, (p: never, c: PennylaneToolCtx) => Promise<unknown>> = {
    list_received: ops.einvoicingReceivedList as never,
    get_received: ops.einvoicingReceivedGet as never,
    fetch_received_file: ops.einvoicingReceivedFile as never,
    set_received_status: ops.einvoicingReceivedSetStatus as never,
  }
  return {
    call: async (op, params) =>
      (await handlers[op]!(params as never, ctx)) as Record<string, unknown>,
    provider: {
      receive: async (o) => String(fake.receive({ paid: o?.paid })),
      originalSha256: (ref) => fake.originalSha256(Number(ref)),
      statusWrites: () =>
        fake.calls.filter((c) => c.method === "PUT" && /e_invoice_status$/.test(c.path)).length,
    },
    target: () => ({
      app: "invoicing",
      entity_type: "received_file",
      entity_id: "00000000-0000-4000-8000-00000000f001",
    }),
  }
}

describe("einvoicing-pa@1 reception conformance — Pennylane adapter over the fake", () => {
  for (const c of einvoicingPaReceptionConformance) {
    it(c.name, () => c.run(receptionHarness()))
  }
})
