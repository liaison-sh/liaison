// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { askSignOutUnsaved, SignOutUnsavedDialog } from "./SignOutUnsavedDialog"
import type { UnsavedPage } from "./sign-out-guard"

const pages: UnsavedPage[] = [
  { key: "a:p1:s", docId: "p1", title: "Returns", body: "the returns text", reason: "offline" },
  { key: "a:p2:s", docId: "p2", title: "Warranty", body: "the warranty text", reason: null },
]

function mount(locale: "en" | "fr" = "en") {
  return render(() => (
    <I18nProvider initialLocale={locale}>
      <SignOutUnsavedDialog />
    </I18nProvider>
  ))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("SignOutUnsavedDialog", () => {
  it("lists the pages by title with Copy; Stay signed in answers stay", async () => {
    mount()
    const answer = askSignOutUnsaved(pages)
    await screen.findByTestId("sign-out-unsaved-dialog")
    const rows = screen.getAllByTestId("sign-out-unsaved-page")
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Returns"),
      expect.stringContaining("Warranty"),
    ])
    expect(rows[0]!.textContent).toContain("you are offline")
    fireEvent.click(screen.getByTestId("sign-out-unsaved-stay"))
    expect(await answer).toBe("stay")
    await waitFor(() => expect(screen.queryByTestId("sign-out-unsaved-dialog")).toBeNull())
  })

  it("Copy puts that page's text on the clipboard", async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
    mount()
    const answer = askSignOutUnsaved(pages)
    await screen.findByTestId("sign-out-unsaved-dialog")
    fireEvent.click(screen.getAllByTestId("sign-out-unsaved-copy")[1]!)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("the warranty text"))
    fireEvent.click(screen.getByTestId("sign-out-unsaved-stay"))
    await answer
  })

  it("Escape is Stay signed in", async () => {
    mount()
    const answer = askSignOutUnsaved(pages)
    const dialog = await screen.findByTestId("sign-out-unsaved-dialog")
    fireEvent.keyDown(dialog, { key: "Escape" })
    expect(await answer).toBe("stay")
  })

  it("Sign out and discard answers discard", async () => {
    mount()
    const answer = askSignOutUnsaved(pages)
    fireEvent.click(await screen.findByTestId("sign-out-unsaved-discard"))
    expect(await answer).toBe("discard")
  })

  it("speaks French", async () => {
    mount("fr")
    const answer = askSignOutUnsaved(pages)
    await screen.findByTestId("sign-out-unsaved-dialog")
    expect(screen.getByText("Du texte n'est pas enregistré")).toBeInTheDocument()
    expect(screen.getByTestId("sign-out-unsaved-stay").textContent).toBe("Rester connecté")
    expect(screen.getByTestId("sign-out-unsaved-discard").textContent).toBe(
      "Se déconnecter et abandonner",
    )
    fireEvent.click(screen.getByTestId("sign-out-unsaved-stay"))
    await answer
  })
})
