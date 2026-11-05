// SPDX-License-Identifier: FSL-1.1-ALv2
// A request refused because an admin restricted the viewer away from an app
// (S20, A7): the toast says "You no longer have access" (not the generic
// forbidden copy) and the shell hears it, even from a caller that shows its
// own error, so the app's entry goes at once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApiClient } from "~/lib/api-client"

function refusal(code: string, status = 403): Response {
  return new Response(
    JSON.stringify({ error: { message: "This app is restricted by your admin.", code } }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  )
}

describe("403 app_restricted", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const onError = vi.fn()
  const onAppRestricted = vi.fn()

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    onError.mockReset()
    onAppRestricted.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  const client = () =>
    createApiClient({
      getAccessToken: () => "t",
      onUnauthorized: vi.fn(),
      onError,
      onAppRestricted,
    })

  it("says you no longer have access and reports it", async () => {
    fetchMock.mockResolvedValueOnce(refusal("app_restricted"))
    await expect(client().get("/apps/tickets/config")).rejects.toMatchObject({
      status: 403,
      code: "app_restricted",
    })
    expect(onAppRestricted).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(
      403,
      expect.stringMatching(/no longer have access/),
      undefined,
    )
  })

  it("reports it even when the caller shows its own error", async () => {
    fetchMock.mockResolvedValueOnce(refusal("app_restricted"))
    await expect(
      client().get("/apps/tickets/config", { suppressGlobalError: true }),
    ).rejects.toBeTruthy()
    expect(onAppRestricted).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("410 app_disabled (an admin turned the app off) is reported too, on every request path", async () => {
    fetchMock.mockResolvedValueOnce(refusal("app_disabled", 410))
    await expect(client().get("/apps/tickets/config")).rejects.toMatchObject({
      status: 410,
      code: "app_disabled",
    })
    fetchMock.mockResolvedValueOnce(refusal("app_disabled", 410))
    await expect(client().rawGet("/apps/tickets/file")).rejects.toBeTruthy()
    expect(onAppRestricted).toHaveBeenCalledTimes(2)
  })

  it("another 410 is not an access change", async () => {
    fetchMock.mockResolvedValueOnce(refusal("gone", 410))
    await expect(client().get("/apps/tickets/config")).rejects.toBeTruthy()
    expect(onAppRestricted).not.toHaveBeenCalled()
  })

  it("another 403 keeps the generic copy and is not an access change", async () => {
    fetchMock.mockResolvedValueOnce(refusal("forbidden"))
    await expect(client().get("/apps/tickets/config")).rejects.toBeTruthy()
    expect(onAppRestricted).not.toHaveBeenCalled()
    expect(onError.mock.calls[0][1]).not.toMatch(/no longer have access/)
  })
})
