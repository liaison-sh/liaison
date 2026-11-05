// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "vitest"
import {
  absoluteApiBase,
  apiUrl,
  authApiPath,
  authApiUrl,
  env,
  serverResourceUrl,
  webSocketOrigin,
} from "~/lib/env"

/** What the mobile boot bundle and the desktop overlay set before we load. */
function setOverride(value: unknown): void {
  ;(globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__ = value
}

describe("env helpers", () => {
  it("builds API URLs from the shared base", () => {
    expect(env.API_BASE).toBe("/api")
    expect(apiUrl("/threads/thread-123")).toBe("/api/threads/thread-123")
  })

  it("builds auth API paths and URLs consistently", () => {
    expect(authApiPath("login")).toBe("/auth/login")
    expect(authApiUrl("/oauth/github/authorize")).toBe("/api/auth/oauth/github/authorize")
  })
})

// ONE BUILD, EVERY DEPLOYMENT (S15). Wrapped in a native shell the page is
// served from capacitor:// or tauri://, where a relative "/api" resolves to
// the bundle itself, so the shell injects the address the user entered and
// every request has to read it. An override that is not an absolute http(s)
// origin is IGNORED rather than trusted: it arrives on a global any script in
// the page can write.
describe("the server address override", () => {
  afterEach(() => {
    setOverride(undefined)
  })

  it("sends API calls to the injected origin", () => {
    setOverride("https://acme.example.com")
    expect(apiUrl("/threads/thread-123")).toBe("https://acme.example.com/api/threads/thread-123")
    expect(absoluteApiBase()).toBe("https://acme.example.com/api")
  })

  it("keeps only the origin of the injected address", () => {
    setOverride("https://acme.example.com/some/path?x=1#y")
    expect(apiUrl("/threads/t")).toBe("https://acme.example.com/api/threads/t")
  })

  it("ignores anything that is not an absolute http or https origin", () => {
    for (const bad of ["", "   ", "/api", "acme.example.com", "javascript:alert(1)", 7, null]) {
      setOverride(bad)
      expect(apiUrl("/threads/t")).toBe("/api/threads/t")
    }
  })

  it("connects the websocket to the injected origin, with the matching scheme", () => {
    setOverride("https://acme.example.com")
    expect(webSocketOrigin()).toBe("wss://acme.example.com")
    setOverride("http://192.168.1.10:3000")
    expect(webSocketOrigin()).toBe("ws://192.168.1.10:3000")
  })
})

// The server hands some URLs back for the page to load directly: an avatar is
// stored as "/api/avatars/<key>" and goes straight into an <img src>. Under a
// native shell that path resolved against capacitor:// or tauri:// and every
// uploaded profile picture was a broken image while initials kept working.
describe("a server-relative resource URL", () => {
  afterEach(() => {
    setOverride(undefined)
  })

  it("stays relative in a browser, where the page shares the API's origin", () => {
    expect(serverResourceUrl("/api/avatars/abc")).toBe("/api/avatars/abc")
  })

  it("is anchored on the injected server origin under a native shell", () => {
    setOverride("https://acme.example.com")
    expect(serverResourceUrl("/api/avatars/abc")).toBe("https://acme.example.com/api/avatars/abc")
  })

  it("leaves absolute, protocol-relative, data and blob URLs alone", () => {
    setOverride("https://acme.example.com")
    for (const url of [
      "https://cdn.example.org/a.png",
      "//cdn.example.org/a.png",
      "data:image/png;base64,AAAA",
      "blob:capacitor://localhost/1234",
    ]) {
      expect(serverResourceUrl(url)).toBe(url)
    }
  })

  it("passes an absent URL through as null", () => {
    setOverride("https://acme.example.com")
    expect(serverResourceUrl(null)).toBeNull()
    expect(serverResourceUrl(undefined)).toBeNull()
    expect(serverResourceUrl("")).toBeNull()
  })
})
