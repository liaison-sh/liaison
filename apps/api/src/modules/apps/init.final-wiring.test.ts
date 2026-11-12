// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { getDefaultApps } from "~/modules/apps/init"

describe("Knowledge final wiring", () => {
  it("ships Knowledge as a default first-party app; Google Drive is a catalog app", async () => {
    const names = (await getDefaultApps()).map((app) => app.name)
    expect(names).toContain("knowledge")
    const { existsSync } = await import("node:fs")
    const { join } = await import("node:path")
    expect(existsSync(join(import.meta.dir, "../../../../../bundled-apps/google-drive/app.manifest.json"))).toBe(true)
  })
})
