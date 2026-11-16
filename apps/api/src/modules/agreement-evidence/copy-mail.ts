// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A signer's copy of a signed agreement, by system mail: the signed PDF and the
// signer's copy of the evidence file attached, the document's fingerprint and
// the seal in the body, so each signer holds the proof outside the org's
// control. System mail only, never a connected mailbox: the copy is not stored
// in Mail. From the org, Reply-To the sender. Nothing in it is a link.

import { sendSystemEmailObserved } from "~/infra/email"
import { renderBrandedEmail } from "~/infra/email-layout"
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

const WORDS = {
  en: {
    subject: (a: string, v: number) => `Your signed copy: ${a}, version ${v}`,
    body: (org: string, title: string) =>
      `Everyone has signed "${title}" with ${org}. Your copy of the signed document and of its evidence file are attached. Keep them: they let you check the document without ${org}.`,
    fingerprint: (fp: string) => `Fingerprint of the signed document (SHA-256): ${fp}`,
    seal: (s: string) => `Seal: ${s}`,
    pending: "The outside timestamp has not arrived yet; a stamped evidence file follows by mail.",
    footer: "This mail was sent for you to keep. It holds no link.",
  },
  fr: {
    subject: (a: string, v: number) => `Votre exemplaire signé : ${a}, version ${v}`,
    body: (org: string, title: string) =>
      `Tout le monde a signé « ${title} » avec ${org}. Votre exemplaire du document signé et de son fichier de preuve sont joints. Gardez-les : ils permettent de vérifier le document sans ${org}.`,
    fingerprint: (fp: string) => `Empreinte du document signé (SHA-256) : ${fp}`,
    seal: (s: string) => `Sceau : ${s}`,
    pending:
      "L'horodatage extérieur n'est pas encore arrivé ; un fichier de preuve horodaté suivra par mail.",
    footer: "Ce mail vous est envoyé pour le garder. Il ne contient aucun lien.",
  },
} as const

/** Sends one signer's copy. Throws when the provider refuses, so the caller can count a failure. */
export async function sendSignedCopyMail(input: CopyMailInput): Promise<void> {
  const w = WORDS[input.lang]
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
