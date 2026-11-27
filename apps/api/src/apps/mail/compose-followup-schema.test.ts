// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A follow-up's `followUp` argument is a closed shape: a misspelt key ("refs "
// with a space, "refs.id", "refsAdvanced") used to pass, leave the refs empty
// and turn a reminder about an invoice into a commercial mail. It is refused
// with a message that names the key and the keys it takes.

import { describe, expect, it } from "bun:test"
import { validateManifestToolParams } from "~/modules/apps/execute-tool-params"
import mailManifest from "./app.manifest.json"

const tools = mailManifest.tools as unknown as Record<string, { params: object } | undefined>
const schemaOf = (name: string): object => {
  const tool = tools[name]
  if (!tool) throw new Error(`no ${name} tool`)
  return tool.params
}

const base = {
  accountId: "acc-1",
  to: ["billing@client.test"],
  subject: "Your card was declined",
  textBody: "The payment for invoice 12 did not go through.",
}
const invoiceRef = [{ kind: "stripe:invoice", id: "in_1" }]

function refusal(tool: string, params: Record<string, unknown>): string {
  try {
    validateManifestToolParams(`mail:${tool}`, schemaOf(tool), params)
  } catch (err) {
    return (err as Error).message
  }
  throw new Error("accepted")
}

describe("mail followUp argument", () => {
  for (const tool of ["compose", "reply"]) {
    const params = (followUp: unknown) =>
      tool === "compose"
        ? { ...base, followUp }
        : { conversationId: "c1", textBody: base.textBody, followUp }

    it(`${tool} accepts a follow-up that names its record, and an empty follow-up`, () => {
      expect(() =>
        validateManifestToolParams(
          `mail:${tool}`,
          schemaOf(tool),
          params({ refs: invoiceRef, classification: "service" }),
        ),
      ).not.toThrow()
      expect(() =>
        validateManifestToolParams(`mail:${tool}`, schemaOf(tool), params({})),
      ).not.toThrow()
    })

    for (const [label, followUp, key] of [
      ["a key with a trailing space", { "refs ": invoiceRef, classification: "service" }, "refs "],
      [
        "dotted keys",
        { "refs.id": "in_1", "refs.kind": "stripe:invoice", classification: "service" },
        "refs.id",
      ],
      ["an invented key", { refsAdvanced: [], classification: "service" }, "refsAdvanced"],
    ] as const) {
      it(`${tool} refuses ${label} and names the keys it takes`, () => {
        const message = refusal(tool, params(followUp))
        expect(message).toContain(`"followUp.${key}" is not a recognised field`)
        expect(message).toContain("refs, classification")
      })
    }

    it(`${tool} refuses a ref with an unknown key or an empty id`, () => {
      expect(
        refusal(
          tool,
          params({
            refs: [{ kind: "stripe:invoice", id: "in_1", note: "x" }],
            classification: "service",
          }),
        ),
      ).toContain('"followUp.refs.0.note" is not a recognised field')
      expect(
        refusal(
          tool,
          params({ refs: [{ kind: "stripe:invoice", id: "" }], classification: "service" }),
        ),
      ).toContain("followUp.refs.0.id")
    })
  }
})
