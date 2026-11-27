// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `kernel:notifications_email_send`: an app's customer mail through the organization's
// transactional sender (the one invitations and survey mails use: `settings.email.from`, the
// managed edition's verified org sender), for an app that has no connected mailbox to send from.
// Invoicing's thank-you mail of a sale is the first caller.
//
// Who may call it: an app whose `cross_app_calls` names it, approved at install. It is internal
// (no person, agent or MCP client reaches it) and hidden from agents. Files go with the mail only
// when the caller can read them under its own context (same check as `files_merge_pdfs`); inline
// images (`cid:`) are files too. The mail goes out on the default (customer) channel, never the
// system channel that sign-in codes use.
import { sql } from "drizzle-orm"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { type EmailAttachment, getEmailProvider, sendEmailOnce } from "~/infra/email"
import { getObjectBuffer as defaultGetObjectBuffer } from "~/infra/storage/object-storage"
import { toolRegistry } from "~/modules/apps/app-registries"
import { getOrgEmailConfig, getOrgSenderTransport } from "~/modules/org/email-from"

const K = sql.raw(schemaRef("kernel"))

/** The files of one mail, all together: a few invoice PDFs and a logo. */
export const NOTIFICATIONS_MAIL_MAX_BYTES = 20 * 1024 * 1024
const CONTENT_ID = /^[A-Za-z0-9._-]{1,64}$/

export const notificationsEmailParams = z.object({
  to: z.string().trim().email(),
  subject: z.string().trim().min(1).max(500),
  textBody: z.string().max(100_000),
  htmlBody: z.string().max(500_000).optional(),
  /** The address replies go to (an issuer's own address); else the org's `email.replyTo`. */
  replyTo: z.string().trim().email().optional(),
  attachments: z.array(z.string().uuid()).max(10).optional(),
  inlineImages: z
    .array(z.object({ fileId: z.string().uuid(), contentId: z.string().regex(CONTENT_ID) }))
    .max(5)
    .optional(),
  /** Sent once per key: a re-run of the caller's job does not mail the buyer twice. */
  idempotencyKey: z.string().min(1).max(200).optional(),
})

export type NotificationsEmailParams = z.infer<typeof notificationsEmailParams>

interface NotificationsMailCtx {
  orgId: string
  db: RlsClient
}

export interface NotificationsMailDeps {
  getObjectBuffer?: (key: string) => Promise<Buffer | Uint8Array>
}

type Result =
  | { sent: true; from: string; to: string }
  | { error: { code: "file_not_found" | "attachments_too_large" | "send_failed"; message: string } }

export async function handleNotificationsEmailSend(
  raw: unknown,
  ctx: NotificationsMailCtx,
  deps: NotificationsMailDeps = {},
): Promise<Result> {
  const params = notificationsEmailParams.parse(raw)
  const inline = new Map((params.inlineImages ?? []).map((i) => [i.fileId, i.contentId]))
  const ids = [...new Set([...(params.attachments ?? []), ...inline.keys()])]
  const attachments: EmailAttachment[] = []
  if (ids.length > 0) {
    // Under the caller's own context: a file it cannot see is absent, and refuses the mail.
    const rows = (await ctx.db.execute<Record<string, unknown>>(
      sql`SELECT id::text AS id, filename, mime_type AS "mimeType",
                 size_bytes AS "sizeBytes", storage_key AS "storageKey"
          FROM ${K}.files
          WHERE id::text IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )}) AND org_id = ${ctx.orgId}`,
    )) as unknown as Array<{
      id: string
      filename: string
      mimeType: string
      sizeBytes: number
      storageKey: string
    }>
    const byId = new Map(rows.map((r) => [r.id, r]))
    const missing = ids.filter((id) => !byId.has(id))
    if (missing.length > 0) {
      return {
        error: { code: "file_not_found", message: `File(s) not readable: ${missing.join(", ")}` },
      }
    }
    const total = rows.reduce((s, r) => s + Number(r.sizeBytes ?? 0), 0)
    if (total > NOTIFICATIONS_MAIL_MAX_BYTES) {
      return {
        error: {
          code: "attachments_too_large",
          message: `The files weigh ${total} bytes, over ${NOTIFICATIONS_MAIL_MAX_BYTES}.`,
        },
      }
    }
    const read = deps.getObjectBuffer ?? defaultGetObjectBuffer
    for (const id of ids) {
      const row = byId.get(id)
      if (!row) continue
      const contentId = inline.get(id)
      // A file both attached and shown inline goes once, inline.
      attachments.push({
        filename: row.filename,
        contentType: row.mimeType,
        content: new Uint8Array(await read(row.storageKey)),
        ...(contentId ? { contentId } : {}),
      })
    }
  }
  // The managed edition's org sender when it has one; otherwise the org's `email.from` (else the
  // deployment's EMAIL_FROM) on the default channel.
  const [orgSender, cfg] = await Promise.all([
    getOrgSenderTransport(ctx.orgId),
    getOrgEmailConfig(ctx.orgId),
  ])
  const from = orgSender?.from ?? cfg.from
  const replyTo = params.replyTo ?? cfg.replyTo
  try {
    await sendEmailOnce(ctx.orgId, orgSender?.provider ?? getEmailProvider(), {
      to: params.to,
      from,
      subject: params.subject,
      template: "apps.notification",
      text: params.textBody,
      html: params.htmlBody ?? plainHtml(params.textBody),
      ...(replyTo ? { replyTo } : {}),
      // Namespaced, so an app's key can never claim a kernel mail's key.
      ...(params.idempotencyKey
        ? { idempotencyKey: `app-notification:${params.idempotencyKey}` }
        : {}),
      ...(attachments.length ? { attachments } : {}),
    })
  } catch (err) {
    return { error: { code: "send_failed", message: String((err as Error)?.message ?? err) } }
  }
  return { sent: true, from, to: params.to }
}

function plainHtml(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
  return `<div style="white-space:pre-wrap;font-family:sans-serif">${esc}</div>`
}

export function registerNotificationsEmailTool(orgId: string): void {
  toolRegistry.set([orgId, "kernel", "notifications_email_send"], {
    appName: "kernel",
    name: "notifications_email_send",
    deferLoading: true,
    agentVisible: false,
    // Only an app that declared it in cross_app_calls, approved at install (execute-tool.ts).
    trustBoundary: "internal",
    description:
      "Internal: send one mail to one recipient through the organization's transactional sender (its email.from), for an app with no mailbox to send from. Files are kernel file ids the caller can read; inline images are shown with cid:<contentId>.",
    requiredScopes: ["kernel:org:admin"],
    params: notificationsEmailParams,
    handler: handleNotificationsEmailSend as (params: unknown, ctx: any) => Promise<unknown>,
  })
}
