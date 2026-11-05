// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import {
  cancelUpload,
  createUploadSession,
  deleteFile,
  FileQuotaExceededError,
  FileStorageUnavailableError,
  fetchFileBytes,
  fetchPreviewObjectUrl,
  getDownloadUrl,
  inFlightUploadsFor,
  isUploadCancelled,
  listFiles,
  moveFilesToParent,
  resetStorageDeliveryCache,
  uploadFile,
} from "~/modules/files/file-service"

function mockApi(
  responses: {
    post?: Record<string, unknown>
    get?: Record<string, unknown>
    getEnvelope?: Record<string, unknown>
    delete?: Record<string, unknown>
  } = {},
) {
  return {
    post: vi.fn(async (path: string) => {
      const v = responses.post?.[path]
      if (v && typeof v === "object" && "__error" in (v as object)) {
        const { status, code, message } = (v as any).__error
        throw new ApiError(message ?? "err", status, code)
      }
      return v
    }),
    get: vi.fn(async (path: string) => responses.get?.[path]),
    getEnvelope: vi.fn(async (path: string) => responses.getEnvelope?.[path]),
    delete: vi.fn(async (_path: string) => responses.delete?.[_path]),
    patch: vi.fn(),
  } as any
}

describe("attachment previews", () => {
  it("fetches the thumbnail with the global error toast suppressed", async () => {
    // A thumbnail that cannot be served (missing object, storage hiccup) is a
    // silent fallback to the filetype card, so it must never raise the global
    // "Something went wrong" toast on a view the user merely opened.
    const rawGet = vi.fn(async () => new Response(new Blob(["x"]), { status: 200 }))
    const api = { rawGet } as any
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} })
    await fetchPreviewObjectUrl(api, "file-1")
    expect(rawGet).toHaveBeenCalledWith("/files/file-1/inline?variant=thumb", {
      suppressGlobalError: true,
    })
    vi.unstubAllGlobals()
  })
})

