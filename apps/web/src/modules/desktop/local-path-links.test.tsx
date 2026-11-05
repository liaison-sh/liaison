// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A path on the user's computer in an agent's message is a link in the
// desktop app, and only there: a browser renders the text it always rendered.
// A click goes to the shell, and a path that is not on this computer says so
// beside the link.

import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  entityPreviewRegistry,
  registerEntityPreview,
} from "~/modules/shell/entity-preview/registry"
import { renderContent } from "~/modules/shell/markdown-content"
import { localFolderFor } from "./desktop-store"
import { installFakeBridge, liveSession, uninstallFakeBridge } from "./fake-bridge"

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({ getEnvelope: vi.fn() }),
}))

const WINDOWS_REPORT = String.raw`C:\Users\someone\Documents\Reports\Hub X\report-2026-08.pdf`

function renderMessage(content: string, base: string | null = null) {
  const onMention = vi.fn()
  const result = render(() => (
    <div data-testid="message">{renderContent(content, onMention, { localPathBase: base })}</div>
  ))
  const root = result.getByTestId("message")
  return { ...result, root, onMention }
}

function links(root: HTMLElement): HTMLAnchorElement[] {
  return Array.from(root.querySelectorAll<HTMLAnchorElement>("a.local-path-link"))
}

afterEach(() => {
  uninstallFakeBridge()
})

