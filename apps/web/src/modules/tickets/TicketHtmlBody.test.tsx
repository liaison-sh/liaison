// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiContext } from "~/modules/shell/ApiContext"
import { TicketHtmlBody } from "~/modules/tickets/TicketHtmlBody"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("TicketHtmlBody", () => {
  it("renders text synchronously and streams inline-file images through the authed route", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:inline-1"),
      revokeObjectURL: vi.fn(),
    })
    const rawGet = vi.fn(async () => new Response(new Blob(["x"])))
    const api = { rawGet } as unknown as ApiClient
    const onImageClick = vi.fn()

    render(() => (
      <ApiContext.Provider value={api}>
        <TicketHtmlBody
          testId="body"
          html={`<p>See the photo:</p><img src="/api/files/file-123/inline" alt="pic.jpg" />`}
          onImageClick={onImageClick}
        />
      </ApiContext.Provider>
    ))

    const body = screen.getByTestId("body")
    // Text is present immediately (declarative innerHTML, not deferred).
    expect(body.textContent).toContain("See the photo:")

    // The image never fires a native (un-authed, 401) load: its src is stripped
    // to a data attribute until the authed bytes arrive.
    const img = body.querySelector("img") as HTMLImageElement
    expect(img.getAttribute("data-file-id")).toBe("file-123")

    // The bytes stream through the authed inline route (no thumb variant), then
    // a blob src is swapped in.
    await waitFor(() => expect(rawGet).toHaveBeenCalledWith("/files/file-123/inline"))
    await waitFor(() => expect(img.getAttribute("src")).toBe("blob:inline-1"))

    // Clicking the image previews it fullscreen, carrying its file id so the
    // lightbox can offer a download.
    fireEvent.click(img)
    expect(onImageClick).toHaveBeenCalledTimes(1)
    expect(onImageClick.mock.calls[0][1]).toBe("file-123")
  })

  it("does not load remote images until the agent asks, then only through the authed proxy", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:remote-1"),
      revokeObjectURL: vi.fn(),
    })
    const rawGet = vi.fn(async () => new Response(new Blob(["x"])))
    const api = { rawGet } as unknown as ApiClient
    const onImageClick = vi.fn()

    render(() => (
      <ApiContext.Provider value={api}>
        <TicketHtmlBody
          testId="body"
          html={`<img src="https://cdn.example.com/logo.png" alt="logo" />`}
          onImageClick={onImageClick}
        />
      </ApiContext.Provider>
    ))

    // The browser never sees a remote src, so no tracking pixel can fire.
    const img = screen.getByTestId("body").querySelector("img") as HTMLImageElement
    expect(img.hasAttribute("src")).toBe(false)
    expect(img.getAttribute("data-remote-src")).toBe("https://cdn.example.com/logo.png")
    expect(img.hasAttribute("data-file-id")).toBe(false)
    expect(rawGet).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("ticket-body-load-images"))
    await waitFor(() =>
      expect(rawGet).toHaveBeenCalledWith(
        `/mail/image-proxy?url=${encodeURIComponent("https://cdn.example.com/logo.png")}`,
      ),
    )
    await waitFor(() => expect(img.getAttribute("src")).toBe("blob:remote-1"))

    fireEvent.click(img)
    // A remote image carries no file id: the lightbox opens without download.
    expect(onImageClick.mock.calls[0][1]).toBeNull()
  })

  it("treats protocol-relative image sources as remote", () => {
    const api = { rawGet: vi.fn() } as unknown as ApiClient
    render(() => (
      <ApiContext.Provider value={api}>
        <TicketHtmlBody testId="body" html={`<img src="//t.example.com/p.gif" />`} />
      </ApiContext.Provider>
    ))
    const img = screen.getByTestId("body").querySelector("img") as HTMLImageElement
    expect(img.hasAttribute("src")).toBe(false)
    expect(screen.getByTestId("ticket-body-image-banner")).toBeTruthy()
  })

  it("marks every body image lazy-loading + async-decoding so images never gate the text paint", () => {
    const api = { rawGet: vi.fn() } as unknown as ApiClient
    render(() => (
      <ApiContext.Provider value={api}>
        <TicketHtmlBody
          testId="body"
          html={`<img src="https://cdn.example.com/a.png" /><img src="/api/files/file-9/inline" />`}
        />
      </ApiContext.Provider>
    ))
    const imgs = Array.from(screen.getByTestId("body").querySelectorAll("img"))
    expect(imgs).toHaveLength(2)
    for (const img of imgs) {
      expect(img.getAttribute("loading")).toBe("lazy")
      expect(img.getAttribute("decoding")).toBe("async")
    }
  })

  // The app's CSS reset strips list markers: a formatted reply (or a
  // customer's HTML list) must still read as a list.
  it("keeps list markers, links and quotes visible", () => {
    render(() => (
      <ApiContext.Provider value={{} as ApiClient}>
        <TicketHtmlBody testId="body" html="<ul><li>un</li></ul>" />
      </ApiContext.Provider>
    ))
    const cls = screen.getByTestId("body").className
    for (const rule of [
      "[&_ul]:list-disc",
      "[&_ol]:list-decimal",
      "[&_a]:underline",
      "[&_ul]:my-2",
    ]) {
      expect(cls).toContain(rule)
    }
  })
})
