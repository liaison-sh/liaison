// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client company an issued document is made out to: read at issue from the
// counterparty contact's identifiers only, never guessed, and NULL whenever the
// kernel does not say.
import { describe, expect, test } from "bun:test"
import { companyOfContact } from "./issue"

const CONTACT = "11111111-1111-4111-8111-111111111111"
const COMPANY = "22222222-2222-4222-8222-222222222222"

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
