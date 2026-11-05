// SPDX-License-Identifier: FSL-1.1-ALv2
import { htmlToText, markdownToEmail } from "@liaison/shared"
import { describe, expect, it } from "vitest"
import { draftMarkdown } from "./draft-body"

describe("draftMarkdown", () => {
  it("opens a draft written in the shared editor from its markdown", async () => {
    const textBody = "Merci **Sam**"
    expect(await draftMarkdown({ textBody, htmlBody: markdownToEmail(textBody).html })).toBe(
      textBody,
    )
  })

  it("opens a plain draft written in the shared editor as typed", async () => {
    const textBody = "Bonjour,\n\nmerci pour votre retour.\n\nCordialement\nPaul"
    expect(await draftMarkdown({ textBody, htmlBody: markdownToEmail(textBody).html })).toBe(
      textBody,
    )
  })

  it("opens a draft the earlier editor saved from its HTML", async () => {
    const htmlBody = "<div>Bonjour <b>Sam</b></div>"
    expect(await draftMarkdown({ htmlBody, textBody: htmlToText(htmlBody) })).toBe(
      "Bonjour **Sam**",
    )
  })

  it("opens a draft holding only HTML with its content, never empty", async () => {
    expect(await draftMarkdown({ htmlBody: "<p>Bonjour</p>", textBody: "" })).toBe("Bonjour")
  })
})
