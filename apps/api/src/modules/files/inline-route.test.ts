// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Route-level tests for the GET /:id/inline endpoint.
 *
 * Tests verify the security-critical response properties:
 *   - X-Content-Type-Options: nosniff on every response (no MIME sniffing)
 *   - Content-Security-Policy: restrictive, includes `sandbox`
 *   - SVG files served as `attachment` (SVG can carry inline scripts)
 *   - Regular images served as `inline`
 *   - 404 when the file is not visible (cross-org RLS denial scenario)
 *
 * The handler logic is extracted into a pure function so the test never
 * touches a real DB or object-storage bucket. This follows the pattern in
 * slots/routes.test.ts (standalone Hono harness with stubbed context).
 *
 * I-TEST-1 — the inline route previously had no route-level tests.
 */
import { describe, expect, it } from "bun:test"
import { Hono } from "hono"

type FileRow = {
  storage_key: string
  mime_type: string
  filename: string
  size_bytes: number
}

/**
 * The security-header and content-disposition logic extracted from routes.ts.
 * Isolated here so the test does not depend on DB / storage imports.
 *
 * Keep this copy in sync with:
 *   - `safeDispositionFilename` (strip control bytes, path separators, then
 *     replace `"`, `\`, `\r`, `\n` with `_`)
 *   - `contentDisposition` (RFC 5987 dual filename= / filename*= form)
 * in apps/api/src/modules/files/routes.ts.
 */
