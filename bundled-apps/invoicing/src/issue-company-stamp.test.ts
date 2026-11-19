// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client company an issued document is made out to: read at issue from the
// counterparty contact's identifiers only, never guessed, and NULL whenever the
// kernel does not say.
import { describe, expect, test } from "bun:test"
import { companyOfContact, documentCompany } from "./issue"

const CONTACT = "11111111-1111-4111-8111-111111111111"
const COMPANY = "22222222-2222-4222-8222-222222222222"
const SOURCE_COMPANY = "33333333-3333-4333-8333-333333333333"
const PROJECT = "44444444-4444-4444-8444-444444444444"
const PROJECT_COMPANY = "55555555-5555-4555-8555-555555555555"

/** Answers the contact read with `contact`, and the project read with the project's company. */
function ctxWith(contact: unknown, calls: string[] = []) {
  return {
    executeTool: async (tool: string) => {
      calls.push(tool)
      if (tool === "projects:milestone_status_read")
        return { status: "completed", result: { companyId: PROJECT_COMPANY } }
      if (contact instanceof Error) throw contact
      return contact as { status: string; result?: unknown }
    },
  } as never
}
const hasCompany = (id: string) => ({ status: "completed", result: { contact: { companyId: id } } })
const noCompany = { status: "completed", result: { contact: { companyId: null } } }

function ctxAnswering(answer: unknown, calls: Array<[string, unknown]> = []) {
  return {
    executeTool: async (tool: string, params: unknown) => {
      calls.push([tool, params])
      if (answer instanceof Error) throw answer
      return answer as { status: string; result?: unknown }
    },
  } as never
}

describe("the company stamped on an issued document", () => {
  test("is the contact's company, read through the identifiers-only kernel read", async () => {
    const calls: Array<[string, unknown]> = []
    const ctx = ctxAnswering(
      { status: "completed", result: { contact: { id: CONTACT, companyId: COMPANY } } },
      calls,
    )
    expect(await companyOfContact(ctx, CONTACT)).toBe(COMPANY)
    expect(calls).toEqual([["kernel:contacts_identity", { contactId: CONTACT }]])
  })

  test("is null for a contact with no company, a refused or failed read, or no contact", async () => {
    const none = ctxAnswering({ status: "completed", result: { contact: { companyId: null } } })
    expect(await companyOfContact(none, CONTACT)).toBeNull()
    const refused = ctxAnswering({ status: "error", error: { code: "forbidden" } })
    expect(await companyOfContact(refused, CONTACT)).toBeNull()
    expect(await companyOfContact(ctxAnswering(new Error("down")), CONTACT)).toBeNull()
    const calls: Array<[string, unknown]> = []
    expect(await companyOfContact(ctxAnswering({}, calls), null)).toBeNull()
    expect(await companyOfContact(ctxAnswering({}, calls), "not-a-uuid")).toBeNull()
    expect(calls).toEqual([])
  })

  test("never takes a value that is not a company id", async () => {
    const odd = ctxAnswering({
      status: "completed",
      result: { contact: { companyId: "Maison Alpha" } },
    })
    expect(await companyOfContact(odd, CONTACT)).toBeNull()
  })
})

describe("the company an issued document is made out to, against the company stamped from its source", () => {
  test("the contact's own company wins over a different company stamped from the source", async () => {
    const company = await documentCompany(ctxWith(hasCompany(COMPANY)), {
      type: "invoice",
      contactId: CONTACT,
      stamped: SOURCE_COMPANY,
      billingProjectId: PROJECT,
    })
    expect(company).toBe(COMPANY)
    expect(company).not.toBe(SOURCE_COMPANY)
  })

  test("a contact with no company takes the stamped company, else the project's", async () => {
    const base = { type: "invoice" as const, contactId: CONTACT, billingProjectId: PROJECT }
    expect(await documentCompany(ctxWith(noCompany), { ...base, stamped: SOURCE_COMPANY })).toBe(
      SOURCE_COMPANY,
    )
    expect(await documentCompany(ctxWith(noCompany), { ...base, stamped: null })).toBe(
      PROJECT_COMPANY,
    )
  })

  test("takes no source company when the contact's company cannot be read", async () => {
    const refused = { status: "error", error: { code: "forbidden" } }
    for (const answer of [refused, new Error("down")]) {
      expect(
        await documentCompany(ctxWith(answer), {
          type: "invoice",
          contactId: CONTACT,
          stamped: SOURCE_COMPANY,
          billingProjectId: PROJECT,
        }),
      ).toBeNull()
    }
  })

  test("a purchase order never takes a client company from its source", async () => {
    const calls: string[] = []
    const po = await documentCompany(ctxWith(noCompany, calls), {
      type: "purchase_order",
      contactId: CONTACT,
      stamped: SOURCE_COMPANY,
      billingProjectId: PROJECT,
    })
    expect(po).toBeNull()
    expect(calls).not.toContain("projects:milestone_status_read")
    // Its supplier contact's own company is still its company.
    expect(
      await documentCompany(ctxWith(hasCompany(COMPANY)), {
        type: "purchase_order",
        contactId: CONTACT,
        stamped: SOURCE_COMPANY,
      }),
    ).toBe(COMPANY)
  })
})
