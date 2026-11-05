// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The staged-attachment strip is shared by the chat, tickets and mail
// composers. It used to render full-width text chips with their own top border
// (a second card above the input, 2026-08-05 layout pass), then 36px tiles that
// showed a blank extension badge for a just-picked photo (iPhone, 2026-09-30).

import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { restoreStaged, StagedAttachmentChips } from "~/modules/files/StagedAttachmentChips"
import { ApiContext } from "~/modules/shell/ApiContext"

const api = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  getEnvelope: vi.fn(),
} as never

function file(over: Record<string, unknown> = {}) {
  return {
    id: "f1",
    filename: "invoice.pdf",
    sizeBytes: 10,
    mimeType: "application/pdf",
    thumbnailKey: null,
    thumbnailUrl: null,
    ...over,
  } as never
}

function renderStrip(files: unknown[]) {
  return render(() => (
    <ApiContext.Provider value={api}>
      <StagedAttachmentChips files={files as never} onRemoved={() => {}} onRestored={() => {}} />
    </ApiContext.Provider>
  ))
}

describe("StagedAttachmentChips", () => {
  it("renders a strip with no border of its own", () => {
    const { getByTestId } = renderStrip([file()])
    const strip = getByTestId("composer-attachment-strip")
    // The heavy top border is what made it read as a separate card.
    expect(strip.className).not.toContain("border-t")
  })

  it("shows a non-image as a chip with its name and size, removable by name", () => {
    const { getByTestId } = renderStrip([file({ sizeBytes: 2048 })])
    const chip = getByTestId("composer-attachment-f1")
    expect(chip.getAttribute("data-kind")).toBe("file")
    expect(chip.textContent).toContain("invoice.pdf")
    expect(chip.textContent).toContain("2 KB")
    expect(chip.getAttribute("title")).toBe("invoice.pdf")
    expect(getByTestId("composer-attachment-remove-f1").getAttribute("aria-label")).toBe(
      "Remove invoice.pdf",
    )
  })

  it("shows the image's own thumbnail when the server produced one", () => {
    const { getByTestId } = renderStrip([
      file({
        id: "f2",
        filename: "shot.png",
        mimeType: "image/png",
        thumbnailUrl: "/api/files/f2/thumb",
      }),
    ])
    const img = getByTestId("composer-attachment-f2").querySelector("img")
    expect(img?.getAttribute("src")).toBe("/api/files/f2/thumb")
    expect(img?.getAttribute("alt")).toBe("shot.png")
  })

  // The iPhone showed a blank "PNG" badge: right after upload the server has
  // not rendered a thumbnail yet, and the tile had nothing else to show. The
  // picked bytes are already on the device, so they are the preview.
  it("shows a freshly picked image from its local bytes, as a 64px square", () => {
    const { getByTestId } = renderStrip([
      file({
        id: "f3",
        filename: "photo.png",
        mimeType: "image/png",
        thumbnailUrl: null,
        localPreviewUrl: "blob:local-photo",
      }),
    ])
    const tile = getByTestId("composer-attachment-f3")
    expect(tile.getAttribute("data-kind")).toBe("image")
    const img = tile.querySelector("img")
    expect(img?.getAttribute("src")).toBe("blob:local-photo")
    expect(img?.className).toContain("object-cover")
    expect(img?.parentElement?.className).toContain("h-16")
    expect(img?.parentElement?.className).toContain("w-16")
    expect(tile.textContent).not.toContain("PNG")
  })

  it("falls back to the authenticated preview route when the row carries no preview", async () => {
    const rawGet = vi.fn(async () => new Response(new Blob(["x"])))
    const createObjectURL = vi.fn(() => "blob:fetched")
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() })
    const { getByTestId } = render(() => (
      <ApiContext.Provider value={{ ...(api as object), rawGet } as never}>
        <StagedAttachmentChips
          files={[file({ id: "f4", filename: "restored.png", mimeType: "image/png" })] as never}
          onRemoved={() => {}}
          onRestored={() => {}}
        />
      </ApiContext.Provider>
    ))
    await waitFor(() =>
      expect(getByTestId("composer-attachment-f4").querySelector("img")?.getAttribute("src")).toBe(
        "blob:fetched",
      ),
    )
    expect(rawGet).toHaveBeenCalledWith("/files/f4/inline?variant=thumb", {
      suppressGlobalError: true,
    })
    vi.unstubAllGlobals()
  })

  it("keeps the remove control a small corner button, out of the touch floor", () => {
    const { getByTestId } = renderStrip([file()])
    const remove = getByTestId("composer-attachment-remove-f1")
    expect(remove.hasAttribute("data-touch-dense")).toBe(true)
    // Always visible: a phone has no hover to reveal it.
    expect(remove.className).not.toContain("opacity-0")
  })

  // A local preview holds the picked photo's bytes in memory until revoked.
  // Only the remove button used to revoke it, so every image that went out
  // with a message (the host clears its list) or sat in a composer that
  // unmounted stayed allocated for the life of the page.
  it("releases a local preview once its file leaves the strip, and the rest on unmount", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    try {
      const img = (id: string) =>
        file({ id, filename: `${id}.png`, mimeType: "image/png", localPreviewUrl: `blob:${id}` })
      const [files, setFiles] = createSignal<unknown[]>([img("a"), img("b")])
      const { unmount } = render(() => (
        <ApiContext.Provider value={api}>
          <StagedAttachmentChips
            files={files() as never}
            onRemoved={() => {}}
            onRestored={() => {}}
          />
        </ApiContext.Provider>
      ))
      expect(revoke).not.toHaveBeenCalled()

      setFiles([img("b")])
      expect(revoke.mock.calls.map((c) => c[0])).toEqual(["blob:a"])

      unmount()
      expect(revoke.mock.calls.map((c) => c[0])).toEqual(["blob:a", "blob:b"])
    } finally {
      revoke.mockRestore()
    }
  })

  it("renders nothing when there is nothing staged", () => {
    const { queryByTestId } = renderStrip([])
    expect(queryByTestId("composer-attachment-strip")).toBeNull()
  })

  // Tickets and mail drew the strip right-aligned under the editor, beside
  // the send button; chat drew it left-aligned above the field. One layout.
  it("lays the strip out left-aligned by default, the way chat does", () => {
    const { getByTestId } = renderStrip([file()])
    const strip = getByTestId("composer-attachment-strip")
    expect(strip.className).not.toContain("justify-end")
    expect(strip.className).toContain("overflow-x-auto")
  })

  describe("removal is optimistic", () => {
    function renderLive(del: (path: string) => Promise<unknown>, initial: unknown[]) {
      const [files, setFiles] = createSignal<any[]>(initial)
      const settled = vi.fn()
      const utils = render(() => (
        <ApiContext.Provider value={{ ...(api as object), delete: del } as never}>
          <StagedAttachmentChips
            files={files() as never}
            onRemoved={(f) => setFiles((p) => p.filter((x) => x.id !== f.id))}
            onRestored={(f, i) => setFiles((p) => restoreStaged(p as never, f, i))}
            onRemoveSettled={settled}
          />
        </ApiContext.Provider>
      ))
      return { ...utils, files, settled }
    }

    it("takes the tile away before the server has answered", async () => {
      let answer!: () => void
      const del = vi.fn(() => new Promise<void>((r) => (answer = r)))
      const { queryByTestId, getByTestId, settled } = renderLive(del, [file()])
      fireEvent.click(getByTestId("composer-attachment-remove-f1"))
      expect(queryByTestId("composer-attachment-f1")).toBeNull()
      expect(del).toHaveBeenCalledWith("/files/f1")
      expect(settled).not.toHaveBeenCalled()
      answer()
      await waitFor(() => expect(settled).toHaveBeenCalledTimes(1))
    })

    it("puts a file back where it was, with a message, when the delete is refused", async () => {
      const del = vi.fn(async () => {
        throw new ApiError("boom", 500)
      })
      const { getByTestId, files, settled } = renderLive(del, [
        file({ id: "a", filename: "a.pdf" }),
        file({ id: "f1" }),
        file({ id: "c", filename: "c.pdf" }),
      ])
      fireEvent.click(getByTestId("composer-attachment-remove-f1"))
      await waitFor(() => expect(files().map((f) => f.id)).toEqual(["a", "f1", "c"]))
      expect(getByTestId("composer-attachment-f1")).toBeTruthy()
      expect(getByTestId("composer-attachment-error").textContent).toContain("invoice.pdf")
      expect(settled).not.toHaveBeenCalled()
    })

    it("counts a file the server no longer has as removed", async () => {
      const del = vi.fn(async () => {
        throw new ApiError("gone", 404)
      })
      const { getByTestId, queryByTestId, files, settled } = renderLive(del, [file()])
      fireEvent.click(getByTestId("composer-attachment-remove-f1"))
      await waitFor(() => expect(settled).toHaveBeenCalledTimes(1))
      expect(files()).toEqual([])
      expect(queryByTestId("composer-attachment-error")).toBeNull()
    })
  })
})
