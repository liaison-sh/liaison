// SPDX-License-Identifier: FSL-1.1-ALv2
// The approval card for a remote MCP tool call: the server and the action as the title, then
// what will be written and where. A live card for "add a note to a company" read
// "Mcp: <slug>:manage crm objects" over "Create request, objects: 1 item": the note text and
// the company it went to were only in the collapsed payload.
import { beforeEach, describe, expect, it } from "bun:test"
import { approvalSummarySchema } from "@liaison/shared"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { generateApprovalSummary } from "~/modules/apps/approval-summarizers"
import { ToolProjector } from "~/modules/mcp-client/projector"

const ORG = "00000000-0000-0000-0000-000000000001"
const CONN = "00000000-0000-0000-0000-000000000010"

// A CRM-shaped write tool: one batch of objects, each with free-form properties and
// associations to other records. Names are generic; the shape is the live one.
const TOOL = {
  name: "manage_crm_objects",
  description:
    "Create or update CRM records (contacts, companies, notes) in one batch.\nPass confirmationStatus once the user confirmed.",
  inputSchema: {
    type: "object",
    properties: {
      createRequest: {
        type: "object",
        properties: {
          objects: {
            type: "array",
            items: {
              type: "object",
              properties: {
                objectType: { type: "string" },
                properties: { type: "object", additionalProperties: { type: "string" } },
                associations: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      targetObjectId: { type: "number", description: "Record to link to" },
                      targetObjectType: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      confirmationStatus: { type: "string" },
    },
  },
  annotations: { destructiveHint: true },
}

function noteArgs(body: string) {
  return {
    createRequest: {
      objects: [
        {
          objectType: "NOTE",
          properties: { note_body: body, note_timestamp: "2026-10-26T00:02:38.705Z" },
          associations: [{ targetObjectId: 457085956283, targetObjectType: "COMPANY" }],
        },
      ],
    },
    confirmationStatus: "CONFIRMED",
  }
}

async function cardFor(args: unknown) {
  const projector = new ToolProjector({ executeMcpCall: async () => ({}) })
  await projector.registerTools({
    orgId: ORG,
    connectionId: CONN,
    slug: "crm",
    displayName: "Acme CRM",
    tools: [TOOL],
  })
  // The gate's own path: executeTool summarizes a parked call through this.
  return generateApprovalSummary(
    ORG,
    "mcp",
    "crm:manage_crm_objects",
    args,
    {} as never,
    "mcp:crm:manage_crm_objects",
  )
}

describe("MCP tool approval card", () => {
  beforeEach(() => resetAppRegistries())

  it("titles the card with the server's name and the action, and shows what is written where", async () => {
    const s = await cardFor(noteArgs("Test note, safe to delete"))
    expect(approvalSummarySchema.safeParse(s).success).toBe(true)
    expect(s.title).toBe("Acme CRM · Manage CRM objects")
    expect(s.title).not.toContain("Mcp:")
    expect(s.subtitle).toBe(
      "Create or update CRM records (contacts, companies, notes) in one batch.",
    )
    // The note text first, in full.
    expect(s.lines[0]).toBe("Properties › Note body: Test note, safe to delete")
    // Where it goes: the association's id, labelled from the schema description.
    expect(s.lines).toContain("Associations › Record to link to: 457085956283")
    expect(s.lines).toContain("Associations › Target object type: COMPANY")
    expect(s.lines).toContain("Objects › Object type: NOTE")
    // Boilerplate confirmation flag left out.
    expect(s.lines.join("\n")).not.toContain("CONFIRMED")
  })

  it("caps a long text at 500 characters with an ellipsis, and a card at 8 lines", async () => {
    const long = `${"word ".repeat(300)}END`
    const s = await cardFor(noteArgs(long))
    expect(s.lines[0]?.length).toBe(500)
    expect(s.lines[0]?.endsWith("…")).toBe(true)
    expect(s.lines[0]).not.toContain("END")

    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field_${i}`, `v${i}`]))
    const big = await cardFor(many)
    expect(big.lines).toHaveLength(8)
    expect(big.lines[7]).toBe("(and 13 more values in the full arguments)")
  })

  it("an array shows its count and only its first items", async () => {
    const objects = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}` }))
    const s = await cardFor({ createRequest: { objects } })
    expect(s.lines).toEqual([
      "Create request › Objects: 5 items, first 3 shown",
      "Objects 1 › Id: n0",
      "Objects 2 › Id: n1",
      "Objects 3 › Id: n2",
    ])
  })

  it("keeps hostile argument text inert: one plain line, markup verbatim, controls stripped", async () => {
    const rlo = String.fromCharCode(0x202e)
    const bel = String.fromCharCode(0x07)
    const hostile = `<img src=x onerror="alert(1)">\n\n# Approve now\n[click](javascript:alert(1)) **bold**${rlo}evil${bel}`
    const s = await cardFor(noteArgs(hostile))
    const line = s.lines[0] ?? ""
    expect(line).toBe(
      'Properties › Note body: <img src=x onerror="alert(1)"> # Approve now [click](javascript:alert(1)) **bold**evil',
    )
    for (const ch of ["\n", rlo, bel]) expect(line.includes(ch)).toBe(false)
    expect(s.title).toBe("Acme CRM · Manage CRM objects")
  })

  it("retiring the server's tools retires their cards", async () => {
    const projector = new ToolProjector({ executeMcpCall: async () => ({}) })
    await projector.registerTools({
      orgId: ORG,
      connectionId: CONN,
      slug: "crm",
      displayName: "Acme CRM",
      tools: [TOOL],
    })
    projector.retireSlug(ORG, "crm")
    const s = await generateApprovalSummary(
      ORG,
      "mcp",
      "crm:manage_crm_objects",
      {},
      {} as never,
      "mcp:crm:manage_crm_objects",
    )
    expect(s.title).not.toContain("Acme CRM")
  })
})
