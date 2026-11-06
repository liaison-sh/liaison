// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server } from "bun"
import { Hono } from "hono"
import { WebSocketManager } from "~/infra/websocket"
import { markBootComplete, ReadinessTestAccess } from "~/lib/readiness"
import { redis } from "~/lib/redis"
import { beginShutdown, ShutdownTestAccess } from "~/lib/shutdown"
import { readyzRoutes } from "~/modules/healthz/readyz"
import {
  createServer,
  maintenanceFlagActive,
  maintenanceHtml,
  readMaintenanceTargetVersion,
  readWebBuildId,
  serveSpaFallback,
  serveStaticAsset,
  WEB_BUILD_HEADER,
  type WsData,
  withWebBuildHeader,
} from "./server"

describe("server static asset + SPA fallback", () => {
  let publicDir: string

  beforeAll(() => {
    publicDir = mkdtempSync(join(tmpdir(), "liaison-public-"))
    writeFileSync(join(publicDir, "index.html"), "<!doctype html><html><body>SPA</body></html>")
    writeFileSync(join(publicDir, "app.js"), "console.log('app')")
  })

  afterAll(() => {
    rmSync(publicDir, { recursive: true, force: true })
  })

  it("serves a static asset directly", async () => {
    const r = await serveStaticAsset(publicDir, "/app.js")
    expect(r).toBeDefined()
    expect(r?.status).toBe(200)
    expect(await r?.text()).toContain("console.log")
  })

  it("returns undefined for an unknown path so the caller can fall back", async () => {
    const r = await serveStaticAsset(publicDir, "/spa/route/that/does/not/exist")
    expect(r).toBeUndefined()
  })

  it("serves index.html for SPA routing fallback", async () => {
    const r = await serveSpaFallback(publicDir)
    expect(r).toBeDefined()
    expect(r?.status).toBe(200)
    expect(r?.headers.get("content-type")).toMatch(/text\/html/)
    expect(await r?.text()).toContain("<html")
  })

  it("treats a malformed percent-escape as a miss instead of throwing", async () => {
    // Scanner paths like this reached decodeURIComponent unguarded: the URIError
    // escaped the Bun fetch handler as a 500 plus a raw "URIError: URI error" line.
    const r = await serveStaticAsset(publicDir, "/%E0%A4%A")
    expect(r).toBeUndefined()
  })

  it("rejects path traversal outside publicDir", async () => {
    const r = await serveStaticAsset(publicDir, "/../etc/passwd")
    expect(r).toBeUndefined()
  })

  it("returns undefined when publicDir has no index.html", async () => {
    const empty = mkdtempSync(join(tmpdir(), "liaison-public-empty-"))
    try {
      const r = await serveSpaFallback(empty)
      expect(r).toBeUndefined()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe("static cache headers", () => {
  // A deploy must reach open browsers: index.html revalidates on every load
  // (no-cache + ETag, 304 when unchanged), hashed assets are immutable for a
  // year, and other static files only live an hour.
  let publicDir: string

  beforeAll(() => {
    publicDir = mkdtempSync(join(tmpdir(), "liaison-public-cache-"))
    writeFileSync(join(publicDir, "index.html"), "<!doctype html><html><body>v1</body></html>")
    writeFileSync(join(publicDir, "favicon.svg"), "<svg/>")
    writeFileSync(join(publicDir, "build-id.txt"), "build-123\n")
    mkdirSync(join(publicDir, "assets"))
    writeFileSync(join(publicDir, "assets", "index-AbC123.js"), "console.log(1)")
  })

  afterAll(() => {
    rmSync(publicDir, { recursive: true, force: true })
  })

  it("index via SPA fallback: no-cache with a strong ETag", async () => {
    const r = await serveSpaFallback(publicDir)
    expect(r?.headers.get("cache-control")).toBe("no-cache")
    expect(r?.headers.get("etag")).toMatch(/^"[A-Za-z0-9_-]{16,}"$/)
  })

  it("/ and /index.html are served like the fallback (no-cache + same ETag)", async () => {
    const fallback = await serveSpaFallback(publicDir)
    const direct = await serveStaticAsset(publicDir, "/index.html")
    expect(direct?.headers.get("cache-control")).toBe("no-cache")
    expect(direct?.headers.get("etag")).toBe(fallback?.headers.get("etag") ?? "missing")
    expect(direct?.headers.get("content-type")).toMatch(/text\/html/)
    expect(await direct?.text()).toContain("v1")
  })

  it("answers 304 with no body when If-None-Match matches the index ETag", async () => {
    const first = await serveSpaFallback(publicDir)
    const etag = first?.headers.get("etag") ?? ""
    const r = await serveSpaFallback(publicDir, new Headers({ "if-none-match": etag }))
    expect(r?.status).toBe(304)
    expect(r?.headers.get("etag")).toBe(etag)
    expect(r?.headers.get("cache-control")).toBe("no-cache")
    expect(await r?.text()).toBe("")
    const weakList = await serveSpaFallback(
      publicDir,
      new Headers({ "if-none-match": `"other", W/${etag}` }),
    )
    expect(weakList?.status).toBe(304)
    const viaPath = await serveStaticAsset(
      publicDir,
      "/index.html",
      new Headers({ "if-none-match": etag }),
    )
    expect(viaPath?.status).toBe(304)
  })

  it("answers 200 when If-None-Match names another version", async () => {
    const r = await serveSpaFallback(publicDir, new Headers({ "if-none-match": '"stale"' }))
    expect(r?.status).toBe(200)
  })

  it("hashed files under /assets/ are immutable for a year", async () => {
    const r = await serveStaticAsset(publicDir, "/assets/index-AbC123.js")
    expect(r?.status).toBe(200)
    expect(r?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  })

  it("other static files get a one-hour max-age", async () => {
    const r = await serveStaticAsset(publicDir, "/favicon.svg")
    expect(r?.headers.get("cache-control")).toBe("public, max-age=3600")
  })

  it("build-id.txt is never cached (it is what a tab polls to notice a deploy)", async () => {
    const r = await serveStaticAsset(publicDir, "/build-id.txt")
    expect(r?.headers.get("cache-control")).toBe("no-store")
  })

  it("readWebBuildId reads the bundled build id once, trimmed; null when absent", async () => {
    expect(readWebBuildId(publicDir)).toBe("build-123")
    const empty = mkdtempSync(join(tmpdir(), "liaison-public-nobuild-"))
    try {
      expect(readWebBuildId(empty)).toBeNull()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it("withWebBuildHeader stamps API responses with the build id", async () => {
    const r = withWebBuildHeader(new Response("{}"), "build-123")
    expect(r.headers.get(WEB_BUILD_HEADER)).toBe("build-123")
    expect(WEB_BUILD_HEADER).toBe("X-Liaison-Web-Build")
    const none = withWebBuildHeader(new Response("{}"), null)
    expect(none.headers.get(WEB_BUILD_HEADER)).toBeNull()
  })
})

describe("server maintenance gate (runs before static SPA)", () => {
  // The Bun fetch handler in createServer() checks these before static asset
  // serving so SPA routes return 503 during an upgrade instead of the stale
  // bundled web app. Spec V9 + the maintenance-mount fix (review issue 16)
  // depend on this short-circuit happening before serveStaticAsset.
  const dirs: string[] = []

  afterAll(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    delete process.env.MAINTENANCE_FLAG_PATH
    delete process.env.MAINTENANCE_VERSION_PATH
  })

  it("maintenanceFlagActive reads MAINTENANCE_FLAG_PATH", () => {
    const d = mkdtempSync(join(tmpdir(), "liaison-srv-maint-"))
    dirs.push(d)
    const flag = join(d, "maintenance")
    process.env.MAINTENANCE_FLAG_PATH = flag
    expect(maintenanceFlagActive()).toBe(false)
    writeFileSync(flag, "")
    expect(maintenanceFlagActive()).toBe(true)
  })

  it("readMaintenanceTargetVersion reads MAINTENANCE_VERSION_PATH", () => {
    const d = mkdtempSync(join(tmpdir(), "liaison-srv-ver-"))
    dirs.push(d)
    const versionPath = join(d, "maintenance-version")
    process.env.MAINTENANCE_VERSION_PATH = versionPath
    expect(readMaintenanceTargetVersion()).toBeUndefined()
    writeFileSync(versionPath, "v0.1.1\n")
    expect(readMaintenanceTargetVersion()).toBe("v0.1.1")
  })

  it("maintenanceHtml renders the upgrade page with target version", () => {
    const html = maintenanceHtml("v0.1.1")
    expect(html).toContain("Liaison is upgrading")
    expect(html).toContain("v0.1.1")
  })
})

describe("web shell security headers and path containment", () => {
  let base: string
  let publicDir: string
  let sibling: string
  const themeScript = "document.documentElement.setAttribute('data-theme','dark')"

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "liaison-shell-"))
    publicDir = join(base, "public")
    sibling = join(base, "public-x")
    mkdirSync(publicDir)
    mkdirSync(sibling)
    writeFileSync(
      join(publicDir, "index.html"),
      `<!doctype html><html><head><script>${themeScript}</script><script type="module" src="/a.js"></script></head><body></body></html>`,
    )
    writeFileSync(join(publicDir, "app.js"), "console.log('app')")
    writeFileSync(join(sibling, "secret.txt"), "secret")
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it("stamps the SPA shell with framing, sniffing, referrer and permissions headers", async () => {
    const r = await serveSpaFallback(publicDir)
    expect(r?.headers.get("x-frame-options")).toBe("DENY")
    expect(r?.headers.get("x-content-type-options")).toBe("nosniff")
    expect(r?.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin")
    expect(r?.headers.get("permissions-policy")).toContain("camera=()")
    expect(r?.headers.get("strict-transport-security")).toContain("max-age=")
  })

  it("sends a CSP that forbids framing by another origin and pins the shell's inline script by hash only", async () => {
    const r = await serveSpaFallback(publicDir)
    const csp = r?.headers.get("content-security-policy") ?? ""
    expect(csp).toContain("frame-ancestors 'self'")
    expect(csp).toContain("object-src 'none'")
    const hash = createHash("sha256").update(themeScript).digest("base64")
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src")) ?? ""
    expect(scriptSrc).toContain(`'sha256-${hash}'`)
    expect(scriptSrc).not.toContain("unsafe-inline")
    expect(scriptSrc.split(" ")).not.toContain("'unsafe-eval'")
    // A legacy mailbox password row opens through a WebAssembly Argon2id: compiling it is allowed, JS eval is not.
    expect(scriptSrc.split(" ")).toContain("'wasm-unsafe-eval'")
  })

  it("keeps the headers on a 304 and on index.html requested by name", async () => {
    const first = await serveSpaFallback(publicDir)
    const etag = first?.headers.get("etag") ?? ""
    const notModified = await serveSpaFallback(publicDir, new Headers({ "if-none-match": etag }))
    expect(notModified?.status).toBe(304)
    expect(notModified?.headers.get("x-frame-options")).toBe("DENY")
    const byName = await serveStaticAsset(publicDir, "/index.html")
    expect(byName?.headers.get("content-security-policy")).toContain("frame-ancestors 'self'")
  })

  it("gives static assets nosniff and DENY, without a document CSP", async () => {
    const r = await serveStaticAsset(publicDir, "/app.js")
    expect(r?.headers.get("x-content-type-options")).toBe("nosniff")
    expect(r?.headers.get("x-frame-options")).toBe("DENY")
    expect(r?.headers.get("content-security-policy")).toBeNull()
  })

  it("does not serve a sibling directory whose name starts with the root's", async () => {
    const r = await serveStaticAsset(publicDir, "/../public-x/secret.txt")
    expect(r).toBeUndefined()
  })
})

describe("HEAD answers like GET (uptime monitors probe with HEAD)", () => {
  const app = new Hono().get("/healthz", (c) => c.json({ status: "ok" }))
  let server: Server<WsData>
  let base: string
  let publicDir: string

  beforeAll(async () => {
    publicDir = mkdtempSync(join(tmpdir(), "liaison-public-head-"))
    writeFileSync(join(publicDir, "index.html"), "<!doctype html><html><body>SPA</body></html>")
    writeFileSync(join(publicDir, "app.js"), "console.log('app')")
    server = await createServer(app, {
      port: 0,
      publicDir,
      wsManager: new WebSocketManager(redis),
    })
    base = `http://127.0.0.1:${server.port}`
  })

  afterAll(() => {
    server.stop(true)
    ShutdownTestAccess.reset()
    rmSync(publicDir, { recursive: true, force: true })
  })

  for (const path of ["/", "/settings/profile", "/app.js", "/healthz"]) {
    it(`HEAD ${path}: GET's status and headers, no body`, async () => {
      const get = await fetch(`${base}${path}`)
      const getBody = await get.text()
      const head = await fetch(`${base}${path}`, { method: "HEAD" })
      expect(get.status).toBe(200)
      expect(head.status).toBe(200)
      expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"))
      expect(head.headers.get("cache-control")).toBe(get.headers.get("cache-control"))
      // Static files keep their length; an API route goes through Hono, whose
      // HEAD answer carries no length.
      if (path !== "/healthz") {
        expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(getBody)))
      }
      expect(await head.text()).toBe("")
    })
  }
})

describe("health-only server (a worker process)", () => {
  // The full app is handed in on purpose: the server, not the app, must refuse
  // every path but the two probes.
  const fullApp = new Hono()
    .get("/healthz", (c) => c.json({ status: "ok" }))
    .route("/readyz", readyzRoutes)
    .get("/api/users/me", (c) => c.json({ id: "u" }))
    .get("/", (c) => c.text("spa"))
  let server: Awaited<ReturnType<typeof createServer>>
  let base: string

  beforeAll(async () => {
    server = await createServer(fullApp, { healthOnly: true, port: 0, logPrefix: "Health" })
    base = `http://127.0.0.1:${server.port}`
  })

  afterAll(() => {
    server.stop(true)
    ShutdownTestAccess.reset()
    ReadinessTestAccess.reset()
  })

  it("answers /healthz and /readyz and 404s the rest", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
    expect((await fetch(`${base}/readyz`)).status).toBe(503)
    markBootComplete()
    expect((await fetch(`${base}/readyz`)).status).toBe(200)
    expect((await fetch(`${base}/api/users/me`)).status).toBe(404)
    expect((await fetch(`${base}/ws`)).status).toBe(404)
    expect((await fetch(`${base}/`)).status).toBe(404)
  })
})

/** What a fresh TCP connection to the port gets: "connected" or the error code. */
function connectionRefused(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port })
    socket.once("connect", () => {
      socket.destroy()
      resolve("connected")
    })
    socket.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? "error"))
  })
}