describe("local path links", () => {
  it("renders paths as plain text in a browser", () => {
    const { root } = renderMessage(
      `Saved to ${WINDOWS_REPORT} and \`/Users/someone/Hub X/deck.html\`.`,
    )
    expect(links(root)).toHaveLength(0)
    expect(root.querySelector("[data-local-path]")).toBeNull()
    expect(root.textContent).toContain(WINDOWS_REPORT)
  })

  it("renders paths as plain text around a shell that cannot open them", () => {
    installFakeBridge({}, { withoutLocalPathOpener: true })
    const { root } = renderMessage(`Saved to ${WINDOWS_REPORT}.`)
    expect(links(root)).toHaveLength(0)
  })

  it("links a path in prose, keeping the text exactly as written", () => {
    installFakeBridge()
    const { root } = renderMessage(`Saved to ${WINDOWS_REPORT}. Done.`)
    const [link] = links(root)
    expect(link.textContent).toBe(WINDOWS_REPORT)
    expect(link.getAttribute("data-local-path")).toBe(WINDOWS_REPORT)
    expect(link.getAttribute("title")).toBe(WINDOWS_REPORT)
    expect(link.hasAttribute("target")).toBe(false)
    expect(root.textContent?.trim()).toBe(`Saved to ${WINDOWS_REPORT}. Done.`)
  })

  it("links a report path whose file name has spaces, as a local session writes it", () => {
    installFakeBridge()
    const report =
      "/Volumes/Minimac/avery/Documents/Rapports Liaison/rapports/Cribbs Causeway 2026-06/2026.06_CC Cribbs Causeway - Monthly review.pdf"
    const { root } = renderMessage(
      `✅ Rapport généré avec succès !\n\nLe rapport mensuel de juin 2026 pour CC Cribbs Causeway est prêt :\n\n📄 ${report}`,
    )
    const [link] = links(root)
    expect(link.textContent).toBe(report)
    expect(link.getAttribute("data-local-path")).toBe(report)
  })

  it("links inline code that is a path with spaces, inside the code", () => {
    installFakeBridge()
    const { root } = renderMessage("Open `/Users/someone/Hub X/deck final.html` now.")
    const [link] = links(root)
    expect(link.textContent).toBe("/Users/someone/Hub X/deck final.html")
    expect(link.parentElement?.tagName).toBe("CODE")
  })

  it("links a markdown link to a file URL or a path, and leaves web links alone", () => {
    installFakeBridge()
    const { root } = renderMessage(
      "[the report](file:///Users/someone/Hub%20X/report.pdf), [the deck](</Users/someone/Hub X/deck.html>) and [the site](https://example.com/Users/a/b.pdf)",
    )
    const found = links(root)
    expect(found.map((link) => link.textContent)).toEqual(["the report", "the deck"])
    expect(found.map((link) => link.getAttribute("data-local-path"))).toEqual([
      "file:///Users/someone/Hub%20X/report.pdf",
      "/Users/someone/Hub X/deck.html",
    ])
    const web = Array.from(root.querySelectorAll("a")).find((a) => a.textContent === "the site")
    expect(web?.getAttribute("href")).toBe("https://example.com/Users/a/b.pdf")
  })

  it("leaves a path inside a code block as code, unless the block is that path alone", () => {
    installFakeBridge()
    const code = renderMessage("```\ncp /Users/someone/a.pdf /Users/someone/b.pdf\n```")
    expect(links(code.root)).toHaveLength(0)
    const alone = renderMessage("```\n/Users/someone/Hub X/report.pdf\n```")
    const [link] = links(alone.root)
    expect(link.getAttribute("data-local-path")).toBe("/Users/someone/Hub X/report.pdf")
    expect(link.closest("pre")).not.toBeNull()
  })

  it("keeps the link when the message also carries a previewable mention", () => {
    // Such a message is rebuilt node by node rather than set as HTML, and
    // that rebuild used to keep only an anchor's class and href.
    installFakeBridge()
    entityPreviewRegistry.clear()
    registerEntityPreview({
      app: "contacts",
      entityType: "contact",
      fetch: async () => ({}),
      render: () => <div />,
    })
    try {
      const { root } = renderMessage("@[Alice](contacts:contact:c1) wrote /Users/someone/a.pdf")
      const [link] = links(root)
      expect(link.getAttribute("data-local-path")).toBe("/Users/someone/a.pdf")
      expect(link.getAttribute("title")).toBe("/Users/someone/a.pdf")
    } finally {
      entityPreviewRegistry.clear()
    }
  })

  it("never turns raw HTML in the message into a local path link", () => {
    installFakeBridge()
    const { root } = renderMessage(
      [
        '<a class="local-path-link" title="/Users/someone/setup.pdf">imitation</a>',
        '<a class="lpmark-0-0" title="/Users/someone/b.pdf">guessed mark</a>',
        '<span class="local-path-link">styled</span>',
      ].join(" "),
    )
    expect(root.querySelector("[data-local-path]")).toBeNull()
    expect(root.querySelector(".local-path-link")).toBeNull()
    expect(root.textContent).toContain("imitation")
  })

  it("never opens a data-local-path that arrived in the message's own HTML", async () => {
    const { calls } = installFakeBridge()
    const { root } = renderMessage(
      [
        '<a data-local-path="/Users/someone/Downloads/invoice.pdf">Open your invoice (https://example.com)</a>',
        String.raw`<span data-local-path="C:\Users\x\a.pdf">click me</span>`,
      ].join(" "),
    )
    expect(root.querySelector("[data-local-path]")).toBeNull()
    for (const text of ["Open your invoice (https://example.com)", "click me"]) {
      const element = Array.from(root.querySelectorAll("a, span")).find(
        (node) => node.textContent === text,
      ) as HTMLElement
      fireEvent.click(element)
    }
    await Promise.resolve()
    expect(calls.openedLocalPaths).toEqual([])
  })

  it("renders no link for a network path, in prose, code or a link target", () => {
    installFakeBridge()
    const { root } = renderMessage(
      [
        String.raw`Saved to \\\\fileserver\\team\\report.pdf today.`,
        "Or `\\\\fileserver\\team\\Hub X\\report.pdf`.",
        "Or `//fileserver/team/report.pdf` and `file://fileserver/team/report.pdf`.",
        "Or [the report](file://fileserver/team/report.pdf).",
      ].join("\n\n"),
    )
    expect(links(root)).toHaveLength(0)
  })

  it("says a network path is not opened when the shell refuses one", async () => {
    installFakeBridge({}, { localPathOutcome: "network" })
    const { root } = renderMessage("See /Users/someone/report.pdf")
    fireEvent.click(links(root)[0])
    const notice = await waitFor(() => {
      const found = root.querySelector(".local-path-notice")
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(notice.textContent).toBe("Network paths are not opened from messages")
  })

  it("does not link the path part of a URL", () => {
    installFakeBridge()
    const { root } = renderMessage("See https://example.com/Users/someone/report.pdf please.")
    expect(links(root)).toHaveLength(0)
  })

  it("resolves a relative path only when the session folder is known", () => {
    installFakeBridge()
    const without = renderMessage("Wrote `Reports/report.pdf`.")
    expect(links(without.root)).toHaveLength(0)
    const withBase = renderMessage("Wrote `Reports/report.pdf`.", "/Users/someone/work")
    const [link] = links(withBase.root)
    expect(link.textContent).toBe("Reports/report.pdf")
    expect(link.getAttribute("title")).toBe("/Users/someone/work/Reports/report.pdf")
  })

  it("knows the session folder of this conversation and of no other", () => {
    installFakeBridge(liveSession("thread-1", "agent-1", { folderPath: "/Users/someone/work" }))
    expect(localFolderFor("thread-1")).toBe("/Users/someone/work")
    expect(localFolderFor("thread-2")).toBeNull()
  })

  it("asks the shell to open the path on a click, and nothing else", async () => {
    const { calls } = installFakeBridge()
    const { root, onMention } = renderMessage(`Saved to ${WINDOWS_REPORT}.`)
    const [link] = links(root)
    const click = fireEvent.click(link)
    expect(click).toBe(false) // default prevented: no navigation to "#"
    await waitFor(() => expect(calls.openedLocalPaths).toEqual([WINDOWS_REPORT]))
    expect(onMention).not.toHaveBeenCalled()
    expect(root.querySelector(".local-path-notice")).toBeNull()
  })

  it("says so beside the link when the path is not on this computer", async () => {
    installFakeBridge({}, { localPathOutcome: "not_found" })
    const { root } = renderMessage("See `/Users/someone/missing.pdf` and /Users/someone/b.pdf")
    const [inCode] = links(root)
    fireEvent.click(inCode)
    const notice = await waitFor(() => {
      const found = root.querySelector(".local-path-notice")
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(notice.textContent).toBe("Not found on this computer")
    expect(notice.getAttribute("role")).toBe("status")
    // Beside the code, not inside it, and only once however often it is clicked.
    expect(notice.previousElementSibling?.tagName).toBe("CODE")
    fireEvent.click(inCode)
    await Promise.resolve()
    expect(root.querySelectorAll(".local-path-notice")).toHaveLength(1)
  })
})
