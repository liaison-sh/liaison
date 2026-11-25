// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client report's mail: system mail from the org, Reply-To the person who
// approved it, carrying exactly the text that went out (the same words the
// client's portal shows). Never a connected mailbox, so the body is not synced
// back where agents read.

import { randomBytes } from "node:crypto"
import { sendSystemEmailObserved } from "~/infra/email"
import { renderBrandedEmail } from "~/infra/email-layout"
import { rootLogger } from "~/lib/logger"
import { isDemoFixtureDelivery } from "~/modules/demo/fixture-delivery"
import { getOrgEmailConfig } from "~/modules/org/email-from"

export const CLIENT_REPORT_MAIL_HEADER = "X-Liaison-Client-Report"

/** Sends one report and answers its mail id (also the header's value). */
export async function sendClientReportMail(input: {
  orgId: string
  replyTo: string | null
  to: string
  subject: string
  text: string
  reportId: string
}): Promise<string> {
  const mailId = randomBytes(16).toString("hex")
  // A demo workspace's clients are fictional, on reserved domains no mailbox can own: a report
  // whose every recipient (the reply-to included) is on one is recorded as delivered, with no
  // network and no provider. One real address and the send goes the usual way, and a demo box
  // refuses it.
  if (await isDemoFixtureDelivery(input.orgId, [input.to, input.replyTo])) {
    rootLogger.info(
      { orgId: input.orgId, reportId: input.reportId, mailId },
      "client report recorded as delivered to a fictional client (demo)",
    )
    return mailId
  }
  const cfg = await getOrgEmailConfig(input.orgId)
  const paragraphs = input.text.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  const { html, text } = renderBrandedEmail({
    subject: input.subject,
    heading: input.subject,
    paragraphs,
  })
  await sendSystemEmailObserved({
    to: input.to,
    from: cfg.from,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    subject: input.subject,
    html,
    text,
    template: "projects.client-report",
    headers: { [CLIENT_REPORT_MAIL_HEADER]: mailId },
  })
  return mailId
}
