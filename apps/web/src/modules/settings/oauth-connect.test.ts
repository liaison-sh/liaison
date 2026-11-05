// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Connecting an app from the desktop and mobile shells: the provider's page
// runs in the system browser (or the iOS authentication session), the flow is
// bound to this window by a PKCE verifier, and it ends on a
// `liaison://oauth-complete` link the window redeems. A browser tab keeps the
// plain redirect.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NATIVE_BRIDGE_GLOBAL } from "~/lib/native-bridge"
import {
  type FakeBridgeHandle,
  installFakeBridge,
  uninstallFakeBridge,
} from "~/modules/desktop/fake-bridge"
import { connectWithOAuth } from "~/modules/settings/oauth-connect"

const PROVIDER = "https://accounts.provider.example/o/oauth2/auth?state=server-state"
const AUTHORIZE = "/connections/mail/gmail/authorize"
const CODE = "c".repeat(64)

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  let binary = ""
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fakeApi() {
  const post = vi.fn(async (path: string, _body?: unknown): Promise<unknown> => {
    if (path.endsWith("/authorize")) return { redirectUrl: PROVIDER }
    if (path.endsWith("/oauth-handoff")) {
      return { appName: "mail", connectionName: "gmail", settingsPath: "/settings/mail/accounts" }
    }
    throw new Error(`unexpected ${path}`)
  })
  const api = { post: post as unknown as <T>(path: string, body?: unknown) => Promise<T> }
  const bodies = (suffix: string) =>
    post.mock.calls.filter(([path]) => path.endsWith(suffix)).map(([, body]) => body)
  return { api, post, bodies }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("connectWithOAuth in the desktop shell", () => {
  let shell: FakeBridgeHandle

  beforeEach(() => {
    shell = installFakeBridge()
  })

  afterEach(() => {
    uninstallFakeBridge()
  })

  it("opens the provider in the system browser and completes only on its own link, with its verifier", async () => {
    const { api, bodies } = fakeApi()
    const navigate = vi.fn()
    const onConnected = vi.fn()
    const pending = connectWithOAuth(
      api,
      AUTHORIZE,
      { mode: "personal" },
      { navigate, onConnected },
    )
    await vi.waitFor(() => expect(shell.calls.openedExternalUrls).toEqual([PROVIDER]))

    const [start] = bodies("/authorize") as Array<Record<string, string>>
    expect(start).toMatchObject({
      mode: "personal",
      client: "desktop",
      code_challenge_method: "S256",
    })
    expect(start.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(start.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(navigate).not.toHaveBeenCalled()

    // A link this window did not mint (a forwarded flow, a sign-in) is ignored.
    shell.deliverOAuthLink(
      `liaison://oauth-complete?code=${"d".repeat(64)}&state=${"x".repeat(43)}`,
    )
    await flush()
    expect(bodies("/oauth-handoff")).toEqual([])

    shell.deliverOAuthLink(`liaison://oauth-complete?code=${CODE}&state=${start.state}`)
    expect(await pending).toBe("connected")
    const [redeem] = bodies("/oauth-handoff") as Array<Record<string, string>>
    expect(redeem.code).toBe(CODE)
    expect(await s256(redeem.code_verifier)).toBe(start.code_challenge)
    expect(JSON.stringify(start)).not.toContain(redeem.code_verifier)
    expect(onConnected).toHaveBeenCalledWith({ settingsPath: "/settings/mail/accounts" })
  })

  it("reports a provider refusal and redeems nothing", async () => {
    const { api, bodies } = fakeApi()
    const pending = connectWithOAuth(api, AUTHORIZE, {}, { onConnected: vi.fn() })
    await vi.waitFor(() => expect(shell.calls.openedExternalUrls).toHaveLength(1))
    const [start] = bodies("/authorize") as Array<Record<string, string>>
    shell.deliverOAuthLink(`liaison://oauth-complete?error=access_denied&state=${start.state}`)
    await expect(pending).rejects.toThrow(/access_denied/)
    expect(bodies("/oauth-handoff")).toEqual([])
  })

  it("redeems on the kernel-wide route for an /api path (host services)", async () => {
    const { api, post } = fakeApi()
    const pending = connectWithOAuth(
      api,
      "/api/connections/shopify/shop/authorize",
      {},
      {
        onConnected: vi.fn(),
      },
    )
    await vi.waitFor(() => expect(shell.calls.openedExternalUrls).toHaveLength(1))
    const state = (post.mock.calls[0]?.[1] as Record<string, string> | undefined)?.state
    shell.deliverOAuthLink(`liaison://oauth-complete?code=${CODE}&state=${state}`)
    await pending
    expect(post.mock.calls[1]?.[0]).toBe("/api/connections/oauth-handoff")
  })
})

describe("connectWithOAuth in a shell without an external opener", () => {
  afterEach(() => uninstallFakeBridge())

  it("keeps the browser flow", async () => {
    installFakeBridge({}, { withoutExternalOpener: true })
    const { api, bodies } = fakeApi()
    const navigate = vi.fn()
    expect(await connectWithOAuth(api, AUTHORIZE, { mode: "org" }, { navigate })).toBe("redirected")
    expect(bodies("/authorize")).toEqual([{ mode: "org" }])
    expect(navigate).toHaveBeenCalledWith(PROVIDER)
  })
})

type Authenticate = (options: { url: string; callbackScheme: string }) => Promise<string | null>

describe("connectWithOAuth in the iOS shell", () => {
  let authenticate: ReturnType<typeof vi.fn<Authenticate>>
  const slot = globalThis as Record<string, unknown>

  beforeEach(() => {
    authenticate = vi.fn<Authenticate>()
    slot[NATIVE_BRIDGE_GLOBAL] = { authenticate }
  })

  afterEach(() => {
    delete slot[NATIVE_BRIDGE_GLOBAL]
  })

  it("runs the provider in the authentication session and redeems its link with the verifier", async () => {
    const { api, bodies } = fakeApi()
    authenticate.mockImplementation(async () => {
      const [start] = bodies("/authorize") as Array<Record<string, string>>
      return `liaison://oauth-complete?code=${CODE}&state=${start.state}`
    })
    const onConnected = vi.fn()
    expect(await connectWithOAuth(api, AUTHORIZE, { mode: "personal" }, { onConnected })).toBe(
      "connected",
    )
    expect(authenticate).toHaveBeenCalledWith({ url: PROVIDER, callbackScheme: "liaison" })
    const [start] = bodies("/authorize") as Array<Record<string, string>>
    expect(start).toMatchObject({ client: "mobile", code_challenge_method: "S256" })
    const [redeem] = bodies("/oauth-handoff") as Array<Record<string, string>>
    expect(redeem.code).toBe(CODE)
    expect(await s256(redeem.code_verifier)).toBe(start.code_challenge)
    expect(onConnected).toHaveBeenCalledWith({ settingsPath: "/settings/mail/accounts" })
  })

  it("refuses a session link with a state it did not mint", async () => {
    const { api, bodies } = fakeApi()
    authenticate.mockResolvedValue(`liaison://oauth-complete?code=${CODE}&state=${"y".repeat(43)}`)
    await expect(connectWithOAuth(api, AUTHORIZE, {}, { onConnected: vi.fn() })).rejects.toThrow()
    expect(bodies("/oauth-handoff")).toEqual([])
  })

  it("says nothing when the user closes the sheet", async () => {
    const { api, bodies } = fakeApi()
    authenticate.mockRejectedValue(Object.assign(new Error("closed"), { code: "cancelled" }))
    expect(await connectWithOAuth(api, AUTHORIZE, {})).toBe("cancelled")
    expect(bodies("/oauth-handoff")).toEqual([])
  })

  it("falls back to the browser flow on a shell with no session", async () => {
    const { api, bodies } = fakeApi()
    authenticate.mockResolvedValue(null)
    const navigate = vi.fn()
    expect(await connectWithOAuth(api, AUTHORIZE, { mode: "personal" }, { navigate })).toBe(
      "redirected",
    )
    expect(bodies("/authorize")[1]).toEqual({ mode: "personal" })
    expect(navigate).toHaveBeenCalledWith(PROVIDER)
  })
})

describe("connectWithOAuth in a browser tab", () => {
  it("redirects to the provider exactly as before", async () => {
    const { api, post } = fakeApi()
    const navigate = vi.fn()
    expect(
      await connectWithOAuth(api, "/connections/tickets/gmail/authorize", undefined, { navigate }),
    ).toBe("redirected")
    // No body, no shell parameters: the request is the one the page always sent.
    expect(post.mock.calls).toEqual([["/connections/tickets/gmail/authorize"]])
    expect(navigate).toHaveBeenCalledWith(PROVIDER)
  })
})
