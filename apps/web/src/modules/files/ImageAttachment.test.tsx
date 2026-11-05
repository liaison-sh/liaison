// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { Suspense } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ImageAttachment } from "~/modules/files/ImageAttachment"
import { ApiContext } from "~/modules/shell/ApiContext"

const FILE = {
  id: "img-1",
  filename: "chart.png",
  mimeType: "image/png",
  sizeBytes: 4096,
  disposition: "inline" as const,
  contentId: null,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ImageAttachment loading box", () => {
  // Regression (walk 2): the preview resource was read during render, so a
  // loading preview suspended the NEAREST <Suspense>, MainPanel's per-tab one:
  // sending a picture pulled the whole thread out of the document and the
  // message list came back scrolled to the top. The preview has its own
  // skeleton and must never suspend anything above it. The button also clips
  // the not-yet-decoded image, which otherwise overflowed the skeleton into
  // the list's scrollHeight.
  it("never suspends the boundary around it while the preview loads", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview-2"),
      revokeObjectURL: vi.fn(),
    })
    let answer: (r: Response) => void = () => {}
    const rawGet = vi.fn(() => new Promise<Response>((r) => (answer = r)))
    const api = { rawGet } as unknown as ApiClient

    render(() => (
      <ApiContext.Provider value={api}>
        <Suspense fallback={<div data-testid="tab-suspended" />}>
          <div data-testid="tab-body">
            <ImageAttachment file={{ ...FILE, id: "img-suspense" }} />
          </div>
        </Suspense>
      </ApiContext.Provider>
    ))

    await waitFor(() => expect(rawGet).toHaveBeenCalled())
    expect(screen.queryByTestId("tab-suspended")).toBeNull()
    expect(screen.getByTestId("tab-body")).toBeTruthy()
    answer(new Response(new Blob(["x"])))
    const img = await waitFor(() => screen.getByTestId("attachment-thumbnail-img-suspense"))
    expect(screen.queryByTestId("tab-suspended")).toBeNull()
    expect(img.closest("button")?.className).toContain("overflow-hidden")
  })

  // Regression: a message image must never collapse the row height while it
  // loads. Before the fix the skeleton (160px) was replaced by a not-yet-decoded
  // <img> of ~0px height, then grew to the full image — that transient *shrink*
  // made TanStack scroll the virtualized thread list downward and stranded the
  // viewport above the newest message. The row height must only ever GROW:
  // hold a fixed skeleton box and keep the <img> out of flow until it decodes.
  it("holds a fixed skeleton box and keeps the <img> out of flow until it decodes", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview-1"),
      revokeObjectURL: vi.fn(),
    })
    const rawGet = vi.fn(async () => new Response(new Blob(["x"])))
    const api = { rawGet } as unknown as ApiClient

    render(() => (
      <ApiContext.Provider value={api}>
        <ImageAttachment file={FILE} />
      </ApiContext.Provider>
    ))

    // Once the preview URL resolves the <img> mounts — but until it has DECODED
    // (its `load` event) the skeleton must still reserve the box and the image
    // must be absolutely positioned so it contributes no flow height.
    const img = await waitFor(() => screen.getByTestId("attachment-thumbnail-img-1"))
    expect(img).toHaveAttribute("src", "blob:preview-1")
    expect(img.className).toContain("absolute")
    expect(img.className).toContain("opacity-0")

    const button = img.closest("button")
    expect(button).not.toBeNull()
    // The fixed-size skeleton (h-40) is present, holding the row height.
    expect(button?.querySelector(".h-40")).not.toBeNull()

    // After the bitmap decodes: skeleton is removed and the image joins the
    // normal flow (no longer absolute / hidden). A monotonic grow — no collapse.
    fireEvent.load(img)
    await waitFor(() => expect(img.className).not.toContain("absolute"))
    expect(img.className).not.toContain("opacity-0")
    expect(button?.querySelector(".h-40")).toBeNull()
  })
})

describe("ImageAttachment lightbox close", () => {
  // Regression (ticket-9988): opening the fullscreen lightbox and closing it
  // (Escape or the close button) must never reset the surrounding scroll
  // container's scroll position. Kobalte's Dialog restores focus on close to
  // its registered trigger ref — but the lightbox is opened from a plain
  // <button>, not a Kobalte Dialog.Trigger, so that ref is never set. Left to
  // Kobalte's fallback, focus lands nowhere in particular and Safari scrolls
  // the nearest scrollable ancestor to bring it into view, snapping a long
  // thread back to the top. ImageLightbox now captures/restores focus itself
  // with `preventScroll: true` to avoid this.
  it("preserves the scroll container's scrollTop after Escape closes the lightbox", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview-1"),
      revokeObjectURL: vi.fn(),
    })
    const rawGet = vi.fn(async () => new Response(new Blob(["x"])))
    const api = { rawGet } as unknown as ApiClient

    render(() => (
      <div data-testid="scroll-container" style={{ height: "200px", "overflow-y": "auto" }}>
        <div style={{ height: "2000px" }} />
        <ApiContext.Provider value={api}>
          <ImageAttachment file={FILE} />
        </ApiContext.Provider>
      </div>
    ))

    const container = screen.getByTestId("scroll-container")
    container.scrollTop = 1500

    const img = await waitFor(() => screen.getByTestId("attachment-thumbnail-img-1"))
    const button = img.closest("button")
    expect(button).not.toBeNull()
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    button!.focus()
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    fireEvent.click(button!)

    await waitFor(() => screen.getByTestId("attachment-lightbox-img-1"))
    expect(container.scrollTop).toBe(1500)

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })

    await waitFor(() => expect(screen.queryByTestId("attachment-lightbox-img-1")).toBeNull())
    // Focus is restored to the trigger button we captured on open (not left on
    // <body>), so Safari has no off-screen element to scroll into view. jsdom
    // cannot reproduce Safari's focus-scroll, so we assert the restore target
    // directly rather than the scroll (which stays put here regardless).
    expect(document.activeElement).toBe(button)
    expect(container.scrollTop).toBe(1500)
  })
})
