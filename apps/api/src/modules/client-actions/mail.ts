// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The three client action mails: the link, the code and the copy. System mail
// only, never a connected mailbox (a link sent from one would be stored in
// app_mail and synced back from Sent, where agents read). From the org, Reply-To
// the sender on the link and the copy, none on the code. Each carries
// `X-Liaison-Action-Mail: <128-bit random>`, the id stored on its event, so a
// synced copy of it is recognised and dropped. No subject holds client text.

import { randomBytes } from "node:crypto"
import { toShippedLocale } from "@liaison/shared"
import { sendSystemEmailObserved } from "~/infra/email"
import { renderBrandedEmail } from "~/infra/email-layout"
import { rootLogger } from "~/lib/logger"
import { orgAppBaseUrl } from "~/lib/org-public-url"
import { isDemoFixtureDelivery } from "~/modules/demo/fixture-delivery"
import { serverT } from "~/modules/i18n/server-i18n"
import { getOrgEmailConfig } from "~/modules/org/email-from"
import type { ClientActionKind } from "./targets"

const log = rootLogger.child({ module: "client-actions" })

export const ACTION_MAIL_HEADER = "X-Liaison-Action-Mail"

/** A fresh mail id: what the header and the event's `mail_id` hold. */
export function newActionMailId(): string {
  return randomBytes(16).toString("hex")
}

/** `p…@example.com`: what the page shows of the address a mail went to. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@")
  return `${local.slice(0, 1)}…@${domain}`
}

function tr(locale: string | null | undefined) {
  const lang = toShippedLocale(locale ?? undefined) ?? "en"
  return {
    lang,
    t: (key: string, params: Record<string, string> = {}) =>
      serverT(lang, `client-action.${key}`, params),
  }
}

/** The page's link: the token in the fragment, never sent to a server or a referrer. */
export async function actionLink(orgId: string, token: string): Promise<string> {
  const base = await orgAppBaseUrl(orgId)
  return `${base}/a#t=${encodeURIComponent(token)}`
}

interface Common {
  orgId: string
  to: string
  mailId: string
  title: string
  kind: ClientActionKind
  locale?: string | null
}

async function send(
  orgId: string,
  msg: { to: string; subject: string; html: string; text: string; mailId: string },
  template:
    | "client-action.link"
    | "client-action.code"
    | "client-action.copy"
    | "client-action.staff",
  replyTo: string | null,
): Promise<void> {
  // A demo workspace's clients are fictional, on reserved domains no mailbox can own: a mail
  // whose every recipient (the reply-to included) is on one is recorded as sent, with no network
  // and no provider. One real address and the send goes the usual way, and a demo box refuses it.
  if (await isDemoFixtureDelivery(orgId, [msg.to, replyTo])) {
    log.info(
      { orgId, template, mailId: msg.mailId },
      "client action mail recorded as delivered to a fictional recipient (demo)",
    )
    return
  }
  const cfg = await getOrgEmailConfig(orgId)
  await sendSystemEmailObserved({
    to: msg.to,
    from: cfg.from,
    ...(replyTo ? { replyTo } : {}),
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    template,
    headers: { [ACTION_MAIL_HEADER]: msg.mailId },
  })
}

/** The link mail. Resolves when sent; the caller does not await it on a mint. */
export async function sendLinkMail(
  input: Common & {
    token: string
    orgName: string
    senderName: string
    senderEmail: string | null
    expiresAt: Date
    message?: string | null
    resend?: boolean
  },
): Promise<void> {
  const { t } = tr(input.locale)
  const verb = t(`verb.${input.kind}`)
  const p = {
    org: input.orgName,
    sender: input.senderName,
    verb,
    title: input.title,
    email: input.to,
    until: input.expiresAt.toISOString().slice(0, 10),
    message: input.message ?? "",
  }
  const href = await actionLink(input.orgId, input.token)
  const subject = input.resend ? t("mail.resend.subject", p) : t("mail.link.subject", p)
  const paragraphs = input.resend
    ? [t("mail.resend.body", p), t("mail.link.safety", p)]
    : [
        t("mail.link.body", p),
        ...(input.message ? [t("mail.link.message", p)] : []),
        t("mail.link.safety", p),
      ]
  const { html, text } = renderBrandedEmail({
    subject,
    brand: input.orgName,
    eyebrow: t("mail.link.eyebrow", p),
    heading: input.title,
    paragraphs,
    cta: { label: input.resend ? t("mail.resend.cta", p) : t("mail.link.cta", p), href },
    footer: [t("mail.link.footer", p)],
  })
  await send(
    input.orgId,
    { to: input.to, subject, html, text, mailId: input.mailId },
    "client-action.link",
    input.senderEmail,
  )
}

/** The code mail: names the document and what entering the code means; no Reply-To. */
export async function sendCodeMail(
  input: Common & { code: string; orgName: string },
): Promise<void> {
  const { t } = tr(input.locale)
  const p = {
    org: input.orgName,
    verb: t(`verb.${input.kind}`),
    title: input.title,
    code: input.code,
  }
  const subject = t("mail.code.subject", p)
  const { html, text } = renderBrandedEmail({
    subject,
    brand: input.orgName,
    eyebrow: t("mail.code.eyebrow", p),
    heading: input.title,
    code: input.code,
    paragraphs: [t("mail.code.body", p), t("mail.code.safety", p)],
    footer: [t("mail.code.footer", p)],
  })
  await send(
    input.orgId,
    { to: input.to, subject, html, text, mailId: input.mailId },
    "client-action.code",
    null,
  )
}

/** The copy of a decision, to the invited address only. */
export async function sendCopyMail(
  input: Common & {
    orgName: string
    decision: string
    decidedAt: Date
    senderEmail: string | null
  },
): Promise<void> {
  const { t } = tr(input.locale)
  const p = {
    org: input.orgName,
    title: input.title,
    decision: t(`decision.${input.decision}`),
    at: input.decidedAt.toISOString().slice(0, 10),
  }
  const subject = t("mail.copy.subject", p)
  const { html, text } = renderBrandedEmail({
    subject,
    brand: input.orgName,
    heading: input.title,
    paragraphs: [t("mail.copy.body", p)],
    footer: [t("mail.copy.footer", p)],
  })
  await send(
    input.orgId,
    { to: input.to, subject, html, text, mailId: input.mailId },
    "client-action.copy",
    input.senderEmail,
  ).catch((err) => {
    log.error({ err, orgId: input.orgId }, "client action copy mail failed")
    throw err
  })
}

/**
 * A member of the org who is a signer gets no link by mail: this says "Open
 * Liaison, Read and sign" and nothing else. Their link is made in their own
 * signed-in session (`my-link`), so a forwarded or synced copy opens nothing.
 */
export async function sendStaffTurnMail(
  input: Common & { orgName: string; senderName: string },
): Promise<void> {
  const { t } = tr(input.locale)
  const p = {
    org: input.orgName,
    sender: input.senderName,
    verb: t(`verb.${input.kind}`),
    title: input.title,
  }
  const subject = t("mail.staff.subject", p)
  const { html, text } = renderBrandedEmail({
    subject,
    brand: input.orgName,
    heading: input.title,
    paragraphs: [t("mail.staff.body", p)],
    footer: [t("mail.staff.footer", p)],
  })
  await send(
    input.orgId,
    { to: input.to, subject, html, text, mailId: input.mailId },
    "client-action.staff",
    null,
  )
}
