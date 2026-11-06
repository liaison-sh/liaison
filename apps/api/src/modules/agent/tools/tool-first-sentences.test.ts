// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Tools a model confuses are told apart by the first words of their descriptions, the part
// a search result shows. These words are the difference between them: reword them freely,
// but keep the difference.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { TOOL_SEARCH_SYNOPSIS_CHARS } from "~/modules/agent/tools/tool-search"
import { toolRegistry } from "~/modules/apps/app-registries"
import { createTestOrg } from "~/tests/helpers/org"

const BUNDLED_APPS = join(import.meta.dir, "../../../../../../bundled-apps")

function manifestTool(app: string, tool: string): string {
  const manifest = JSON.parse(readFileSync(join(BUNDLED_APPS, app, "app.manifest.json"), "utf8"))
  return manifest.tools[tool].description
}

const PINS: Array<[app: string, tool: string, words: string]> = [
  ["invoicing", "documents_search", "Search invoices, quotes, credit notes"],
  [
    "invoicing",
    "received_einvoices_list",
    "supplier e-invoices delivered by the e-invoicing platform",
  ],
  ["invoicing", "documents_record_refund", "records only, moves no money"],
  ["invoicing", "credit_note_create_and_issue", "a legal document"],
  [
    "pennylane",
    "customer_invoices_list",
    "as booked in the accounting system; to act on an invoice use invoicing",
  ],
  ["pennylane", "supplier_invoices_list", "bills booked in accounting"],
  ["shopify", "refunds_create", "moves money on the order"],
  ["shopify", "returns_refund", "moves money on the order"],
  ["shopify", "order_update", "through approval"],
  ["shopify", "order_note_set", "applied at once"],
  ["boxtal", "prep_list", "worklist people see, with offers and status"],
  ["boxtal", "to_prepare_list", "Exact counts of what is left to ship"],
  ["boxtal", "track", "Where a parcel is now, for the person"],
  ["boxtal", "get_shipment", "The shipment record, refreshed"],
  ["boxtal", "search", "Find a shipment by name, order or number"],
  ["boxtal", "print_pack", "labels and shipping papers"],
]

describe("first words of tools a model confuses", () => {
  for (const [app, tool, words] of PINS) {
    it(`${app}__${tool}`, () => {
      const head = manifestTool(app, tool).slice(0, TOOL_SEARCH_SYNOPSIS_CHARS)
      expect(head).toContain(words)
    })
  }

  describe("kernel", () => {
    let orgId = ""
    beforeAll(async () => {
      orgId = (await createTestOrg()).id
      const { registerKernelAgentTools } = await import("./kernel-tools")
      await registerKernelAgentTools(orgId)
    })
    afterAll(() => {
      toolRegistry.deleteByPrefix([orgId])
    })

    it("enable_app installs, apps_set_enabled switches an installed app", () => {
      expect(toolRegistry.get([orgId, "kernel", "enable_app"])?.description).toStartWith(
        "Install an app from the catalog",
      )
      expect(toolRegistry.get([orgId, "kernel", "apps_set_enabled"])?.description).toStartWith(
        "Turn an installed app On or Off",
      )
    })
  })
})
