// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A plain draft that bills a client project (one with no billing plan, so no milestone route):
// drafts_create takes the project, the issued invoice keeps it, and the invoice is made out to
// a company even when the contact has none on file, from the project's own company.
import { describe, expect, test } from "bun:test"
import { harness, PROJECT } from "./__tests__/billing-plan-fixtures"
import { invoiceIssue } from "./mutations"
import { draftsCreate, draftsCreatePreflight, draftsUpdate } from "./mutations/drafts"

type Row = Record<string, unknown>

const CONTACT = "7c1d2c3e-0000-4000-8000-0000000000c1"
const PROJECT_COMPANY = "7c1d2c3e-0000-4000-8000-0000000000e1"
const CONTACT_COMPANY = "7c1d2c3e-0000-4000-8000-0000000000e2"
const UNKNOWN_PROJECT = "7c1d2c3e-0000-4000-8000-0000000000f9"

/** The shared harness, with the contact's company and the project's company answered. */
function setup(contactCompany: string | null) {
  const h = harness()
  const base = h.ctx.executeTool.bind(h.ctx)
  h.ctx.executeTool = (async (target: string, args: Row) => {
    if (target === "kernel:contacts_identity")
      return {
        status: "completed",
        result: { contact: { id: CONTACT, companyId: contactCompany } },
      }
    if (target === "projects:milestone_status_read") {
      if (args.projectId !== PROJECT)
        return { status: "error", error: { code: "not_found", message: "No project" } }
      const r = (await base(target, args)) as { result: Row }
      return { status: "completed", result: { ...r.result, companyId: PROJECT_COMPANY } }
    }
    return base(target, args)
  }) as typeof h.ctx.executeTool
  return h
}

const DRAFT = {
  type: "invoice" as const,
  counterparty_contact_id: CONTACT,
  counterparty_name: "Client Example",
  counterparty_address: "4 quai Test, 69002 Lyon",
  counterparty_country: "FR",
  counterparty_email: "billing@client.example",
  // A private client, so the e-invoicing identity checks stay out of this test's way.
  customer_kind: "individual",
  billing_line1: "4 quai Test",
  billing_postcode: "69002",
  billing_city: "Lyon",
  billing_country_code: "FR",
  operation_category: "services",
  currency: "EUR",
  items: [{ description: "First milestone", quantity: 1, unit_price_minor: 500_000 }],
}