describe("drain", () => {
  // A slow route stands for any in-flight request when the SIGTERM lands.
  const app = new Hono()
    .route("/readyz", readyzRoutes)
    .get("/slow", async (c) => {
      await Bun.sleep(4_000)
      return c.text("done")
    })
    .get("/fast", (c) => c.text("fast"))
  let server: Server<WsData>
  let base: string
  let port: number
  const exits: number[] = []

  beforeAll(async () => {
    ShutdownTestAccess.reset()
    ShutdownTestAccess.configure({ exit: (code) => exits.push(code), edgeGraceMs: 2_500 })
    server = await createServer(app, { port: 0, wsManager: new WebSocketManager(redis) })
    port = server.port ?? 0
    base = `http://127.0.0.1:${port}`
    markBootComplete()
  })

  afterAll(() => {
    server.stop(true)
    ShutdownTestAccess.reset()
    ReadinessTestAccess.reset()
  })

  it("readiness goes 503 at once, in-flight requests finish, the listener closes, responses say close", async () => {
    expect((await fetch(`${base}/readyz`)).status).toBe(200)
    const slow = fetch(`${base}/slow`)
    await Bun.sleep(100)
    const t0 = Date.now()
    const done = beginShutdown("test")

    // (a) /readyz answers 503 within 50 ms of t0.
    const ready = await fetch(`${base}/readyz`, { headers: { connection: "close" } })
    expect(ready.status).toBe(503)
    expect(Date.now() - t0).toBeLessThan(50)
    // (d) a response written after t0 carries Connection: close.
    expect(ready.headers.get("connection")).toBe("close")
    const fast = await fetch(`${base}/fast`)
    expect(fast.headers.get("connection")).toBe("close")

    // (b) the request started before t0 completes 200 after t0 + 3 s.
    const res = await slow
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("done")
    expect(Date.now() - t0).toBeGreaterThan(3_000)

    // (c) a new TCP connection after t0 + 3 s is refused.
    expect(await connectionRefused(port)).toBe("ECONNREFUSED")

    await done
    expect(exits).toEqual([0])
  }, 15_000)
})
