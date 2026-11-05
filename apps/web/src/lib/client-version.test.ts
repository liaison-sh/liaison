// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApiClient } from "~/lib/api-client"
import {
  CLIENT_HEADER,
  type ClientPolicyEnv,
  clientHeaders,
  compareVersions,
  createClientPolicy,
  type ShellClient,
  startClientPolicy,
} from "~/lib/client-version"
import { DESKTOP_BRIDGE_KEY } from "~/lib/desktop-shell-contract"
import { NATIVE_BRIDGE_GLOBAL } from "~/lib/native-bridge"

const POLICY = { data: { desktop: "0.1.33", ios: "1.0.34", android: "0.0.0" } }

function policyResponse(body: unknown = POLICY, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function policy(client: ShellClient | null, answer: () => Promise<Response>) {
  const fetchPolicy = vi.fn(answer)
  const env: ClientPolicyEnv = { client: async () => client, fetchPolicy }
  return { model: createClientPolicy(env), fetchPolicy }
}

describe("compareVersions", () => {
  it("orders by major, minor and patch numerically", () => {
    expect(compareVersions("0.1.33", "0.1.33")).toBe(0)
    expect(compareVersions("0.1.9", "0.1.33")).toBeLessThan(0)
    expect(compareVersions("1.0.40", "1.0.34")).toBeGreaterThan(0)
    expect(compareVersions("0.2.0", "0.1.99")).toBeGreaterThan(0)
  })
})

describe("the client version policy", () => {
  it("a shell below its minimum: the header is set and the notice is due", async () => {
    const { model } = policy({ platform: "desktop", version: "0.1.30" }, async () =>
      policyResponse(),
    )
    await model.start()
    expect(model.header()).toBe("desktop/0.1.30")
    expect(model.belowMinimum()).toBe("desktop")
  })

  it("a shell at or above its minimum: the header, and no notice", async () => {
    for (const client of [
      { platform: "desktop", version: "0.1.33" },
      { platform: "ios", version: "1.0.40" },
    ] as const) {
      const { model } = policy(client, async () => policyResponse())
      await model.start()
      expect(model.header()).toBe(`${client.platform}/${client.version}`)
      expect(model.belowMinimum()).toBeNull()
    }
  })

  it("a browser: no policy call, no header, no notice", async () => {
    const { model, fetchPolicy } = policy(null, async () => policyResponse())
    await model.start()
    expect(fetchPolicy).not.toHaveBeenCalled()
    expect(model.header()).toBeNull()
    expect(model.belowMinimum()).toBeNull()
  })

  it("an older server that does not answer the policy: no header, no notice", async () => {
    const answers = [
      async () => policyResponse({ error: "not found" }, 404),
      // The desktop's asset protocol answers index.html with a 200.
      async () => new Response("<!doctype html>", { status: 200 }),
      async () => {
        throw new TypeError("Failed to fetch")
      },
    ]
    for (const answer of answers) {
      const { model } = policy({ platform: "desktop", version: "0.1.30" }, answer)
      await model.start()
      expect(model.header()).toBeNull()
      expect(model.belowMinimum()).toBeNull()
    }
  })

  it("asks the server once, however often it is started", async () => {
    const { model, fetchPolicy } = policy({ platform: "android", version: "1.0.3" }, async () =>
      policyResponse(),
    )
    await Promise.all([model.start(), model.start()])
    await model.start()
    expect(fetchPolicy).toHaveBeenCalledTimes(1)
  })
})

describe("the header on the page's requests", () => {
  const global = globalThis as Record<string, unknown>

  afterEach(() => {
    vi.unstubAllGlobals()
    global[DESKTOP_BRIDGE_KEY] = undefined
    global[NATIVE_BRIDGE_GLOBAL] = undefined
  })

  function api() {
    return createApiClient({ getAccessToken: () => "t", onUnauthorized: vi.fn() })
  }

  function sentHeaders(fetchMock: ReturnType<typeof vi.fn>, index: number) {
    return (fetchMock.mock.calls[index][1] as { headers: Record<string, string> }).headers
  }

  it("a desktop shell whose server answered the policy sends X-Liaison-Client", async () => {
    global[DESKTOP_BRIDGE_KEY] = {
      version: 1,
      platform: "macos",
      appVersion: async () => "0.1.35",
    }
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/client-policy") ? policyResponse() : policyResponse({ data: { ok: true } }),
    )
    vi.stubGlobal("fetch", fetchMock)
    await startClientPolicy()
    expect(clientHeaders()).toEqual({ [CLIENT_HEADER]: "desktop/0.1.35" })
    await api().get("/users/me")
    expect(sentHeaders(fetchMock, 1)[CLIENT_HEADER]).toBe("desktop/0.1.35")
  })

  it("a phone shell reports its own platform and version", async () => {
    global[NATIVE_BRIDGE_GLOBAL] = {
      clientVersion: async () => ({ platform: "ios", version: "1.0.36" }),
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => policyResponse()),
    )
    await startClientPolicy()
    expect(clientHeaders()).toEqual({ [CLIENT_HEADER]: "ios/1.0.36" })
  })

  it("no header when the policy call fails (an older server)", async () => {
    global[DESKTOP_BRIDGE_KEY] = { version: 1, platform: "macos", appVersion: async () => "0.1.35" }
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/client-policy")
        ? policyResponse({ error: "not found" }, 404)
        : policyResponse({ data: { ok: true } }),
    )
    vi.stubGlobal("fetch", fetchMock)
    await startClientPolicy()
    expect(clientHeaders()).toEqual({})
    await api().get("/users/me")
    expect(sentHeaders(fetchMock, 1)[CLIENT_HEADER]).toBeUndefined()
  })

  it("a browser never asks and never sends the header", async () => {
    const fetchMock = vi.fn(async () => policyResponse({ data: { ok: true } }))
    vi.stubGlobal("fetch", fetchMock)
    await startClientPolicy()
    expect(fetchMock).not.toHaveBeenCalled()
    await api().get("/users/me")
    expect(sentHeaders(fetchMock, 0)[CLIENT_HEADER]).toBeUndefined()
  })
})
