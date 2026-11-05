// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The adapter save and restore are deferred host tools: what tool_search shows
// of them is their description, held to the kernel tools' 240 characters (S31),
// and the words a person uses for them ride as search keywords instead.
import { describe, expect, it } from "bun:test"
import { toolRegistry } from "~/modules/apps/app-registries"
import { registerAdapterAuthoringTools } from "./authoring-tools"

const ORG = "00000000-0000-0000-0000-0000000ad5a1"

describe("the adapter authoring tools' descriptions", () => {
  registerAdapterAuthoringTools(ORG)

  it("fit in 240 characters", () => {
    for (const name of ["connector_adapter_save", "connector_adapter_restore"]) {
      const def = toolRegistry.get([ORG, "api-connector", name])
      expect(def?.description.length).toBeLessThanOrEqual(240)
    }
  })

  it("the save keeps its guide pointer and the request's words as keywords", () => {
    const def = toolRegistry.get([ORG, "api-connector", "connector_adapter_save"])
    expect(def?.description).toContain("connector_adapter_reference")
    expect(def?.description).toContain("confirmCredentialWipe")
    expect(def?.searchKeywords).toEqual(
      expect.arrayContaining(["connect", "integration", "crm", "erp"]),
    )
  })
})
