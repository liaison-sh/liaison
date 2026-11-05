// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { renderBrandedEmail } from "~/infra/email-layout"

describe("renderBrandedEmail", () => {
  it("renders a self-contained branded HTML document with the default wordmark", () => {
    const { html } = renderBrandedEmail({
      subject: "Reset your password",
      heading: "Reset your password",
      paragraphs: ["We received a request to reset your password."],
    })
    expect(html).toStartWith("<!doctype html>")
    // Brand wordmark present, defaulting to Liaison.
    expect(html).toContain(">Liaison<")
    // Visual system carried over from the digest (warm canvas + dark-mode block).
    expect(html).toContain("background:#f6f5f0")
    expect(html).toContain("prefers-color-scheme: dark")
    // Self-contained: no external assets.
    expect(html).not.toContain("<img")
    expect(html).not.toContain("http://")
  })

  it("allows overriding the brand wordmark for generic self-hosters", () => {
    const { html, text } = renderBrandedEmail({
      subject: "Hi",
      heading: "Hi",
      paragraphs: ["Body."],
      brand: "Acme Support",
    })
    expect(html).toContain(">Acme Support<")
    expect(text).toStartWith("Acme Support")
    expect(html).not.toContain(">Liaison<")
  })

  it("escapes user-controlled content in every slot", () => {
    const { html } = renderBrandedEmail({
      subject: "<x>",
      eyebrow: "<e>",
      heading: "<b>boom</b>",
      paragraphs: ["<script>alert(1)</script>", "quote \" and '"],
      footer: ["<i>foot</i>"],
      cta: { label: "<click>", href: "https://example.com/x" },
    })
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).toContain("&lt;b&gt;boom&lt;/b&gt;")
    expect(html).toContain("&lt;click&gt;")
    // The trusted CTA href is interpolated raw so the link still works.
    expect(html).toContain('href="https://example.com/x"')
  })

  it("renders the CTA button and footer only when provided", () => {
    const withCta = renderBrandedEmail({
      subject: "s",
      heading: "h",
      paragraphs: ["p"],
      cta: { label: "Go", href: "https://example.com/go" },
      footer: ["small print"],
    })
    expect(withCta.html).toContain("https://example.com/go")
    expect(withCta.html).toContain('class="cta"')
    expect(withCta.html).toContain("small print")
    expect(withCta.text).toContain("Go: https://example.com/go")
    expect(withCta.text).toContain("small print")

    const without = renderBrandedEmail({ subject: "s", heading: "h", paragraphs: ["p"] })
    expect(without.html).not.toContain('class="cta"')
    expect(without.html).not.toContain("<hr")
  })

  it("produces a plain-text variant mirroring the content in order", () => {
    const { text } = renderBrandedEmail({
      subject: "s",
      eyebrow: "Security",
      heading: "Reset your password",
      paragraphs: ["First.", "Second."],
      cta: { label: "Reset", href: "https://example.com/r" },
    })
    expect(text).toContain("SECURITY")
    expect(text).toContain("Reset your password")
    expect(text).toContain("First.")
    expect(text).toContain("Second.")
    expect(text).toContain("Reset: https://example.com/r")
    // Heading appears before the body, body before the CTA.
    expect(text.indexOf("Reset your password")).toBeLessThan(text.indexOf("First."))
    expect(text.indexOf("Second.")).toBeLessThan(text.indexOf("Reset: https"))
  })

  it("shows a one-time code the way mail clients detect it: labelled, unbroken, in the preheader and first", () => {
    const { html, text } = renderBrandedEmail({
      subject: "123456 is your Liaison sign-in code",
      heading: "Your sign-in code",
      code: "123456",
      paragraphs: ["Enter it to sign in."],
    })
    // The digits are one run, right after the label, with nothing between them.
    expect(html).toMatch(/Your verification code is<\/p>\s*<p[^>]*>123456<\/p>/)
    // The preheader (inbox preview) says it too, before the body.
    expect(html).toContain(">Your verification code is 123456</div>")
    expect(html.indexOf("123456</p>")).toBeLessThan(html.indexOf("Enter it to sign in."))
    // The text part: the code line comes before the body.
    expect(text).toContain("Your verification code is 123456")
    expect(text.indexOf("Your verification code is 123456")).toBeLessThan(
      text.indexOf("Enter it to sign in."),
    )
  })

  it("renders no code block without a code", () => {
    const { html, text } = renderBrandedEmail({ subject: "s", heading: "h", paragraphs: ["p"] })
    expect(html).not.toContain("Your verification code is")
    expect(text).not.toContain("Your verification code is")
  })
})
