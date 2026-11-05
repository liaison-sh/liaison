// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { matchUnderline } from "./markdown-rules"

describe("matchUnderline", () => {
  it("matches ++text++ at the start of a string with no previous token", () => {
    const match = matchUnderline("++hello++ world", [])
    expect(match).toBeDefined()
    expect(match?.text).toBe("hello")
    expect(match?.raw).toBe("++hello++")
  })

  it("does not match when immediately preceded by a word character", () => {
    // "C++ et C++" — the first ++ closes a token whose raw ends in a letter,
    // so a second ++ must not be read as the start of an underline span.
    const match = matchUnderline("++ et C++", [{ raw: "C" }])
    expect(match).toBeUndefined()
  })

  it("matches when preceded by whitespace", () => {
    const match = matchUnderline("++text++", [{ raw: "hello " }])
    expect(match).toBeDefined()
    expect(match?.text).toBe("text")
  })

  it("matches when preceded by punctuation", () => {
    const match = matchUnderline("++text++", [{ raw: "hello," }])
    expect(match).toBeDefined()
    expect(match?.text).toBe("text")
  })

  it("does not match an unterminated ++text with no closing ++", () => {
    expect(matchUnderline("++text", [])).toBeUndefined()
  })

  it("does not match empty-content ++++", () => {
    expect(matchUnderline("++++", [])).toBeUndefined()
  })
})
