// SPDX-License-Identifier: FSL-1.1-ALv2
// The Help tab reads the bundled docs: the landing page first, a page link stays in the tab,
// an outside link goes to the browser.
import type { HelpDocsIndex, HelpDocsPage } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))
vi.mock("~/modules/desktop/desktop-store", () => ({ openExternalUrl: async () => false }))

const { resetHelpDocsCache } = await import("./help-docs")
const { showHelpPage } = await import("./help-store")
const HelpTab = (await import("./HelpTab")).default

const INDEX: HelpDocsIndex = { landing: { url: "", title: "Docs" }, sections: [], entries: [] }
const PAGES: Record<string, HelpDocsPage> = {
  "/help-docs/pages/index.json": {
    url: "",
    title: "Liaison documentation",
    description: "",
    showLede: false,
    section: "",
    html: '<p><a href="/help/apps/mail#connect-gmail">Mail</a> <a href="https://example.com/x">out</a></p>',
    headings: [],
  },
  "/help-docs/pages/apps/mail.json": {
    url: "apps/mail",
    title: "Mail",
    description: "Read and answer email.",
    showLede: true,
    section: "Apps",
    html: '<h2 id="connect-gmail">Connect Gmail</h2>',
    headings: [{ depth: 2, text: "Connect Gmail", id: "connect-gmail" }],
  },
}

beforeEach(() => {
  resetHelpDocsCache()
  showHelpPage({ url: "", hash: "" })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      const body = path === "/help-docs/index.json" ? INDEX : PAGES[path]
      return body ? new Response(JSON.stringify(body)) : new Response("not found", { status: 404 })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("HelpTab", () => {
  it("opens on the landing page, and a page link opens that page in the tab", async () => {
    render(() => <HelpTab />)
    const article = await screen.findByTestId("help-page")
    expect(article.getAttribute("data-url")).toBe("")
    fireEvent.click(screen.getByText("Mail"))
    await waitFor(() =>
      expect(screen.getByTestId("help-page").getAttribute("data-url")).toBe("apps/mail"),
    )
    expect(screen.getByText("Read and answer email.")).toBeTruthy()
  })

  it("sends an outside link to the browser", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    render(() => <HelpTab />)
    await screen.findByTestId("help-page")
    fireEvent.click(screen.getByText("out"))
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith("https://example.com/x", "_blank", "noopener,noreferrer"),
    )
  })

  it("says so when the docs cannot be read, with a way to try again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    )
    render(() => <HelpTab />)
    expect(await screen.findByTestId("help-load-failed")).toBeTruthy()
  })
})
