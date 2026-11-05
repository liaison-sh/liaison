// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Signing in to an MCP server from the desktop shell: like an app connection
// (settings/oauth-connect.ts), the provider runs in the system browser, the
// flow is bound to this window by a PKCE verifier, and it ends on a
// `liaison://oauth-complete` link the window redeems. A browser tab keeps
// opening the provider in a new tab.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import {
  type FakeBridgeHandle,
  installFakeBridge,
  uninstallFakeBridge,
} from "~/modules/desktop/fake-bridge"
import { signInToMcp } from "~/modules/mcp-manager/api"

const PROVIDER = "https://issuer.example/authorize?state=server-state"
const CODE = "c".repeat(64)
const CONN = "0b9a3c1e-8f0e-4c1e-9d3e-2a1b3c4d5e6f"

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  let binary = ""
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fakeApi() {
  const post = vi.fn(async (path: string, _body?: unknown): Promise<unknown> => {
    if (path.endsWith("/oauth/start")) return { authorizationUrl: PROVIDER }
    if (path.endsWith("/oauth/handoff")) return { connectionId: CONN }
    throw new Error(`unexpected ${path}`)
  })
  const api = { post } as unknown as ApiClient
  const bodies = (suffix: string) =>
    post.mock.calls.filter(([path]) => path.endsWith(suffix)).map(([, body]) => body)
  return { api, post, bodies }
}

describe("signInToMcp in the desktop shell", () => {
  let shell: FakeBridgeHandle
  beforeEach(() => {
    shell = installFakeBridge()
  })
  afterEach(() => uninstallFakeBridge())

  it("runs the provider in the system browser and completes on its own link, with its verifier", async () => {
    const { api, bodies } = fakeApi()
    const open = vi.fn()
    const pending = signInToMcp(api, CONN, open)
    await vi.waitFor(() => expect(shell.calls.openedExternalUrls).toEqual([PROVIDER]))
    const [start] = bodies("/oauth/start") as Array<Record<string, string>>
    expect(start).toMatchObject({ client: "desktop", code_challenge_method: "S256" })
    expect(start.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // The page's own opener is not used: the shell opened the system browser.
    expect(open).not.toHaveBeenCalled()

    shell.deliverOAuthLink(`liaison://oauth-complete?code=${CODE}&state=${start.state}`)
    expect(await pending).toBe("connected")
    const [redeem] = bodies("/oauth/handoff") as Array<Record<string, string>>
    expect(redeem.code).toBe(CODE)
    expect(await s256(redeem.code_verifier)).toBe(start.code_challenge)
  })
})

describe("signInToMcp in a browser tab", () => {
  it("opens the provider exactly as before, with no shell parameters", async () => {
    const { api, bodies } = fakeApi()
    const open = vi.fn()
    expect(await signInToMcp(api, CONN, open)).toBe("opened")
    expect(open).toHaveBeenCalledWith(PROVIDER)
    expect(bodies("/oauth/start")).toEqual([undefined])
    expect(bodies("/oauth/handoff")).toEqual([])
  })

  it("refuses an unsafe authorization URL", async () => {
    const post = vi.fn(async () => ({ authorizationUrl: "javascript:alert(1)" }))
    const open = vi.fn()
    await expect(signInToMcp({ post } as unknown as ApiClient, CONN, open)).rejects.toThrow(
      /unsafe/,
    )
    expect(open).not.toHaveBeenCalled()
  })
})
