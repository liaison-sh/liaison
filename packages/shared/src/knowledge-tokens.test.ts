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

  it("does not touch an image or another scheme", () => {
    const body = `![alt](knowledge:document:${A}) [x](https://example.com) [y](knowledge:docs:${A})`
    expect(normalizePageRefs(body)).toBe(body)
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

  it("a code span closes only on a run of the same length; an unclosed run is text", () => {
    const link = `@[T](knowledge:document:${A})`
    // Two backticks hold a single one: the link inside is code.
    expect(pageIdsOf(`\`\` a \` ${link} \`\``)).toEqual([])
    // One backtick is not closed by two: the link is read.
    expect(pageIdsOf(`\` ${link} \`\``)).toEqual([A])
    // No closer at all: the run is plain text.
    expect(normalizePageRefs(`x \`\`\` ${link}`)).toBe(`x \`\`\` ${pageToken(A)}`)
  })

  it("long runs of backticks are read in linear time", () => {
    const link = `[](knowledge:document:${A})`
    for (const body of [
      "`".repeat(200_000) + link,
      `\`${"``".repeat(100_000)}${link}`,
      "`a".repeat(100_000) + link,
    ]) {
      const started = performance.now()
      expect(pageIdsOf(body).length).toBeLessThanOrEqual(1)
      normalizePageRefs(body)
      expect(performance.now() - started).toBeLessThan(1_000)
    }
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
