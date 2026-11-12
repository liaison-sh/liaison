// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import * as handlers from "~/apps/projects/handlers"
import manifest from "../app.manifest.json"

describe("projects.handlers", () => {
  it("projects.handlers.manifest-names-module-exports", () => {
    const exports = handlers as unknown as Record<string, unknown>
    for (const tool of Object.values(manifest.tools)) {
      expect(typeof exports[tool.handler]).toBe("function")
    }
    expect(typeof exports[manifest.views.attentionItems.handler]).toBe("function")
  })
})
