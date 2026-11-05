// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T09: the floating "Local" pill becomes a quiet badge in the row.
// 2026-09-25: once the session has written files, the pill opens them (and
// attaches them); the separate icon beside the `+` is gone.

import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"

// Hoisted, because vi.mock's factory runs before any top level binding of
// this file exists.
const { uploadFile } = vi.hoisted(() => ({
  uploadFile: vi.fn(async (_api: unknown, file: File) => ({
    id: "file-1",
    filename: file.name,
    sizeBytes: file.size,
    mimeType: file.type,
    thumbnailKey: null,
  })),
}))

vi.mock("~/modules/files/file-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/files/file-service")>()
  return { ...actual, uploadFile }
})

import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"
import { installFakeBridge, liveSession, uninstallFakeBridge } from "./fake-bridge"
import RuntimeBadge from "./RuntimeBadge"

const PRODUCED = [
  { path: "/Users/someone/code/tessera-monorepo/report.md", name: "report.md" },
  { path: "/Users/someone/code/tessera-monorepo/out/build.log", name: "build.log" },
]
const PARENT = { app: "kernel", entityType: "file_upload_session", entityId: "s1" } as const
const OPEN_LABEL = "Open files created by the agent"

function withApi(ui: () => JSX.Element, locale: "en" | "fr" = "en") {
  return render(() => (
    <I18nProvider initialLocale={locale}>
      <Router>
        <Route path="/*" component={() => <ApiProvider>{ui()}</ApiProvider>} />
      </Router>
    </I18nProvider>
  ))
}

function renderPill(options: { compact?: boolean; locale?: "en" | "fr" } = {}) {
  const onUploaded = vi.fn()
  const result = withApi(
    () => (
      <RuntimeBadge
        threadId="t1"
        compact={options.compact}
        parent={PARENT}
        onUploaded={onUploaded}
      />
    ),
    options.locale,
  )
  return { ...result, onUploaded }
}

async function openMenu(name = OPEN_LABEL): Promise<HTMLElement> {
  const trigger = screen.getByRole("button", { name })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  return await screen.findByRole("menu")
}

async function hoverHint(): Promise<string> {
  fireEvent.pointerEnter(screen.getByTestId("desktop-runtime-badge"), { pointerType: "mouse" })
  return (await screen.findByTestId("tooltip-content")).textContent ?? ""
}

function pressEnter(element: Element) {
  fireEvent.keyDown(element as HTMLElement, { key: "Enter" })
}

