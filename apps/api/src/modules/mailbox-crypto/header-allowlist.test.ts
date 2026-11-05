// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The header allowlist exists twice by necessity: once as TypeScript the seal
// path reads, and once as a literal SQL list inside the Invariant P trigger
// body, which is a JSON string in the mail manifest and cannot import anything.
// Two copies that drift produce the worst failure available here: the seal path
// keeps a header the trigger forbids, so every ingest raises, or the trigger
// permits a header the seal path stripped, so content sits in cleartext.
//
// This test is the only thing keeping them equal.

import { describe, expect, test } from "bun:test"
import mailManifest from "~/apps/mail/app.manifest.json"
import { MAIL_HEADER_ALLOWLIST, splitMailHeaders } from "~/modules/mailbox-crypto/header-allowlist"

function triggerAllowlist(): string[] {
  const body = (mailManifest as any).schema.messages.triggers.enforce_mailbox_plaintext_invariant
    .body as string
  const match = body.match(/k NOT IN \(([^)]*)\)/)
  if (!match) throw new Error("the messages trigger body no longer carries a header NOT IN list")
  return (match[1] as string)
    .split(",")
    .map((token) => token.trim().replace(/^'/, "").replace(/'$/, ""))
}

describe("mail header allowlist", () => {
  test("the trigger body and the TypeScript constant name the same headers", () => {
    const fromTrigger = triggerAllowlist()
    // Non-vacuity: a regex that matched nothing, or a constant that was empty,
    // would otherwise make the equality below trivially true.
    expect(fromTrigger.length).toBeGreaterThan(10)
    const fromCode: string[] = [...MAIL_HEADER_ALLOWLIST]
    expect(fromCode.length).toBe(fromTrigger.length)
    expect([...fromCode].sort()).toEqual([...fromTrigger].sort())
  })

  test("subject is never allowlisted", () => {
    expect([...MAIL_HEADER_ALLOWLIST] as string[]).not.toContain("subject")
  })

  test("splitMailHeaders retains the allowlist and seals everything else", () => {
    const { retained, sealed } = splitMailHeaders({
      "message-id": "<a@b>",
      Subject: "a secret subject",
      "x-mailer": "Sneaky 1.0",
      "thread-topic": "the topic",
      To: "b@c",
    })
    expect(retained).toEqual({ "message-id": "<a@b>", to: "b@c" })
    expect(sealed).toEqual({
      subject: "a secret subject",
      "x-mailer": "Sneaky 1.0",
      "thread-topic": "the topic",
    })
  })

  test("an empty header map splits into two empty maps", () => {
    const { retained, sealed } = splitMailHeaders({})
    expect(retained).toEqual({})
    expect(sealed).toEqual({})
  })
})
