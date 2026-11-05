// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The host-side gate on client-job payloads. It is the check that does not
// depend on the mail bundle building its payloads correctly, so it is tested
// against what a careless or hostile bundle would actually send.

import { describe, expect, it } from "bun:test"
import {
  assertEnvelopeOnlyPayload,
  EnvelopePayloadError,
  MAX_PAYLOAD_BYTES,
  MAX_PAYLOAD_STRING_LENGTH,
} from "~/modules/mailbox-jobs/payload-guard"

const envelope = {
  ruleId: "finance",
  accountId: "acc-1",
  conversationId: "conv-1",
  messageIds: ["m1", "m2"],
  fromEmail: "alice@example.test",
  toEmails: ["bob@example.test"],
  labels: ["INBOX", "Finance"],
  direction: "inbound",
  sentAt: "2026-08-20T09:00:00.000Z",
  attachmentCount: 2,
  attachmentFilenames: ["q3-forecast.xlsx", "notes.pdf"],
}

describe("mailbox client job payload guard", () => {
  it("accepts a real envelope payload, so the refusals below are not vacuous", () => {
    expect(JSON.parse(assertEnvelopeOnlyPayload(envelope))).toEqual(envelope)
  })

  it("accepts an empty payload", () => {
    expect(assertEnvelopeOnlyPayload({})).toBe("{}")
  })

  for (const key of ["subject", "snippet", "textBody", "html_body", "excerpt", "Preview"]) {
    it(`refuses a payload carrying "${key}"`, () => {
      expect(() => assertEnvelopeOnlyPayload({ ...envelope, [key]: "hello" })).toThrow(
        EnvelopePayloadError,
      )
    })
  }

  it("refuses a content key however it is spelled or nested", () => {
    expect(() =>
      assertEnvelopeOnlyPayload({ context: { messages: [{ "TEXT-BODY": "hi" }] } }),
    ).toThrow(EnvelopePayloadError)
  })

  it("keeps ids and filenames that merely LOOK like content keys", () => {
    expect(() =>
      assertEnvelopeOnlyPayload({ messageIds: ["m1"], attachmentFilenames: ["body.txt"] }),
    ).not.toThrow()
  })

  it("refuses a string long enough to be a body", () => {
    expect(() =>
      assertEnvelopeOnlyPayload({ note: "x".repeat(MAX_PAYLOAD_STRING_LENGTH + 1) }),
    ).toThrow(/the cap is/)
  })

  it("refuses a payload larger than the total cap", () => {
    const many = Array.from({ length: 200 }, () => "y".repeat(MAX_PAYLOAD_STRING_LENGTH))
    expect(() => assertEnvelopeOnlyPayload({ many })).toThrow(
      new RegExp(`the cap is ${MAX_PAYLOAD_BYTES}`),
    )
  })

  it("refuses a structure nested past the depth cap", () => {
    let deep: unknown = "leaf"
    for (let i = 0; i < 12; i++) deep = { nested: deep }
    expect(() => assertEnvelopeOnlyPayload(deep)).toThrow(/nested too deeply/)
  })

  it("refuses a value that is not JSON data", () => {
    expect(() => assertEnvelopeOnlyPayload({ when: () => "now" })).toThrow(EnvelopePayloadError)
  })
})
