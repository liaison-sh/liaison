// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Route-level tests for the token-authenticated upload relay
 * (PUT /api/file-relay/:token). Covers the guard paths that never reach
 * object storage: token verification and the authorized-size ceiling.
 * (The happy path writes to the bucket and is exercised by the file-upload
 * E2E scenarios.)
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { fileUploadRelay } from "~/modules/files/routes"
import { signFileToken } from "~/modules/files/service"
import * as orgDeleting from "~/modules/org/purge/deleting"

const PAYLOAD = {
  orgId: "org-1",
  userId: "user-1",
  app: "kernel",
  entityType: "thread",
  entityId: "thread-1",
  storageKey: "orgs/org-1/kernel/thread/thread-1/x.bin",
  filename: "x.bin",
  mimeType: "application/octet-stream",
  sizeBytes: 4,
}

describe("upload relay", () => {
  beforeEach(() => {
    spyOn(orgDeleting, "assertOrgNotDeleting").mockResolvedValue(undefined)
  })
  afterEach(() => {
    mock.restore()
  })

  it("refuses a valid token once its org's deletion has started (410)", async () => {
    spyOn(orgDeleting, "assertOrgNotDeleting").mockRejectedValue(new orgDeleting.OrgDeletedError())
    const token = await signFileToken(PAYLOAD)
    const res = await fileUploadRelay.request(`/${encodeURIComponent(token)}`, {
      method: "PUT",
      body: "data",
    })
    expect(res.status).toBe(410)
    expect(orgDeleting.assertOrgNotDeleting).toHaveBeenCalledWith("org-1")
  })

  it("rejects a garbage token with 401 INVALID_TOKEN", async () => {
    const res = await fileUploadRelay.request("/not-a-jwt", {
      method: "PUT",
      body: "data",
    })
    expect(res.status).toBe(401)
    const json = (await res.json()) as { error: { code: string } }
    expect(json.error.code).toBe("INVALID_TOKEN")
  })

  it("rejects an expired token with 401 INVALID_TOKEN", async () => {
    const token = await signFileToken(PAYLOAD, undefined, -60)
    const res = await fileUploadRelay.request(`/${encodeURIComponent(token)}`, {
      method: "PUT",
      body: "data",
    })
    expect(res.status).toBe(401)
  })

  it("rejects a body larger than the authorized sizeBytes with 413", async () => {
    const token = await signFileToken(PAYLOAD)
    const res = await fileUploadRelay.request(`/${encodeURIComponent(token)}`, {
      method: "PUT",
      body: "this body is longer than four bytes",
    })
    expect(res.status).toBe(413)
    const json = (await res.json()) as { error: { code: string } }
    expect(json.error.code).toBe("FILE_TOO_LARGE")
  })

  // A client that declares no length (chunked) used to have its whole body buffered
  // before the size was compared. The stream is now counted and cut at the authorized size.
  it("stops reading a chunked body at the authorized size, without a declared length", async () => {
    const token = await signFileToken(PAYLOAD)
    let pulled = 0
    const chunk = new Uint8Array(1024)
    const stream = new ReadableStream({
      pull(controller) {
        pulled++
        if (pulled > 5000) return controller.close()
        controller.enqueue(chunk)
      },
    })
    const res = await fileUploadRelay.request(`/${encodeURIComponent(token)}`, {
      method: "PUT",
      body: stream,
      // Stream request bodies need duplex (fetch spec; Bun's RequestInit types it).
      duplex: "half",
    })
    expect(res.status).toBe(413)
    // It gave up after a few chunks; it did not drain thousands of them first.
    expect(pulled).toBeLessThan(50)
  })
})
