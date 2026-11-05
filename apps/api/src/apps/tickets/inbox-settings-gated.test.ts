// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An inbox's reply-to and from addresses, signature and acknowledgement text decide
// where customers' replies go and what they are told, so an agent changing them
// parks an approval like any other outward-facing write.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "app.manifest.json"), "utf8")) as {
  tools: Record<string, { gated?: boolean; params?: { properties?: Record<string, unknown> } }>
}

describe("inbox settings are approved changes", () => {
  for (const name of ["inboxes.create", "inboxes.update"]) {
    test(`${name} is gated and carries the reply-routing fields`, () => {
      const tool = manifest.tools[name]
      expect(tool?.gated).toBe(true)
      const props = Object.keys(tool?.params?.properties ?? {})
      expect(props).toContain("replyToEmail")
    })
  }
})
