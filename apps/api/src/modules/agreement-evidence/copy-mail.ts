// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A signer's copy of a signed agreement, by system mail: the signed PDF and the
// signer's copy of the evidence file attached, the document's fingerprint and
// the seal in the body, so each signer holds the proof outside the org's
// control. System mail only, never a connected mailbox: the copy is not stored
// in Mail. From the org, Reply-To the sender. Nothing in it is a link.

import { sendSystemEmailObserved } from "~/infra/email"
import { renderBrandedEmail } from "~/infra/email-layout"
import { serverT } from "~/modules/i18n/server-i18n"
import { getOrgEmailConfig } from "~/modules/org/email-from"
import { plainText, type SignatureLang } from "./signature-pages"

export interface CopyMailInput {
  orgId: string
  orgName: string
  to: string
  lang: SignatureLang
  agreement: string
  version: number
  title: string
  documentSha256: string
  seal: string
  timestamped: boolean
  senderEmail: string | null
  signedPdf: { filename: string; bytes: Uint8Array }
  copyZip: { filename: string; bytes: Uint8Array }
}

/** The mail words, from the `agreement-evidence` locale files, in the document's language. */
function wordsFor(lang: SignatureLang) {
  const t = (key: string, params?: Record<string, string | number>) =>
    serverT(lang, `agreement-evidence.copy.${key}`, params)
  return {
    subject: (agreement: string, version: number) => t("subject", { agreement, version }),
    body: (org: string, title: string) => t("body", { org, title }),
    fingerprint: (fingerprint: string) => t("fingerprint", { fingerprint }),
    seal: (seal: string) => t("seal", { seal }),
    pending: t("pending"),
    footer: t("footer"),
  }
}

/** Sends one signer's copy. Throws when the provider refuses, so the caller can count a failure. */
export async function sendSignedCopyMail(input: CopyMailInput): Promise<void> {
  const w = wordsFor(input.lang)
  const title = plainText(input.title)
  const subject = w.subject(plainText(input.agreement), input.version)
  const paragraphs: string[] = [
    w.body(plainText(input.orgName), title),
    w.fingerprint(input.documentSha256),
    w.seal(input.seal),
  ]
  if (!input.timestamped) paragraphs.push(w.pending)
  const { html, text } = renderBrandedEmail({
    subject,
    brand: input.orgName,
    heading: title,
    paragraphs,
    footer: [w.footer],
  })
  const cfg = await getOrgEmailConfig(input.orgId)
  await sendSystemEmailObserved({
    to: input.to,
    from: cfg.from,
    ...(input.senderEmail ? { replyTo: input.senderEmail } : {}),
    subject,
    html,
    text,
    template: "agreements.signed-copy",
    attachments: [
      {
        filename: input.signedPdf.filename,
        contentType: "application/pdf",
        content: input.signedPdf.bytes,
      },
      {
        filename: input.copyZip.filename,
        contentType: "application/zip",
        content: input.copyZip.bytes,
      },
    ],
  })
}
