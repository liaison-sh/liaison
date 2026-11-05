// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A GLOBAL WILDCARD IS A GRANT. The agent Settings tab drew "0 / 42" against a
// ceiling of `["*"]` while the Overview beside it said "everything this
// workspace allows" for the same row: the grid only understood an APP wildcard
// ("kernel"), so the one grant that means all of them counted as none, and the
// bare "*" was even rendered as an app group of its own.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { PermissionGrid, type ScopeCatalogEntry } from "~/modules/settings/PermissionGrid"

const CATALOG: ScopeCatalogEntry[] = [
  { scope: "kernel", app: "kernel" },
  { scope: "kernel:threads:read", app: "kernel" },
  { scope: "kernel:agents:admin", app: "kernel" },
  { scope: "tickets", app: "tickets" },
  { scope: "tickets:tickets:read", app: "tickets" },
]

function grid(granted: string[]) {
  return render(() => (
    <I18nProvider>
      <PermissionGrid catalog={CATALOG} granted={granted} mode="edit" testIdPrefix="pg" />
    </I18nProvider>
  ))
}

function humanGrid(locale: "en" | "fr") {
  return render(() => (
    <I18nProvider initialLocale={locale}>
      <PermissionGrid
        catalog={[{ scope: "kernel:agents:read", app: "kernel" }]}
        granted={[]}
        mode="edit"
        humanLabels
        testIdPrefix="pg"
      />
    </I18nProvider>
  ))
}

const countOf = (app: string): string => {
  const header = screen.getByTestId(`pg-permission-app-header-${app}`)
  return header.textContent?.match(/(\d+)\s*\/\s*(\d+)/)?.[0]?.replace(/\s+/g, "") ?? ""
}

afterEach(() => cleanup())

describe("PermissionGrid and a global wildcard", () => {
  it("counts every scope in every app as granted", () => {
    grid(["*"])
    expect(countOf("kernel")).toBe("3/3")
    expect(countOf("tickets")).toBe("2/2")
  })

  it("renders no app group for the bare wildcard itself", () => {
    grid(["*"])
    expect(screen.queryByTestId("pg-permission-app-*")).toBeNull()
  })

  it("marks each row granted, so the grid agrees with the overview", () => {
    grid(["*"])
    const row = screen.getByTestId("pg-permission-app-kernel")
    const toggles = row.querySelectorAll("[data-granted]")
    expect(toggles.length).toBeGreaterThan(0)
    for (const el of toggles) expect(el.getAttribute("data-granted")).toBe("true")
  })

  it("still counts an explicit grant list exactly", () => {
    grid(["kernel:threads:read"])
    expect(countOf("kernel")).toBe("1/3")
    expect(countOf("tickets")).toBe("0/2")
  })

  it("still counts an APP wildcard as the app's own grant", () => {
    grid(["kernel"])
    expect(countOf("kernel")).toBe("1/3")
  })
})
describe("PermissionGrid in humanLabels mode", () => {
  // One component named the same app twice: "Kernel" from a local table in the
  // header and "Workspace" from the shared catalog in the rows.
  it("names the app the same way in the header and in the rows, in the reader's language", () => {
    humanGrid("en")
    expect(screen.getByTestId("pg-permission-app-header-kernel").textContent).toContain("Workspace")
    expect(screen.getByTestId("pg-add-scope-kernel:agents:read").textContent).toContain("Workspace")
    expect(screen.queryByTestId("pg-permission-app-slug-kernel")).toBeNull()
    cleanup()

    humanGrid("fr")
    const header = screen.getByTestId("pg-permission-app-header-kernel").textContent ?? ""
    expect(header).toContain("Espace de travail")
    expect(header).not.toContain("Kernel")
  })

  // French puts a space before a colon. The separator was a literal in the
  // shared formatter, so a French row read "Espace de travail: lire les agents".
  it("separates the app from what it allows the way the locale does", () => {
    humanGrid("en")
    expect(screen.getByTestId("pg-add-scope-kernel:agents:read").textContent).toContain(
      "Workspace: read agents",
    )
    cleanup()

    humanGrid("fr")
    // The catalog's French description of the scope, never the server's English.
    expect(screen.getByTestId("pg-add-scope-kernel:agents:read").textContent).toContain(
      "Espace de travail : Lire la définition complète d'un agent",
    )
  })

  // The identifier stays reachable for the admin who wants it, as a hover.
  it("keeps the identifier in the row title and out of the label", () => {
    humanGrid("en")
    const row = screen.getByTestId("pg-add-scope-kernel:agents:read")
    expect(row.getAttribute("title")).toBe("Permission id: kernel:agents:read")
    expect(row.textContent).not.toContain("kernel:agents:read")
  })
})

describe("PermissionGrid where identifiers are the point", () => {
  // The admin roles and users grids author grants BY id, so the slug stays.
  it("keeps the app slug in the group header", () => {
    grid([])
    expect(screen.getByTestId("pg-permission-app-slug-kernel").textContent).toBe("kernel")
  })

  // The wildcard row's stand-in description was an English sentence wrapped
  // around a translated app name: "Full Espace de travail access".
  it("says what a wildcard grant covers in one language", () => {
    render(() => (
      <I18nProvider initialLocale="fr">
        <PermissionGrid catalog={CATALOG} granted={[]} mode="edit" testIdPrefix="pg" />
      </I18nProvider>
    ))
    const row = screen.getByTestId("pg-add-scope-kernel")
    expect(row.textContent).toContain("Accès complet à Espace de travail")
    expect(row.textContent).not.toContain("Full")
    expect(row.textContent).not.toContain("access")
  })

  // A reader searches for the name in the header, which is the app's name in
  // their language in either mode.
  it("the search matches the app name shown in the group header", () => {
    grid([])
    fireEvent.input(screen.getByTestId("pg-scope-input"), { target: { value: "workspace" } })
    expect(screen.getByTestId("pg-permission-app-kernel")).toBeInTheDocument()
    expect(screen.queryByTestId("pg-permission-app-tickets")).toBeNull()
  })
})
describe("PermissionGrid empty states", () => {
  // Two English sentences reached the screen whatever the reader's language.
  it("says there is nothing to show in the reader's language", () => {
    render(() => (
      <I18nProvider initialLocale="fr">
        <PermissionGrid catalog={[]} granted={[]} mode="edit" testIdPrefix="pg" />
      </I18nProvider>
    ))
    expect(screen.getByText("Aucun droit disponible.")).toBeInTheDocument()

    fireEvent.input(screen.getByTestId("pg-scope-input"), { target: { value: "zzz" } })
    expect(screen.getByText("Aucun droit ne correspond à « zzz ».")).toBeInTheDocument()
  })
})
