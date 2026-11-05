// SPDX-License-Identifier: FSL-1.1-ALv2
// Pure-function tests for the Slack → Liaison markdown converter used by
// `slack import`. No DB/network — everything here is deterministic string
// transformation.
import { describe, expect, it } from "bun:test"
import {
  attachmentsToMarkdown,
  blockKitToMarkdown,
  blocksToMarkdown,
  buildReplyQuotePrefix,
  legacyTextToMarkdown,
  messageToMarkdown,
  type SlackRefs,
  truncateSingleLine,
} from "./markdown"

const resolveUser = (id: string): string => ({ U1: "Pat Rivera", U2: "Alice Chen" })[id] ?? id

describe("blocksToMarkdown — rich_text blocks", () => {
  it("renders a plain rich_text_section", () => {
    const blocks = [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [{ type: "text", text: "Hello world" }],
          },
        ],
      },
    ]
    expect(blocksToMarkdown(blocks, resolveUser)).toBe("Hello world")
  })

  it("applies bold / italic / strike / code inline styles", () => {
    const blocks = [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "text", text: "bold", style: { bold: true } },
              { type: "text", text: " and " },
              { type: "text", text: "italic", style: { italic: true } },
              { type: "text", text: " and " },
              { type: "text", text: "struck", style: { strike: true } },
              { type: "text", text: " and " },
              { type: "text", text: "coded", style: { code: true } },
            ],
          },
        ],
      },
    ]
    expect(blocksToMarkdown(blocks, resolveUser)).toBe(
      "**bold** and _italic_ and ~~struck~~ and `coded`",
    )
  })

  it("renders a rich_text_preformatted block as a fenced code block", () => {
    const blocks = [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_preformatted",
            elements: [{ type: "text", text: "const x = 1\nconsole.log(x)" }],
          },
        ],
      },
    ]
    expect(blocksToMarkdown(blocks, resolveUser)).toBe("```\nconst x = 1\nconsole.log(x)\n```")
  })

  it("renders a rich_text_quote block with a leading '> '", () => {
    const blocks = [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_quote",
            elements: [{ type: "text", text: "quoted text" }],
          },
        ],
      },
    ]
    expect(blocksToMarkdown(blocks, resolveUser)).toBe("> quoted text")
  })

  it("renders a bullet rich_text_list with '-' markers", () => {
    const blocks = [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_list",
            style: "bullet",
            elements: [
              { type: "rich_text_section", elements: [{ type: "text", text: "first" }] },
              { type: "rich_text_section", elements: [{ type: "text", text: "second" }] },
            ],
          },
        ],
      },
    ]
    expect(blocksToMarkdown(blocks, resolveUser)).toBe("- first\n- second")
  })

  it("renders an ordered rich_text_list with '1.' / '2.' markers", () => {
    const blocks = [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_list",
            style: "ordered",
            elements: [
              { type: "rich_text_section", elements: [{ type: "text", text: "one" }] },
              { type: "rich_text_section", elements: [{ type: "text", text: "two" }] },
            ],
          },
        ],
      },
    ]
    expect(blocksToMarkdown(blocks, resolveUser)).toBe("1. one\n2. two")
  })

  it("resolves a user mention element to @Name via the resolver", () => {
    const blocks = [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "text", text: "hey " },
              { type: "user", user_id: "U1" },
              { type: "text", text: ", ping" },
            ],
          },
        ],
      },
    ]
    expect(blocksToMarkdown(blocks, resolveUser)).toBe("hey @Pat Rivera, ping")
  })

  it("renders a link element as markdown, and a bare link when no label", () => {
    const blocks = [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "link", url: "https://fabrikam.example", text: "our site" },
              { type: "text", text: " " },
              { type: "link", url: "https://fabrikam.example" },
            ],
          },
        ],
      },
    ]
    expect(blocksToMarkdown(blocks, resolveUser)).toBe(
      "[our site](https://fabrikam.example) https://fabrikam.example",
    )
  })

  it("renders an emoji element as unicode when present, else :name:", () => {
    const blocks = [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "emoji", name: "+1", unicode: "1f44d" },
              { type: "text", text: " " },
              { type: "emoji", name: "custom_emoji" },
            ],
          },
        ],
      },
    ]
    expect(blocksToMarkdown(blocks, resolveUser)).toBe("\u{1F44D} :custom_emoji:")
  })

  it("renders a channel element as #name", () => {
    const blocks = [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [{ type: "channel", channel_id: "C1", name: "general" }],
          },
        ],
      },
    ]
    expect(blocksToMarkdown(blocks, resolveUser)).toBe("#general")
  })

  it("renders a broadcast element as the literal @here / @channel", () => {
    const hereBlocks = [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [{ type: "broadcast", name: "here" }],
          },
        ],
      },
    ]
    const channelBlocks = [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [{ type: "broadcast", name: "channel" }],
          },
        ],
      },
    ]
    expect(blocksToMarkdown(hereBlocks, resolveUser)).toBe("@here")
    expect(blocksToMarkdown(channelBlocks, resolveUser)).toBe("@channel")
  })

  it("skips non-rich_text top-level blocks (e.g. call) without throwing", () => {
    const blocks = [{ type: "call", call_id: "R123" }]
    expect(blocksToMarkdown(blocks, resolveUser)).toBe("")
  })

  it("returns empty string for undefined/empty blocks", () => {
    expect(blocksToMarkdown(undefined, resolveUser)).toBe("")
    expect(blocksToMarkdown([], resolveUser)).toBe("")
  })
})

