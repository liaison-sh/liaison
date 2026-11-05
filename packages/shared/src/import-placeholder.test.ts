// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  IMPORT_PLACEHOLDER_EMAIL_LIKE,
  importPlaceholderEmail,
  isImportPlaceholderEmail,
} from "./import-placeholder"

describe("import placeholders", () => {
  it("builds a stable, undeliverable address", () => {
    expect(importPlaceholderEmail("slack-import", "Jean.Dupont")).toBe(
      "slack-import+jean.dupont@import.invalid",
    )
  })

  it("recognises a placeholder address, whatever its case", () => {
    expect(isImportPlaceholderEmail("slack-import+ghost@import.invalid")).toBe(true)
    expect(isImportPlaceholderEmail(" Slack-Import+Ghost@IMPORT.INVALID ")).toBe(true)
  })

  it("never mistakes a person's address for a placeholder", () => {
    expect(isImportPlaceholderEmail("sam@test.com")).toBe(false)
    expect(isImportPlaceholderEmail("sam@import.invalid.example.com")).toBe(false)
    expect(isImportPlaceholderEmail(null)).toBe(false)
    expect(isImportPlaceholderEmail("")).toBe(false)
  })

  it("exposes the SQL pattern of the same domain", () => {
    expect(IMPORT_PLACEHOLDER_EMAIL_LIKE).toBe("%@import.invalid")
  })
})
