// SPDX-License-Identifier: FSL-1.1-ALv2
// fetchWithPinnedHost must connect to the address it validated, never to a
// second DNS answer (DNS rebinding). These tests use the real runtime fetch
// against local servers, with the resolver replaced through `node:dns/promises`
// (the module's lookup seam), so a hostname that only the injected resolver
// knows can be reached only through the pinned address.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as dnsPromises from "node:dns/promises"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TLSSocket } from "node:tls"
import { fetchWithPinnedHost, UnsafeOutboundUrlError } from "~/lib/outbound-fetch"

type Answer = { address: string; family: 4 | 6 }

interface Hit {
  host: string | null
  peer: string | undefined
}

function startHttpServer(
  hostname: string,
  handler?: (req: Request, port: number) => Response,
): { server: ReturnType<typeof Bun.serve>; hits: Hit[] } {
  const hits: Hit[] = []
  const server = Bun.serve({
    hostname,
    port: 0,
    fetch(req, srv) {
      hits.push({ host: req.headers.get("host"), peer: srv.requestIP(req)?.address })
      return handler ? handler(req, srv.port ?? 0) : new Response("reached")
    },
  })
  return { server, hits }
}

let lookupSpy: ReturnType<typeof spyOn>

/** Answers each hostname from `table`; a function entry is called per lookup. */
function resolveWith(table: Record<string, Answer | (() => Answer)>): void {
  lookupSpy.mockImplementation((async (host: string) => {
    const entry = table[host]
    if (!entry) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" })
    return [typeof entry === "function" ? entry() : entry]
  }) as never)
}

beforeEach(() => {
  lookupSpy = spyOn(dnsPromises, "lookup")
})
afterEach(() => {
  lookupSpy.mockRestore()
})

describe("fetchWithPinnedHost connects to the validated address", () => {
  it("never reaches the address a rebinding resolver gives after validation", async () => {
    // `rebind.localhost` is a name the runtime's own resolver (and so an unpinned fetch) maps
    // to the private address; the injected resolver answers a public address
    // first and the private one on any later lookup.
    // The system resolver may answer either loopback family, so listen on both.
    const { server, hits } = startHttpServer("127.0.0.1")
    const v6 = Bun.serve({
      hostname: "::1",
      port: server.port,
      fetch(req) {
        hits.push({ host: req.headers.get("host"), peer: "::1" })
        return new Response("reached")
      },
    })
    let calls = 0
    resolveWith({
      "rebind.localhost": () =>
        ++calls === 1
          ? { address: "93.184.216.34", family: 4 }
          : { address: "127.0.0.1", family: 4 },
    })
    try {
      const outcome = await fetchWithPinnedHost(
        `http://rebind.localhost:${server.port}/internal`,
        { signal: AbortSignal.timeout(1500) },
        { requireHttps: false },
      ).then(
        (r) => `status ${r.status}`,
        (e: Error) => `rejected ${e.name} ${e.message}`,
      )
      expect(hits).toEqual([])
      expect(outcome).toStartWith("rejected")
    } finally {
      server.stop(true)
      v6.stop(true)
    }
  })

  it("connects to the pinned IPv4 address and sends the original Host", async () => {
    const { server, hits } = startHttpServer("127.0.0.1")
    resolveWith({ "pin-only.invalid": { address: "127.0.0.1", family: 4 } })
    try {
      const res = await fetchWithPinnedHost(
        `http://pin-only.invalid:${server.port}/x`,
        {},
        { allowPrivateHostsInTest: true },
      )
      expect(res.status).toBe(200)
      expect(await res.text()).toBe("reached")
      expect(hits).toEqual([{ host: `pin-only.invalid:${server.port}`, peer: "127.0.0.1" }])
    } finally {
      server.stop(true)
    }
  })

  it("connects to a pinned IPv6 address (bracketed literal)", async () => {
    const { server, hits } = startHttpServer("::1")
    resolveWith({ "pin-only6.invalid": { address: "::1", family: 6 } })
    try {
      const res = await fetchWithPinnedHost(
        `http://pin-only6.invalid:${server.port}/`,
        {},
        { allowPrivateHostsInTest: true },
      )
      expect(res.status).toBe(200)
      expect(hits).toEqual([{ host: `pin-only6.invalid:${server.port}`, peer: "::1" }])
    } finally {
      server.stop(true)
    }
  })

  it("refuses a redirect hop whose host resolves private, on every hop", async () => {
    const { server, hits } = startHttpServer("127.0.0.1", (req, port) => {
      const path = new URL(req.url).pathname
      if (path === "/one") {
        return new Response(null, {
          status: 302,
          headers: { location: `http://second.invalid:${port}/two` },
        })
      }
      if (path === "/two") {
        return new Response(null, {
          status: 302,
          headers: { location: `http://rebound.invalid:${port}/internal` },
        })
      }
      return new Response("internal")
    })
    resolveWith({
      "first.invalid": { address: "127.0.0.1", family: 4 },
      "second.invalid": { address: "127.0.0.1", family: 4 },
      "rebound.invalid": { address: "127.0.0.1", family: 4 },
    })
    try {
      const allowed = new Set(["first.invalid", "second.invalid"])
      await expect(
        fetchWithPinnedHost(
          `http://first.invalid:${server.port}/one`,
          {},
          { privateAllowedFor: (u) => allowed.has(u.hostname) },
        ),
      ).rejects.toBeInstanceOf(UnsafeOutboundUrlError)
      expect(hits.map((h) => h.host)).toEqual([
        `first.invalid:${server.port}`,
        `second.invalid:${server.port}`,
      ])
    } finally {
      server.stop(true)
    }
  })
})

