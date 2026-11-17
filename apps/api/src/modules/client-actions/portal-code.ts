// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The emailed code a portal person asks before they sign (or decide in a session
// past 12 hours): only the invited person, under the same budgets as the link's
// page, mailed to the invited address only. The raw code goes to the mail alone.

import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import type { PortalCaller } from "~/modules/portal/decide-gate"
import { issueCode, pausedUntil, takeCodeSend } from "./codes"
import { deadFrameBody, frameOf, portalDecideGate, viewOf } from "./decide"
import { writeClientActionEvent } from "./events"
import { maskEmail, newActionMailId, sendCodeMail } from "./mail"

const log = rootLogger.child({ module: "client-actions" })

export type PortalCodeAnswer = { status: number; body: Record<string, unknown> }

export async function sendPortalActionCode(input: {
  portal: PortalCaller
  actionId: string
  ip: string | null
  userAgent: string | null
}): Promise<PortalCodeAnswer> {
  const gate = await portalDecideGate(input.portal, input.actionId)
  if (!gate.ok) return { status: gate.status, body: gate.body }
  const row = gate.row
  const frame = frameOf(row, "current")
  if (frame !== "open") return { status: 410, body: deadFrameBody(row, frame) }
  if (env.LIAISON_DEMO_MODE) return { status: 403, body: { error: { code: "NO_MAIL_ON_DEMO" } } }
  const until = await pausedUntil(row.id)
  if (until)
    return { status: 423, body: { error: { code: "paused", retry_at: until.toISOString() } } }
  const budget = await takeCodeSend(row.id)
  if (!budget.ok) {
    return {
      status: 429,
      body: { error: { code: "rate_limited", retry_at: budget.retryAt.toISOString() } },
    }
  }
  const view = await viewOf(row)
  if (view === "down") return { status: 503, body: { state: "down" } }
  const code = await issueCode(row.id)
  const mailId = newActionMailId()
  try {
    await sendCodeMail({
      orgId: row.org_id,
      to: row.invited_email,
      mailId,
      title: view.title,
      kind: row.kind,
      code,
      orgName: row.org_name,
      locale: row.sender_locale,
    })
  } catch (err) {
    log.error({ err, actionId: row.id }, "portal client action code mail failed")
    return { status: 502, body: { error: { code: "send_failed" } } }
  }
  await withPrivilegedDb(row.org_id, "client-action-portal-code", (tx) =>
    writeClientActionEvent(tx, {
      orgId: row.org_id,
      actionId: row.id,
      event: "code_sent",
      actorKind: "portal_user",
      actorUserId: input.portal.userId,
      mailId,
      ip: input.ip,
      userAgent: input.userAgent,
    }),
  )
  return {
    status: 202,
    body: {
      sent_to: maskEmail(row.invited_email),
      next_at: new Date(Date.now() + 60_000).toISOString(),
    },
  }
}
