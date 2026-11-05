// SPDX-License-Identifier: FSL-1.1-ALv2
//
// APNs only speaks HTTP/2 and Bun's fetch does not: every real push failed
// (2026-09-28) while the fake transport kept the suite green. The server here
// accepts HTTP/2 only (h2c with prior knowledge), like APNs.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import http2 from "node:http2"
import type { AddressInfo } from "node:net"
import { FetchPushTransport } from "~/modules/push/transport"

let server: http2.Http2Server
let port = 0
const seen: Array<{ method: string; path: string; auth: string; topic: string; body: string }> = []

beforeAll(async () => {
  server = http2.createServer()
  server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
    let body = ""
    stream.setEncoding("utf8")
    stream.on("data", (c: string) => {
      body += c
    })
    stream.on("end", () => {
      seen.push({
        method: String(headers[":method"]),
        path: String(headers[":path"]),
        auth: String(headers.authorization ?? ""),
        topic: String(headers["apns-topic"] ?? ""),
        body,
      })
      stream.respond({ ":status": 410, "content-type": "application/json" })
      stream.end(JSON.stringify({ reason: "Unregistered" }))
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  port = (server.address() as AddressInfo).port
})

afterAll(() => {
  server.close()
})

describe("push transport", () => {
  it("speaks HTTP/2 to an APNs-like host and returns its status and body", async () => {
    const transport = new FetchPushTransport({ http2Hosts: ["127.0.0.1"] })
    const res = await transport.request({
      url: `http://127.0.0.1:${port}/3/device/abc`,
      method: "POST",
      headers: { authorization: "bearer x", "apns-topic": "sh.liaison.mobile" },
      body: '{"aps":{}}',
    })
    expect(res).toEqual({ status: 410, body: '{"reason":"Unregistered"}' })
    expect(seen.at(-1)).toEqual({
      method: "POST",
      path: "/3/device/abc",
      auth: "bearer x",
      topic: "sh.liaison.mobile",
      body: '{"aps":{}}',
    })
  })

  it("routes the real APNs hosts over HTTP/2 by default", () => {
    const t = new FetchPushTransport() as unknown as { http2Hosts: readonly string[] }
    expect(t.http2Hosts).toContain("push.apple.com")
  })

  it("a network failure is a 599 with the reason, not a throw", async () => {
    const transport = new FetchPushTransport({ http2Hosts: ["127.0.0.1"] })
    const res = await transport.request({
      url: "http://127.0.0.1:1/x",
      method: "POST",
      headers: {},
      body: "",
    })
    expect(res.status).toBe(599)
    expect(res.body).toContain("reason")
  })
})
