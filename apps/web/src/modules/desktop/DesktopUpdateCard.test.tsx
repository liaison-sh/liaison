// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The update card: while the shell downloads and installs an update, the whole
// window says so. Before it, the only signs were the title bar and the taskbar
// progress, and nothing in the document changed at all.

import { render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "~/App"
import { clearAuth } from "~/modules/auth/auth-store"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import DesktopUpdateCard from "./DesktopUpdateCard"
import { installFakeBridge, uninstallFakeBridge } from "./fake-bridge"

const DASHES = /[–—]|--/

describe("DesktopUpdateCard", () => {
  afterEach(() => {
    uninstallFakeBridge()
    vi.unstubAllGlobals()
  })

  it("draws nothing without an update in progress", () => {
    installFakeBridge({ updateProgress: null })
    render(() => <DesktopUpdateCard />)
    expect(screen.queryByTestId("desktop-update-card")).toBeNull()
  })

  it("draws nothing in a browser, whatever the state says", () => {
    render(() => <DesktopUpdateCard />)
    expect(screen.queryByTestId("desktop-update-card")).toBeNull()
  })

  it("while downloading: a modal card with the version, a real bar and the percent", () => {
    installFakeBridge({ updateProgress: { version: "0.2.0", phase: "downloading", percent: 42 } })
    render(() => <DesktopUpdateCard />)

    const card = screen.getByRole("dialog")
    expect(card.getAttribute("aria-modal")).toBe("true")
    expect(screen.getByText("Updating Liaison")).toBeInTheDocument()
    expect(screen.getByTestId("desktop-update-status").textContent).toBe(
      "Downloading version 0.2.0",
    )
    expect(screen.getByTestId("desktop-update-percent").textContent).toBe("42%")
    const bar = screen.getByRole("progressbar")
    expect(bar.getAttribute("aria-valuenow")).toBe("42")
    expect(bar.getAttribute("data-indeterminate")).toBeNull()
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite")
    expect(screen.queryByTestId("desktop-update-restart")).toBeNull()
    // The backdrop covers the whole window, so nothing behind it takes a click.
    expect(screen.getByTestId("desktop-update-backdrop").className).toContain("fixed inset-0")
    expect(document.activeElement).toBe(card)
  })

  it("a download of unknown size is an indeterminate bar with no percent", () => {
    installFakeBridge({ updateProgress: { version: "0.2.0", phase: "downloading", percent: null } })
    render(() => <DesktopUpdateCard />)
    expect(screen.queryByTestId("desktop-update-percent")).toBeNull()
    const bar = screen.getByRole("progressbar")
    expect(bar.getAttribute("data-indeterminate")).toBe("true")
    expect(bar.hasAttribute("aria-valuenow")).toBe(false)
  })

  it("follows the shell: percent moves, then installing, then gone", () => {
    const fake = installFakeBridge({
      updateProgress: { version: "0.2.0", phase: "downloading", percent: 10 },
    })
    render(() => <DesktopUpdateCard />)
    expect(screen.getByTestId("desktop-update-percent").textContent).toBe("10%")

    fake.push({ updateProgress: { version: "0.2.0", phase: "downloading", percent: 99 } })
    expect(screen.getByTestId("desktop-update-percent").textContent).toBe("99%")

    fake.push({ updateProgress: { version: "0.2.0", phase: "installing", percent: null } })
    expect(screen.getByTestId("desktop-update-card").getAttribute("data-phase")).toBe("installing")
    expect(screen.getByTestId("desktop-update-status").textContent).toBe("Installing version 0.2.0")
    expect(screen.getByTestId("desktop-update-restart").textContent).toBe(
      "Liaison will restart by itself in a moment. Do not close it.",
    )
    expect(screen.getByRole("progressbar").getAttribute("data-indeterminate")).toBe("true")

    // A failed install, or Smart App Control refusing it: the window is back.
    fake.push({ updateProgress: null })
    expect(screen.queryByTestId("desktop-update-card")).toBeNull()
  })

  it("speaks French, with no dash punctuation in either language", () => {
    installFakeBridge({ updateProgress: { version: "0.2.0", phase: "installing", percent: null } })
    render(() => (
      <I18nProvider initialLocale="fr">
        <DesktopUpdateCard />
      </I18nProvider>
    ))
    const card = screen.getByTestId("desktop-update-card")
    expect(screen.getByText("Mise à jour de Liaison")).toBeInTheDocument()
    expect(screen.getByTestId("desktop-update-status").textContent).toBe(
      "Installation de la version 0.2.0",
    )
    expect(screen.getByTestId("desktop-update-restart").textContent).toBe(
      "Liaison va redémarrer automatiquement dans un instant. Ne fermez pas l'application.",
    )
    expect(card.textContent).not.toMatch(DASHES)
  })

  // Mounted at the app root, beside the router: the login and connect steps
  // get it too, not only the signed in shell.
  it("covers the login screen of the real app", async () => {
    clearAuth()
    window.history.pushState({}, "", "/login")
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    )
    installFakeBridge({ updateProgress: { version: "0.3.1", phase: "downloading", percent: 5 } })
    render(() => <App />)
    await waitFor(() => expect(screen.getByTestId("desktop-update-card")).toBeInTheDocument())
    expect(screen.getByTestId("desktop-update-status").textContent).toBe(
      "Downloading version 0.3.1",
    )
  })
})
