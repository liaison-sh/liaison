// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The doors of the token page itself (`/a`, the web page a client opens from a
// mail): its document's headers, and how it renders what clients and senders
// typed. Each test is named by its door id and fails when its protection is
// removed.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { serveSpaFallback } from "~/lib/server"

const WEB_MODULE = resolve(import.meta.dir, "../../../../../web/src/modules/client-action")

/** Ways a page could turn a string into markup or script. */
const MARKUP_SINKS = [
  /\binnerHTML\b/,
  /\bouterHTML\b/,
  /\binsertAdjacentHTML\b/,
  /\bDOMParser\b/,
  /\bdocument\.write\b/,
  /\bcreateContextualFragment\b/,
  /\bsrcdoc\b/,
  /\beval\s*\(/,
  /\bnew Function\b/,
  /href=\{(?!url)/,
]

describe("token page doors", () => {
  let publicDir: string
  beforeAll(() => {
    publicDir = mkdtempSync(join(tmpdir(), "liaison-token-page-"))
    writeFileSync(join(publicDir, "index.html"), "<!doctype html><html><body>SPA</body></html>")
  })
  afterAll(() => rmSync(publicDir, { recursive: true, force: true }))

  it("NT-49: the /a page answers with no referrer, no index and no framing, and a member page keeps its own rules", async () => {
    const page = await serveSpaFallback(publicDir, undefined, "/a")
    expect(page?.status).toBe(200)
    expect(page?.headers.get("referrer-policy")).toBe("no-referrer")
    expect(page?.headers.get("x-robots-tag")).toContain("noindex")
    expect(page?.headers.get("x-frame-options")).toBe("DENY")
    expect(page?.headers.get("content-security-policy") ?? "").toContain("frame-ancestors 'none'")
    // A path that only starts with the letter is not the token page.
    const member = await serveSpaFallback(publicDir, undefined, "/agents")
    expect(member?.headers.get("x-robots-tag")).toBeNull()
    expect(member?.headers.get("content-security-policy") ?? "").toContain("frame-ancestors 'self'")
  })

  it("NT-49: the /portal sign-in page and shell answer with no referrer, no index and no framing", async () => {
    for (const path of ["/portal", "/portal/x"]) {
      const page = await serveSpaFallback(publicDir, undefined, path)
      expect({ path, status: page?.status }).toEqual({ path, status: 200 })
      expect(page?.headers.get("referrer-policy")).toBe("no-referrer")
      expect(page?.headers.get("x-robots-tag")).toContain("noindex")
      expect(page?.headers.get("content-security-policy") ?? "").toContain("frame-ancestors 'none'")
    }
    // A path that only starts with the word is not the portal.
    const member = await serveSpaFallback(publicDir, undefined, "/portals")
    expect(member?.headers.get("x-robots-tag")).toBeNull()
  })

  it("NT-55: the token page renders typed names, capacities, reasons, subjects, filenames and request texts as text, never as markup", () => {
    const files = readdirSync(WEB_MODULE, { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    expect(files.length).toBeGreaterThan(0)
    const hits: string[] = []
    for (const f of files) {
      const text = readFileSync(join(WEB_MODULE, f), "utf8")
      for (const re of MARKUP_SINKS) if (re.test(text)) hits.push(`${f}: ${re.source}`)
    }
    expect(hits).toEqual([])
  })
})
