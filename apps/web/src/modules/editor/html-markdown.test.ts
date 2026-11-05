// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { htmlToMarkdown } from "./html-markdown"

describe("htmlToMarkdown", () => {
  // What the earlier mail editor (a contentEditable with execCommand) saved.
  it("reads a draft the earlier mail editor saved", () => {
    const html =
      'Hi <b>Sam</b>,<div><br></div><div>Here is the <i>fix</i>:</div><ul><li>one</li><li>two</li></ul><div><a href="https://x.test/doc">the doc</a></div>'
    expect(htmlToMarkdown(html)).toBe(
      "Hi **Sam**,\n\nHere is the *fix*:\n\n- one\n- two\n\n[the doc](https://x.test/doc)",
    )
  })

  it("keeps the text of what the editor cannot show, never a script", () => {
    const md = htmlToMarkdown('<p style="color:red">Rouge</p><script>alert(1)</script>')
    expect(md).toBe("Rouge")
  })
})
