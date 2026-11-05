// SPDX-License-Identifier: FSL-1.1-ALv2
import { render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { dispatchWsEventMessage, registerWsEntityHandler } from "~/framework/app-registry"
import { ApiError } from "~/lib/api-error"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import FileList from "./FileList"
import { handleFileEvent } from "./file-events"

function mount(
  getEnvelope: ReturnType<typeof vi.fn>,
  locale: "en" | "fr" = "en",
  rawGet?: ReturnType<typeof vi.fn>,
) {
  render(() => (
    <I18nProvider initialLocale={locale}>
      <ApiContext.Provider value={{ getEnvelope, rawGet } as never}>
        <div data-testid="host">
          <FileList parent={{ app: "knowledge", entityType: "document", entityId: "d1" }} />
        </div>
      </ApiContext.Provider>
    </I18nProvider>
  ))
}

describe("FileList", () => {
  it("lists without the global error toast, and a refusal (403) shows nothing", async () => {
    const getEnvelope = vi.fn(async (_path: string, _init?: object) => {
      throw new ApiError("Forbidden", 403)
    })
    mount(getEnvelope)
    await waitFor(() => expect(getEnvelope).toHaveBeenCalled())
    expect(getEnvelope.mock.calls[0]![1]).toMatchObject({ suppressGlobalError: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByTestId("host").textContent).toBe("")
  })

  it("says a list it could not load in the reader's language", async () => {
    mount(
      vi.fn(async () => {
        throw new ApiError("Server error", 500)
      }),
      "fr",
    )
    expect(await screen.findByText("Impossible de charger les pièces jointes")).toBeTruthy()
  })

  // The Files panel said "No files yet" until a reload after an agent (or the
  // files API) attached a file: nothing listened to the kernel:file event.
  it("shows a file attached elsewhere live, from the kernel:file event", async () => {
    registerWsEntityHandler("kernel:file", "kernel", handleFileEvent, { owner: "file" })
    const row = {
      id: "f1",
      filename: "kestrel-rma-label.pdf",
      sizeBytes: 1200,
      mimeType: "application/pdf",
      thumbnailKey: null,
    }
    let served: unknown[] = []
    const getEnvelope = vi.fn(async () => ({ data: served }))
    mount(getEnvelope)
    expect(await screen.findByTestId("file-list-empty")).toBeTruthy()

    served = [row]
    // Another parent's file changes nothing here.
    dispatchWsEventMessage(
      {
        type: "event",
        payload: {
          app: "kernel",
          entity: "file",
          action: "create",
          data: { app: "knowledge", entityType: "document", entityId: "other", id: "f0" },
        },
      },
      { currentUserId: "u1", activeTabId: null, isDocumentVisible: true, isOwnAction: false },
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(getEnvelope).toHaveBeenCalledTimes(1)

    dispatchWsEventMessage(
      {
        type: "event",
        payload: {
          app: "kernel",
          entity: "file",
          action: "create",
          data: { app: "knowledge", entityType: "document", entityId: "d1", id: "f1" },
        },
      },
      { currentUserId: "u1", activeTabId: null, isDocumentVisible: true, isOwnAction: false },
    )
    expect(await screen.findByTestId("file-list-item-f1")).toBeTruthy()
    expect(screen.queryByTestId("file-list-empty")).toBeNull()
    expect(getEnvelope).toHaveBeenCalledTimes(2)
  })

  // Relayed delivery: the row's thumbnail is the API's authed inline route, not
  // an object-store URL. It loads through the authed client into a blob URL; a
  // bare <img src> could not send the Bearer header, and the page's CSP does
  // not name the store.
  it("loads a relayed thumbnail through the authed client, never as a raw src", async () => {
    const row = {
      id: "img1",
      filename: "photo.png",
      sizeBytes: 1200,
      mimeType: "image/png",
      thumbnailUrl: "/api/files/img1/inline?variant=thumb",
    }
    const rawGet = vi.fn(async () => new Response(new Blob(["x"], { type: "image/webp" })))
    const createObjectURL = vi.fn(() => "blob:thumb-img1")
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL }))
    mount(
      vi.fn(async () => ({ data: [row] })),
      "en",
      rawGet,
    )
    const img = (await screen.findByTestId("file-list-thumbnail-img1")) as HTMLImageElement
    expect(img.getAttribute("src")).toBe("blob:thumb-img1")
    expect(rawGet).toHaveBeenCalledWith("/files/img1/inline?variant=thumb", expect.anything())
  })

  it("shows a presigned (direct delivery) thumbnail as is", async () => {
    const row = {
      id: "img2",
      filename: "photo.png",
      sizeBytes: 1200,
      mimeType: "image/png",
      thumbnailUrl: "https://store.example/orgs/k.thumb.webp?sig=1",
    }
    const rawGet = vi.fn()
    mount(
      vi.fn(async () => ({ data: [row] })),
      "en",
      rawGet,
    )
    const img = (await screen.findByTestId("file-list-thumbnail-img2")) as HTMLImageElement
    expect(img.getAttribute("src")).toBe("https://store.example/orgs/k.thumb.webp?sig=1")
    expect(rawGet).not.toHaveBeenCalled()
  })
})
