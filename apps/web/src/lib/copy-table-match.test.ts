// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
//
// The dock's copy used to live as English literals in `modules/shell/dock-copy.ts`
// and this file pinned them byte for byte against spec.md's copy table. The
// literals are gone: every dock string is a `kernel.dock.*` catalog entry now,
// so what is worth pinning is that each key RESOLVES in both shipped locales
// (a missing French entry silently falls back to English, which is the defect
// this replaces the byte match with).
import { describe, expect, it } from "vitest"
import en from "../../../../packages/shared/src/i18n/locales/en/kernel.json"
import fr from "../../../../packages/shared/src/i18n/locales/fr/kernel.json"

const DOCK_KEYS = [
  "chats",
  "collapse",
  "openInHome",
  "close",
  "more",
  "moreConversations",
  "conversation",
  "unreadOne",
  "unreadMany",
  "contextBoundary",
] as const

describe("dock copy resolves in every shipped locale", () => {
  it("every dock key is a string in en and fr", () => {
    const missing = DOCK_KEYS.filter(
      (k) =>
        typeof (en as Record<string, any>).dock?.[k] !== "string" ||
        typeof (fr as Record<string, any>).dock?.[k] !== "string",
    )
    expect(missing).toEqual([])
  })

  it("the counted rows keep their interpolation in both locales", () => {
    for (const key of ["more", "unreadOne", "unreadMany"] as const) {
      expect((en as any).dock[key]).toContain("{{count}}")
      expect((fr as any).dock[key]).toContain("{{count}}")
    }
    expect((en as any).dock.contextBoundary).toContain("{{name}}")
    expect((fr as any).dock.contextBoundary).toContain("{{name}}")
  })

  it("no dash punctuation reaches a reader, in either locale", () => {
    for (const key of DOCK_KEYS) {
      for (const text of [(en as any).dock[key], (fr as any).dock[key]]) {
        expect({ key, text, dashes: /--|–|—/.test(text) }).toEqual({ key, text, dashes: false })
      }
    }
  })
})
