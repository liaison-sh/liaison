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
})
