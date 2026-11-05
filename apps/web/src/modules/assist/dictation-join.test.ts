// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
//
// SK8: consecutive segments overlap by about a second of audio (no word falls
// between two recorders), so the words of that second come back twice. The
// join drops the repeat: the longest run of tokens ending one piece and
// starting the next, compared without case or punctuation, at most 8 tokens.
import { describe, expect, it } from "vitest"
import { joinTranscripts, MAX_OVERLAP_TOKENS } from "./dictation-join"

describe("joinTranscripts", () => {
  it("joins pieces with nothing in common as they are", () => {
    expect(joinTranscripts(["hello world", "how are you"])).toBe("hello world how are you")
  })

  it("drops the repeated words at the seam, whatever their case and punctuation", () => {
    expect(joinTranscripts(["send the invoice by Friday,", "by friday please"])).toBe(
      "send the invoice by Friday, please",
    )
  })

  it("prefers the longest repeat", () => {
    expect(joinTranscripts(["we said no no", "no no more"])).toBe("we said no no more")
  })

  it("a piece wholly repeated at the seam adds nothing", () => {
    expect(joinTranscripts(["call me back", "me back"])).toBe("call me back")
    expect(joinTranscripts(["call me back", "Call me back."])).toBe("call me back")
  })

  it("never drops more than 8 tokens", () => {
    expect(MAX_OVERLAP_TOKENS).toBe(8)
    const nine = "a b c d e f g h i"
    expect(joinTranscripts([`x ${nine}`, `${nine} y`])).toBe(`x ${nine} ${nine} y`)
  })

  it("skips empty pieces and chains three", () => {
    expect(joinTranscripts(["one two three", "", "three four", "four five"])).toBe(
      "one two three four five",
    )
  })

  it("is empty for nothing", () => {
    expect(joinTranscripts([])).toBe("")
    expect(joinTranscripts(["", "  "])).toBe("")
  })
})
