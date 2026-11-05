// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { buildSmtpMessage, classifyDeliveryState } from "~/modules/apps/sandbox/smtp-bridge"

describe("buildSmtpMessage", () => {
  it("builds a basic email message", () => {
    const result = buildSmtpMessage({
      from: "sender@example.com",
      to: ["recipient@example.com"],
      subject: "Test",
      htmlBody: "<p>Hello</p>",
      textBody: "Hello",
    })

    expect(result.from).toBe("sender@example.com")
    expect(result.to).toEqual(["recipient@example.com"])
    expect(result.subject).toBe("Test")
    expect(result.html).toBe("<p>Hello</p>")
    expect(result.text).toBe("Hello")
  })

  it("includes In-Reply-To and References for replies", () => {
    const result = buildSmtpMessage({
      from: "sender@example.com",
      to: ["recipient@example.com"],
      subject: "Re: Test",
      htmlBody: "<p>Reply</p>",
      textBody: "Reply",
      inReplyTo: "<original@example.com>",
      references: ["<root@example.com>", "<original@example.com>"],
    })

    expect(result.inReplyTo).toBe("<original@example.com>")
    expect(result.references).toBe("<root@example.com> <original@example.com>")
  })

  it("includes cc and bcc when provided", () => {
    const result = buildSmtpMessage({
      from: "sender@example.com",
      to: ["a@example.com"],
      cc: ["b@example.com"],
      bcc: ["c@example.com"],
      subject: "Test",
      htmlBody: "",
      textBody: "",
    })

    expect(result.cc).toEqual(["b@example.com"])
    expect(result.bcc).toEqual(["c@example.com"])
  })

  it("normalizes { name, email } recipients to nodemailer's { name, address } shape", () => {
    // Real-world case: mail.reply hands the row's `from_address` jsonb (which uses
    // `{ name, email }`) directly. Without normalization nodemailer JSON-stringifies
    // the object and the envelope ends up like `<email}>`.
    const result = buildSmtpMessage({
      from: "sender@example.com",
      to: [{ name: "Sam (Customer)", email: "billing-customer@example.com" }],
      cc: [{ email: "manager@example.com" }],
      subject: "Test",
      htmlBody: "",
      textBody: "",
    })

    expect(result.to).toEqual([{ name: "Sam (Customer)", address: "billing-customer@example.com" }])
    expect(result.cc).toEqual(["manager@example.com"])
  })

  it("throws when a recipient object has no email", () => {
    expect(() =>
      buildSmtpMessage({
        from: "sender@example.com",
        // @ts-expect-error — intentional bad input
        to: [{ name: "no email" }],
        subject: "Test",
        htmlBody: "",
        textBody: "",
      }),
    ).toThrow(/email/)
  })
})

describe("classifyDeliveryState", () => {
  it("reports delivered when every recipient is accepted", () => {
    expect(classifyDeliveryState(["a@x.test", "b@x.test"], [])).toBe("delivered")
  })

  it("reports ambiguous on a partial rejection", () => {
    // nodemailer's info.rejected contains the refused addresses; ambiguous means
    // at least one recipient was accepted AND at least one was rejected.
    expect(classifyDeliveryState(["a@x.test"], ["b@x.test"])).toBe("ambiguous")
  })

  it("reports ambiguous when multiple are accepted but some are rejected", () => {
    expect(classifyDeliveryState(["a@x.test", "c@x.test"], ["b@x.test"])).toBe("ambiguous")
  })

  it("reports rejected when no recipient is accepted (info.accepted is empty)", () => {
    // Total rejection from the SMTP server: info.accepted=[], info.rejected=[...]
    expect(classifyDeliveryState([], ["a@x.test", "b@x.test"])).toBe("rejected")
  })

  it("reports rejected when both lists are empty (nothing delivered)", () => {
    // Defensive: an SMTP server that returns no envelope result is treated as a
    // failure rather than silently reporting delivered.
    expect(classifyDeliveryState([], [])).toBe("rejected")
  })

  it("does not treat a single total rejection as ambiguous", () => {
    expect(classifyDeliveryState([], ["only@x.test"])).toBe("rejected")
  })
})
