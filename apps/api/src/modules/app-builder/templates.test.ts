// SPDX-License-Identifier: FSL-1.1-ALv2
// The starters apps_build_create emits build and type-check clean as they are.
import { describe, expect, test } from "bun:test"
import { buildDraft } from "./build/build-draft"
import { DRAFT_TEMPLATES, templateFiles } from "./templates"

const APP = "returns-o1a2b3c4d"

describe("draft templates", () => {
  for (const template of DRAFT_TEMPLATES) {
    test(`${template} builds and type-checks clean`, async () => {
      const files = templateFiles(template, APP, "Returns")
      const r = await buildDraft(files, { appName: APP, version: "0.1.0", typecheck: true })
      expect(r.errors).toEqual([])
      expect(r.ok).toBe(true)
      expect(r.typecheck?.errors).toEqual([])
      expect(r.typecheck?.ok).toBe(true)
      const manifest = JSON.parse(files["app.manifest.json"]) as {
        scopes: string[]
        store: { collections: Record<string, { readScope: string }> }
      }
      for (const s of manifest.scopes) expect(s.startsWith(`${APP}:`)).toBe(true)
      expect(manifest.store.collections.items?.readScope).toBe(`${APP}:items:read`)
    }, 90_000)
  }
})