describe("legacyTextToMarkdown — text-field fallback", () => {
  it("resolves <@UXXX> via the resolver", () => {
    expect(legacyTextToMarkdown("hey <@U1> check this", resolveUser)).toBe(
      "hey @Pat Rivera check this",
    )
  })

  it("prefers an inline label on <@UXXX|label>", () => {
    expect(legacyTextToMarkdown("hey <@U1|mat>", resolveUser)).toBe("hey @mat")
  })

  it("converts <url|label> to markdown link and <url> to a bare url", () => {
    expect(legacyTextToMarkdown("see <https://fabrikam.example|our site>", resolveUser)).toBe(
      "see [our site](https://fabrikam.example)",
    )
    expect(legacyTextToMarkdown("see <https://fabrikam.example>", resolveUser)).toBe(
      "see https://fabrikam.example",
    )
  })

  it("converts <#CXXX|name> to #name", () => {
    expect(legacyTextToMarkdown("in <#C1|general>", resolveUser)).toBe("in #general")
  })

  it("converts <!here> / <!channel> / <!everyone>", () => {
    expect(legacyTextToMarkdown("<!here> ping", resolveUser)).toBe("@here ping")
    expect(legacyTextToMarkdown("<!channel> ping", resolveUser)).toBe("@channel ping")
    expect(legacyTextToMarkdown("<!everyone> ping", resolveUser)).toBe("@everyone ping")
  })

  it("unescapes &amp; &lt; &gt;", () => {
    expect(legacyTextToMarkdown("Tom &amp; Jerry &lt;3 &gt;9000", resolveUser)).toBe(
      "Tom & Jerry <3 >9000",
    )
  })

  it("unescapes once: a typed &lt; stays the text &lt;", () => {
    expect(legacyTextToMarkdown("write &amp;lt; for &lt;", resolveUser)).toBe("write &lt; for <")
  })

  it("converts Slack single-asterisk bold to markdown double-asterisk", () => {
    expect(legacyTextToMarkdown("this is *important* text", resolveUser)).toBe(
      "this is **important** text",
    )
  })

  it("passes triple-backtick code fences through untouched", () => {
    const text = "```const x = 1```"
    expect(legacyTextToMarkdown(text, resolveUser)).toBe(text)
  })

  it("leaves underscore italics alone (already markdown-compatible)", () => {
    expect(legacyTextToMarkdown("this is _italic_ text", resolveUser)).toBe("this is _italic_ text")
  })
})

describe("truncateSingleLine", () => {
  it("collapses whitespace/newlines to single spaces", () => {
    expect(truncateSingleLine("line one\nline   two")).toBe("line one line two")
  })

  it("leaves short content untouched", () => {
    expect(truncateSingleLine("short")).toBe("short")
  })

  it("truncates to ~80 chars with an ellipsis", () => {
    const long = "x".repeat(120)
    const result = truncateSingleLine(long)
    expect(result.length).toBe(81) // 80 chars + ellipsis
    expect(result.endsWith("…")).toBe(true)
  })
})

