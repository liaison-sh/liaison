// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `{{team}}` placeholder (pure substitution; the send paths are covered
// in ack.test.ts and render.test.ts).

import { describe, expect, it } from "bun:test"
import { applyTeamPlaceholder, hasTeamPlaceholder } from "./team-placeholder"

describe("applyTeamPlaceholder", () => {
  it("replaces the placeholder with the team", () => {
    expect(applyTeamPlaceholder("Votre demande concerne {{team}}.", "Riverside Office")).toBe(
      "Votre demande concerne Riverside Office.",
    )
  })

  it("accepts inner spaces and any case, and replaces every occurrence", () => {
    expect(applyTeamPlaceholder("{{ Team }} / {{TEAM}}", "Team 2")).toBe("Team 2 / Team 2")
  })

  it("returns a template without the placeholder byte for byte", () => {
    const text = "  Help Desk  - \n  merci  "
    expect(applyTeamPlaceholder(text, "Riverside Office")).toBe(text)
    expect(applyTeamPlaceholder(text, null)).toBe(text)
  })

  it("passes null and undefined templates through as null", () => {
    expect(applyTeamPlaceholder(null, "X")).toBeNull()
    expect(applyTeamPlaceholder(undefined, "X")).toBeNull()
  })

  it("keeps `$&` and `$1` in a team name literal", () => {
    expect(applyTeamPlaceholder("Pour {{team}}", "A $& B $1")).toBe("Pour A $& B $1")
  })

  it("folds newlines and control characters in the team to one space", () => {
    expect(applyTeamPlaceholder("Support - {{team}}", "Westside\r\nBcc: evil@x.test\u0000")).toBe(
      "Support - Westside Bcc: evil@x.test",
    )
  })

  describe("HTML mode", () => {
    it("escapes the team value", () => {
      expect(applyTeamPlaceholder("<p>Pour {{team}}</p>", `<b>Q&A "x"</b>`, "html")).toBe(
        "<p>Pour &lt;b&gt;Q&amp;A &quot;x&quot;&lt;/b&gt;</p>",
      )
    })

    it("leaves the team raw in text mode (the text body is escaped when it becomes HTML)", () => {
      expect(applyTeamPlaceholder("Pour {{team}}", "Q&A", "text")).toBe("Pour Q&A")
    })
  })

  describe("ticket without a team", () => {
    it.each([null, undefined, "", "   ", "\n"])("drops the placeholder for %p", (team) => {
      expect(applyTeamPlaceholder("Help Desk {{team}}", team)).not.toContain("{{")
    })

    it("drops a dash separator", () => {
      expect(applyTeamPlaceholder("Help Desk - {{team}}", null)).toBe("Help Desk")
      expect(applyTeamPlaceholder("Help Desk – {{team}}", null)).toBe("Help Desk")
      expect(applyTeamPlaceholder("Help Desk | {{team}}", null)).toBe("Help Desk")
    })

    it("drops a connector word with it", () => {
      expect(applyTeamPlaceholder("L'équipe Help Desk pour {{team}}", null)).toBe(
        "L'équipe Help Desk",
      )
      expect(applyTeamPlaceholder("Votre demande concernant {{team}} est reçue.", null)).toBe(
        "Votre demande est reçue.",
      )
      expect(applyTeamPlaceholder("Your request for {{team}} is in.", null)).toBe(
        "Your request is in.",
      )
    })

    it("does not eat the end of a longer word", () => {
      expect(applyTeamPlaceholder("Plateau {{team}}", null)).toBe("Plateau")
      expect(applyTeamPlaceholder("Un café {{team}}", null)).toBe("Un café")
    })

    it("drops a leading placeholder and the separator after it", () => {
      expect(applyTeamPlaceholder("{{team}} - Support", null)).toBe("Support")
    })

    it("drops empty brackets left behind", () => {
      expect(applyTeamPlaceholder("Support ({{team}})", null)).toBe("Support")
    })

    it("a name that was only the placeholder comes out empty", () => {
      expect(applyTeamPlaceholder("{{team}}", null)).toBe("")
    })

    it("keeps the rest of the text, line breaks included", () => {
      expect(
        applyTeamPlaceholder(
          "Bonjour,\nMerci de votre message concernant {{team}}.\nCordialement",
          null,
        ),
      ).toBe("Bonjour,\nMerci de votre message.\nCordialement")
    })

    it("HTML mode drops an inline tag that wrapped only the placeholder", () => {
      expect(
        applyTeamPlaceholder('<p>L\'\u00e9quipe pour <b class="x">{{team}}</b></p>', null, "html"),
      ).toBe("<p>L'\u00e9quipe</p>")
    })

    it("HTML mode drops it the same way", () => {
      expect(applyTeamPlaceholder("<p>L'équipe pour {{team}}</p>", null, "html")).toBe(
        "<p>L'équipe</p>",
      )
    })
  })
})

describe("hasTeamPlaceholder", () => {
  it("detects the placeholder", () => {
    expect(hasTeamPlaceholder("a {{team}}")).toBe(true)
    expect(hasTeamPlaceholder("a {{ TEAM }}")).toBe(true)
    expect(hasTeamPlaceholder("a team")).toBe(false)
    expect(hasTeamPlaceholder(null)).toBe(false)
  })
})
