// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { AttachmentStrip } from "~/modules/files/AttachmentStrip"
import { ApiContext } from "~/modules/shell/ApiContext"

const FILES = [
  {
    id: "img-1",
    filename: "hero.png",
    mimeType: "image/png",
    sizeBytes: 1234,
    thumbnailUrl: "https://thumb/hero.webp",
    downloadUrl: "https://download/hero.png",
    disposition: "inline" as const,
    contentId: null,
  },
  {
    id: "img-cid",
    filename: "embedded.png",
    mimeType: "image/png",
    sizeBytes: 555,
    thumbnailUrl: "https://thumb/embedded.webp",
    downloadUrl: "https://download/embedded.png",
    disposition: "inline" as const,
    contentId: "embedded@cid",
  },
  {
    id: "pdf-1",
    filename: "brief.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2048,
    thumbnailKey: null,
    downloadUrl: "https://download/brief.pdf",
    disposition: "attachment" as const,
  },
]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("AttachmentStrip", () => {
  it("renders inline image previews (via the authed inline route) and file chips with download actions", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview-1"),
      revokeObjectURL: vi.fn(),
    })
    const rawGet = vi.fn(async () => new Response(new Blob(["x"])))
    const api = { rawGet } as unknown as ApiClient
    const onDownload = vi.fn()
    render(() => (
      <ApiContext.Provider value={api}>
        <AttachmentStrip files={FILES} onDownload={onDownload} />
      </ApiContext.Provider>
    ))

    expect(screen.getByTestId("attachment-strip")).toBeVisible()
    // Images render as Slack-style inline previews, not compact cards.
    expect(screen.getByTestId("attachment-image-img-1")).toHaveAttribute(
      "data-disposition",
      "inline",
    )
    expect(screen.queryByTestId("attachment-card-img-1")).toBeNull()
    await waitFor(() =>
      expect(screen.getByTestId("attachment-thumbnail-img-1")).toHaveAttribute(
        "src",
        "blob:preview-1",
      ),
    )
    expect(rawGet).toHaveBeenCalledWith("/files/img-1/inline?variant=thumb", {
      suppressGlobalError: true,
    })

    // CID-embedded images (already rendered inside the mail body) keep the
    // compact card instead of duplicating the picture at full size.
    expect(screen.getByTestId("attachment-card-img-cid")).toBeVisible()
    expect(screen.queryByTestId("attachment-image-img-cid")).toBeNull()

    // Clicking the preview opens the full-resolution lightbox (streamed via
    // the inline route without the thumb variant).
    fireEvent.click(screen.getByTestId("attachment-thumbnail-img-1"))
    await waitFor(() => expect(screen.getByTestId("attachment-lightbox-img-1")).toBeVisible())
    await waitFor(() => expect(rawGet).toHaveBeenCalledWith("/files/img-1/inline"))
    // Non-image files never fetch a preview — icon fallback only.
    expect(screen.getByTestId("attachment-icon-pdf-1")).toBeVisible()
    expect(screen.getByTestId("attachment-card-pdf-1")).toHaveTextContent("brief.pdf")
    expect(screen.getByTestId("attachment-card-pdf-1")).toHaveTextContent("2 KB")

    fireEvent.click(screen.getByTestId("attachment-download-pdf-1"))
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ id: "pdf-1" }))
  })

  it("lets a body-embedded (CID) image card be opened fullscreen — the ticket-attachment path", async () => {
    // A ticket whose inline images carry a Content-ID demote to compact cards
    // (the body already references them). Those cards must still open the
    // fullscreen lightbox — the message body's <img src="/api/files/:id/inline">
    // can't authenticate, so the card is the only working preview path.
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:cid-open"),
      revokeObjectURL: vi.fn(),
    })
    const rawGet = vi.fn(async () => new Response(new Blob(["x"])))
    const api = { rawGet } as unknown as ApiClient
    render(() => (
      <ApiContext.Provider value={api}>
        <AttachmentStrip
          files={[
            {
              id: "ticket-cid",
              filename: "IMG_5998.jpeg",
              mimeType: "image/jpeg",
              sizeBytes: 414794,
              disposition: "inline" as const,
              contentId: "549B3964-2936-4B58-909F-4239597B83FC",
            },
          ]}
        />
      </ApiContext.Provider>
    ))

    // Demoted to a card (not the big inline preview) but still previewable.
    expect(screen.getByTestId("attachment-card-ticket-cid")).toBeVisible()
    const thumb = await waitFor(() => screen.getByTestId("attachment-thumbnail-ticket-cid"))
    fireEvent.click(thumb)
    await waitFor(() => expect(screen.getByTestId("attachment-lightbox-ticket-cid")).toBeVisible())
    await waitFor(() => expect(rawGet).toHaveBeenCalledWith("/files/ticket-cid/inline"))
  })

  it("shows an image preview for attachment-disposition files even when Gmail stamped a contentId", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview-2"),
      revokeObjectURL: vi.fn(),
    })
    const rawGet = vi.fn(async () => new Response(new Blob(["x"])))
    const api = { rawGet } as unknown as ApiClient
    render(() => (
      <ApiContext.Provider value={api}>
        <AttachmentStrip
          files={[
            {
              id: "img-gmail",
              filename: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 999,
              disposition: "attachment" as const,
              // Gmail sets a Content-ID on ordinary attachments; nothing in the
              // body references it, so it must still preview (not demote to card).
              contentId: "f_abc123",
            },
          ]}
        />
      </ApiContext.Provider>
    ))
    await waitFor(() => expect(screen.getByTestId("attachment-image-img-gmail")).toBeVisible())
    expect(screen.queryByTestId("attachment-card-img-gmail")).toBeNull()
  })

  it("falls back to the filetype icon when no ApiProvider is mounted", () => {
    render(() => <AttachmentStrip files={[FILES[0]]} />)
    expect(screen.getByTestId("attachment-icon-img-1")).toBeVisible()
  })

  it("renders nothing for empty files arrays", () => {
    render(() => <AttachmentStrip files={[]} />)
    expect(screen.queryByTestId("attachment-strip")).toBeNull()
  })
})