describe("fetchWithPinnedHost over HTTPS verifies the original hostname", () => {
  let dir: string
  let ca: string
  let server: HttpsServer
  let port = 0
  const sniSeen: Array<string | false | null | undefined> = []

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pinned-tls-"))
    const gen = Bun.spawnSync([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=pinned-tls.invalid",
      "-addext",
      "subjectAltName=DNS:pinned-tls.invalid",
    ])
    if (gen.exitCode !== 0) throw new Error(`openssl failed: ${gen.stderr.toString()}`)
    ca = readFileSync(join(dir, "cert.pem"), "utf8")
    server = createHttpsServer(
      { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: ca },
      (req, res) => {
        res.end(`${req.headers.host}`)
      },
    )
    server.on("secureConnection", (socket: TLSSocket) => {
      sniSeen.push(socket.servername)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("no server port")
    port = address.port
  })

  afterAll(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("sends the original hostname as SNI and accepts its certificate", async () => {
    resolveWith({ "pinned-tls.invalid": { address: "127.0.0.1", family: 4 } })
    const res = await fetchWithPinnedHost(
      `https://pinned-tls.invalid:${port}/`,
      { tls: { ca } } as RequestInit,
      { allowPrivateHostsInTest: true },
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(`pinned-tls.invalid:${port}`)
    expect(sniSeen).toContain("pinned-tls.invalid")
  })

  it("rejects a certificate that does not name the original hostname", async () => {
    resolveWith({ "other-name.invalid": { address: "127.0.0.1", family: 4 } })
    await expect(
      fetchWithPinnedHost(`https://other-name.invalid:${port}/`, { tls: { ca } } as RequestInit, {
        allowPrivateHostsInTest: true,
      }),
    ).rejects.toThrow()
  })

  it("keeps chain verification on (an untrusted self-signed certificate is refused)", async () => {
    resolveWith({ "pinned-tls.invalid": { address: "127.0.0.1", family: 4 } })
    await expect(
      fetchWithPinnedHost(
        `https://pinned-tls.invalid:${port}/`,
        {},
        { allowPrivateHostsInTest: true },
      ),
    ).rejects.toThrow()
  })
})
