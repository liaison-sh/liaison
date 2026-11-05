// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { decodeHtmlEntities } from "./html-entities"

describe("decodeHtmlEntities", () => {
  test("decodes the entities YouTube snippets actually emit (don&#39;t, &amp;)", () => {
    expect(decodeHtmlEntities("don&#39;t")).toBe("don't")
    expect(decodeHtmlEntities("Sound &amp; Vision")).toBe("Sound & Vision")
    expect(decodeHtmlEntities("A &#39; B &amp; C")).toBe("A ' B & C")
  })

  test("decodes named, decimal, and hex references", () => {
    expect(decodeHtmlEntities("&lt;tag&gt;")).toBe("<tag>")
    expect(decodeHtmlEntities("&quot;q&quot;")).toBe('"q"')
    expect(decodeHtmlEntities("&#39;")).toBe("'")
    expect(decodeHtmlEntities("&#x27;")).toBe("'")
    expect(decodeHtmlEntities("a&nbsp;b")).toBe("a b")
  })

  test("leaves unknown entities and plain text verbatim", () => {
    expect(decodeHtmlEntities("plain text")).toBe("plain text")
    expect(decodeHtmlEntities("&notareal;")).toBe("&notareal;")
    // An out-of-range code point is left as-is, never dropped.
    expect(decodeHtmlEntities("&#9999999999;")).toBe("&#9999999999;")
  })

  test("passes null/undefined/empty through unchanged", () => {
    expect(decodeHtmlEntities(null)).toBeNull()
    expect(decodeHtmlEntities(undefined)).toBeUndefined()
    expect(decodeHtmlEntities("")).toBe("")
  })
})
