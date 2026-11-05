// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { getDefaultApps } from "~/modules/apps/init"

describe("Knowledge final wiring", () => {
  it("ships Knowledge and Google Drive as default first-party apps", async () => {
    const names = (await getDefaultApps()).map((app) => app.name)
    expect(names).toEqual(expect.arrayContaining(["knowledge", "google-drive"]))
  })
})
