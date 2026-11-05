// SPDX-License-Identifier: FSL-1.1-ALv2
// Host-only `__mailbox*` parameters: hidden from the schema a model or an MCP client sees and
// stripped from what they send, so only the bridge's mailbox retry can supply them.
import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { stripHostOnlyParams } from "~/modules/agent/tools/host-only-params"
import { describeToolParams, providerInputSchemaOf } from "~/modules/agent/tools/tool-bridge"

const params = z.object({
  fileId: z.string(),
  context: z.string().optional(),
  __mailboxAttachments: z.record(z.string(), z.string()).optional(),
})

function propertiesOf(schema: unknown): string[] {
  const s = schema as { jsonSchema?: { properties?: Record<string, unknown> } }
  if (s.jsonSchema?.properties) return Object.keys(s.jsonSchema.properties)
  return Object.keys((schema as z.ZodObject<z.ZodRawShape>).shape)
}

describe("host-only tool parameters", () => {
  it("strips __mailbox* keys from model or client arguments, and only those", () => {
    const args: Record<string, unknown> = {
      fileId: "f1",
      context: "totals",
      __mailboxAttachments: { f1: "QUJD" },
    }
    expect(stripHostOnlyParams(args)).toEqual({ fileId: "f1", context: "totals" })
    const clean = { fileId: "f1" }
    expect(stripHostOnlyParams(clean)).toBe(clean)
    expect(stripHostOnlyParams(null)).toBeNull()
  })

  it("leaves them out of the provider-facing schema and the blind-call description", () => {
    const props = propertiesOf(providerInputSchemaOf(params))
    expect(props).toContain("fileId")
    expect(props).not.toContain("__mailboxAttachments")
    expect(describeToolParams(params)).not.toContain("__mailbox")
  })

  it("hides them for a manifest (JSON Schema) tool too", () => {
    const manifest = {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        __mailboxQuote: { type: "object" },
        __mailboxSearchIds: { type: "array", items: { type: "string" } },
      },
      required: ["conversationId"],
    }
    const props = propertiesOf(providerInputSchemaOf(manifest))
    expect(props).toEqual(["conversationId"])
  })
})
