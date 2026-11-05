// SPDX-License-Identifier: FSL-1.1-ALv2
import { resolveLocale } from "@liaison/shared"
import { render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"
import { applyStoredLocale, I18nProvider, useI18n } from "~/modules/i18n/i18n-context"

function Probe() {
  const { t } = useI18n()
  return <span data-testid="probe">{t("kernel.settings.profile.title")}</span>
}

describe("startup locale resolution (I4/I5)", () => {
  it("resolveLocale precedence: stored wins, else navigator, else en", () => {
    // I4: a stored shipped language is applied on next login.
    expect(resolveLocale("fr", "en-US")).toBe("fr")
    // I5: no stored pref → navigator language resolves.
    expect(resolveLocale(null, "fr-FR")).toBe("fr")
    // I5: unshipped navigator → English.
    expect(resolveLocale(null, "de")).toBe("en")
    // Unshipped stored value → English (read clamp).
    expect(resolveLocale("zz", null)).toBe("en")
  })

  it("applyStoredLocale flips the provider locale reactively (no remount)", async () => {
    render(() => (
      <I18nProvider initialLocale="en">
        <Probe />
      </I18nProvider>
    ))
    expect(screen.getByTestId("probe").textContent).toBe("Profile")

    // Simulate the startup hook resolving a persisted `language=fr`.
    applyStoredLocale("fr")

    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toBe("Profil")
    })
  })
})
