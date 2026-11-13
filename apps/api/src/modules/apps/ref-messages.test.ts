// SPDX-License-Identifier: FSL-1.1-ALv2
// The sequencing texts a small model follows: each refusal names the next action and
// the exact token form, and near-miss references are caught before they are sent.
import { describe, expect, it } from "bun:test"
import mailManifest from "~/apps/mail/app.manifest.json"
import { sequencingRecipe } from "~/modules/approvals/agent-guidance"
import { personRefusalError, validateParamsForTool } from "~/modules/apps/execute-tool"
import {
  findMalformedRefs,
  malformedRefMessage,
  refNotChainableMessage,
  refNotFoundMessage,
  refSpanMessage,
  refUnknownOutputMessage,
  sequencingHint,
} from "~/modules/apps/ref-messages"

const ID = "3f2b6c1e-8a4d-4f0e-9b7a-2c5d8e1f0a93"
const ID2 = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"

describe("near-miss references", () => {
  it("flags reference-like text that is not a parseable token", () => {
    const params = {
      customer_reference: "{{step1.record_id}}",
      attachments: ["@ref:<approval2>:pdf_file_id", `@REF:${ID}`],
      textBody: `Quote $${"{"}approval_2.outputs.number} attached`,
      other: "$ref:quote.number",
      missingUuid: "@ref:pdf_file_id",
      call: `@ref(${ID}.outputs.x)`,
    }
    const paths = findMalformedRefs(params).map((h) => h.path)
    expect(paths).toEqual([
      "customer_reference",
      "attachments.0",
      "attachments.1",
      "textBody",
      "other",
      "missingUuid",
      "call",
    ])
  })

  it("leaves valid tokens and ordinary text alone", () => {
    expect(
      findMalformedRefs({
        attachments: [`@ref:${ID}:pdf_file_id`],
        textBody: `Hello {{firstName}}, quote @ref:${ID}:number. Refund done; see @refunds.`,
        schema: { $ref: "#/components/schemas/Contact" },
        yaml: "$ref: '#/components/schemas/Contact'",
        // Review 2026-10-30: an address on a ref.* domain and mail-merge slots that
        // merely start with a ref word are ordinary text.
        to: "anna@ref.io",
        cc: ["ops@ref-audio.example", "x.y@ref:5"],
        mergeSlots: "Signed on {{approval_date}} for {{output_format}}, {{referrer}}.",
      }),
    ).toEqual([])
  })

  it("the refusal shows the offending text and the exact expected form", () => {
    const msg = malformedRefMessage("mail:reply", [
      { path: "attachments.0", text: "@ref:<approval2>:pdf_file_id" },
    ])
    expect(msg).toContain('attachments.0 holds "@ref:<approval2>:pdf_file_id"')
    expect(msg).toContain("@ref:<approvalRequestId>:<output_key>")
    expect(msg).toContain("Copy the token from `outputs` verbatim")
  })
})

describe("ref refusal messages", () => {
  it("not found: where the token comes from", () => {
    const msg = refNotFoundMessage([ID])
    expect(msg).toContain(ID)
    expect(msg).toContain("THIS conversation")
    expect(msg).toContain("`approvalRequestId`")
    expect(msg).toContain("`outputs`")
  })

  it("unknown output: lists the ready-to-paste tokens, or says none exist", () => {
    const msg = refUnknownOutputMessage(ID, "invoicing:quote_create_and_issue", "pdf", [
      "document_id",
      "pdf_file_id",
    ])
    expect(msg).toContain(`"@ref:${ID}:document_id", "@ref:${ID}:pdf_file_id"`)
    const none = refUnknownOutputMessage(ID, "mail:reply", "id", [])
    expect(none).toContain("declares no outputs")
    expect(none).toContain("without any @ref token")
  })

  it("not chainable: approved means use real values, rejected means propose again", () => {
    expect(refNotChainableMessage(ID, "api-connector:connector_write", "approved")).toContain(
      "pass those values directly",
    )
    for (const status of ["rejected", "expired", "cancelled", "failed"]) {
      const msg = refNotChainableMessage(ID, "api-connector:connector_write", status)
      expect(msg).toContain(status)
      expect(msg).toContain("propose the whole sequence again as new calls")
    }
  })

  it("span: one earlier step per call, chain in order", () => {
    const msg = refSpanMessage([ID, ID2])
    expect(msg).toContain("only ONE earlier step")
    expect(msg).toContain(`${ID}, ${ID2}`)
  })

  it("a person's own @ref call says to use real values", () => {
    const err = personRefusalError("sequenced", "mail:reply", [])
    expect(err.message).toContain("Replace each @ref token with the real value")
  })
})

describe("the gated result's sequencing text", () => {
  it("the hint carries a ready-to-paste example from this call", () => {
    const hint = sequencingHint(ID, ["pdf_file_id", "number"])
    expect(hint).toContain(`"@ref:${ID}:pdf_file_id"`)
    expect(hint).toContain("added to this request")
    expect(hint).toContain("Do not wait")
  })

  it("the recipe is numbered and lists the outputs, and is empty without outputs", () => {
    const recipe = sequencingRecipe({ record_id: `@ref:${ID}:record_id` })
    expect(recipe).toContain(`record_id = "@ref:${ID}:record_id"`)
    expect(recipe).toContain("1. ")
    expect(recipe).toContain("Never pass the bare approvalRequestId")
    expect(sequencingRecipe(undefined)).toBe("")
  })
})

describe("mail:reply attachments take only a file id or a whole @ref token", () => {
  const tool = {
    appName: "mail",
    name: "reply",
    description: "reply",
    requiredScopes: [],
    handler: { bundlePath: "/nonexistent.js", exportName: "reply", core: true },
    params: mailManifest.tools.reply.params,
  } as unknown as Parameters<typeof validateParamsForTool>[0]
  const call = (attachments: string[]) =>
    validateParamsForTool(tool, ID, "mail", "reply", {
      conversationId: ID,
      textBody: "hi",
      attachments,
    })

  it("accepts a uuid and a whole @ref token", () => {
    expect(() => call([ID, `@ref:${ID2}:pdf_file_id`])).not.toThrow()
  })

  it("refuses a document number, a filename or a URL, saying what an attachment id is", () => {
    for (const bad of ["QUO-2026-0001", "quote.pdf", "https://x.example/q.pdf"]) {
      let message = ""
      try {
        call([bad])
      } catch (err) {
        message = err instanceof Error ? err.message : String(err)
      }
      expect(message).toContain(`holds "${bad}"`)
      expect(message).toContain("files_list")
      expect(message).toContain("pdf_file_id")
    }
  })
})
