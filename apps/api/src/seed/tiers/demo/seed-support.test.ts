// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * WHAT: The demo support seed's approval payloads, held to the API's contract
 * without a database (`approval-payload.ts` explains the contract).
 *
 * The seed's own spec tables are checked by `assertTicketApprovalsResolve` at
 * its load (`seed-support.ts`), which is what refuses a ticket approval that
 * names no ticket; that call is pinned here by source, and the checker is
 * exercised on its own.
 */
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assertTicketApprovalsResolve } from "./approval-payload"
import { APPROVAL_SPECS, type ApprovalRefs } from "./approval-specs"

describe("a seeded ticket approval", () => {
  it("must name a ticket the seed creates, so Open ticket has somewhere to go", () => {
    const tickets = [{ key: "kestrel-10-wont-power" }]
    expect(() =>
      assertTicketApprovalsResolve(
        [{ key: "reply", toolName: "tickets:reply", ticketKey: "kestrel-10-wont-power" }],
        tickets,
      ),
    ).not.toThrow()
    expect(() =>
      assertTicketApprovalsResolve([{ key: "reply", toolName: "tickets:reply" }], tickets),
    ).toThrow("approval reply (tickets:reply) names no ticket")
    expect(() =>
      assertTicketApprovalsResolve(
        [{ key: "reply", toolName: "tickets:reply", ticketKey: "nope" }],
        tickets,
      ),
    ).toThrow("unknown ticket nope")
    // A bulk ticket action spans many tickets and names none.
    expect(() =>
      assertTicketApprovalsResolve([{ key: "bulk", toolName: "tickets:bulkClose" }], tickets),
    ).not.toThrow()
    // A refund names no ticket and needs none.
    expect(() =>
      assertTicketApprovalsResolve(
        [{ key: "refund", toolName: "invoicing:documents_record_refund" }],
        tickets,
      ),
    ).not.toThrow()
  })

  it("is checked by the seed at load, over its own spec tables", () => {
    const source = readFileSync(join(import.meta.dir, "seed-support.ts"), "utf8")
    expect(source).toContain("assertTicketApprovalsResolve(APPROVAL_SPECS, TICKET_SPECS)")
    const specs = readFileSync(join(import.meta.dir, "approval-specs.ts"), "utf8")
    expect(specs).toMatch(
      /toolName: "tickets:reply",\s+thread: "[^"]+",\s+ticketKey: "kestrel-10-wont-power"/,
    )
  })

  it("writes the resolved ticket id into the payload the API reads", () => {
    const spec = APPROVAL_SPECS.find((a) => a.key === "reply-kestrel-10-replacement")
    if (!spec) throw new Error("the seeded ticket reply approval is gone")
    const ticketId = "11111111-2222-3333-4444-555555555555"
    const refs = {
      ticket: (key: string) => (key === "kestrel-10-wont-power" ? ticketId : "wrong"),
    } as unknown as ApprovalRefs
    expect(spec.payload(refs).ticketId).toBe(ticketId)
  })
})

describe("the seeded knowledge base", () => {
  it("holds one document the whole team may edit, so the Knowledge tour's edit step has one", () => {
    // Every other article is authored by the admin and readable only (org
    // access "viewer"): a visitor who is not its creator sees no Edit on it.
    const source = readFileSync(join(import.meta.dir, "support-specs.ts"), "utf8")
    expect(source).toMatch(
      /key: "shipping-timelines",[\s\S]{0,400}?orgAccess: "editor",[\s\S]{0,200}?verified: false/,
    )
  })
})
