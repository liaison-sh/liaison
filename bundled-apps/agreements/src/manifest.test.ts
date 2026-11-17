// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { packageManifestSchema } from "@liaison/app-sdk"
import manifest from "../app.manifest.json"
import * as handlers from "../handlers"

describe("agreements manifest", () => {
  it("is at version 0.5.1", () => {
    expect(manifest.version).toBe("0.5.1")
  })

  it("an uploaded version's page text and source text are declared as outside text, so a read returning them taints the turn", () => {
    expect(manifest.outsideTextFields).toEqual(
      expect.arrayContaining(["signers", "imported_text", "source_text", "pages"]),
    )
  })

  it("parses as a package manifest", () => {
    expect(packageManifestSchema.safeParse(manifest).success).toBe(true)
  })

  it("every tool names a handler the bundle exports", () => {
    const exported = new Set(Object.keys(handlers))
    for (const [name, tool] of Object.entries(manifest.tools)) {
      expect({ name, ok: exported.has((tool as { handler: string }).handler) }).toEqual({
        name,
        ok: true,
      })
    }
  })

  it("no tool signs, decides or accepts: a person does, through their own link", () => {
    expect(Object.keys(manifest.tools).filter((t) => /sign|decide|accept/.test(t))).toEqual([])
  })

  it("the corporate templates feature is declared, so later work needs no manifest edit", () => {
    expect(Object.keys(manifest.features)).toEqual(["corporateTemplates"])
  })
})
