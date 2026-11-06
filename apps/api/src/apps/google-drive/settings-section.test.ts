// SPDX-License-Identifier: FSL-1.1-ALv2
// People connect their own Drive: the connection section is open to every
// member. Org connections stay behind the admin scope on the server.
import { describe, expect, test } from "bun:test"
import manifest from "./app.manifest.json"

describe("Drive settings", () => {
  test("the connection section is visible to a member", () => {
    const section = manifest.settings.sections.find((s) => s.id === "connection")
    expect(section?.scope).toBe("user")
    expect(section).not.toHaveProperty("adminScope")
  })
})
