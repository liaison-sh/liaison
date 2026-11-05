// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { app } from "~/app"
import { DEFAULT_APP_ORIGINS, parseOriginAllowlist, resolveCorsOrigin } from "~/lib/app-origins"

describe("app origin allowlist", () => {
  it("defaults to the three native shell origins and nothing else", () => {
    expect(parseOriginAllowlist(DEFAULT_APP_ORIGINS)).toEqual([
      "capacitor://localhost",
      "tauri://localhost",
      "http://tauri.localhost",
    ])
  })

  it("matches an entry exactly", () => {
    const allowed = ["https://app.example.com", "capacitor://localhost"]
    expect(resolveCorsOrigin("capacitor://localhost", allowed)).toBe("capacitor://localhost")
    expect(resolveCorsOrigin("https://app.example.com", allowed)).toBe("https://app.example.com")
    expect(resolveCorsOrigin("https://evil.example.com", allowed)).toBeNull()
    // A prefix is not a match: an attacker owns capacitor://localhost.evil.com.
    expect(resolveCorsOrigin("capacitor://localhost.evil.com", allowed)).toBeNull()
  })

  it("allows any port only where the entry says so", () => {
    const allowed = ["http://localhost:*"]
    expect(resolveCorsOrigin("http://localhost:1420", allowed)).toBe("http://localhost:1420")
    expect(resolveCorsOrigin("http://localhost", allowed)).toBe("http://localhost")
    expect(resolveCorsOrigin("https://localhost:1420", allowed)).toBeNull()
    expect(resolveCorsOrigin("http://evil.com:1420", allowed)).toBeNull()
    expect(resolveCorsOrigin("http://localhost:1420", ["http://localhost:5173"])).toBeNull()
  })

  it("refuses an absent or empty origin", () => {
    expect(resolveCorsOrigin("", ["capacitor://localhost"])).toBeNull()
  })
})

// The wrapped shells are a CROSS ORIGIN caller of this API: the page is served
// from capacitor:// or tauri://, the session cookie rides on `credentials:
// "include"`, and without the origin on the allowlist the browser drops the
// response before the app ever sees it.
describe("CORS for the native shells", () => {
  async function preflight(origin: string): Promise<string | null> {
    const response = await app.request("/api/health", {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
    })
    return response.headers.get("Access-Control-Allow-Origin")
  }

  it("allows the Capacitor and Tauri app origins", async () => {
    expect(await preflight("capacitor://localhost")).toBe("capacitor://localhost")
    expect(await preflight("tauri://localhost")).toBe("tauri://localhost")
  })

  it("allows the Windows desktop shell, which WebView2 serves from http://tauri.localhost", async () => {
    // Tauri has no custom scheme on Windows: the page is served from this
    // host over http, and the first Windows install could not sign in because
    // this origin was not on the list.
    expect(await preflight("http://tauri.localhost")).toBe("http://tauri.localhost")
    // Still exact: neither the https twin nor a look alike host.
    expect(await preflight("https://tauri.localhost")).toBeNull()
    expect(await preflight("http://tauri.localhost.evil.com")).toBeNull()
  })

  it("still refuses an origin nobody allowlisted", async () => {
    expect(await preflight("https://evil.example.com")).toBeNull()
  })
})
