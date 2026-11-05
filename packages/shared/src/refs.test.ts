// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { z } from "zod"
import {
  buildRefToken,
  deferrableRef,
  describeRefOutput,
  findRefTokens,
  humanizeRefTokens,
  parseRefToken,
  refTokenSchema,
  resolveRefTokens,
} from "./refs"

const A1 = "11111111-1111-4111-8111-111111111111"
const A2 = "22222222-2222-4222-8222-222222222222"

describe("ref tokens", () => {
  it("buildRefToken / parseRefToken round-trip", () => {
    const t = buildRefToken(A1, "label_pdf")
    expect(t).toBe(`@ref:${A1}:label_pdf`)
    expect(parseRefToken(t)).toEqual({ approvalId: A1, outputKey: "label_pdf" })
    expect(parseRefToken("not a token")).toBeNull()
    expect(parseRefToken("@ref:not-a-uuid:x")).toBeNull()
  })

  it("refTokenSchema accepts only well-formed tokens", () => {
    expect(refTokenSchema.safeParse(buildRefToken(A1, "x")).success).toBe(true)
    expect(refTokenSchema.safeParse("@ref:bad:x").success).toBe(false)
    expect(refTokenSchema.safeParse("plain").success).toBe(false)
  })

  it("deferrableRef accepts a concrete value or a token", () => {
    const schema = deferrableRef(z.string().uuid())
    expect(schema.safeParse(A1).success).toBe(true)
    expect(schema.safeParse(buildRefToken(A2, "id")).success).toBe(true)
    expect(schema.safeParse("garbage").success).toBe(false)
  })

  it("findRefTokens finds whole-string and embedded tokens with paths", () => {
    const payload = {
      attachments: [buildRefToken(A1, "label_pdf")],
      body: `Hello — tracking ${buildRefToken(A1, "tracking_number")} thanks`,
      nested: { x: 1 },
    }
    const found = findRefTokens(payload)
    expect(found.map((f) => `${f.approvalId}:${f.outputKey}`).sort()).toEqual([
      `${A1}:label_pdf`,
      `${A1}:tracking_number`,
    ])
    expect(found.every((f) => typeof f.path === "string")).toBe(true)
  })

  it("resolveRefTokens substitutes whole-string (any type) and embedded (stringified)", () => {
    const payload = {
      attachments: [buildRefToken(A1, "label_pdf")],
      body: `Tracking: ${buildRefToken(A1, "tracking_number")}.`,
    }
    const resolved = resolveRefTokens(payload, {
      [A1]: { label_pdf: "att-999", tracking_number: 12345 },
    }) as typeof payload
    expect(resolved.attachments).toEqual(["att-999"])
    expect(resolved.body).toBe("Tracking: 12345.")
  })

  it("resolveRefTokens throws on an unresolvable token", () => {
    expect(() =>
      resolveRefTokens({ x: buildRefToken(A1, "missing") }, { [A1]: { other: 1 } }),
    ).toThrow(/missing/)
  })

  it("an unresolvable token names the keys the referenced step returned", () => {
    expect(() =>
      resolveRefTokens({ x: buildRefToken(A1, "pdf_file_id") }, { [A1]: { number: "Q-1", id: 7 } }),
    ).toThrow('missing output "pdf_file_id": that step returned "number", "id"')
    expect(() => resolveRefTokens({ x: buildRefToken(A1, "pdf_file_id") }, {})).toThrow(
      `the step ${A1} has no result`,
    )
  })
})

describe("humanizeRefTokens: tokens read as the step they come from", () => {
  const CRM = "11111111-1111-4111-8111-111111111111"
  const QUOTE = "22222222-2222-4222-8222-222222222222"
  const sources = (id: string) =>
    id === CRM
      ? { step: 1, toolName: "api-connector:connector_write", payload: { connection: "crm" } }
      : id === QUOTE
        ? { step: 2, toolName: "invoicing:quote_create_and_issue" }
        : undefined

  it("names a whole value 'the <thing> from step N' and one in a sentence in brackets", () => {
    expect(humanizeRefTokens(buildRefToken(QUOTE, "pdf_file_id"), sources)).toBe(
      "the quote PDF from step 2",
    )
    expect(humanizeRefTokens(`Customer ref: ${buildRefToken(CRM, "record_id")}`, sources)).toBe(
      "Customer ref: [CRM record from step 1]",
    )
    expect(humanizeRefTokens(`Our quote ${buildRefToken(QUOTE, "number")} attached`, sources)).toBe(
      "Our quote [quote number from step 2] attached",
    )
  })

  it("keeps the bare key words for a step it cannot place, and with no lookup", () => {
    const unknown = "33333333-3333-4333-8333-333333333333"
    expect(humanizeRefTokens(buildRefToken(unknown, "tracking_number"), sources)).toBe(
      "[tracking number]",
    )
    expect(humanizeRefTokens(`x ${buildRefToken(QUOTE, "pdf_file_id")}`)).toBe("x [pdf file id]")
  })

  it("words an output no table names from its key", () => {
    expect(
      describeRefOutput("tracking_number", { step: 3, toolName: "boxtal:create_shipment" }),
    ).toBe("shipment tracking number from step 3")
  })
})
