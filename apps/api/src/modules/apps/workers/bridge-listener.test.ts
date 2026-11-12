// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it } from "bun:test"
import { isBridgeListenerRequest, startBridgeListener } from "./bridge-listener"

describe("the bridge-only listener", () => {
  it("passes a run's bridge call only", () => {
    expect(isBridgeListenerRequest("POST", "/api/app-bridge/run-1")).toBe(true)
    expect(isBridgeListenerRequest("GET", "/api/app-bridge/run-1")).toBe(false)
    expect(isBridgeListenerRequest("GET", "/api/app-bridge/bundles/abc")).toBe(false)
    expect(isBridgeListenerRequest("POST", "/api/app-bridge/bundles")).toBe(false)
    expect(isBridgeListenerRequest("POST", "/api/app-bridge/run-1/x")).toBe(false)
    expect(isBridgeListenerRequest("POST", "/api/auth/login")).toBe(false)
    expect(isBridgeListenerRequest("GET", "/healthz")).toBe(false)
    expect(isBridgeListenerRequest("POST", "/api/app-bridge")).toBe(false)
  })

  const seen: string[] = []
  const server = startBridgeListener(
    {
      fetch: (req) => {
        seen.push(`${req.method} ${new URL(req.url).pathname}`)
        return new Response("from-app")
      },
    },
    { port: 0, hostname: "127.0.0.1" },
  )
  afterAll(() => server.stop(true))
  const url = (p: string) => `http://127.0.0.1:${server.port}${p}`

  it("answers 404 for everything else, before the app sees it", async () => {
    for (const [method, path] of [
      ["GET", "/healthz"],
      ["POST", "/api/auth/login"],
      ["GET", "/api/app-bridge/bundles/0"],
      ["GET", "/"],
    ] as const) {
      const res = await fetch(url(path), { method })
      expect(res.status).toBe(404)
    }
    expect(seen).toEqual([])
    const ok = await fetch(url("/api/app-bridge/r-1"), { method: "POST", body: "{}" })
    expect(await ok.text()).toBe("from-app")
    expect(seen).toEqual(["POST /api/app-bridge/r-1"])
  })
})
