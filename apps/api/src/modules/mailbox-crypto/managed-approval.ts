// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Gated mail sends from a server-managed mailbox: the drafted body, subject and
// note in the approval row are sealed under the mailbox's own key
// (`enc_version = 2`), exactly where a private mailbox's are sealed to the
// owner's identity (`approval-payload.ts`). An approval row and its outbox event
// are readable by whoever holds the approvals scope, so a plaintext draft there
// would show personal mail to an org admin.
//
// The owner reads the draft on the approval card (`revealManagedApprovalRows`)
// and approves it; the send runs with the draft opened in memory
// (`openManagedApprovalPayload`), plus the quoted originals the send needs. Only
// the mailbox's owner can do either: the opener refuses anyone else, which is
// the same rule a private mailbox's draft follows (only the owner's browser can
// open it).

import { mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"
import { writeAuditLog } from "~/modules/audit/service"
import {
  loadMailboxServerKey,
  loadOrCreateMailboxServerKeyPrivileged,
} from "~/modules/mailbox-crypto/managed-keys"
import {
  ManagedMailAccessError,
  openManagedMailRowsByAccount,
} from "~/modules/mailbox-crypto/managed-open"
import {
  MAILBOX_MANAGED_ENC_VERSION,
  openManaged,
  sealManaged,
} from "~/modules/mailbox-crypto/managed-seal"

export interface ManagedApprovalPart {
  outKey: "bodyCiphertext" | "htmlBodyCiphertext" | "noteCiphertext" | "subjectCiphertext"
  kind: "draftBody" | "draftSubject"
  suffix: string
  value: string
}

const PLAIN_KEY: Record<ManagedApprovalPart["outKey"], string> = {
  bodyCiphertext: "textBody",
  htmlBodyCiphertext: "htmlBody",
  noteCiphertext: "note",
  subjectCiphertext: "subject",
}

const PARTS: Array<Pick<ManagedApprovalPart, "outKey" | "kind" | "suffix">> = [
  { outKey: "bodyCiphertext", kind: "draftBody", suffix: "" },
  { outKey: "htmlBodyCiphertext", kind: "draftBody", suffix: ":html" },
  { outKey: "noteCiphertext", kind: "draftBody", suffix: ":note" },
  { outKey: "subjectCiphertext", kind: "draftSubject", suffix: "" },
]

/** The payload keys the managed seal adds; never handed to the tool. */
const MANAGED_KEYS = [
  "mailboxSealed",
  "bodyCiphertext",
  "htmlBodyCiphertext",
  "noteCiphertext",
  "subjectCiphertext",
  "contentKeyWrapped",
  "contentKeyEpk",
  "encKeyId",
  "encVersion",
  "subjectHash",
  "byteLength",
  "recipientCount",
  "mailboxQuoteMessageIds",
  "mailboxAccountId",
]

/** Seal an approval's draft parts under the managed mailbox's key. */
export async function sealManagedApprovalParts(input: {
  orgId: string
  accountId: string
  approvalRequestId: string
  parts: ManagedApprovalPart[]
}): Promise<Record<string, unknown>> {
  const dek = await loadOrCreateMailboxServerKeyPrivileged(input.orgId, input.accountId)
  try {
    const sealed = sealManaged({
      accountId: input.accountId,
      dek: dek.key,
      items: input.parts.map((part) => ({
        context: mailboxAad[part.kind](`${input.approvalRequestId}${part.suffix}`),
        plaintext: part.value,
      })),
    })
    const out: Record<string, unknown> = {
      contentKeyWrapped: sealed.contentKeyWrapped.toString("base64"),
      encKeyId: dek.keyVersion,
      encVersion: MAILBOX_MANAGED_ENC_VERSION,
      mailboxAccountId: input.accountId,
      mailboxSealed: true,
    }
    input.parts.forEach((part, i) => {
      out[part.outKey] = (sealed.items[i] as Buffer).toString("base64")
    })
    return out
  } finally {
    dek.key.fill(0)
  }
}

export function isManagedApprovalPayload(payload: Record<string, unknown> | null | undefined) {
  return (
    payload?.mailboxSealed === true &&
    Number(payload.encVersion) === MAILBOX_MANAGED_ENC_VERSION &&
    typeof payload.mailboxAccountId === "string"
  )
}

async function ownerOf(
  tx: { execute(q: unknown): Promise<unknown> },
  orgId: string,
  accountId: string,
) {
  const mail = drizzleSql.raw(quoteIdent(schemaRef("app_mail")))
  return extractRows<{ owner_id: string | null; owner_type: string }>(
    await tx.execute(drizzleSql`
      SELECT owner_id::text AS owner_id, owner_type FROM ${mail}.accounts
       WHERE id = ${accountId}::uuid AND org_id = ${orgId}::uuid`),
  )[0]
}

/** Open the draft parts of a managed approval, for the mailbox owner only. */
async function openDraft(
  payload: Record<string, unknown>,
  orgId: string,
  userId: string,
  approvalRequestId: string,
  why: "approval_view" | "approval_send",
): Promise<Record<string, string>> {
  const accountId = payload.mailboxAccountId as string
  return withPrivilegedDb(orgId, "mailbox-managed:approval", async (tx) => {
    const account = await ownerOf(tx, orgId, accountId)
    if (account?.owner_type !== "user" || account.owner_id !== userId) {
      throw new ManagedMailAccessError(
        `the draft of approval ${approvalRequestId} is sealed to its mailbox owner`,
      )
    }
    const dek = await loadMailboxServerKey(tx, orgId, accountId, Number(payload.encKeyId))
    try {
      const present = PARTS.filter((p) => typeof payload[p.outKey] === "string")
      const opened = openManaged({
        accountId,
        dek: dek.key,
        contentKeyWrapped: Buffer.from(String(payload.contentKeyWrapped), "base64"),
        fields: present.map((p) => ({
          context: mailboxAad[p.kind](`${approvalRequestId}${p.suffix}`),
          ciphertext: Buffer.from(String(payload[p.outKey]), "base64"),
        })),
      })
      const out: Record<string, string> = {}
      present.forEach((p, i) => {
        const value = opened[i]
        if (value != null) out[PLAIN_KEY[p.outKey]] = value
      })
      await writeAuditLog(tx, {
        orgId,
        actorId: userId,
        actorType: "user",
        app: "mail",
        entityType: "approval_requests",
        entityId: approvalRequestId,
        action: "mail.content.decrypt",
        metadata: { purpose: why, accountId },
      })
      return out
    } finally {
      dek.key.fill(0)
    }
  })
}

/**
 * The executable payload of an approved send from a managed mailbox: the draft
 * opened in memory and the quoted originals the send assembles, for the owner
 * deciding it. Nothing here is written anywhere.
 */
export async function openManagedApprovalPayload(input: {
  payload: Record<string, unknown>
  orgId: string
  deciderId: string
  approvalRequestId: string
}): Promise<Record<string, unknown>> {
  const { payload, orgId, deciderId, approvalRequestId } = input
  const draft = await openDraft(payload, orgId, deciderId, approvalRequestId, "approval_send")
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (!MANAGED_KEYS.includes(key)) out[key] = value
  }
  Object.assign(out, draft)
  const quoteIds = Array.isArray(payload.mailboxQuoteMessageIds)
    ? (payload.mailboxQuoteMessageIds as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : []
  if (quoteIds.length > 0) {
    const mail = drizzleSql.raw(quoteIdent(schemaRef("app_mail")))
    const rows = await withPrivilegedDb(orgId, "mailbox-managed:approval-quote", async (tx) =>
      extractRows<Record<string, unknown> & { id: string }>(
        await tx.execute(drizzleSql`
          SELECT * FROM ${mail}.messages WHERE org_id = ${orgId}::uuid
             AND id IN (${drizzleSql.join(
               quoteIds.map((id) => drizzleSql`${id}::uuid`),
               drizzleSql`, `,
             )})`),
      ),
    )
    const opened = await openManagedMailRowsByAccount({
      orgId,
      entity: "messages",
      rows,
      actor: { userId: deciderId },
      purpose: { kind: "tool", tool: "approval_quote" },
    })
    const quote: Record<string, { quotedBody: string | null; resolvedSubject: string | null }> = {}
    for (const [id, fields] of opened) {
      quote[id] = { quotedBody: fields.textBody ?? null, resolvedSubject: fields.subject ?? null }
    }
    if (Object.keys(quote).length > 0) out.__mailboxQuote = quote
  }
  return out
}

/**
 * Approval summaries as the owner sees them on the card: a managed draft opened
 * for its owner, sealed for everyone else (exactly what a private draft shows a
 * viewer without its key). Only `currentPayload` changes: the payload hash the
 * decision is bound to stays the hash of what is stored.
 */
export async function revealManagedApprovalSummaries<
  T extends { id: string; currentPayload: unknown },
>(summaries: T[], orgId: string, userId: string): Promise<T[]> {
  for (const summary of summaries) {
    const payload = summary.currentPayload as Record<string, unknown> | null
    if (!payload || !isManagedApprovalPayload(payload)) continue
    try {
      const draft = await openDraft(payload, orgId, userId, summary.id, "approval_view")
      const shown: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(payload)) {
        if (!MANAGED_KEYS.includes(key) || key === "mailboxQuoteMessageIds") shown[key] = value
      }
      summary.currentPayload = { ...shown, ...draft }
    } catch (err) {
      if (!(err instanceof ManagedMailAccessError)) throw err
    }
  }
  return summaries
}