describe("buildReplyQuotePrefix", () => {
  it("builds the '> ↳ reply to X: \"…\"' prefix followed by a blank line", () => {
    const prefix = buildReplyQuotePrefix("Alice Chen", "Original message here")
    expect(prefix).toBe('> ↳ reply to Alice Chen: "Original message here"\n\n')
  })

  it("truncates a long parent message inside the quote", () => {
    const long = "y".repeat(200)
    const prefix = buildReplyQuotePrefix("Bob", long)
    expect(prefix).toContain("…")
    expect(prefix.startsWith('> ↳ reply to Bob: "')).toBe(true)
  })
})

const UID = "11111111-1111-4111-8111-111111111111"
const TID = "22222222-2222-4222-8222-222222222222"
const refs: SlackRefs = {
  userMention: (id) => (id === "U1" ? `@[Pat Rivera](user:${UID})` : null),
  channelLink: (id, name) => (id === "C1" ? `@[${name ?? "general"}](thread:${TID})` : null),
}

describe("live mentions and channel links (refs)", () => {
  it("rich_text user and channel elements become live tokens", () => {
    const blocks = [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "user", user_id: "U1" },
              { type: "text", text: " see " },
              { type: "channel", channel_id: "C1" },
            ],
          },
        ],
      },
    ]
    expect(blocksToMarkdown(blocks, resolveUser, refs)).toBe(
      `@[Pat Rivera](user:${UID}) see @[general](thread:${TID})`,
    )
  })

  it("legacy <@U…> and <#C…|name> become live tokens", () => {
    expect(legacyTextToMarkdown("hi <@U1> in <#C1|general>", resolveUser, refs)).toBe(
      `hi @[Pat Rivera](user:${UID}) in @[general](thread:${TID})`,
    )
  })

  it("falls back to plain text when a ref is unknown", () => {
    expect(legacyTextToMarkdown("hi <@U2> in <#C9|random>", resolveUser, refs)).toBe(
      "hi @Alice Chen in #random",
    )
  })
})

describe("blockKitToMarkdown — app posts", () => {
  it("renders header, section text and fields, context", () => {
    const blocks = [
      { type: "header", text: { type: "plain_text", text: "Deploy" } },
      {
        type: "section",
        text: { type: "mrkdwn", text: "*done* <https://x.test|link>" },
        fields: [{ type: "mrkdwn", text: "env: prod" }],
      },
      { type: "context", elements: [{ type: "mrkdwn", text: "by CI" }] },
      { type: "actions", elements: [] },
    ]
    expect(blockKitToMarkdown(blocks, resolveUser)).toBe(
      "**Deploy**\n**done** [link](https://x.test)\nenv: prod\n_by CI_",
    )
  })
})

describe("attachmentsToMarkdown — integration posts", () => {
  it("renders pretext, linked title, text and fields", () => {
    const out = attachmentsToMarkdown(
      [
        {
          pretext: "New issue",
          title: "BUG-1",
          title_link: "https://jira.test/BUG-1",
          text: "Broken",
          fields: [{ title: "Priority", value: "High" }],
          fallback: "ignored",
        },
      ],
      resolveUser,
    )
    expect(out).toBe("New issue\n**[BUG-1](https://jira.test/BUG-1)**\nBroken\n**Priority**: High")
  })

  it("uses the fallback only when nothing else renders", () => {
    expect(attachmentsToMarkdown([{ fallback: "Alert: disk 90%" }], resolveUser)).toBe(
      "Alert: disk 90%",
    )
  })

  it("drops a plain link preview and quotes a shared message", () => {
    expect(
      attachmentsToMarkdown([{ original_url: "https://x.test", title: "X" }], resolveUser),
    ).toBe("")
    expect(
      attachmentsToMarkdown([{ is_share: true, author_name: "Pat", text: "hello" }], resolveUser),
    ).toBe("> **Pat**\n> hello")
  })
})

describe("messageToMarkdown", () => {
  it("prefers rich text, then Block Kit, then the text fallback, then attachments", () => {
    expect(
      messageToMarkdown(
        {
          text: "fallback",
          blocks: [{ type: "section", text: { type: "plain_text", text: "from blocks" } }],
        },
        resolveUser,
      ),
    ).toBe("from blocks")
    expect(
      messageToMarkdown(
        { text: "just text", attachments: [{ fallback: "an alert" }] },
        resolveUser,
      ),
    ).toBe("just text\n\nan alert")
    expect(messageToMarkdown({ text: "", attachments: [{ fallback: "only" }] }, resolveUser)).toBe(
      "only",
    )
  })
})