describe("RuntimeBadge", () => {
  afterEach(() => {
    uploadFile.mockClear()
    resetToastStore()
    uninstallFakeBridge()
  })

  it("runtime badge names the runtime while a local session is live here", () => {
    installFakeBridge(liveSession("t1", "a1"))
    render(() => <RuntimeBadge threadId="t1" />)
    expect(screen.getByTestId("desktop-runtime-badge").textContent).toContain("This machine")
  })

  it("runtime badge renders nothing without a desktop bridge", () => {
    uninstallFakeBridge()
    const { container } = render(() => <RuntimeBadge threadId="t1" />)
    expect(container.innerHTML).toBe("")
  })

  it("runtime badge renders nothing when no session is live for this conversation", () => {
    installFakeBridge({ runtimeLocation: "local", sessionStatus: "idle", producedFiles: PRODUCED })
    const { container } = render(() => <RuntimeBadge threadId="t1" />)
    expect(container.innerHTML).toBe("")
  })

  it("runtime badge is never positioned and carries no inline style", () => {
    installFakeBridge(liveSession("t1", "a1", { producedFiles: PRODUCED }))
    const { container } = renderPill()
    const badge = screen.getByTestId("desktop-runtime-badge")
    for (const element of [badge, ...Array.from(badge.querySelectorAll("*"))]) {
      const classes = element.getAttribute("class") ?? ""
      expect(classes).not.toContain("fixed")
      expect(classes).not.toContain("absolute")
    }
    expect(container.querySelectorAll("[style]").length).toBe(0)
  })

  it("a compact runtime badge hides its words from the eye and not from a reader", async () => {
    installFakeBridge(liveSession("t1", "a1"))
    render(() => <RuntimeBadge threadId="t1" compact />)
    const badge = screen.getByTestId("desktop-runtime-badge")
    const words = badge.querySelector("span:not(.shrink-0)")
    expect(words?.textContent).toBe("This machine")
    expect(words?.getAttribute("class")).toBe("sr-only")
    expect(await hoverHint()).toBe("This machine")
  })

  it("with nothing produced the pill is a plain badge, not a button, and hints the runtime", async () => {
    installFakeBridge(liveSession("t1", "a1", { producedFiles: [] }))
    renderPill()
    const badge = screen.getByTestId("desktop-runtime-badge")
    expect(badge.tagName).toBe("SPAN")
    expect(badge.querySelector("button")).toBeNull()
    expect(screen.queryByRole("button", { name: OPEN_LABEL })).toBeNull()
    expect(await hoverHint()).toBe("This machine")
  })

  it("with produced files the pill opens a menu of them under its title", async () => {
    installFakeBridge(liveSession("t1", "a1", { producedFiles: PRODUCED }))
    renderPill()
    const trigger = screen.getByRole("button", { name: OPEN_LABEL })
    // The pill keeps its words and says how many files there are.
    expect(trigger.textContent).toContain("This machine")
    expect(screen.getByTestId("desktop-produced-files-count").textContent).toBe("2")
    const menu = await openMenu()
    expect(menu.textContent).toContain("Files created by the agent")
    const rows = Array.from(menu.querySelectorAll('[data-testid="desktop-produced-file-row"]'))
    expect(rows.map((row) => (row.textContent ?? "").trim())).toEqual(["report.md", "build.log"])
  })

  it("clicking a file row opens it on this computer and uploads nothing", async () => {
    const shell = installFakeBridge(liveSession("t1", "a1", { producedFiles: PRODUCED }))
    renderPill()
    await openMenu()
    pressEnter(screen.getByText("report.md").closest('[role="menuitem"]') as HTMLElement)
    await waitFor(() => expect(shell.calls.openedLocalPaths).toEqual([PRODUCED[0].path]))
    expect(shell.calls.readFiles).toEqual([])
    expect(uploadFile).not.toHaveBeenCalled()
  })

  it("a file the shell cannot find says so", async () => {
    const shell = installFakeBridge(liveSession("t1", "a1", { producedFiles: PRODUCED }), {
      localPathOutcome: "not_found",
    })
    renderPill()
    await openMenu()
    pressEnter(screen.getByText("build.log").closest('[role="menuitem"]') as HTMLElement)
    await waitFor(() => expect(shell.calls.openedLocalPaths).toEqual([PRODUCED[1].path]))
    await waitFor(() =>
      expect(toasts().map((toast) => toast.message)).toContain("Not found on this computer"),
    )
  })

  it("the attach action on a row uploads it through the existing file service", async () => {
    const shell = installFakeBridge(liveSession("t1", "a1", { producedFiles: PRODUCED }), {
      readLocalFileResult: new Blob(["# report"], { type: "text/markdown" }),
    })
    const { onUploaded } = renderPill()
    await openMenu()
    pressEnter(screen.getByRole("menuitem", { name: "Attach to the conversation: report.md" }))
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1))
    const [, file, parent] = uploadFile.mock.calls[0] as unknown as [unknown, File, unknown]
    expect(file.name).toBe("report.md")
    expect(parent).toEqual(PARENT)
    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1))
    // Attaching is not opening.
    expect(shell.calls.openedLocalPaths).toEqual([])
  })

  it("a file the shell cannot read uploads nothing", async () => {
    installFakeBridge(liveSession("t1", "a1", { producedFiles: PRODUCED }), {
      readLocalFileResult: null,
    })
    renderPill()
    await openMenu()
    pressEnter(screen.getByRole("menuitem", { name: "Attach to the conversation: report.md" }))
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(uploadFile).not.toHaveBeenCalled()
  })

  it("the pill's hint says it opens the files, in English and in French", async () => {
    installFakeBridge(liveSession("t1", "a1", { producedFiles: PRODUCED }))
    const english = renderPill()
    expect(await hoverHint()).toBe(OPEN_LABEL)
    english.unmount()

    renderPill({ locale: "fr" })
    const french = "Ouvrir les fichiers créés par l'agent"
    expect(screen.getByRole("button", { name: french })).toBeInTheDocument()
    expect(await hoverHint()).toBe(french)
    const menu = await openMenu(french)
    expect(menu.textContent).toContain("Fichiers créés par l'agent")
    expect(
      screen.getByRole("menuitem", { name: "Joindre à la discussion: report.md" }),
    ).toBeInTheDocument()
  })

  it("the compact pill keeps the same menu and puts its words in the hint", async () => {
    const shell = installFakeBridge(liveSession("t1", "a1", { producedFiles: PRODUCED }))
    renderPill({ compact: true })
    const trigger = screen.getByRole("button", { name: OPEN_LABEL })
    expect(trigger.querySelector(".sr-only")?.textContent).toBe("This machine")
    expect(await hoverHint()).toBe(OPEN_LABEL)
    await openMenu()
    pressEnter(screen.getByText("build.log").closest('[role="menuitem"]') as HTMLElement)
    await waitFor(() => expect(shell.calls.openedLocalPaths).toEqual([PRODUCED[1].path]))
  })
})
