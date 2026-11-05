// SPDX-License-Identifier: FSL-1.1-ALv2
// A remote server that answers with a long chain of content codings and then
// closes the connection must make the fetch reject, never raise an uncaught
// exception (which the API's process handlers turn into a process exit).
// Checked twice: through fetchWithPinnedHost as the API calls it, and against
// the installed undici package itself (loaded by file path, so a Node consumer
// of the dependency is covered too).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createRequire } from "node:module"
import { createServer, type Server } from "node:net"
import { fetchWithPinnedHost } from "~/lib/outbound-fetch"

let server: Server
let port = 0

beforeAll(async () => {
  server = createServer((socket) => {
    socket.once("data", () => {
      socket.write(
        "HTTP/1.1 200 OK\r\n" +
          "Content-Type: text/plain\r\n" +
          "Content-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\n" +
          "Content-Length: 100\r\n" +
          "\r\n",
      )
      setTimeout(() => socket.destroy(), 20)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no server port")
  port = address.port
})

afterAll(() => {
  server.close()
})

/** Runs `request`, returns its outcome and every uncaught exception raised meanwhile. */
async function withUncaughtCapture(
  request: () => Promise<Response>,
): Promise<{ outcome: string; uncaught: string[] }> {
  const uncaught: string[] = []
  const onUncaught = (err: unknown) => {
    uncaught.push(String((err as Error)?.message ?? err))
  }
  // Replace bun:test's own listener for the duration of the request so the
  // stray error is recorded instead of failing the run out of band.
  const previous = process.listeners("uncaughtException")
  process.removeAllListeners("uncaughtException")
  process.on("uncaughtException", onUncaught)
  let outcome = "resolved"
  try {
    const res = await request()
    try {
      await res.text()
      outcome = "body read"
    } catch {
      outcome = "body rejected"
    }
  } catch {
    outcome = "fetch rejected"
  } finally {
    // Give a stray stream error time to surface.
    await new Promise((resolve) => setTimeout(resolve, 300))
    process.removeListener("uncaughtException", onUncaught)
    for (const listener of previous) process.on("uncaughtException", listener)
  }
  return { outcome, uncaught }
}

describe("many content codings then an early close", () => {
  it("fetchWithPinnedHost rejects without an uncaught exception", async () => {
    const { outcome, uncaught } = await withUncaughtCapture(() =>
      fetchWithPinnedHost(
        `http://127.0.0.1:${port}/page`,
        {},
        { requireHttps: false, allowPrivateHostsInTest: true },
      ),
    )
    expect(outcome).not.toBe("body read")
    expect(uncaught).toEqual([])
  })

  it("the installed undici package rejects without an uncaught exception", async () => {
    const require = createRequire(import.meta.url)
    const entry = require.resolve("undici/package.json").replace(/package\.json$/, "index.js")
    const undici = require(entry) as {
      Agent: new (opts: object) => object
      fetch: (url: string, init: object) => Promise<Response>
    }
    const agent = new undici.Agent({
      connect: {
        lookup: (
          _host: string,
          _opts: object,
          cb: (err: Error | null, address: string, family: number) => void,
        ) => cb(null, "127.0.0.1", 4),
      },
    })
    const { outcome, uncaught } = await withUncaughtCapture(() =>
      undici.fetch(`http://127.0.0.1:${port}/page`, { dispatcher: agent }),
    )
    expect(outcome).not.toBe("body read")
    expect(uncaught).toEqual([])
  })
})
