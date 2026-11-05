// SPDX-License-Identifier: FSL-1.1-ALv2
import { type EmailBody, markdownToEmail } from "@liaison/shared"

/**
 * The largest body converted: the 2 MB budget a mail message gets when it is
 * written (PAGE_WRITE_BYTE_BUDGET). The conversion runs on the main thread, so
 * a body no mail could carry is refused, not parsed.
 */
export const MAX_EMAIL_BODY_BYTES = 2_000_000

/**
 * What the customer receives. A body is written as markdown or plain text (a
 * composer, an agent, an approver's edit) and goes out as email HTML with its
 * text alternative, the conversion the browser previews with. Plain text
 * comes out exactly as typed. HTML a caller composed itself is kept.
 */
export function emailBody(body: { htmlBody?: string; textBody?: string }): EmailBody {
  const source = body.textBody ?? ""
  if (Buffer.byteLength(source, "utf8") > MAX_EMAIL_BODY_BYTES) {
    throw new Error(`email body over ${MAX_EMAIL_BODY_BYTES} bytes`)
  }
  const converted = markdownToEmail(source)
  return body.htmlBody?.trim() ? { ...converted, html: body.htmlBody } : converted
}
