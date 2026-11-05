// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { normalizeSubjectRoot, ticketDedupeKey } from "~/apps/tickets/search-enrichment"

describe("normalizeSubjectRoot", () => {
  it("strips reply and forward prefixes, repeatedly and case-insensitively", () => {
    expect(normalizeSubjectRoot("Re: Request to Return ORDER #2936")).toBe(
      "request to return order #2936",
    )
    expect(normalizeSubjectRoot("RE: re: Fwd: Request to Return ORDER #2936")).toBe(
      "request to return order #2936",
    )
    expect(normalizeSubjectRoot("FW: AW: TR: SV: hello")).toBe("hello")
    expect(normalizeSubjectRoot("Re[2]: hello")).toBe("hello")
  })

  it("lowercases and collapses whitespace so cosmetic variants share a root", () => {
    expect(normalizeSubjectRoot("  Request   to  Return ORDER #2936 ")).toBe(
      "request to return order #2936",
    )
  })

  it("does not strip prefix-like words inside the subject", () => {
    expect(normalizeSubjectRoot("Repair request")).toBe("repair request")
    expect(normalizeSubjectRoot("Return policy: question")).toBe("return policy: question")
  })
})

describe("ticketDedupeKey", () => {
  it("same contact + subject variants of one conversation share a key", () => {
    const base = ticketDedupeKey({
      contact_id: "c-1",
      subject: "Request to Return ORDER #2936",
    })
    const reply = ticketDedupeKey({
      contact_id: "c-1",
      subject: "Re: Request to Return ORDER #2936",
    })
    const deepReply = ticketDedupeKey({
      contact_id: "c-1",
      subject: "RE: Re: request to return order #2936",
    })
    expect(base).not.toBeNull()
    expect(reply).toBe(base as string)
    expect(deepReply).toBe(base as string)
  })

  it("different contact or different subject root never share a key", () => {
    const a = ticketDedupeKey({ contact_id: "c-1", subject: "Re: Broken encoder" })
    const b = ticketDedupeKey({ contact_id: "c-2", subject: "Re: Broken encoder" })
    const c = ticketDedupeKey({ contact_id: "c-1", subject: "Re: Broken slider" })
    expect(a).not.toBe(b as string)
    expect(a).not.toBe(c as string)
  })

  it("no contact or empty subject dedupes with nothing (null key)", () => {
    expect(ticketDedupeKey({ contact_id: null, subject: "Re: hello" })).toBeNull()
    expect(ticketDedupeKey({ contact_id: "c-1", subject: "" })).toBeNull()
    expect(ticketDedupeKey({ contact_id: "c-1", subject: "Re: " })).toBeNull()
    expect(ticketDedupeKey({ contact_id: "c-1" })).toBeNull()
  })
})
