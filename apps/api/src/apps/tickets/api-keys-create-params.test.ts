// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Tickets settings page's "Generate API key" button (one per API inbox,
// apps/web/src/modules/tickets/TicketsInboxRouting.tsx) calls apiKeys.create with
// {label, inboxId}. The tool validates params against the manifest and refuses a
// name the manifest does not declare, so the button did nothing ("inboxId is not
// a recognised parameter") while the handler, which has always supported the
// inbox scope, was unreachable from it. The manifest must declare every param the
// handler reads.

import { describe, expect, it } from "bun:test"
import ticketsManifest from "./app.manifest.json"

const tool = ticketsManifest.tools["apiKeys.create"]

describe("apiKeys.create manifest params", () => {
  it("declares label, allowedOrigins and inboxId, the three names the handler reads", () => {
    expect(Object.keys(tool.params.properties).sort()).toEqual([
      "allowedOrigins",
      "inboxId",
      "label",
    ])
  })

  it("types inboxId as a string (a null is refused on an optional field: the caller omits the key)", () => {
    expect(tool.params.properties.inboxId.type).toBe("string")
  })

  it("keeps label the only required param, so a key stays creatable org-wide from the generic form", () => {
    expect(tool.params.required).toEqual(["label"])
  })
})
