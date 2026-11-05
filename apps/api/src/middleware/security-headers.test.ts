// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { Hono } from "hono"
import { env } from "~/lib/env"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import {
  contentSecurityPolicy,
  inlineScriptHashes,
  securityHeaders,
  TURNSTILE_ORIGIN,
  webShellHeaders,
} from "./security-headers"

describe("securityHeaders middleware", () => {
  const app = new Hono()
  app.use("*", securityHeaders())
  app.get("/test", (c) => c.text("ok"))

  it("sets X-Content-Type-Options", async () => {
    const res = await app.request("/test")
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
  })

  it("sets X-Frame-Options", async () => {
    const res = await app.request("/test")
    expect(res.headers.get("X-Frame-Options")).toBe("DENY")
  })

  it("sets Referrer-Policy", async () => {
    const res = await app.request("/test")
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin")
  })

  it("sets Permissions-Policy: microphone for the app origin only (dictation), camera and geolocation off", async () => {
    const res = await app.request("/test")
    expect(res.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(self), geolocation=()",
    )
  })

  it("gives the web shell the same Permissions-Policy, so the SPA document may record", () => {
    // lib/server.ts answers the SPA document itself, before Hono: the
    // document's own header is the one getUserMedia is judged against.
    for (const html of ["<html></html>", null]) {
      expect(webShellHeaders({ html })["Permissions-Policy"]).toBe(
        "camera=(), microphone=(self), geolocation=()",
      )
    }
  })

  it("sets Content-Security-Policy", async () => {
    const res = await app.request("/test")
    const csp = res.headers.get("Content-Security-Policy")
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it("allows the mailbox crypto worker to boot from a blob url", async () => {
    // The mailbox crypto worker is fetched, hashed against the hash baked into
    // the page, and booted from a blob URL only on a match (no browser can
    // SRI-pin a worker). Without an explicit worker-src that blob boot falls
    // back to default-src 'self' and the browser blocks it, which leaves the
    // mailbox unopenable for every user.
    const res = await app.request("/test")
    const csp = res.headers.get("Content-Security-Policy")
    expect(csp).toContain("worker-src 'self' blob:")
  })

  it("applies to error responses too", async () => {
    const errApp = new Hono()
    errApp.use("*", securityHeaders())
    errApp.get("/fail", () => {
      throw new Error("boom")
    })
    const res = await errApp.request("/fail")
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
  })

  // A route that answers with its own, stricter policy keeps it. The default
  // used to overwrite it: a served upload lost its `sandbox`, and a page that
  // allows one hashed stylesheet was handed `style-src 'unsafe-inline'`.
  it("keeps a route's own Content-Security-Policy and Referrer-Policy", async () => {
    const own = new Hono()
    own.use("*", securityHeaders())
    own.get(
      "/strict",
      () =>
        new Response("x", {
          headers: {
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Referrer-Policy": "no-referrer",
          },
        }),
    )
    const res = await own.request("/strict")
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox")
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer")
    expect(res.headers.get("X-Frame-Options")).toBe("DENY")
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
  })

  it("keeps a route's own framing rule (the app frame document is framed by this origin)", async () => {
    const own = new Hono()
    own.use("*", securityHeaders())
    own.get(
      "/frame",
      () =>
        new Response("x", {
          headers: {
            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'",
            "X-Frame-Options": "SAMEORIGIN",
          },
        }),
    )
    const res = await own.request("/frame")
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN")
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; frame-ancestors 'self'",
    )
  })
})

// The policy names the object store exactly when the delivery decision sends
// the browser there (infra/storage/delivery.ts), and never otherwise.
describe("securityHeaders: the object store in the policy", () => {
  async function cspWith(storageOrigin: string | null | undefined) {
    const app = new Hono()
    app.use("*", securityHeaders(storageOrigin === undefined ? {} : { storageOrigin }))
    app.get("/t", (c) => c.text("ok"))
    const res = await app.request("/t")
    return res.headers.get("Content-Security-Policy") ?? ""
  }
  const directive = (csp: string, name: string) =>
    csp.split("; ").find((d) => d.startsWith(`${name} `))

  it("adds the store origin to connect-src and img-src when direct", async () => {
    const origin = "https://bucket.s3.eu-west-1.amazonaws.com"
    const csp = await cspWith(origin)
    expect(directive(csp, "connect-src")).toBe(`connect-src 'self' wss: ${origin}`)
    expect(directive(csp, "img-src")).toBe(`img-src 'self' data: https: ${origin}`)
  })

  it("leaves the policy unchanged when relayed", async () => {
    const csp = await cspWith(null)
    expect(directive(csp, "connect-src")).toBe("connect-src 'self' wss:")
    expect(directive(csp, "img-src")).toBe("img-src 'self' data: https:")
  })

  it("follows the deployment's switch by default (off: relayed)", async () => {
    const csp = await cspWith(undefined)
    expect(directive(csp, "connect-src")).toBe("connect-src 'self' wss:")
  })
})

describe("Turnstile in the web shell's policy", () => {
  function withDemo<T>(demo: boolean, siteKey: string | undefined, run: () => T): T {
    const before = env.TURNSTILE_SITE_KEY
    env.TURNSTILE_SITE_KEY = siteKey
    DemoModeTestAccess.set(demo)
    try {
      return run()
    } finally {
      DemoModeTestAccess.set(null)
      env.TURNSTILE_SITE_KEY = before
    }
  }

  it("names Cloudflare in script-src and frame-src on a demo box with a site key", () => {
    const csp = withDemo(true, "1x00000000000000000000AA", () =>
      contentSecurityPolicy({ storageOrigin: null, scriptHashes: [] }),
    )
    expect(csp).toContain(`script-src 'self' 'wasm-unsafe-eval' ${TURNSTILE_ORIGIN}`)
    expect(csp).toContain(`frame-src 'self' ${TURNSTILE_ORIGIN}`)
  })

  it("names no third party anywhere else", () => {
    for (const [demo, key] of [
      [false, "1x00000000000000000000AA"],
      [true, undefined],
      [false, undefined],
    ] as const) {
      const csp = withDemo(demo, key, () =>
        contentSecurityPolicy({ storageOrigin: null, scriptHashes: [] }),
      )
      expect(csp).not.toContain("challenges.cloudflare.com")
      expect(csp).not.toContain("frame-src")
    }
  })

  it("never opens it on API responses, only the web shell", () => {
    const csp = withDemo(true, "1x00000000000000000000AA", () =>
      contentSecurityPolicy({ storageOrigin: null }),
    )
    expect(csp).not.toContain("challenges.cloudflare.com")
  })
})

describe("inlineScriptHashes", () => {
  const hash = (body: string) => `'sha256-${createHash("sha256").update(body).digest("base64")}'`

  it("hashes each inline script, whatever form its end tag takes, and skips src scripts", () => {
    const html =
      "<script>a()</script><script >b()</script ><SCRIPT>c()</SCRIPT\n><script src=x.js></script><script>d()</script foo>"
    expect(inlineScriptHashes(html)).toEqual([hash("a()"), hash("b()"), hash("c()"), hash("d()")])
  })

  it("does not end a script at a longer tag name", () => {
    expect(inlineScriptHashes("<script>x</scripts>y</script>")).toEqual([hash("x</scripts>y")])
  })
})
