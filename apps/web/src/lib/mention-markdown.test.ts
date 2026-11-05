// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { mentionsToMarkdownLinks, pendingMentionStart } from "~/lib/mention-markdown"

describe("mentionsToMarkdownLinks", () => {
  it("rewrites a mention mid sentence as a plain link", () => {
    expect(
      mentionsToMarkdownLinks("I read @[Client Feedback](mail:conversation:c1) already."),
    ).toBe("I read [Client Feedback](mail:conversation:c1) already.")
  })

  // The Discuss reply: the chip was drawn and the brackets were left around it.
  it("absorbs a pair of brackets wrapped around the token", () => {
    expect(
      mentionsToMarkdownLinks("I read [@[Client Feedback](mail:conversation:c1)] already."),
    ).toBe("I read [Client Feedback](mail:conversation:c1) already.")
  })

  it("keeps a bracketed subject inside the label", () => {
    expect(mentionsToMarkdownLinks("@[Re: [urgent] order](mail:conversation:c1)")).toBe(
      "[Re: [urgent] order](mail:conversation:c1)",
    )
  })

  it("carries an escaped label through verbatim, so the link text still parses", () => {
    expect(mentionsToMarkdownLinks("@[Re: a\\] b](mail:conversation:c1)")).toBe(
      "[Re: a\\] b](mail:conversation:c1)",
    )
  })

  it("leaves an ordinary link and ordinary brackets alone", () => {
    expect(mentionsToMarkdownLinks("see [docs](https://example.com) and [a note]")).toBe(
      "see [docs](https://example.com) and [a note]",
    )
  })

  it("leaves a mention whose ref is not an entity reference alone", () => {
    expect(mentionsToMarkdownLinks("@[docs](https://example.com)")).toBe(
      "@[docs](https://example.com)",
    )
  })
})

/**
 * EVERY SCHEME THE APP KNOWS, not just the one that was reported.
 *
 * The rewrite was written for `mail:conversation:<id>` and tested only there.
 * A ticket chip came back as raw markdown because the model wraps the mention
 * in a LINK, "[@[title](tickets:ticket:<id>)](tickets:ticket:<id>)", which the
 * bracket-pair rule does not match; and the two part kernel references
 * (`thread:<id>`, `agent:<handle>`, `user:<id>`) were never references at all
 * as far as the href test was concerned, so they streamed out raw.
 */
describe("mentionsToMarkdownLinks across every entity scheme", () => {
  const SCHEMES: Array<[string, string]> = [
    ["a ticket", "tickets:ticket:4a2a2f26-0f1e-4f1b-9b6d-1c9a7f2b3c4d"],
    ["a mail conversation", "mail:conversation:c1"],
    ["a project task", "projects:task:t1"],
    ["a contact", "contacts:contact:k1"],
    ["a kernel user", "kernel:user:u1"],
    ["a thread", "thread:9c3f2a10"],
    ["an agent", "agent:support"],
  ]

  for (const [name, ref] of SCHEMES) {
    it(`rewrites ${name} written bare`, () => {
      expect(mentionsToMarkdownLinks(`I read @[Title](${ref}) already.`)).toBe(
        `I read [Title](${ref}) already.`,
      )
    })

    it(`rewrites ${name} wrapped in brackets`, () => {
      expect(mentionsToMarkdownLinks(`I read [@[Title](${ref})] already.`)).toBe(
        `I read [Title](${ref}) already.`,
      )
    })

    // What the model actually produces: the mention as a link's own text.
    it(`rewrites ${name} wrapped in a link, leaving no trailing reference`, () => {
      expect(mentionsToMarkdownLinks(`I read [@[Title](${ref})](${ref}) already.`)).toBe(
        `I read [Title](${ref}) already.`,
      )
    })
  }

  it("still leaves an ordinary link and an ordinary bracketed phrase alone", () => {
    expect(mentionsToMarkdownLinks("see [docs](https://example.com) and [a note]")).toBe(
      "see [docs](https://example.com) and [a note]",
    )
    expect(mentionsToMarkdownLinks("see [docs](mailto:a@b.com)")).toBe("see [docs](mailto:a@b.com)")
  })
})

describe("pendingMentionStart", () => {
  it("holds back a token whose reference has not arrived", () => {
    expect(pendingMentionStart("I read @[Client Feed")).toBe(7)
    expect(pendingMentionStart("I read @[Client Feedback](mail:conversa")).toBe(7)
    expect(pendingMentionStart("I read [@[Client Feed")).toBe(7)
  })

  it("releases a token that is complete", () => {
    expect(pendingMentionStart("I read @[Client Feedback](mail:conversation:c1) already")).toBe(-1)
  })

  it("holds nothing back when there is no token at all", () => {
    expect(pendingMentionStart("plain prose with [brackets] and a (paren)")).toBe(-1)
  })
})
