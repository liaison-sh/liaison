// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `kernel__mailbox_setup`: the card, in the conversation, for the person's OWN
// personal mailboxes.
//
// - A private (zero-access) mailbox waiting for its mailbox password: the card
//   is where the owner sets it (the same enrollment Settings > Mail draws).
// - A transparent mailbox the person asks to make private (`private: true`):
//   the card sets the mailbox password if they have none, then re-encrypts the
//   mailbox so only they can read it. Offered only when the org allows private
//   mailboxes, and only on the person's request: a transparent mailbox needs no
//   card at all.
//
// Only the caller's own mailboxes are read (owner_id = the caller), and only
// their owner can complete the card.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"
import { mailboxEncryptionSettings } from "~/modules/mailbox-crypto/encryption-mode"

export interface MailboxSetupParams {
  email?: string
  private?: boolean
}

interface OwnMailbox {
  id: string
  email_address: string
  encryption_state: string | null
}

/** A private mailbox's states in which it waits for its owner's mailbox password. */
const WAITS_FOR_PASSWORD = new Set(["none", "pending_enrollment", "paused"])

/** The line the agent says when a private mailbox waits for its password. */
export const MAILBOX_WAITS_FOR_PASSWORD =
  "Nothing arrives in this private mailbox until its owner chooses a mailbox password: it keeps their mail readable by them alone."

export async function handleMailboxSetup(
  params: MailboxSetupParams,
  ctx: { orgId: string; userId: string },
) {
  const { rows, allowPrivate } = await withPrivilegedDb(
    ctx.orgId,
    "mailbox-setup-tool",
    async (tx) => {
      const mail = drizzleSql.raw(quoteIdent(schemaRef("app_mail")))
      const rows = extractRows<OwnMailbox>(
        await tx.execute(drizzleSql`
        SELECT id::text AS id, email_address, encryption_state FROM ${mail}.accounts
         WHERE org_id = ${ctx.orgId}::uuid AND owner_type = 'user'
           AND owner_id = ${ctx.userId}::uuid AND sync_status <> 'disconnected'`),
      )
      const settings = await mailboxEncryptionSettings(tx, ctx.orgId, ctx.userId)
      return { rows, allowPrivate: settings.allowPrivate }
    },
  )
  return mailboxSetupResult(rows, params, allowPrivate)
}

/** The tool's answer from the person's own mailboxes. */
export function mailboxSetupResult(
  own: ReadonlyArray<OwnMailbox>,
  params: MailboxSetupParams,
  allowPrivate: boolean,
) {
  const wanted = params.email?.trim().toLowerCase()
  const rows = own.filter((r) => !wanted || r.email_address.toLowerCase() === wanted)
  const mailboxes = rows.map((r) => ({
    accountId: r.id,
    email: r.email_address,
    mode: r.encryption_state === "managed" ? "transparent" : "private",
    waitsFor:
      r.encryption_state === "blocked"
        ? "mailbox_reset"
        : WAITS_FOR_PASSWORD.has(r.encryption_state ?? "none")
          ? "mailbox_password"
          : null,
  }))
  const toSetUp = mailboxes.filter((m) => m.waitsFor === "mailbox_password")
  const transparent = mailboxes.filter((m) => m.mode === "transparent")
  let card: "shown" | "none" = "none"
  let nextStep: string
  if (params.private === true) {
    if (!allowPrivate) {
      nextStep =
        "This organization does not allow private mailboxes: an admin turns them on in Settings > Mail. Say so plainly. The mailbox stays transparent: encrypted at rest, readable by its owner and their agent, not by the organization's admins."
    } else if (transparent.length > 0) {
      card = "shown"
      nextStep = `The card under this call makes ${transparent.map((m) => m.email).join(", ")} private. Say in two sentences what changes: only the person can read it, with a mailbox password (and optionally a passkey), and you (the agent) read it only while their mailbox is unlocked in an open Liaison window, so routines no longer can. Ask them to confirm in the card. Post nothing else in this message.`
    } else {
      nextStep = "None of the person's mailboxes here is transparent: they are already private."
    }
  } else if (toSetUp.length > 0) {
    card = "shown"
    nextStep = `The mailbox setup card is shown under this call for ${toSetUp.map((m) => m.email).join(", ")}. ${MAILBOX_WAITS_FOR_PASSWORD} In one or two sentences, say exactly that and ask the person to choose it in the card (a passkey is optional). Post nothing else in this message. Never say the mailbox is syncing until it is set.`
  } else {
    const blocked = mailboxes.filter((m) => m.waitsFor === "mailbox_reset")
    nextStep =
      blocked.length > 0
        ? `${blocked.map((m) => m.email).join(", ")} stopped syncing: its mailbox keys cannot be used. The owner resets the mailbox in Settings > Mail, and it downloads again from the provider.`
        : "None of the person's own mailboxes waits for anything. A transparent mailbox syncs with no setup. Read mail__listAccounts for sync status and errors."
  }
  return { mailboxes, card, private: params.private === true, nextStep }
}
