// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  encodeAddressString,
  encodeDisplayName,
  encodeHeaderValue,
  formatMailbox,
} from "./header-encoding"

/** Decode a value made of RFC 2047 B encoded words (as a mail client would). */
function decodeEncodedWords(value: string): string {
  const words = value.split("\r\n ")
  const bytes: number[] = []
  for (const word of words) {
    const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(word)
    if (!m) throw new Error(`not an encoded word: ${word}`)
    bytes.push(...Buffer.from(m[1] ?? "", "base64"))
  }
  return Buffer.from(bytes).toString("utf8")
}

describe("encodeHeaderValue", () => {
  it("passes plain ASCII through unchanged", () => {
    expect(encodeHeaderValue("Re: Hello world")).toBe("Re: Hello world")
    expect(encodeHeaderValue("  padded  ")).toBe("padded")
  })

  it("encodes a non-ASCII subject as ASCII encoded words that decode back", () => {
    const subject = "Liaison : accès aux stats Instagram de @shop"
    const encoded = encodeHeaderValue(subject)
    expect(encoded).toMatch(/^[\x20-\x7e\r\n]+$/)
    expect(encoded.startsWith("=?UTF-8?B?")).toBe(true)
    expect(decodeEncodedWords(encoded)).toBe(subject)
  })

  it("splits long values into words of at most 75 chars without splitting a UTF-8 sequence", () => {
    const subject = `${"é".repeat(30)} ${"日本語".repeat(10)} 🎉🎉🎉 ${"x".repeat(50)} ñ`
    const encoded = encodeHeaderValue(subject)
    const words = encoded.split("\r\n ")
    expect(words.length).toBeGreaterThan(2)
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75)
      // Each word must decode to valid UTF-8 on its own (no split sequence).
      const decoded = decodeEncodedWords(word)
      expect(decoded).not.toContain("�")
    }
    expect(`Subject: ${words[0]}`.length).toBeLessThanOrEqual(76)
    expect(decodeEncodedWords(encoded)).toBe(subject)
  })

  it("still strips CR/LF injection", () => {
    expect(encodeHeaderValue("Hi\r\nBcc: evil@x.test")).toBe("Hi Bcc: evil@x.test")
    const encoded = encodeHeaderValue("accès\r\nBcc: evil@x.test")
    expect(decodeEncodedWords(encoded)).toBe("accès Bcc: evil@x.test")
    expect(encoded.split("\r\n ").every((w) => w.startsWith("=?UTF-8?B?"))).toBe(true)
  })
})

describe("display names", () => {
  it("keeps plain ASCII names bare, quotes specials, encodes non-ASCII", () => {
    expect(encodeDisplayName("Alice Martin")).toBe("Alice Martin")
    expect(encodeDisplayName("J. Doe")).toBe("J. Doe")
    expect(encodeDisplayName('Doe, "JD"')).toBe('"Doe, \\"JD\\""')
    expect(decodeEncodedWords(encodeDisplayName("Élodie Dupré"))).toBe("Élodie Dupré")
  })

  it("never encodes the addr-spec", () => {
    expect(formatMailbox("", "a@x.test")).toBe("a@x.test")
    expect(formatMailbox("Alice", "a@x.test")).toBe("Alice <a@x.test>")
    const mailbox = formatMailbox("Élodie", "e@x.test")
    expect(mailbox.endsWith(" <e@x.test>")).toBe(true)
    expect(decodeEncodedWords(mailbox.slice(0, -" <e@x.test>".length))).toBe("Élodie")
  })

  it("re-encodes a non-ASCII name inside a pre-formatted address string", () => {
    expect(encodeAddressString("Alice <a@x.test>")).toBe("Alice <a@x.test>")
    const out = encodeAddressString('"Élodie" <e@x.test>')
    expect(out).toMatch(/^=\?UTF-8\?B\?[^ ]+\?= <e@x\.test>$/)
    expect(decodeEncodedWords(out.replace(" <e@x.test>", ""))).toBe("Élodie")
  })
})
