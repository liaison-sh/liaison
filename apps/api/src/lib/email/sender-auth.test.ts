// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { evaluateAuthenticationResults, senderAuthOf, trustedAuthservIdsFor } from "./sender-auth"

const GMAIL = ["mx.google.com"]

const gmailPass =
  "mx.google.com; dkim=pass header.i=@customer.test header.s=s1 header.b=abc; spf=pass (google.com: domain of bounce@customer.test designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@customer.test; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=customer.test"
const gmailDmarcFail =
  "mx.google.com; spf=fail (google.com: domain of x@customer.test does not designate 6.6.6.6) smtp.mailfrom=x@customer.test; dmarc=fail (p=NONE) header.from=customer.test"
const forgedPass = "mx.google.com; dmarc=pass header.from=customer.test"

describe("evaluateAuthenticationResults", () => {
  it("passes on the provider's DMARC pass for the From domain", () => {
    expect(evaluateAuthenticationResults([gmailPass], "alice@customer.test", GMAIL)).toBe("pass")
  })

  it("fails on the provider's DMARC fail", () => {
    expect(evaluateAuthenticationResults([gmailDmarcFail], "alice@customer.test", GMAIL)).toBe(
      "fail",
    )
  })

  it("reads only the TOPMOST header: a planted pass below the provider's fail does not count", () => {
    expect(
      evaluateAuthenticationResults([gmailDmarcFail, forgedPass], "alice@customer.test", GMAIL),
    ).toBe("fail")
  })

  it("ignores a lower trusted-looking header when the topmost one is from another server", () => {
    const relay = "relay.example.net; spf=none smtp.mailfrom=customer.test"
    expect(evaluateAuthenticationResults([relay, forgedPass], "alice@customer.test", GMAIL)).toBe(
      "none",
    )
  })

  it("is none when no authserv-id is trusted (IMAP without configuration)", () => {
    expect(evaluateAuthenticationResults([forgedPass], "alice@customer.test", [])).toBe("none")
  })

  it("does not pass a DMARC result for a different header.from domain", () => {
    const other = "mx.google.com; dmarc=pass header.from=attacker.test"
    expect(evaluateAuthenticationResults([other], "alice@customer.test", GMAIL)).toBe("none")
  })

  it("a DMARC pass that does not name its From domain proves nothing on its own", () => {
    const bare = "mx.google.com; dmarc=pass"
    expect(evaluateAuthenticationResults([bare], "alice@customer.test", GMAIL)).toBe("none")
    const withDkim = "mx.google.com; dkim=pass header.d=customer.test; dmarc=pass"
    expect(evaluateAuthenticationResults([withDkim], "alice@customer.test", GMAIL)).toBe("pass")
  })

  it("passes on an aligned DKIM signature without a DMARC result", () => {
    const dkim = "mx.google.com; dkim=pass header.i=@mail.customer.test header.s=s1"
    expect(evaluateAuthenticationResults([dkim], "alice@customer.test", GMAIL)).toBe("pass")
  })

  it("does not pass on an unaligned DKIM signature", () => {
    const dkim = "mx.google.com; dkim=pass header.i=@bulkmailer.test header.s=s1"
    expect(evaluateAuthenticationResults([dkim], "alice@customer.test", GMAIL)).toBe("none")
  })

  it("strips nested comments before parsing", () => {
    const nested =
      "mx.google.com; dmarc=pass (p=NONE (nested; dmarc=fail)) header.from=customer.test"
    expect(evaluateAuthenticationResults([nested], "alice@customer.test", GMAIL)).toBe("pass")
  })

  it("is none without any header", () => {
    expect(evaluateAuthenticationResults(undefined, "alice@customer.test", GMAIL)).toBe("none")
  })
})

describe("senderAuthOf / trusted ids by path", () => {
  const prev = process.env.INBOUND_TRUSTED_AUTHSERV_IDS
  afterEach(() => {
    if (prev === undefined) delete process.env.INBOUND_TRUSTED_AUTHSERV_IDS
    else process.env.INBOUND_TRUSTED_AUTHSERV_IDS = prev
  })

  it("trusts Gmail's id only for messages fetched through the Gmail API", () => {
    delete process.env.INBOUND_TRUSTED_AUTHSERV_IDS
    expect(trustedAuthservIdsFor({ receivedVia: "gmail_api" })).toEqual(["mx.google.com"])
    expect(trustedAuthservIdsFor({ receivedVia: "imap" })).toEqual([])
    expect(trustedAuthservIdsFor({})).toEqual([])
  })

  it("an IMAP message carrying a sender-written Gmail header is not authenticated", () => {
    delete process.env.INBOUND_TRUSTED_AUTHSERV_IDS
    expect(
      senderAuthOf({
        from: { email: "alice@customer.test" },
        authenticationResults: [forgedPass],
        receivedVia: "imap",
      }),
    ).toBe("none")
  })

  it("an operator can trust their IMAP provider's id", () => {
    process.env.INBOUND_TRUSTED_AUTHSERV_IDS = "mx.provider.test"
    expect(
      senderAuthOf({
        from: { email: "alice@customer.test" },
        authenticationResults: ["mx.provider.test; dmarc=pass header.from=customer.test"],
        receivedVia: "imap",
      }),
    ).toBe("pass")
  })
})
