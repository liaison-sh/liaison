// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HelpDocsIndex, HelpDocsPage } from "../../packages/shared/src/help-docs"
import { rewriteLinks, writeAppBundle } from "./build-app-bundle"

describe("rewriteLinks", () => {
  it("points page links at the Help tab and images at the bundle", () => {
    const html =
      '<a href="../../agents/approvals/#gated">a</a><a href="../">up</a><img src="../../assets/x.png"><a href="#here">h</a><a href="https://github.com/x" rel="noopener">g</a>'
    expect(rewriteLinks(html, "apps/mail")).toBe(
      '<a href="/help/agents/approvals#gated">a</a><a href="/help/apps">up</a><img src="/help-docs/assets/x.png"><a href="#here">h</a><a href="https://github.com/x" rel="noopener">g</a>',
    )
    expect(rewriteLinks('<a href="./">home</a>', "")).toBe('<a href="/help">home</a>')
  })
})

describe("writeAppBundle", () => {
  const out = mkdtempSync(join(tmpdir(), "help-docs-"))
  afterAll(() => rmSync(out, { recursive: true, force: true }))

  it("writes the index and one file per page from the real docs", () => {
    const n = writeAppBundle(join(import.meta.dir, "../../docs"), out)
    const index = JSON.parse(readFileSync(join(out, "index.json"), "utf8")) as HelpDocsIndex
    expect(index.entries).toHaveLength(n)
    expect(index.sections.length).toBeGreaterThan(0)
    const mail = JSON.parse(readFileSync(join(out, "pages/apps/mail.json"), "utf8")) as HelpDocsPage
    expect(mail.title).toBe("Mail")
    expect(mail.html).not.toMatch(/href="\.\.?\//)
    const landing = JSON.parse(readFileSync(join(out, "pages/index.json"), "utf8")) as HelpDocsPage
    expect(landing.url).toBe("")
  })
})
