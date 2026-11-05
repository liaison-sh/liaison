// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { NavPage, NavSection } from "../../docs/nav"
import { buildDocs, DocsBuildError } from "./build"

const LANDING: NavPage = { id: "index", url: "" }

const NAV: NavSection[] = [
  {
    title: "Guides",
    pages: [
      { id: "guides/one", url: "guides/one" },
      { id: "guides/two", url: "guides/two" },
    ],
  },
  {
    title: "Developers",
    pages: [{ id: "dev-guide", url: "developers/dev" }],
  },
]

const FILES: Record<string, string> = {
  "index.md": `---
title: Fixture docs
description: The fixture landing page.
---

Welcome to the fixture.
`,
  "guides/one.md": `---
title: Do the first thing
description: How to do the first thing.
---

Start with [the second page](two.md) and the [dev guide](../dev-guide.md#set-it-up).
Also [external](https://example.com).

## First step

Body of the first page, marker ONE-BODY.

### A detail

| a | b |
|---|---|
| 1 | 2 |

\`\`\`sh
echo hi
\`\`\`
`,
  "guides/two.md": `---
title: Do the second thing
description: How to do the second thing.
---

Marker TWO-BODY. Back to [one](one.md#first-step).
`,
  "dev-guide.md": `# Dev guide

This is the developer guide paragraph that becomes the description.

## Set it up

Marker DEV-BODY.
`,
}

let roots: string[] = []

function fixture(overrides: Record<string, string> = {}): { docsDir: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), "docs-build-test-"))
  roots.push(root)
  const docsDir = join(root, "docs")
  for (const [path, body] of Object.entries({ ...FILES, ...overrides })) {
    const file = join(docsDir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
  return { docsDir, out: join(root, "out") }
}

const read = (out: string, path: string) => readFileSync(join(out, path), "utf8")

afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
})

