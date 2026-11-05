// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { messagePlainText } from "./plain-text"

const USER = "11111111-1111-4111-8111-111111111111"
const AGENT = "6c7de388-0000-4000-8000-000000000001"

describe("messagePlainText", () => {
  it("renders a user mention as @Name", () => {
    expect(messagePlainText(`@[Recipient](user:${USER}) push matrix TF-mention-background`)).toBe(
      "@Recipient push matrix TF-mention-background",
    )
  })

  it("renders an agent mention as @Name", () => {
    expect(messagePlainText(`@[Data](agent:${AGENT}) can you check this?`)).toBe(
      "@Data can you check this?",
    )
  })

  it("renders a channel/thread reference and an entity mention by their label", () => {
    expect(
      messagePlainText(`see #[general](thread:${USER}) and @[Q3 plan](projects:task:${USER})`),
    ).toBe("see #general and @Q3 plan")
  })

  it("unescapes a label with brackets", () => {
    expect(messagePlainText(`@[Ops \\[EU\\]](user:${USER}) hi`)).toBe("@Ops [EU] hi")
  })

  it("renders a link as its text and an image as its alt", () => {
    expect(
      messagePlainText("read [the runbook](https://x.test/r) now ![chart](https://x.test/c.png)"),
    ).toBe("read the runbook now chart")
    expect(messagePlainText(`[@[Alice](user:${USER})](https://x.test/u)`)).toBe("@Alice")
  })

  it("drops bold, italic, strike and underline markers", () => {
    expect(messagePlainText("this is **bold**, __also__, *it*, _it2_ and ~~gone~~")).toBe(
      "this is bold, also, it, it2 and gone",
    )
  })

  it("keeps an inline code span's text without backticks, and does not render mentions inside it", () => {
    expect(messagePlainText("run `bun test` please")).toBe("run bun test please")
    expect(messagePlainText(`syntax: \`@[Name](user:${USER})\``)).toBe(
      `syntax: @[Name](user:${USER})`,
    )
  })

  it("flattens block markup into one line", () => {
    expect(
      messagePlainText("# Title\n\n> quoted\n- one\n- two\n1. three\n```ts\nconst a = 1\n```"),
    ).toBe("Title quoted one two three const a = 1")
  })

  it("leaves plain text and snake_case words alone", () => {
    expect(messagePlainText("plain text")).toBe("plain text")
    expect(messagePlainText("set my_var_name to 2*3*4")).toBe("set my_var_name to 2*3*4")
  })
})

describe("messagePlainText, editor extras", () => {
  it("drops underline markers and checklist boxes", () => {
    expect(
      messagePlainText("an ++underlined++ word, C++ and C++ stay\n- [ ] todo\n- [x] done"),
    ).toBe("an underlined word, C++ and C++ stay todo done")
  })
})