describe("a plain draft that bills a project", () => {
  test("keeps the project on the draft and the issued invoice, with the project's company", async () => {
    const h = setup(null)
    const created = await draftsCreate(h.ctx, { ...DRAFT, project_id: PROJECT } as never)
    const draft = h.db.__all("documents").find((r) => r.id === created.draft_id) as Row
    expect(draft.billing_project_id).toBe(PROJECT)

    const issued = await invoiceIssue(h.ctx, { draft_id: created.draft_id })
    expect(JSON.stringify(issued)).toContain('"completed"')
    const id = (issued as { document_id: string }).document_id
    const doc = h.db.__all("documents").find((r) => r.id === id) as Row
    expect(doc.billing_project_id).toBe(PROJECT)
    expect(doc.company_id).toBe(PROJECT_COMPANY)
  })

  test("the contact's own company wins over the project's", async () => {
    const h = setup(CONTACT_COMPANY)
    const created = await draftsCreate(h.ctx, { ...DRAFT, project_id: PROJECT } as never)
    const issued = await invoiceIssue(h.ctx, { draft_id: created.draft_id })
    const id = (issued as { document_id: string }).document_id
    const doc = h.db.__all("documents").find((r) => r.id === id) as Row
    expect(doc.company_id).toBe(CONTACT_COMPANY)
    expect(doc.billing_project_id).toBe(PROJECT)
  })

  test("a project that cannot be read is refused before anything is drafted or parked", async () => {
    const h = setup(null)
    const before = h.db.__all("documents").length
    const pre = await draftsCreatePreflight(h.ctx, {
      ...DRAFT,
      project_id: UNKNOWN_PROJECT,
    } as never)
    expect(JSON.stringify(pre)).toContain("project_unreadable")
    await expect(
      draftsCreate(h.ctx, { ...DRAFT, project_id: UNKNOWN_PROJECT } as never),
    ).rejects.toThrow(/project_unreadable/)
    expect(h.db.__all("documents").length).toBe(before)
    expect(h.approvals.length).toBe(0)
  })

  test("updating a draft's project sets its company from the contact, else the project", async () => {
    // No company on the contact: the invoice is made out to the project's company.
    const h = setup(null)
    const created = await draftsCreate(h.ctx, DRAFT as never)
    const plain = h.db.__all("documents").find((r) => r.id === created.draft_id) as Row
    expect(plain.billing_project_id ?? null).toBeNull()
    await draftsUpdate(h.ctx, {
      draft_id: created.draft_id,
      patch: { project_id: PROJECT } as never,
    })
    const draft = h.db.__all("documents").find((r) => r.id === created.draft_id) as Row
    expect(draft.billing_project_id).toBe(PROJECT)
    const issued = await invoiceIssue(h.ctx, { draft_id: created.draft_id })
    const id = (issued as { document_id: string }).document_id
    const doc = h.db.__all("documents").find((r) => r.id === id) as Row
    expect(doc.billing_project_id).toBe(PROJECT)
    expect(doc.company_id).toBe(PROJECT_COMPANY)

    // The contact's own company wins over the project's.
    const h2 = setup(CONTACT_COMPANY)
    const c2 = await draftsCreate(h2.ctx, DRAFT as never)
    await draftsUpdate(h2.ctx, { draft_id: c2.draft_id, patch: { project_id: PROJECT } as never })
    const i2 = await invoiceIssue(h2.ctx, { draft_id: c2.draft_id })
    const d2 = h2.db
      .__all("documents")
      .find((r) => r.id === (i2 as { document_id: string }).document_id) as Row
    expect(d2.company_id).toBe(CONTACT_COMPANY)
    expect(d2.billing_project_id).toBe(PROJECT)
  })

  test("a draft's project that cannot be read is refused and the draft is unchanged", async () => {
    const h = setup(null)
    const created = await draftsCreate(h.ctx, DRAFT as never)
    await expect(
      draftsUpdate(h.ctx, {
        draft_id: created.draft_id,
        patch: { project_id: UNKNOWN_PROJECT } as never,
      }),
    ).rejects.toThrow(/project_unreadable/)
    const draft = h.db.__all("documents").find((r) => r.id === created.draft_id) as Row
    expect(draft.billing_project_id ?? null).toBeNull()
  })

  test("the raw billing_project_id key in a patch gets the same project check", async () => {
    const h = setup(null)
    const created = await draftsCreate(h.ctx, DRAFT as never)
    await expect(
      draftsUpdate(h.ctx, {
        draft_id: created.draft_id,
        patch: { billing_project_id: UNKNOWN_PROJECT } as never,
      }),
    ).rejects.toThrow(/project_unreadable/)
    const draft = h.db.__all("documents").find((r) => r.id === created.draft_id) as Row
    expect(draft.billing_project_id ?? null).toBeNull()

    await draftsUpdate(h.ctx, {
      draft_id: created.draft_id,
      patch: { billing_project_id: PROJECT } as never,
    })
    const linked = h.db.__all("documents").find((r) => r.id === created.draft_id) as Row
    expect(linked.billing_project_id).toBe(PROJECT)
  })

  test("a patch naming two different projects is refused", async () => {
    const h = setup(null)
    const created = await draftsCreate(h.ctx, DRAFT as never)
    await expect(
      draftsUpdate(h.ctx, {
        draft_id: created.draft_id,
        patch: { project_id: PROJECT, billing_project_id: UNKNOWN_PROJECT } as never,
      }),
    ).rejects.toThrow(/invalid_project/)
    const draft = h.db.__all("documents").find((r) => r.id === created.draft_id) as Row
    expect(draft.billing_project_id ?? null).toBeNull()
  })
})
