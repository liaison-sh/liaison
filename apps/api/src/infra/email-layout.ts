// SPDX-License-Identifier: FSL-1.1-ALv2
import { escapeHtml } from "~/infra/email"

/**
 * Shared, Liaison-branded HTML layout for transactional emails (password reset,
 * invitations, CSAT surveys, and any future one-off message).
 *
 * This is the same visual system as the attention digest
 * (`modules/attention/digest.ts`): a warm off-white canvas, an editorial serif
 * wordmark + headline, a bordered white card for the body copy, an optional
 * solid CTA button, and a muted footer -- with a `prefers-color-scheme: dark`
 * variant. Routing every transactional send through this one function keeps the
 * whole product's mail consistent and on-brand.
 *
 * Constraints (carried over from the digest, for broad client support):
 *   1. Table layout + inline styles -- Outlook 2007-2019 ignore <style>.
 *   2. The <style> block only carries dark-mode + :hover enhancements that are
 *      safe to lose.
 *   3. No external assets -- self-contained, no image / webfont / tracking pixel.
 *      The wordmark is text-only.
 *   4. 560 px content column on a 600 px wrapper for comfortable margins.
 *
 * Trusted vs untrusted inputs:
 *   - `heading`, `eyebrow`, `paragraphs[*]`, `footer[*]`, `cta.label`, `brand`,
 *     and `preview` are all passed through `escapeHtml`; callers may hand them
 *     raw user-controlled strings.
 *   - `cta.href` is interpolated RAW into the href (like the digest's links).
 *     Callers must pass a URL-safe, HTML-safe link -- in practice these are
 *     `${BASE_URL}/...` with opaque base64url / UUID tokens, which contain no
 *     HTML metacharacters.
 */
export interface BrandedEmailContent {
  /** Document <title>; should match the email subject. */
  subject: string
  /** Small uppercase mono kicker above the headline (e.g. "Security"). Optional. */
  eyebrow?: string
  /** Serif headline. */
  heading: string
  /**
   * A one-time code (digits). Shown first in the card, large, as one unbroken
   * run of digits after "Your verification code is", and repeated in the
   * preheader and the first line of the text part: the wording and layout mail
   * clients (Gmail's "Copy code") recognise as a code to offer one-tap copy.
   */
  code?: string
  /** Body paragraphs, rendered in order inside the card. */
  paragraphs: string[]
  /** Optional primary call-to-action button below the card. */
  cta?: { label: string; href: string }
  /** Optional small-print footer lines below the divider. */
  footer?: string[]
  /** Header wordmark / product name. Defaults to "Liaison". */
  brand?: string
  /** Hidden inbox-preview (preheader) text. Defaults to the first paragraph. */
  preview?: string
}

export interface RenderedEmail {
  html: string
  text: string
}

const SERIF = "'Charter','Iowan Old Style','Georgia',serif"
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
const MONO = "'SF Mono','Menlo','Consolas',monospace"

/** Render a Liaison-branded transactional email (HTML + plain-text variants). */
export function renderBrandedEmail(content: BrandedEmailContent): RenderedEmail {
  const brand = content.brand ?? "Liaison"
  const codeLine = content.code ? `Your verification code is ${content.code}` : null
  const preview = content.preview ?? codeLine ?? content.paragraphs[0] ?? ""

  // The code: no letter-spacing, no spans between digits, so selecting or
  // detecting it yields exactly the code.
  const codeHtml = content.code
    ? `<p class="muted" style="margin:0 0 6px 0;font-family:${SANS};font-size:13px;line-height:1.4;color:#7a786f;">Your verification code is</p>
        <p class="body-text" style="margin:0 0 18px 0;font-family:${MONO};font-size:30px;font-weight:600;line-height:1.2;color:#15171a;-webkit-user-select:all;user-select:all;">${escapeHtml(
          content.code,
        )}</p>`
    : ""

  const eyebrowHtml = content.eyebrow
    ? `<tr><td style="padding:0 4px 8px 4px;">
        <div class="meta" style="font-family:${MONO};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#7a786f;">${escapeHtml(
          content.eyebrow,
        )}</div>
      </td></tr>`
    : ""

  const paragraphsHtml = content.paragraphs
    .map(
      (p) =>
        `<p class="body-text" style="margin:0 0 14px 0;font-family:${SERIF};font-size:16px;line-height:1.5;color:#15171a;">${escapeHtml(
          p,
        )}</p>`,
    )
    .join("")

  const ctaHtml = content.cta
    ? `<tr><td align="center" style="padding:28px 4px 0 4px;">
        <a href="${content.cta.href}" class="cta" style="display:inline-block;font-family:${SANS};font-size:13px;font-weight:600;letter-spacing:0.01em;color:#ffffff;background:#15171a;text-decoration:none;padding:11px 22px;border-radius:4px;">${escapeHtml(
          content.cta.label,
        )} &rarr;</a>
      </td></tr>`
    : ""

  const footerHtml =
    content.footer && content.footer.length > 0
      ? `<tr><td style="padding:36px 4px 0 4px;">
        <hr class="divider" style="border:none;border-top:1px solid #e7e6e1;margin:0 0 16px 0;" />
        <p class="muted" style="margin:0;font-family:${SANS};font-size:11.5px;line-height:1.55;color:#7a786f;">${content.footer
          .map((f) => escapeHtml(f))
          .join("<br />")}</p>
      </td></tr>`
      : ""

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(content.subject)}</title>
<style>
  @media (prefers-color-scheme: dark) {
    body, .bg { background:#0f1014 !important; }
    .card { background:#191a1f !important; border-color:#26262c !important; }
    .body-text { color:#cdcdd4 !important; }
    .muted, .meta { color:#8a8a92 !important; }
    .cta { background:#cdcdd4 !important; color:#0f1014 !important; }
    .divider { border-color:#26262c !important; }
  }
  .cta:hover { opacity:0.92 !important; }
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:#f6f5f0;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preview)}</div>
<table class="bg" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f5f0;">
  <tr><td align="center" style="padding:32px 16px 48px 16px;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:100%;">

      <!-- Header -->
      <tr><td style="padding:0 4px 22px 4px;">
        <div class="body-text" style="font-family:${SERIF};font-size:18px;font-weight:600;letter-spacing:-0.01em;color:#15171a;">${escapeHtml(
          brand,
        )}</div>
      </td></tr>

      ${eyebrowHtml}

      <!-- Headline -->
      <tr><td style="padding:0 4px 18px 4px;">
        <h1 class="body-text" style="margin:0;font-family:${SERIF};font-size:24px;font-weight:500;line-height:1.25;color:#15171a;letter-spacing:-0.01em;">${escapeHtml(
          content.heading,
        )}</h1>
      </td></tr>

      <!-- Card with body copy -->
      <tr><td>
        <table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e7e6e1;border-radius:6px;">
          <tr><td style="padding:22px 22px 8px 22px;">
            ${codeHtml}
            ${paragraphsHtml}
          </td></tr>
        </table>
      </td></tr>

      ${ctaHtml}

      ${footerHtml}

    </table>
  </td></tr>
</table>
</body>
</html>`

  const textParts = [brand, ""]
  if (content.eyebrow) textParts.push(content.eyebrow.toUpperCase(), "")
  textParts.push(content.heading, "")
  if (codeLine) textParts.push(codeLine, "")
  textParts.push(...content.paragraphs)
  if (content.cta) {
    textParts.push("", `${content.cta.label}: ${content.cta.href}`)
  }
  if (content.footer && content.footer.length > 0) {
    textParts.push("", ...content.footer)
  }
  const text = textParts.join("\n")

  return { html, text }
}