function safeDispositionFilename(name: string): string {
  // sanitizeFilename: strip control bytes (0x00-0x1f, 0x7f) and path separators.
  // The control bytes are the point: this mirrors the production sanitizer.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips 0x00-0x1f and 0x7f by design
  const sanitized = name.replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_")
  // Strip characters that could break out of a quoted Content-Disposition value.
  return sanitized.replace(/["\\\r\n]/g, "_")
}

function contentDisposition(disposition: "inline" | "attachment", rawName: string): string {
  // Pure-ASCII fallback — Bun rejects non-ISO-8859-1 header bytes (see routes.ts).
  const asciiName = safeDispositionFilename(rawName).replace(/[^\x20-\x7e]/g, "_")
  // RFC 5987 percent-encoding: encode every byte except unreserved chars.
  const encodedName = encodeURIComponent(rawName).replace(
    /['()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
}

function buildInlineHeaders(row: FileRow): { headers: Record<string, string>; isImage: boolean } {
  const mimeType = row.mime_type
  const lcMime = mimeType.toLowerCase()
  const isSvg = lcMime === "image/svg+xml" || lcMime.startsWith("image/svg+xml;")
  const isImage = lcMime.startsWith("image/") && !isSvg
  const headers: Record<string, string> = {
    "Content-Type": mimeType,
    "Cache-Control": "private, max-age=60",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    "Referrer-Policy": "no-referrer",
    "Content-Disposition": contentDisposition(isImage ? "inline" : "attachment", row.filename),
  }
  return { headers, isImage }
}

function makeApp(opts: { fileRow: FileRow | null; bytes?: Uint8Array }): Hono {
  const app = new Hono()

  app.on(["GET", "HEAD"], "/:id/inline", (c) => {
    const row = opts.fileRow
    if (!row) {
      return c.json({ error: { message: "Not found", code: "NOT_FOUND" } }, 404)
    }
    const { headers } = buildInlineHeaders(row)
    if (c.req.method === "HEAD") {
      headers["Content-Length"] = String(row.size_bytes)
      return new Response(null, { status: 200, headers })
    }
    const bytes = opts.bytes ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    headers["Content-Length"] = String(bytes.byteLength)
    return new Response(bytes, { status: 200, headers })
  })

  return app
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("inline route — security headers", () => {
  const pngRow: FileRow = {
    storage_key: "orgs/o/k/t/f/img.png",
    mime_type: "image/png",
    filename: "img.png",
    size_bytes: 4,
  }

  it("serves X-Content-Type-Options: nosniff on every response", async () => {
    const app = makeApp({ fileRow: pngRow })
    const res = await app.request("/00000000-0000-0000-0000-000000000001/inline")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  })

  it("includes a restrictive Content-Security-Policy with sandbox directive", async () => {
    const app = makeApp({ fileRow: pngRow })
    const res = await app.request("/00000000-0000-0000-0000-000000000001/inline")
    const csp = res.headers.get("content-security-policy") ?? ""
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("sandbox")
  })

  it("sets Content-Disposition: inline for regular images (PNG)", async () => {
    const app = makeApp({ fileRow: pngRow })
    const res = await app.request("/00000000-0000-0000-0000-000000000001/inline")
    expect(res.headers.get("content-disposition")).toMatch(/^inline/)
  })

  it("sets Content-Disposition: attachment for SVG — SVG can carry inline scripts", async () => {
    const svgRow: FileRow = {
      storage_key: "orgs/o/k/t/f/icon.svg",
      mime_type: "image/svg+xml",
      filename: "icon.svg",
      size_bytes: 100,
    }
    const app = makeApp({ fileRow: svgRow })
    const res = await app.request("/00000000-0000-0000-0000-000000000001/inline")
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/)
  })

  it("sets Content-Disposition: attachment for PDF (non-image type)", async () => {
    const pdfRow: FileRow = {
      storage_key: "orgs/o/k/t/f/doc.pdf",
      mime_type: "application/pdf",
      filename: "report.pdf",
      size_bytes: 1024,
    }
    const app = makeApp({ fileRow: pdfRow })
    const res = await app.request("/00000000-0000-0000-0000-000000000001/inline")
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/)
  })

  // Cross-org: when the file row is invisible to the caller (RLS denies), the
  // route returns 404. In production the RLS policy filters the row out; here
  // we simulate that by returning null from the query stub.
  it("returns 404 when the file is not visible to the caller (cross-org denial)", async () => {
    const app = makeApp({ fileRow: null })
    const res = await app.request("/00000000-0000-0000-0000-000000000001/inline")
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("NOT_FOUND")
  })

  it("responds with 200 and no body for HEAD requests", async () => {
    const app = makeApp({ fileRow: pngRow })
    const res = await app.request("/00000000-0000-0000-0000-000000000001/inline", {
      method: "HEAD",
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-length")).toBe("4")
    // HEAD responses have no body.
    const text = await res.text()
    expect(text).toBe("")
  })

  it("sets Referrer-Policy: no-referrer to prevent leaking the signed URL", async () => {
    const app = makeApp({ fileRow: pngRow })
    const res = await app.request("/00000000-0000-0000-0000-000000000001/inline")
    expect(res.headers.get("referrer-policy")).toBe("no-referrer")
  })
})

// ---------------------------------------------------------------------------
// Unit-level checks on the header-building helper
// ---------------------------------------------------------------------------

describe("buildInlineHeaders — content-disposition logic", () => {
  it("JPEG is treated as inline", () => {
    const { headers } = buildInlineHeaders({
      storage_key: "k",
      mime_type: "image/jpeg",
      filename: "photo.jpg",
      size_bytes: 1,
    })
    expect(headers["Content-Disposition"]).toMatch(/^inline/)
  })

  it("SVG is forced to attachment regardless of image/* prefix", () => {
    const { headers } = buildInlineHeaders({
      storage_key: "k",
      mime_type: "image/svg+xml",
      filename: "icon.svg",
      size_bytes: 1,
    })
    expect(headers["Content-Disposition"]).toMatch(/^attachment/)
  })

  it("SVG with charset param is also forced to attachment", () => {
    const { headers } = buildInlineHeaders({
      storage_key: "k",
      mime_type: "image/svg+xml; charset=utf-8",
      filename: "icon.svg",
      size_bytes: 1,
    })
    expect(headers["Content-Disposition"]).toMatch(/^attachment/)
  })

  it("application/octet-stream is attachment", () => {
    const { headers } = buildInlineHeaders({
      storage_key: "k",
      mime_type: "application/octet-stream",
      filename: "blob.bin",
      size_bytes: 1,
    })
    expect(headers["Content-Disposition"]).toMatch(/^attachment/)
  })

  it("filenames with double-quotes are escaped in the ASCII fallback form", () => {
    const { headers } = buildInlineHeaders({
      storage_key: "k",
      mime_type: "image/png",
      filename: 'say "hello".png',
      size_bytes: 1,
    })
    // The quoted filename= fallback must not contain an unescaped literal `"hello"`.
    expect(headers["Content-Disposition"]).not.toContain('"hello"')
  })

  it("emits RFC 5987 filename*=UTF-8'' form for ASCII filenames", () => {
    const { headers } = buildInlineHeaders({
      storage_key: "k",
      mime_type: "image/png",
      filename: "photo.png",
      size_bytes: 1,
    })
    const cd = headers["Content-Disposition"]
    // Must include both the ASCII fallback and the RFC 5987 encoded form.
    expect(cd).toContain('filename="photo.png"')
    expect(cd).toContain("filename*=UTF-8''photo.png")
  })

  it("emits RFC 5987 percent-encoded filename*= for non-ASCII filenames", () => {
    const { headers } = buildInlineHeaders({
      storage_key: "k",
      mime_type: "image/png",
      filename: "résumé.png",
      size_bytes: 1,
    })
    const cd = headers["Content-Disposition"]
    // The RFC 5987 param must be present and percent-encoded.
    expect(cd).toContain("filename*=UTF-8''")
    expect(cd).toContain("%C3%A9")
  })

  it("non-ASCII filenames produce a pure-ASCII quoted fallback and a constructible Response", () => {
    // Regression: Bun's Response throws on header values with non-ISO-8859-1
    // bytes, turning every inline request for e.g. "Capture d’écran ....png"
    // into a 500 and breaking image previews.
    const { headers } = buildInlineHeaders({
      storage_key: "k",
      mime_type: "image/png",
      filename: "Capture d’écran 2020-10-15 à 16.05.51.png",
      size_bytes: 1,
    })
    const cd = headers["Content-Disposition"]
    const quoted = /filename="([^"]*)"/.exec(cd)?.[1] ?? ""
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the ASCII range
    expect(quoted).toMatch(/^[\x20-\x7e]*$/)
    // Constructing a Response with these headers must not throw.
    expect(() => new Response(null, { status: 200, headers })).not.toThrow()
  })
})

describe("inline route — Cache-Control variant semantics (real helper)", () => {
  // Imported lazily so this file's DB-free tests above stay DB-free even if
  // routes.ts ever grows import-time side effects.
  it("long-caches immutable bytes when serving the requested variant", async () => {
    const { inlineCacheControl } = await import("./routes")
    // Original requested, original served — bytes for an id never change.
    expect(inlineCacheControl(false, false)).toBe("private, max-age=31536000, immutable")
    // Thumb requested, thumb served — the thumb object is also immutable.
    expect(inlineCacheControl(true, true)).toBe("private, max-age=31536000, immutable")
  })

  it("keeps a short TTL when a thumb request falls back to the original", async () => {
    const { inlineCacheControl } = await import("./routes")
    // variant=thumb requested but no thumbnail yet: the SAME URL will start
    // serving the thumb once generated, so the fallback must not be cached
    // long-term.
    expect(inlineCacheControl(true, false)).toBe("private, max-age=60")
  })
})
