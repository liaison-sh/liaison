// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The doors of the client portal's web pages and of the staff section that
// previews them (the company page's client portal section): how they render what
// clients typed. Each test is named by its door id and fails when its protection
// is removed.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const WEB_SRC = resolve(import.meta.dir, "../../../../../web/src")
const PORTAL = join(WEB_SRC, "modules/portal")
const STAFF_SECTION = join(WEB_SRC, "modules/contacts/CompanyPortalSection.tsx")

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
  /href=\{/,
]

function sources(): string[] {
  const files = readdirSync(PORTAL, { recursive: true })
    .map(String)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => join(PORTAL, f))
  return [...files, STAFF_SECTION]
}

describe("client portal web doors", () => {
  it("NT-55: the portal screens and the staff preview render typed names, capacities, reasons, subjects, filenames and request texts as text, never as markup", () => {
    const files = sources()
    expect(files.length).toBeGreaterThan(5)
    const hits: string[] = []
    for (const f of files) {
      const text = readFileSync(f, "utf8")
      for (const re of MARKUP_SINKS)
        if (re.test(text)) hits.push(`${f.slice(WEB_SRC.length)}: ${re.source}`)
    }
    expect(hits).toEqual([])
  })
})
