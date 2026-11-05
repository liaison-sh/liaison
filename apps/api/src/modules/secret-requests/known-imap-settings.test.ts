// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { knownImapSettings } from "~/modules/secret-requests/approved-settings"

describe("the credentials card for a personal Gmail address", () => {
  const plain = ["imapHost", "imapPort", "smtpHost", "smtpPort", "username"]

  it("fills Google's servers and the username, so only the app password is asked", () => {
    expect(knownImapSettings("Someone@gmail.com", plain)).toEqual({
      imapHost: "imap.gmail.com",
      imapPort: "993",
      smtpHost: "smtp.gmail.com",
      smtpPort: "465",
      username: "someone@gmail.com",
    })
  })

  it("fills nothing for another address, and only the fields the connection declares", () => {
    expect(knownImapSettings("support@company.test", plain)).toEqual({})
    expect(knownImapSettings("someone@gmail.com", ["imapHost"])).toEqual({
      imapHost: "imap.gmail.com",
    })
  })
})
