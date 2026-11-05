// SPDX-License-Identifier: FSL-1.1-ALv2
import http2 from "node:http2"
import type { PushHttpRequest, PushHttpResponse, PushTransport } from "~/modules/push/types"

/** Hosts that only speak HTTP/2 (APNs). Everything else (FCM) goes through `fetch`. */
export const HTTP2_ONLY_HOST_SUFFIXES: readonly string[] = ["push.apple.com"]

const REQUEST_TIMEOUT_MS = 15_000

/**
 * The production transport.
 *
 * APNs accepts HTTP/2 only, and Bun's `fetch` does not speak HTTP/2: every APNs
 * request failed with `Malformed_HTTP_Response` (found live, 2026-09-28; the
 * fake transport in the tests hid it). APNs requests therefore go through
 * `node:http2`, one short-lived session per request, which is plenty at a
 * notification's volume. FCM keeps `fetch`.
 *
 * A network failure comes back as a 599 rather than a throw: the caller's
 * classifier already knows what to do with a 5xx (retry), and a rejected
 * promise here would have to be caught identically at every call site. The
 * reason is kept in the body so the log says what happened.
 */
export class FetchPushTransport implements PushTransport {
  private readonly http2Hosts: readonly string[]

  constructor(opts: { http2Hosts?: readonly string[] } = {}) {
    this.http2Hosts = opts.http2Hosts ?? HTTP2_ONLY_HOST_SUFFIXES
  }

  async request(req: PushHttpRequest): Promise<PushHttpResponse> {
    try {
      const url = new URL(req.url)
      if (this.http2Hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) {
        return await http2Request(url, req)
      }
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      })
      return { status: response.status, body: await response.text() }
    } catch (err) {
      return { status: 599, body: JSON.stringify({ reason: String(err) }) }
    }
  }
}

function http2Request(url: URL, req: PushHttpRequest): Promise<PushHttpResponse> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(url.origin)
    const timer = setTimeout(() => {
      session.destroy()
      reject(new Error(`http2 request to ${url.host} timed out`))
    }, REQUEST_TIMEOUT_MS)
    const done = (fn: () => void) => {
      clearTimeout(timer)
      session.close()
      fn()
    }
    session.on("error", (err) => done(() => reject(err)))
    const stream = session.request({
      ":method": req.method,
      ":path": `${url.pathname}${url.search}`,
      ...Object.fromEntries(
        Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    })
    let status = 0
    let body = ""
    stream.setEncoding("utf8")
    stream.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0)
    })
    stream.on("data", (chunk: string) => {
      body += chunk
    })
    stream.on("end", () => done(() => resolve({ status, body })))
    stream.on("error", (err) => done(() => reject(err)))
    stream.end(req.body ?? undefined)
  })
}
