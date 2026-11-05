// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { emailBody, MAX_EMAIL_BODY_BYTES } from "./email-body"

describe("emailBody", () => {
  it("keeps HTML a caller composed, with the text part of the body as written", () => {
    expect(emailBody({ htmlBody: "<p>Hi</p>", textBody: "Merci **beaucoup**" })).toEqual({
      html: "<p>Hi</p>",
      text: "Merci beaucoup",
    })
  })

  // A ticket reply is converted on the main thread too: the mail budget holds.
  it("refuses a body over the mail size budget", () => {
    expect(() => emailBody({ textBody: "a".repeat(MAX_EMAIL_BODY_BYTES + 1) })).toThrow(
      /email body over/,
    )
  })
})