describe("file-service", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    resetStorageDeliveryCache()
  })

  it("uploadFile PUTs straight to the presigned url when the server says direct", async () => {
    const PUT_URL = "https://s3.test/put"
    const api = mockApi({
      post: {
        "/files/upload-url": {
          uploadUrl: PUT_URL,
          uploadMode: "direct",
          fileToken: "tk",
          storageKey: "k1",
        },
        "/files/confirm": {
          id: "f1",
          filename: "x.txt",
          size: 5,
          mime: "text/plain",
          thumbnailKey: null,
        },
      },
    })
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const file = new File(["hello"], "x.txt", { type: "text/plain" })
    const row = await uploadFile(api, file, {
      app: "kernel",
      entityType: "thread",
      entityId: "t1",
    })
    expect(row.id).toBe("f1")
    // One PUT, to the store: the relay is never touched.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(PUT_URL, expect.objectContaining({ method: "PUT" }))
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = (call[1].headers ?? {}) as Record<string, string>
    // Content-Type only, as every PUT to a presigned url in the codebase: the
    // signature pins it and the length, which the browser sets itself.
    expect(headers).toEqual({ "Content-Type": "text/plain" })
    // The signature is the credential: no app cookie goes to the store.
    expect(call[1].credentials).toBe("omit")
    expect(call[1].body).toBe(file)
  })

  // A composer shows a picked photo at once: while it travels it is an
  // in-flight upload of its staging parent, then the confirmed row carries a
  // local object URL of the picked bytes (the server thumbnail comes later).
  it("uploadFile tracks the upload in flight and hands back a local image preview", async () => {
    const api = mockApi({
      post: {
        "/files/upload-url": { uploadUrl: "https://s3.test/put", fileToken: "tk", storageKey: "k" },
        "/files/confirm": { id: "img1", filename: "p.png", thumbnailKey: null },
      },
    })
    let releasePut: (r: Response) => void = () => {}
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((res) => (releasePut = res))),
    )
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:picked", revokeObjectURL: vi.fn() })
    const parent = { app: "kernel", entityType: "file_upload_session", entityId: "s1" }
    const pending = uploadFile(api, new File(["x"], "p.png", { type: "image/png" }), parent)
    await vi.waitFor(() =>
      expect(inFlightUploadsFor("kernel:file_upload_session:s1")).toHaveLength(1),
    )
    expect(inFlightUploadsFor("kernel:file_upload_session:s1")[0]).toMatchObject({
      filename: "p.png",
      previewUrl: "blob:picked",
    })
    expect(inFlightUploadsFor("kernel:file_upload_session:other")).toHaveLength(0)
    releasePut(new Response(null, { status: 200 }))
    const row = await pending
    expect(row.localPreviewUrl).toBe("blob:picked")
    expect(inFlightUploadsFor("kernel:file_upload_session:s1")).toHaveLength(0)
  })

  // Under the desktop shell the page origin is not the server: a relative
  // relay url was answered by the shell's asset protocol with index.html, 200.
  it("uploadFile relays through the SERVER's api base when the direct PUT fails", async () => {
    const api = mockApi({
      post: {
        "/files/upload-url": {
          uploadUrl: "http://objectstore:8333/put",
          uploadMode: "direct",
          fileToken: "tk",
          storageKey: "k1",
        },
        "/files/confirm": {
          id: "f1",
          filename: "x.txt",
          size: 5,
          mime: "text/plain",
          thumbnailKey: null,
        },
      },
    })
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "http://objectstore:8333/put") throw new TypeError("Failed to fetch")
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)
    ;(globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__ = "https://box.example.com"
    try {
      const file = new File(["hello"], "x.txt", { type: "text/plain" })
      await uploadFile(api, file, { app: "kernel", entityType: "thread", entityId: "t1" })
    } finally {
      delete (globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__
    }
    const relay = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(relay[0]).toBe("https://box.example.com/api/file-relay/tk")
    expect(relay[1].method).toBe("PUT")
  })

  // demo.liaison.sh walk: every upload first PUT to the internal object store, which
  // the browser blocked as mixed content (a console error and a wasted trip).
  // The server now says "relay" for a store browsers cannot reach.
  it("uploadFile goes straight to the relay when the server says relay", async () => {
    const api = mockApi({
      post: {
        "/files/upload-url": {
          uploadUrl: "https://box.example.com/api/file-relay/tk",
          uploadMode: "relay",
          fileToken: "tk",
          storageKey: "k1",
        },
        "/files/confirm": {
          id: "f1",
          filename: "x.txt",
          size: 5,
          mime: "text/plain",
          thumbnailKey: null,
        },
      },
    })
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    await uploadFile(api, new File(["hello"], "x.txt", { type: "text/plain" }), {
      app: "kernel",
      entityType: "thread",
      entityId: "t1",
    })
    const urls = fetchMock.mock.calls.map((c) => String((c as unknown as [string])[0]))
    expect(urls).toHaveLength(1)
    expect(urls[0]).toMatch(/\/file-relay\/tk$/)
  })

  // A server that predates `uploadMode` signs urls for a store the browser may
  // not reach: the relay is the path that always worked there.
  it("uploadFile relays when the server does not say direct", async () => {
    const api = mockApi({
      post: {
        "/files/upload-url": { uploadUrl: "https://s3.test/put", fileToken: "tk", storageKey: "k" },
        "/files/confirm": { id: "f1", filename: "x.txt", thumbnailKey: null },
      },
    })
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    await uploadFile(api, new File(["hello"], "x.txt", { type: "text/plain" }), {
      app: "kernel",
      entityType: "thread",
      entityId: "t1",
    })
    const urls = fetchMock.mock.calls.map((c) => String((c as unknown as [string])[0]))
    expect(urls).toEqual([expect.stringMatching(/\/file-relay\/tk$/)])
  })

  // GET /files/delivery answers the deployment's mode; per-file lookups only
  // happen on a direct deployment.
  function downloadApi(mode: "direct" | "relay", link?: unknown) {
    const get = vi.fn(async (path: string) =>
      path === "/files/delivery" ? { delivery: mode } : link,
    )
    const rawGet = vi.fn(async () => new Response("relayed"))
    return { get, rawGet }
  }

  it("fetchFileBytes fetches the presigned GET without credentials when direct", async () => {
    const api = downloadApi("direct", {
      downloadUrl: "https://s3.test/get?sig",
      delivery: "direct",
    })
    const fetchMock = vi.fn(async () => new Response("direct"))
    vi.stubGlobal("fetch", fetchMock)
    const res = await fetchFileBytes(api as any, "f1")
    expect(await res.text()).toBe("direct")
    expect(api.get).toHaveBeenCalledWith("/files/f1/download-url", { suppressGlobalError: true })
    expect(fetchMock).toHaveBeenCalledWith("https://s3.test/get?sig", { credentials: "omit" })
    expect(api.rawGet).not.toHaveBeenCalled()
  })

  it("fetchFileBytes falls back to the API route when the direct GET fails", async () => {
    const api = downloadApi("direct", {
      downloadUrl: "https://s3.test/get?sig",
      delivery: "direct",
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch")
      }),
    )
    const res = await fetchFileBytes(api as any, "f1")
    expect(await res.text()).toBe("relayed")
    expect(api.rawGet).toHaveBeenCalledWith("/files/f1/inline?download=1")
  })

  it("fetchFileBytes relays a file the server relays on a direct deployment (sealed)", async () => {
    const api = downloadApi("direct", {
      downloadUrl: "https://box/api/file-relay-dl/t",
      delivery: "relay",
    })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const res = await fetchFileBytes(api as any, "f1")
    expect(await res.text()).toBe("relayed")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Switch off: no per-file lookup, the mode is asked once per session.
  it("fetchFileBytes goes straight to the API route when the deployment relays", async () => {
    const api = downloadApi("relay")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    for (const id of ["f1", "f2", "f3"]) {
      const res = await fetchFileBytes(api as any, id)
      expect(await res.text()).toBe("relayed")
    }
    expect(api.get.mock.calls.map((c) => c[0])).toEqual(["/files/delivery"])
    expect(api.rawGet.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual([
      "/files/f1/inline?download=1",
      "/files/f2/inline?download=1",
      "/files/f3/inline?download=1",
    ])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // A failed lookup relays, and is asked again after a minute rather than
  // pinning relay for the whole session.
  it("fetchFileBytes retries a failed delivery lookup after the backoff", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      let fail = true
      const get = vi.fn(async (path: string) => {
        if (path === "/files/delivery") {
          if (fail) throw new ApiError("unavailable", 503, "UNAVAILABLE")
          return { delivery: "direct" }
        }
        return { downloadUrl: "https://s3.test/get?sig", delivery: "direct" }
      })
      const rawGet = vi.fn(async () => new Response("relayed"))
      const fetchMock = vi.fn(async () => new Response("direct"))
      vi.stubGlobal("fetch", fetchMock)
      const api = { get, rawGet } as any

      expect(await (await fetchFileBytes(api, "f1")).text()).toBe("relayed")
      fail = false
      vi.advanceTimersByTime(30_000)
      expect(await (await fetchFileBytes(api, "f2")).text()).toBe("relayed")
      vi.advanceTimersByTime(31_000)
      expect(await (await fetchFileBytes(api, "f3")).text()).toBe("direct")
      expect(get.mock.calls.filter((c) => c[0] === "/files/delivery")).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("uploadFile throws FileStorageUnavailableError on 503", async () => {
    const api = mockApi({
      post: {
        "/files/upload-url": { __error: { status: 503 } },
      },
    })
    await expect(
      uploadFile(api, new File([""], "x"), { app: "kernel", entityType: "thread", entityId: "t" }),
    ).rejects.toBeInstanceOf(FileStorageUnavailableError)
  })

  it("uploadFile maps 413 to FileQuotaExceededError", async () => {
    const api = mockApi({
      post: { "/files/upload-url": { __error: { status: 413, message: "quota" } } },
    })
    await expect(
      uploadFile(api, new File([""], "x"), { app: "kernel", entityType: "thread", entityId: "t" }),
    ).rejects.toBeInstanceOf(FileQuotaExceededError)
  })

  it("listFiles unwraps envelope", async () => {
    const api = mockApi({
      getEnvelope: {
        "/files?app=kernel&entityType=thread&entityId=t1": {
          data: [{ id: "f1", filename: "a", size: 1, mime: "image/png", thumbnailKey: null }],
        },
      },
    })
    const list = await listFiles(api, { app: "kernel", entityType: "thread", entityId: "t1" })
    expect(list.length).toBe(1)
    expect(list[0].id).toBe("f1")
  })

  it("getDownloadUrl returns url field", async () => {
    const api = mockApi({
      get: { "/files/abc/download-url": { downloadUrl: "https://signed/" } },
    })
    const url = await getDownloadUrl(api, "abc")
    expect(url).toBe("https://signed/")
  })

  it("deleteFile calls DELETE /files/:id", async () => {
    const api = mockApi()
    await deleteFile(api, "fid")
    expect(api.delete).toHaveBeenCalledWith("/files/fid")
  })

  it("createUploadSession posts target to /files/upload-sessions", async () => {
    const api = mockApi({
      post: {
        "/files/upload-sessions": {
          id: "sess-1",
          targetApp: "mail",
          targetEntityType: "message",
          targetEntityId: null,
        },
      },
    })
    const session = await createUploadSession(api, {
      targetApp: "mail",
      targetEntityType: "message",
    })
    expect(session.id).toBe("sess-1")
    expect(api.post).toHaveBeenCalledWith("/files/upload-sessions", {
      targetApp: "mail",
      targetEntityType: "message",
    })
  })

  it("uploadFile forwards disposition + contentId on confirm", async () => {
    const PUT_URL = "https://s3.test/put-inline"
    const calls: Array<{ path: string; body?: unknown }> = []
    const api = {
      post: vi.fn(async (path: string, body?: unknown) => {
        calls.push({ path, body })
        if (path === "/files/upload-url") {
          return { uploadUrl: PUT_URL, fileToken: "tk-inline", storageKey: "k-inline" }
        }
        if (path === "/files/confirm") {
          return {
            id: "f-inline",
            filename: "hero.png",
            sizeBytes: 5,
            mimeType: "image/png",
            thumbnailKey: null,
            disposition: "inline",
            contentId: "hero@cid",
          }
        }
      }),
      get: vi.fn(),
      getEnvelope: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
    } as any
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    )
    const file = new File(["hi"], "hero.png", { type: "image/png" })
    const row = await uploadFile(
      api,
      file,
      { app: "kernel", entityType: "file_upload_session", entityId: "sess-1" },
      { disposition: "inline", contentId: "<hero@cid>" },
    )
    expect(row.disposition).toBe("inline")
    const confirmCall = calls.find((c) => c.path === "/files/confirm")!
    expect(confirmCall.body).toMatchObject({
      fileToken: "tk-inline",
      disposition: "inline",
      contentId: "<hero@cid>",
    })
  })

  it("moveFilesToParent posts session+target+fileIds", async () => {
    const api = mockApi({ post: { "/files/move-to-parent": { moved: 2 } } })
    const res = await moveFilesToParent(api, {
      sourceSessionId: "sess-1",
      target: { app: "kernel", entityType: "message", entityId: "m-1" },
      fileIds: ["f1", "f2"],
    })
    expect(res.moved).toBe(2)
    expect(api.post).toHaveBeenCalledWith("/files/move-to-parent", {
      sourceSessionId: "sess-1",
      target: { app: "kernel", entityType: "message", entityId: "m-1" },
      fileIds: ["f1", "f2"],
    })
  })
})

// Walk 3: a tile still uploading could not be removed, so a slow upload could
// not be dropped. cancelUpload aborts it and leaves nothing behind.
describe("cancelling an upload", () => {
  const PARENT = { app: "kernel", entityType: "file_upload_session", entityId: "cancel-1" }
  const PARENT_KEY = "kernel:file_upload_session:cancel-1"
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("aborts the storage PUT, drops the tile and its preview at once, and never confirms", async () => {
    const api = mockApi({
      post: {
        "/files/upload-url": { uploadUrl: "https://s3.test/put", fileToken: "tk", storageKey: "k" },
      },
    })
    let putSignal: AbortSignal | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            putSignal = init.signal ?? undefined
            putSignal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            )
          }),
      ),
    )
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pic")
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    onTestFinished(() => {
      create.mockRestore()
      revoke.mockRestore()
    })
    const upload = uploadFile(api, new File(["x"], "pic.png", { type: "image/png" }), PARENT)
    await vi.waitFor(() => expect(putSignal).toBeDefined())
    const [tile] = inFlightUploadsFor(PARENT_KEY)
    expect(tile?.previewUrl).toBe("blob:pic")

    cancelUpload(tile!.key)
    // At once, not when the request unwinds.
    expect(inFlightUploadsFor(PARENT_KEY)).toHaveLength(0)
    expect(revoke).toHaveBeenCalledWith("blob:pic")
    expect(putSignal?.aborted).toBe(true)

    const err = await upload.catch((e: unknown) => e)
    expect(isUploadCancelled(err)).toBe(true)
    // The row is created by the confirm: none was asked for, none to delete.
    expect(api.post).not.toHaveBeenCalledWith("/files/confirm", expect.anything())
    expect(api.delete).not.toHaveBeenCalled()
  })

  it("deletes the row a confirm already on its way created", async () => {
    let landConfirm: (row: unknown) => void = () => {}
    const api = mockApi()
    api.post = vi.fn((path: string) =>
      path === "/files/confirm"
        ? new Promise((r) => {
            landConfirm = r
          })
        : Promise.resolve({ uploadUrl: "https://s3.test/put", fileToken: "tk", storageKey: "k" }),
    )
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    )
    const upload = uploadFile(api, new File(["x"], "doc.pdf", { type: "application/pdf" }), PARENT)
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/files/confirm", expect.anything()),
    )
    cancelUpload(inFlightUploadsFor(PARENT_KEY)[0]!.key)
    expect(isUploadCancelled(await upload.catch((e: unknown) => e))).toBe(true)

    landConfirm({
      id: "late-row",
      filename: "doc.pdf",
      sizeBytes: 1,
      mimeType: "application/pdf",
      thumbnailKey: null,
    })
    await vi.waitFor(() => expect(api.delete).toHaveBeenCalledWith("/files/late-row"))
  })
})
