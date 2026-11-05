// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import manifest from "../app.manifest.json"

describe("projects.handlers", () => {
  it("projects.handlers.manifest-names-script-mode-functions", async () => {
    const source = await Bun.file(new URL("../handlers.ts", import.meta.url)).text()
    for (const tool of Object.values(manifest.tools)) {
      expect(source).toContain(`async function ${tool.handler}(`)
    }
    expect(source).toContain(`async function ${manifest.views.attentionItems.handler}(`)
  })
})
