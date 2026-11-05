// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { AttachmentCard } from "~/modules/files/AttachmentCard"
import { ApiContext } from "~/modules/shell/ApiContext"

// Unique ids per case so the module-level preview cache (keyed by file id) never
// bleeds a resolved blob URL from one test into another's rawGet assertions.
const imageFile = (id: string) => ({
  id,
  filename: `${id}.jpeg`,
  mimeType: "image/jpeg",
  sizeBytes: 4096,
  disposition: "inline" as const,
  contentId: "embedded@cid",
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("AttachmentCard", () => {
  it("opens the fullscreen lightbox (full-res, no thumb variant) when an image card is clicked", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    })
    const rawGet = vi.fn(async () => new Response(new Blob(["x"])))
    const api = { rawGet } as unknown as ApiClient
    const onDownload = vi.fn()
    const file = imageFile("card-open")

    render(() => (
      <ApiContext.Provider value={api}>
        <AttachmentCard file={file} onDownload={onDownload} />
      </ApiContext.Provider>
    ))

    // Thumbnail streams through the authed thumb route (never a native <img>).
    const thumb = await waitFor(() => screen.getByTestId(`attachment-thumbnail-${file.id}`))
    // The whole thumbnail is a real button (accessible, keyboard-activatable) —
    // this is the fullscreen affordance body-embedded images otherwise lack.
    const button = thumb.closest("button")
    expect(button).not.toBeNull()
    expect(button?.className).toContain("cursor-zoom-in")

    fireEvent.click(thumb)

    await waitFor(() => expect(screen.getByTestId(`attachment-lightbox-${file.id}`)).toBeVisible())
    // The lightbox streams the ORIGINAL bytes (no `?variant=thumb`).
    await waitFor(() => expect(rawGet).toHaveBeenCalledWith(`/files/${file.id}/inline`))
  })

  it("is not clickable and mounts no lightbox for non-image files", async () => {
    const rawGet = vi.fn(async () => new Response(new Blob(["x"])))
    const api = { rawGet } as unknown as ApiClient
    render(() => (
      <ApiContext.Provider value={api}>
        <AttachmentCard
          file={{
            id: "doc-1",
            filename: "brief.pdf",
            mimeType: "application/pdf",
            sizeBytes: 2048,
            disposition: "attachment",
          }}
        />
      </ApiContext.Provider>
    ))

    expect(screen.getByTestId("attachment-icon-doc-1")).toBeVisible()
    // Only the download button exists — the thumbnail box stays a plain <div>.
    expect(screen.queryByTestId("attachment-lightbox-doc-1")).toBeNull()
    const buttons = screen.getAllByRole("button")
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAttribute("data-testid", "attachment-download-doc-1")
    // A non-image card never touches the inline route.
    expect(rawGet).not.toHaveBeenCalled()
  })
})
