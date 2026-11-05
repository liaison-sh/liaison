// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { inlineServedContentType, servedContentType } from "~/modules/files/served-content-type"

describe("servedContentType", () => {
  it("serves script, markup and stylesheet types as opaque bytes", () => {
    for (const t of [
      "application/javascript",
      "text/javascript; charset=utf-8",
      "application/x-javascript",
      "text/ecmascript",
      "module",
      "text/html",
      "TEXT/HTML; charset=utf-8",
      "application/xhtml+xml",
      "image/svg+xml",
      "text/xml",
      "application/xml",
      "application/vnd.mozilla.xul+xml",
      "text/css",
      "",
    ]) {
      expect(servedContentType(t)).toBe("application/octet-stream")
    }
  })

  it("keeps inert types as declared", () => {
    for (const t of [
      "image/png",
      "image/webp",
      "audio/mpeg",
      "video/mp4",
      "application/pdf",
      "text/plain; charset=utf-8",
      "text/csv",
      "application/json",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
    ]) {
      expect(servedContentType(t)).toBe(t)
    }
  })
})

describe("inlineServedContentType", () => {
  it("keeps an SVG's own type on /inline, which answers with CSP sandbox and as an attachment", () => {
    expect(inlineServedContentType("image/svg+xml")).toBe("image/svg+xml")
    expect(inlineServedContentType("image/svg+xml; charset=utf-8")).toBe(
      "image/svg+xml; charset=utf-8",
    )
  })

  it("serves every other active type as opaque bytes there too", () => {
    for (const t of ["text/html", "application/javascript", "text/xml", "text/css"]) {
      expect(inlineServedContentType(t)).toBe("application/octet-stream")
    }
    expect(inlineServedContentType("image/png")).toBe("image/png")
  })
})
