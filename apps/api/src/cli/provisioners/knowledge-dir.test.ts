// SPDX-License-Identifier: FSL-1.1-ALv2
// Folder import for knowledge.documents[] (no database): which files a
// `{ dir }` entry reads, how each one's title and body are derived, and the
// path-safety rules.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigError } from "~/cli/config/parse"
import { validateConfig } from "~/cli/config/schema"
import {
  disambiguateTitles,
  expandKnowledgeDir,
  MAX_KNOWLEDGE_BODY_CHARS,
  parseKnowledgeFile,
} from "~/cli/provisioners/knowledge-dir"

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kb-dir-"))
  dirs.push(root)
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

describe("parseKnowledgeFile", () => {
  test("front matter title and source win; the front matter leaves the body", () => {
    const parsed = parseKnowledgeFile(
      "---\ntitle: Pricing\nsource: https://acme.example/pricing\n---\n# Other\n\nText\n",
    )
    expect(parsed).toEqual({
      title: "Pricing",
      source: "https://acme.example/pricing",
      body: "# Other\n\nText\n",
    })
  })

  test("without front matter, the first heading is the title", () => {
    expect(parseKnowledgeFile("intro\n\n## Getting started ##\nbody").title).toBe("Getting started")
  })

  test("no title at all, and malformed front matter is left in the body", () => {
    const parsed = parseKnowledgeFile("---\n: [oops\n---\nplain text")
    expect(parsed.title).toBeNull()
    expect(parsed.body).toContain("plain text")
  })
})

describe("expandKnowledgeDir", () => {
  test("reads text files only, skips dot files, node_modules and excludes, sorted", async () => {
    const root = tree({
      "kb/b.md": "# B\n\nbee",
      "kb/a/notes.txt": "plain notes",
      "kb/a/guide.mdx": "# Guide\n",
      "kb/image.png": "png",
      "kb/.hidden.md": "# Hidden",
      "kb/.git/HEAD.md": "# Git",
      "kb/node_modules/pkg/README.md": "# Vendored",
      "kb/CHANGELOG.md": "# Changelog",
    })
    const { documents, skipped } = await expandKnowledgeDir(root, {
      dir: "kb",
      collection: "C",
      exclude: ["CHANGELOG.md"],
    })
    expect(documents.map((d) => [d.path, d.title])).toEqual([
      ["kb/a/guide.mdx", "Guide"],
      ["kb/a/notes.txt", "notes"],
      ["kb/b.md", "B"],
    ])
    expect(skipped).toEqual([])
  })

  test("include globs narrow the match", async () => {
    const root = tree({ "kb/x.md": "# X", "kb/y.txt": "y" })
    const { documents } = await expandKnowledgeDir(root, {
      dir: "kb",
      collection: "C",
      include: ["**/*.txt"],
    })
    expect(documents.map((d) => d.path)).toEqual(["kb/y.txt"])
  })

  test("a source front matter value becomes a Source line; empty and oversized files are skipped", async () => {
    const root = tree({
      "kb/page.md": "---\nurl: https://acme.example/\n---\nHello\n",
      "kb/empty.md": "\n\n",
      "kb/huge.md": "x".repeat(MAX_KNOWLEDGE_BODY_CHARS + 1),
    })
    const { documents, skipped } = await expandKnowledgeDir(root, { dir: "kb", collection: "C" })
    expect(documents).toEqual([
      { path: "kb/page.md", title: "page", body: "Source: https://acme.example/\n\nHello\n" },
    ])
    expect(skipped.map((s) => s.path)).toEqual(["kb/empty.md", "kb/huge.md"])
  })

  test("absolute, escaping, missing and non-directory dirs are config errors", async () => {
    const root = tree({ "kb/file.md": "# F" })
    for (const dir of ["/etc", "../", "missing", "kb/file.md"]) {
      await expect(expandKnowledgeDir(root, { dir, collection: "C" })).rejects.toBeInstanceOf(
        ConfigError,
      )
    }
  })

  test("a dir that is a symlink to somewhere outside the config directory is rejected", async () => {
    const outside = tree({ "secret.md": "# Secret" })
    const root = tree({ "keep.md": "# Keep" })
    symlinkSync(outside, join(root, "kb"))
    await expect(expandKnowledgeDir(root, { dir: "kb", collection: "C" })).rejects.toBeInstanceOf(
      ConfigError,
    )
  })

  test("a file far over the size cap is skipped without being read", async () => {
    const root = tree({ "kb/ok.md": "# Ok" })
    writeFileSync(join(root, "kb/huge.txt"), Buffer.alloc(MAX_KNOWLEDGE_BODY_CHARS * 4 + 1, 97))
    const { documents, skipped } = await expandKnowledgeDir(root, { dir: "kb", collection: "C" })
    expect(documents.map((d) => d.title)).toEqual(["Ok"])
    expect(skipped.map((s) => s.path)).toEqual(["kb/huge.txt"])
  })

  test("a symlink that points outside the dir is never read", async () => {
    const outside = tree({ "secret.md": "# Secret", "more/other.md": "# Other" })
    const root = tree({ "kb/ok.md": "# Ok" })
    symlinkSync(join(outside, "secret.md"), join(root, "kb/link.md"))
    symlinkSync(join(outside, "more"), join(root, "kb/linked-dir"))
    const { documents } = await expandKnowledgeDir(root, { dir: "kb", collection: "C" })
    expect(documents.map((d) => d.title)).toEqual(["Ok"])
  })
})

describe("disambiguateTitles", () => {
  test("a shared title gets the path appended; unique ones and fixed titles stay", () => {
    const out = disambiguateTitles(
      ["Overview"],
      [
        { path: "kb/a/README.md", title: "Acme", body: "a" },
        { path: "kb/b/README.md", title: "Acme", body: "b" },
        { path: "kb/c.md", title: "Overview", body: "c" },
        { path: "kb/d.md", title: "Unique", body: "d" },
      ],
    )
    expect(out.map((d) => d.title)).toEqual([
      "Acme (kb/a/README.md)",
      "Acme (kb/b/README.md)",
      "Overview (kb/c.md)",
      "Unique",
    ])
  })
})

describe("config schema", () => {
  test("a document is either a single file or a dir, never a mix", () => {
    const base = { org: { slug: "a", name: "A" } }
    const dirOk = validateConfig({
      ...base,
      knowledge: { documents: [{ dir: "knowledge/web", collection: "Web", include: ["**/*.md"] }] },
    })
    expect(dirOk.ok).toBe(true)
    const mixed = validateConfig({
      ...base,
      knowledge: { documents: [{ dir: "x", contentFile: "y.md", collection: "Web" }] },
    })
    expect(mixed.ok).toBe(false)
  })
})
