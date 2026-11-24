// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  FILE_TOKEN_RE,
  fileIdsOf,
  fileToken,
  normalizePageRefs,
  PAGE_TOKEN_RE,
  pageIdsOf,
  pageToken,
  plainTextOf,
  replaceFileIds,
} from "./knowledge-tokens"

const A = "0b9a3c5e-1d2f-4a6b-8c7d-9e0f1a2b3c4d"
const B = "1c0b4d6f-2e3a-4b7c-9d8e-0f1a2b3c4d5e"
const F = "2d1c5e7a-3f4b-4c8d-8e9f-1a2b3c4d5e6f"

describe("knowledge tokens", () => {
  it("builds the canonical tokens", () => {
    expect(pageToken(A)).toBe(`[](knowledge:document:${A})`)
    expect(fileToken(F)).toBe(`![](liaison-file:${F})`)
    expect(new RegExp(PAGE_TOKEN_RE.source, "i").test(pageToken(A))).toBe(true)
    expect(new RegExp(FILE_TOKEN_RE.source, "i").test(fileToken(F))).toBe(true)
  })

  it("drops the label of an agent's mention and of a plain labelled link", () => {
    expect(normalizePageRefs(`See @[Return policy](knowledge:document:${A}) now`)).toBe(
      `See [](knowledge:document:${A}) now`,
    )
    expect(normalizePageRefs(`See [Secret plan](knowledge:document:${B}).`)).toBe(
      `See [](knowledge:document:${B}).`,
    )
    expect(normalizePageRefs(`[a \\] b](knowledge:document:${A})`)).toBe(pageToken(A))
  })

  it("is idempotent and leaves canonical bytes alone", () => {
    const body = `x [](knowledge:document:${A}) ![](liaison-file:${F}) y\r\n`
    expect(normalizePageRefs(body)).toBe(body)
    const once = normalizePageRefs(`@[T](knowledge:document:${A})`)
    expect(normalizePageRefs(once)).toBe(once)
  })

  it("leaves code spans and fenced blocks untouched", () => {
    const body = [
      `inline \`[T](knowledge:document:${A})\` and [U](knowledge:document:${B})`,
      "```",
      `[V](knowledge:document:${A})`,
      "```",
      "~~~md",
      `@[W](knowledge:document:${B})`,
      "~~~",
      `after [X](knowledge:document:${A})`,
    ].join("\n")
    expect(normalizePageRefs(body)).toBe(
      [
        `inline \`[T](knowledge:document:${A})\` and [](knowledge:document:${B})`,
        "```",
        `[V](knowledge:document:${A})`,
        "```",
        "~~~md",
        `@[W](knowledge:document:${B})`,
        "~~~",
        `after [](knowledge:document:${A})`,
      ].join("\n"),
    )
  })

  it("does not touch another scheme", () => {
    const body = `[x](https://example.com) [y](knowledge:docs:${A}) ![z](liaison-file:${F})`
    expect(normalizePageRefs(body)).toBe(body)
  })

  // A label is the linked page's title: whatever it holds, it never survives a write,
  // and the link is still recorded (MED-2).
  const T = pageToken(A)
  const hostile: Array<[string, string, string]> = [
    ["balanced brackets", `See @[Q3 [draft] Zephyr](knowledge:document:${A}) now`, `See ${T} now`],
    ["nested twice", `[a [b [c]] d](knowledge:document:${A})`, T],
    ["an unbalanced opening bracket", `x @[Q3 [draft](knowledge:document:${A}) y`, `x ${T} y`],
    ["an opening bracket at the end", `x @[Q3 [](knowledge:document:${A}) y`, `x ${T} y`],
    ["an unbalanced closing bracket", `x @[Q3 draft]](knowledge:document:${A}) y`, `x ${T} y`],
    ["a plain link with a stray bracket", `x [Q3 [draft](knowledge:document:${A}) y`, `x ${T} y`],
    ["escapes", `x [Q3 \\[a\\] \\](knowledge:document:${A}) y`, `x ${T} y`],
    [
      "an escaped closing bracket before the target",
      `x [Q3 draft\\](knowledge:document:${A}) y`,
      `x ${T} y`,
    ],
    ["a code span in the label", `x @[Q3 \`beta]\` plan](knowledge:document:${A}) y`, `x ${T} y`],
    ["a link title", `x [Q3](knowledge:document:${A} "Q3 plan") y`, `x ${T} y`],
    ["an angle-bracket target", `x [Q3](<knowledge:document:${A}> 'Q3') y`, `x ${T} y`],
    ["a label over two lines", `x [Q3\nplan](knowledge:document:${A}) y`, `x ${T} y`],
    ["an image of the page", `x ![Q3 plan](knowledge:document:${A}) y`, `x ${T} y`],
    ["an autolink", `x <knowledge:document:${A}> y`, `x ${T} y`],
    [
      "an HTML anchor",
      `x <a href="knowledge:document:${A}" title="Q3">Q3 [plan]</a> y`,
      `x ${T} y`,
    ],
    [
      "a reference link",
      `x [Q3 plan][p] y\n\n[p]: knowledge:document:${A} "Q3 plan"\n`,
      `x ${T} y\n\n`,
    ],
    ["a collapsed reference", `x [Q3][] y\n\n[q3]: <knowledge:document:${A}>`, `x ${T} y\n\n`],
    [
      "a shortcut reference",
      `x [Q3 plan] y\n[Q3  PLAN]:\n  knowledge:document:${A}\n`,
      `x ${T} y\n`,
    ],
  ]
  for (const [name, body, expected] of hostile) {
    it(`drops a label with ${name}, and records the link`, () => {
      const out = normalizePageRefs(body)
      expect(out).toBe(expected)
      expect(out).not.toContain("Q3")
      expect(normalizePageRefs(out)).toBe(out)
      expect(pageIdsOf(body)).toEqual([A])
      expect(plainTextOf(body)).not.toContain("Q3")
    })
  }

  it("keeps the writer's own brackets around canonical links", () => {
    const body = `[WIP] see [](knowledge:document:${A}), [note [](knowledge:document:${B}) and [x]`
    expect(normalizePageRefs(body)).toBe(body)
    expect(pageIdsOf(body)).toEqual([A, B])
    const two = `@[One](knowledge:document:${A}) and @[Two](knowledge:document:${B})`
    expect(normalizePageRefs(two)).toBe(`${pageToken(A)} and ${pageToken(B)}`)
    // A reference label that names no page is the writer's text.
    const other = `[a][b] [c]\n\n[b]: https://example.com\n`
    expect(normalizePageRefs(`${other}[](knowledge:document:${A})`)).toBe(
      `${other}[](knowledge:document:${A})`,
    )
  })

  it("reads a file reference whose alt text holds brackets", () => {
    expect(fileIdsOf(`![a [b] c](liaison-file:${F})`)).toEqual([F])
  })

  it("lists page and file ids outside code, once each", () => {
    const body = `@[T](knowledge:document:${A}) [](knowledge:document:${B}) [](knowledge:document:${A}) ![](liaison-file:${F}) \`[](knowledge:document:${F})\``
    expect(pageIdsOf(body)).toEqual([A, B])
    expect(fileIdsOf(body)).toEqual([F])
  })

  it("plain text has no token and no label", () => {
    expect(
      plainTextOf(`Hello @[Secret](knowledge:document:${A}) and ![](liaison-file:${F}) bye`),
    ).toBe("Hello  and  bye")
  })

  it("replaces only the ids it is given, keeps every other byte, never inside code", () => {
    const G = "3e2d6f8b-4a5c-4d9e-9fa0-2b3c4d5e6f70"
    const up = F.toUpperCase()
    const body = [
      `a ![](liaison-file:${F}) b ![kept alt](liaison-file:${up}) c ![](liaison-file:${B})`,
      `\`![](liaison-file:${F})\``,
      "```",
      `![](liaison-file:${F})`,
      "```",
      `[](knowledge:document:${F})`,
    ].join("\n")
    expect(replaceFileIds(body, { [F]: G })).toBe(
      [
        `a ![](liaison-file:${G}) b ![kept alt](liaison-file:${G}) c ![](liaison-file:${B})`,
        `\`![](liaison-file:${F})\``,
        "```",
        `![](liaison-file:${F})`,
        "```",
        `[](knowledge:document:${F})`,
      ].join("\n"),
    )
    expect(replaceFileIds(body, {})).toBe(body)
    expect(replaceFileIds(body, { [A]: G })).toBe(body)
  })
})
