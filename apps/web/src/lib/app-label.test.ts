// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"
import { appLabel, entityTypeLabel, roleDisplayName } from "~/lib/app-label"
import type { Translate } from "~/modules/i18n/i18n-context"

const catalogHasKey = vi.fn<(key: string) => boolean>()
const currentLocale = vi.fn<() => string>()
const seededCopy = vi.fn<(stored: string | null | undefined, key: string, t: Translate) => string>()

vi.mock("~/modules/i18n/i18n-context", () => ({
  catalogHasKey: (key: string) => catalogHasKey(key),
  currentLocale: () => currentLocale(),
  seededCopy: (stored: string | null | undefined, key: string, t: Translate) =>
    seededCopy(stored, key, t),
}))

const stubT: Translate = (key) => `t:${key}`

beforeEach(() => {
  catalogHasKey.mockReset()
  currentLocale.mockReset()
  seededCopy.mockReset()
  currentLocale.mockReturnValue("en")
})

describe("appLabel", () => {
  it("returns the translated catalog label when the key exists and locale isn't en", () => {
    catalogHasKey.mockReturnValue(true)
    currentLocale.mockReturnValue("fr")
    expect(appLabel("invoicing", stubT)).toBe("t:kernel.capabilities.apps.invoicing")
  })

  it("falls back to the manifest displayName when the catalog lacks the key", () => {
    catalogHasKey.mockReturnValue(false)
    expect(appLabel("custom-app", stubT, "Custom App")).toBe("Custom App")
  })

  it("falls back to the raw app id when neither the catalog nor a displayName has it", () => {
    catalogHasKey.mockReturnValue(false)
    expect(appLabel("custom-app", stubT, undefined)).toBe("custom-app")
  })

  it("prefers the manifest displayName over the catalog key while locale is en", () => {
    catalogHasKey.mockReturnValue(true)
    currentLocale.mockReturnValue("en")
    expect(appLabel("invoicing", stubT, "Invoicing (manifest)")).toBe("Invoicing (manifest)")
  })
})

describe("entityTypeLabel", () => {
  it("falls back to the raw type string when the catalog lacks the key", () => {
    catalogHasKey.mockReturnValue(false)
    expect(entityTypeLabel("widget", stubT)).toBe("widget")
  })

  it("translates when the catalog has the key", () => {
    catalogHasKey.mockReturnValue(true)
    expect(entityTypeLabel("task", stubT)).toBe("t:kernel.searchUi.entityTypes.task")
  })
})

describe("roleDisplayName", () => {
  it("translates the seeded Full Member role name via seededCopy", () => {
    seededCopy.mockReturnValue("Membre complet")
    expect(roleDisplayName("Full Member", stubT)).toBe("Membre complet")
    expect(seededCopy).toHaveBeenCalledWith("Full Member", "kernel.roleNames.fullMember", stubT)
  })

  it("names an app's own role by the app and its tier, never the raw id", () => {
    seededCopy.mockImplementation((stored) => stored ?? "")
    catalogHasKey.mockImplementation((key) => key === "kernel.roleNames.tiers.admin")
    const t: Translate = (key, params) =>
      key === "kernel.roleNames.appTier"
        ? `${params?.app} · ${params?.tier}`
        : key === "kernel.roleNames.tiers.admin"
          ? "Admin"
          : key
    const names = { "api-connector": "API connector" }
    expect(roleDisplayName("api-connector.admin", t, names)).toBe("API connector · Admin")
    // A tier the catalog does not name reads in words.
    expect(roleDisplayName("api-connector.support_lead", t, names)).toBe(
      "API connector · Support lead",
    )
  })

  it("leaves a dotted name that is not an app's role as written", () => {
    seededCopy.mockImplementation((stored) => stored ?? "")
    catalogHasKey.mockReturnValue(false)
    expect(roleDisplayName("team.alpha", stubT, {})).toBe("team.alpha")
  })

  it("passes any other role name through unchanged", () => {
    seededCopy.mockImplementation((stored) => stored ?? "")
    expect(roleDisplayName("Custom Admin", stubT)).toBe("Custom Admin")
  })
})
