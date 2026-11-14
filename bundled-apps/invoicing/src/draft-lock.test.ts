// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The lines of a draft made from a planned vs done card belong to the card: drafts_update and the
// editor (documents_update) refuse to change them with `from_reconcile_change_on_card`, and the due
// date stays editable. Only a draft linked to a reconciliation is locked: a month-end run's draft
// keeps its editable lines.

import { describe, expect, test } from "bun:test"
import { documentsUpdate, draftsCreate, draftsUpdate, type MutationsCtx } from "./mutations"
import { createMockDb, type MockDb } from "./test-db"
import { testTime } from "./test-time"

const ISSUER = {
  id: "iss-1",
  legal_name: "Maison Studio SAS",
  country: "FR",
  vat_id: "FR12345678901",
  address: "1 rue Test, 75001 Paris",
  iban: null,
  swift_bic: null,
  bank_name: null,
  default_language: "fr",
  prefix_invoice: "F-{YYYY}-",
  prefix_quote: "D-{YYYY}-",
  prefix_proforma: "P-{YYYY}-",
  prefix_po: "BC-{YYYY}-",
  prefix_credit_note: "A-{YYYY}-",
  invoice_approval_threshold_minor: null,
  po_approval_threshold_minor: null,
  require_two_eyes: false,
  mail_account_id: null,
}

const RECIPIENT = {
  counterparty_contact_id: "contact-1",
  counterparty_name: "Klangwerk GmbH",
  counterparty_address: "Rheinallee 4, 40545 Duesseldorf, Germany",
  counterparty_vat_id: "DE298765432",
  counterparty_email: "billing@klangwerk.example",
  counterparty_country: "DE",
}

const LINE = {
  position: 1,
  description: "Monitoring, 4 d",
  quantity: "4",
  unit_price_minor: 93_000n,
  line_kind: "service",
  product_source: null,
  external_id: null,
}

function makeCtx(): { ctx: MutationsCtx; db: MockDb } {
  const db = createMockDb({ seed: { issuer_profiles: [ISSUER] } })
  const ctx: MutationsCtx = {
    getUserId: async () => "user-1",
    approval: null,
    db,
    time: testTime(),
    pdf: {
      async render() {
        return {
          file_id: "pdf-1",
          byte_size: 1,
          page_count: 1,
          sha256: "0".repeat(64),
          parent_entity_id: crypto.randomUUID(),
        }
      },
    },
    messages: { post: async () => ({ message_id: "m" }) },
    requestApproval: async () => ({ approval_id: "a" }),
    decideApproval: async () => ({ status: "ok" }),
    executeTool: async (name: string) =>
      // No Stripe app here: the kernel answers an absent app's tool as not found.
      name.startsWith("stripe:")
        ? { status: "error" as const, error: { code: "tool_not_found", message: "absent" } }
        : { status: "completed" as const, result: {} },
    emit: async () => {},
  }
  return { ctx, db }
}

async function draft(
  h: { ctx: MutationsCtx; db: MockDb },
  link: { external_ref?: string; external_refs?: Record<string, unknown> },
): Promise<string> {
  const created = await draftsCreate(h.ctx, {
    type: "invoice",
    issuer_profile_id: ISSUER.id,
    currency: "EUR",
    items: [LINE],
    ...RECIPIENT,
  } as never)
  await h.db.update("documents", created.draft_id, link)
  return created.draft_id
}

const changedLines = [{ ...LINE, quantity: "5", unit_price_minor: "93000" }]
const lineQuantities = (db: MockDb, id: string) =>
  db
    .__all("document_lines")
    .filter((l) => l.document_id === id)
    .map((l) => String(l.quantity))

describe("lines of a draft from planned vs done", () => {
  test("lines of a draft from planned vs done cannot be edited, its due date can", async () => {
    const h = makeCtx()
    const id = await draft(h, { external_ref: "reconcile:7a1d2c3e-0000-4000-8000-0000000000aa:2" })

    await expect(
      draftsUpdate(h.ctx, { draft_id: id, patch: { lines: changedLines } } as never),
    ).rejects.toThrow(/from_reconcile_change_on_card/)
    const viaEditor = await documentsUpdate(h.ctx, { id, lines: changedLines } as never)
    expect(viaEditor).toMatchObject({
      status: "error",
      error: { code: "from_reconcile_change_on_card" },
    })
    expect(lineQuantities(h.db, id)).toEqual(["4"])

    await draftsUpdate(h.ctx, { draft_id: id, patch: { due_at: "2026-12-15" } } as never)
    expect(h.db.__all("documents").find((d) => d.id === id)?.due_at).toBe("2026-12-15")
  })

  test("a retainer month's draft linked to its reconciliation is locked the same way", async () => {
    const h = makeCtx()
    const id = await draft(h, {
      external_ref: "retainer:schedule-1:2026-10",
      external_refs: { reconciliation_id: "7a1d2c3e-0000-4000-8000-0000000000ab" },
    })
    await expect(
      draftsUpdate(h.ctx, { draft_id: id, patch: { lines: changedLines } } as never),
    ).rejects.toThrow(/from_reconcile_change_on_card/)
  })

  test("a month-end run draft's lines stay editable", async () => {
    const h = makeCtx()
    const id = await draft(h, { external_ref: "recurring:schedule-1:2026-10" })
    await draftsUpdate(h.ctx, { draft_id: id, patch: { lines: changedLines } } as never)
    expect(lineQuantities(h.db, id)).toEqual(["5"])
  })

  test("a plain draft's lines stay editable in the editor", async () => {
    const h = makeCtx()
    const id = await draft(h, {})
    const res = await documentsUpdate(h.ctx, { id, lines: changedLines } as never)
    expect((res as { status: string }).status).not.toBe("error")
    expect(lineQuantities(h.db, id)).toEqual(["5"])
  })
})