describe("docs build", () => {
  it("renders a page at its URL with canonical, meta and JSON-LD", async () => {
    const { docsDir, out } = fixture()
    await buildDocs({ docsDir, out, nav: { landing: LANDING, sections: NAV } })
    const html = read(out, "docs/guides/one/index.html")
    expect(html).toContain("<title>Do the first thing · Liaison docs</title>")
    expect(html).toContain('<link rel="canonical" href="https://liaison.sh/docs/guides/one/">')
    expect(html).toContain('<meta name="description" content="How to do the first thing.">')
    const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
      (m) => JSON.parse(m[1] ?? "") as { "@type": string; itemListElement?: unknown[] },
    )
    expect(ld.map((x) => x["@type"]).sort()).toEqual(["BreadcrumbList", "TechArticle"])
    expect(ld.find((x) => x["@type"] === "BreadcrumbList")?.itemListElement).toHaveLength(3)
    // links rewritten to the target page URLs, fragment kept, relative
    expect(html).toContain('href="../two/"')
    expect(html).toContain('href="../../developers/dev/#set-it-up"')
    expect(html).toContain('href="https://example.com" rel="noopener"')
    // heading ids and the folded contents list
    expect(html).toContain('id="first-step"')
    expect(html).toMatch(
      /<details class="toc-inline">[\s\S]*href="#first-step"[\s\S]*href="#a-detail"/,
    )
    expect(html).toContain('<div class="tbl"><table>')
    expect(html).toContain('class="copy"')
    expect(html).toContain("https://github.com/mathieufro/liaison/edit/main/docs/guides/one.md")
    expect(read(out, "docs/index.html")).toContain("Welcome to the fixture.")
  })

  it("fails on a link to an .md that is not in the nav, naming file and link", async () => {
    const { docsDir, out } = fixture({
      "guides/two.md":
        "---\ntitle: Two\ndescription: d\n---\n\nSee [gone](../nope.md) and [also](one.md).\n",
    })
    const err = await buildDocs({ docsDir, out, nav: { landing: LANDING, sections: NAV } }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(DocsBuildError)
    const broken = (err as DocsBuildError).broken
    expect(broken).toEqual([{ file: "guides/two.md", link: "../nope.md" }])
    expect((err as Error).message).toContain("guides/two.md: ../nope.md")
  })

  it("fails on a missing #fragment on a known page", async () => {
    const { docsDir, out } = fixture({
      "guides/two.md":
        "---\ntitle: Two\ndescription: d\n---\n\nSee [one](one.md#no-such-heading).\n",
    })
    const err = await buildDocs({ docsDir, out, nav: { landing: LANDING, sections: NAV } }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(DocsBuildError)
    expect((err as DocsBuildError).broken).toEqual([
      { file: "guides/two.md", link: "one.md#no-such-heading" },
    ])
  })

  it("fails when a nav page has no file, unless allowMissing renders a stub", async () => {
    const nav = [...NAV, { title: "Extra", pages: [{ id: "extra/missing", url: "extra/missing" }] }]
    const { docsDir, out } = fixture()
    const err = await buildDocs({ docsDir, out, nav: { landing: LANDING, sections: nav } }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(DocsBuildError)
    expect((err as Error).message).toContain("extra/missing.md")
    await buildDocs({ docsDir, out, nav: { landing: LANDING, sections: nav }, allowMissing: true })
    expect(read(out, "docs/extra/missing/index.html")).toContain("Coming soon")
  })

  it("lists every nav page in the sitemap", async () => {
    const { docsDir, out } = fixture()
    await buildDocs({ docsDir, out, nav: { landing: LANDING, sections: NAV } })
    const xml = read(out, "docs/sitemap.xml")
    for (const url of ["", "guides/one/", "guides/two/", "developers/dev/"]) {
      expect(xml).toContain(`<loc>https://liaison.sh/docs/${url}</loc>`)
    }
  })

  it("writes llms.txt by section and llms-full.txt with every page body", async () => {
    const { docsDir, out } = fixture()
    await buildDocs({ docsDir, out, nav: { landing: LANDING, sections: NAV } })
    const llms = read(out, "llms.txt")
    expect(llms.startsWith("# Liaison\n\n> ")).toBe(true)
    expect(llms).toContain(
      "## Guides\n\n- [Do the first thing](https://liaison.sh/docs/guides/one/): How to do the first thing.",
    )
    expect(llms).toContain(
      "## Developers\n\n- [Dev guide](https://liaison.sh/docs/developers/dev/)",
    )
    const full = read(out, "llms-full.txt")
    for (const marker of ["ONE-BODY", "TWO-BODY", "DEV-BODY"]) expect(full).toContain(marker)
    expect(full).toContain("# Do the second thing\n\nSource: https://liaison.sh/docs/guides/two/")
    expect(full.indexOf("ONE-BODY")).toBeLessThan(full.indexOf("TWO-BODY"))
    expect(full.indexOf("TWO-BODY")).toBeLessThan(full.indexOf("DEV-BODY"))
  })

  it("links previous and next in nav order", async () => {
    const { docsDir, out } = fixture()
    await buildDocs({ docsDir, out, nav: { landing: LANDING, sections: NAV } })
    const two = read(out, "docs/guides/two/index.html")
    expect(two).toMatch(
      /<a rel="prev" href="\.\.\/one\/"><small>Previous<\/small>Do the first thing<\/a>/,
    )
    expect(two).toMatch(
      /<a rel="next" href="\.\.\/\.\.\/developers\/dev\/"><small>Next<\/small>Dev guide<\/a>/,
    )
    const last = read(out, "docs/developers/dev/index.html")
    expect(last).not.toContain('rel="next"')
  })

  it("falls back to the first # heading and paragraph without frontmatter", async () => {
    const { docsDir, out } = fixture()
    await buildDocs({ docsDir, out, nav: { landing: LANDING, sections: NAV } })
    const html = read(out, "docs/developers/dev/index.html")
    expect(html).toContain("<title>Dev guide · Liaison docs</title>")
    expect(html).toContain(
      '<meta name="description" content="This is the developer guide paragraph that becomes the description.">',
    )
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1)
    const index = JSON.parse(read(out, "docs/search-index.json")) as { title: string }[]
    expect(index.map((p) => p.title)).toContain("Dev guide")
  })
})
