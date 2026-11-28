// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { appSettingsSchema, SETTINGS_SCHEMA_VERSION, settingsBlockSchema } from "./app-settings"

const blocks: Record<string, Record<string, unknown>> = {
  field: { block: "field", key: "a.b", type: "text", label: "A" },
  connections: { block: "connections" },
  list: { block: "list", ops: { list: "rows.list" }, columns: [{ key: "k", label: "K" }] },
  tree: {
    block: "tree",
    ops: { list: "l", create: "c", update: "u", reorder: "r", archive: "a" },
    maxDepth: 2,
  },
  custom: { block: "custom", component: "Panel", reason: "a drag and drop editor" },
  appSecrets: { block: "appSecrets", connection: "billing" },
}

describe("settings block fallback", () => {
  it("every block kind accepts a fallback with text and an optional relative href", () => {
    for (const [kind, block] of Object.entries(blocks)) {
      const plain = settingsBlockSchema.safeParse({
        ...block,
        fallback: { text: "Set it on the web." },
      })
      expect({ kind, ok: plain.success }).toEqual({ kind, ok: true })
      for (const href of ["/settings/apps/x", "#billing"]) {
        const linked = settingsBlockSchema.safeParse({
          ...block,
          fallback: { text: "Open it.", href },
        })
        expect({ kind, href, ok: linked.success }).toEqual({ kind, href, ok: true })
      }
    }
  })

  it("keeps the fallback in the parsed page", () => {
    const parsed = appSettingsSchema.parse({
      sections: [
        {
          id: "s",
          title: "S",
          scope: "org",
          blocks: [{ ...blocks.field, fallback: { text: "On the web.", href: "#s" } }],
        },
      ],
    })
    expect(parsed.sections[0].blocks[0].fallback).toEqual({ text: "On the web.", href: "#s" })
  })

  it("refuses empty or long text, an href with a scheme or a host, and unknown keys", () => {
    const bad: unknown[] = [
      { text: "" },
      { text: "x".repeat(281) },
      { text: "ok", href: "https://example.com/x" },
      { text: "ok", href: "javascript:alert(1)" },
      { text: "ok", href: "//example.com/x" },
      { text: "ok", href: "settings/apps/x" },
      { text: "ok", href: "" },
      { text: "ok", extra: true },
      "text",
    ]
    for (const fallback of bad) {
      const r = settingsBlockSchema.safeParse({ ...blocks.field, fallback })
      expect({ fallback, ok: r.success }).toEqual({ fallback, ok: false })
    }
    expect(
      settingsBlockSchema.safeParse({ ...blocks.field, fallback: { text: "x".repeat(280) } })
        .success,
    ).toBe(true)
  })
})

describe("SETTINGS_SCHEMA_VERSION", () => {
  it("is an integer of at least 1", () => {
    expect(Number.isInteger(SETTINGS_SCHEMA_VERSION)).toBe(true)
    expect(SETTINGS_SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
  })
})
