// SPDX-License-Identifier: FSL-1.1-ALv2
// L7: an app's settings row is never labelled with its raw id.
import { describe, expect, it } from "vitest"
import { settingsAppName } from "./settings-nav-groups"

const t = (key: string) => key

describe("settingsAppName", () => {
  it("an app the catalog, the rail and its page do not name reads as its id in words", () => {
    expect(settingsAppName("acme_field-tool", [], [], t)).toBe("Acme field tool")
  })
})
