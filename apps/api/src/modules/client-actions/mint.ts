// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Making, rotating and withdrawing a client action. The raw token exists only in
// this call's memory and the link mail: the row holds its SHA-256. A rotation
// moves the old hash to `prior_token_hashes`, which opens only the "replaced"
// page. The link mail is sent from here and not awaited; a send that fails
// rotates the token again (the mailed one is dead) and tells the sender, and no
// rendered body is ever queued for a retry.
//
// `sent_at` is written just before its mail is handed over (`claimLinkMail`), and
// emptied when that fails. A link whose token stands and whose `sent_at` is empty,
// with no failure recorded, was never mailed: the server stopped in between. The
// `client-action-unsent-links` job gives it a fresh token and mails it, once
// (unsent-links.ts). What that later mail needs of the decision it goes on is kept with the
// trail's `sent` event (owed-mail.ts): the check its card pinned and the card itself, never the
// message or an address.
//
// A send of several signers (`mintClientActionSend`) reads the document once and
// writes every signer in one transaction, with the event that tells the target's
// app: after a failure or a killed caller there are all of its links or none, and
// the app hears of them whatever happened to the run that asked.
//
// Apps never call the gated agent tool: they reach `mintClientAction` and
// `revokeClientAction` through their bridge methods. The agent's tool reaches
// them after a person approved its card.

import { type SQL, sql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { generateToken, hashToken } from "~/lib/crypto"
import { rootLogger } from "~/lib/logger"
import { writeClientActionEvent } from "./events"
import { clientActionHearers } from "./hearers"
import { newActionMailId, sendLinkMail, sendStaffTurnMail } from "./mail"
import {
  heldBack,
  type MailDecision,
  type OwedMailMeta,
  owedMailMeta,
  typedMessage,
} from "./owed-mail"
import {
  type ClientActionKind,
  type ClientActionView,
  declaredTarget,
  TARGET_PORTAL_SHARE_KINDS,
  viewTarget,
} from "./targets"

const log = rootLogger.child({ module: "client-actions" })

const K = () => sql.raw(schemaRef("kernel"))

export const EXPIRY_DAYS = [7, 14, 30] as const
export const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000"

export type ClientActionRevokeReason =
  | "withdrawn"
  | "replaced"
  | "access_ended"
  | "person_removed"
  | "sender_voided"

export class ClientActionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message)
    this.name = "ClientActionError"
  }
}

export interface MintInput {
  orgId: string
  kind: ClientActionKind
  targetApp: string
  targetType: string
  targetId: string
  /** When given, the target must still hash to it. */
  targetSha256?: string
  /** When given, the blocks the page shows must still hash to it (a new link of a send). */
  targetBlocksSha256?: string
  contactId?: string | null
  companyId?: string | null
  invitedEmail?: string | null
  invitedName?: string | null
  expiresInDays: (typeof EXPIRY_DAYS)[number]
  signOrder?: number | null
  groupId?: string | null
  /** Not this signer's turn yet: no token until `openTurn`. */
  waitingTurn?: boolean
  visibleTo?: string[] | null
  requiredPhrase?: string | null
  message?: string | null
  createdByUserId: string | null
  createdByAgentId?: string | null
  /** The person who approved this send (the approval's decider, or their own click); null when
   *  no person did. A call chained from the approved send runs on that person's act. */
  approvedByUserId?: string | null
  /** What the mail goes on, kept for one that leaves later than the decision. */
  mailDecision?: MailDecision | null
  /** The link of the same signer this one replaces (a new link): it leaves the send's group. */
  replacesActionId?: string | null
  /** One signer of a send written whole: how many signers that send has. */
  sendSize?: number | null
}

/**
 * True for the row `alias` when a later link of the same send replaced it (a new link after an
 * expiry, a withdrawal, a code-less decline or a corrected address). A replaced link no longer
 * counts in the send's signers or its turn order; its trail stays as it was.
 */
export function replacedSql(alias: string) {
  const a = sql.raw(alias)
  return sql`EXISTS (
    SELECT 1 FROM ${K()}.client_actions n
      JOIN ${K()}.client_action_events e ON e.action_id = n.id AND e.org_id = n.org_id
     WHERE n.org_id = ${a}.org_id AND n.group_id = ${a}.group_id AND n.id <> ${a}.id
       AND e.event = 'created' AND e.meta->>'replaces' = ${a}.id::text)`
}

export interface MintResult {
  id: string
  status: "open" | "waiting_turn"
  expiresAt: Date
  /** The link mail left (a staff signer gets none: they sign in their session). */
  mailQueued: boolean
  /** An open action for the same target, contact and address already existed. */
  deduped: boolean
  invitedEmail: string
  invitedName: string
  signerIsStaff: boolean
  title: string
  /** A share opened on the portal for this person's company, when they are a portal client. */
  sharedOnPortal: boolean
}

interface Invitee {
  email: string
  name: string
  contactId: string | null
  companyId: string | null
}

async function resolveInvitee(tx: PrivilegedDb, input: MintInput): Promise<Invitee> {
  if (input.contactId) {
    const [c] = extractRows<{ email: string | null; name: string; company_id: string | null }>(
      await tx.execute(sql`
        SELECT lower(email) AS email,
               coalesce(nullif(trim(name), ''), email, handle) AS name,
               company_id
          FROM ${K()}.contacts WHERE id = ${input.contactId} AND org_id = ${input.orgId}
      `),
    )
    if (!c)
      throw new ClientActionError("NOT_FOUND", "No contact with this id in this organization", 404)
    const email = (input.invitedEmail ?? c.email ?? "").trim().toLowerCase()
    if (!email) throw new ClientActionError("EMAIL_REQUIRED", "The contact has no email address")
    // A contact signer is the contact at the contact's own address. Another address than the one
    // the directory holds makes a signer at that address, linked to no contact, so the trail
    // never names the contact for someone else's signature. A contact with no address takes the
    // one given.
    if (c.email && email !== c.email) {
      return {
        email,
        name: input.invitedName?.trim() || email,
        contactId: null,
        companyId: input.companyId ?? null,
      }
    }
    return {
      email,
      name: input.invitedName?.trim() || c.name,
      contactId: input.contactId,
      companyId: input.companyId ?? c.company_id,
    }
  }
  const email = (input.invitedEmail ?? "").trim().toLowerCase()
  if (!email || !email.includes("@")) {
    throw new ClientActionError("EMAIL_REQUIRED", "Give a contact or an email address")
  }
  return {
    email,
    name: input.invitedName?.trim() || email,
    contactId: null,
    companyId: input.companyId ?? null,
  }
}

/** The name a link is kept under. */
const nameOf = (i: Invitee) => i.name.trim().slice(0, 200)

/**
 * Who a signer of a send is: a contact at the address it signs at, else an address and the name
 * typed with it, so two people who share one address are two signers.
 */
const signerKey = (i: { contactId: string | null; email: string; name: string }) =>
  i.contactId ? `${i.contactId}|${i.email}` : `|${i.email}|${i.name.trim().toLowerCase()}`

/** The address each signer of one send would be mailed at, in order (a pinned check covers them). */
export async function signerAddresses(
  orgId: string,
  signers: ReadonlyArray<{ contact_id?: string | null; email?: string | null }>,
): Promise<string[]> {
  return withPrivilegedDb(orgId, "client-action-signer-addresses", async (tx) => {
    const out: string[] = []
    for (const s of signers) {
      const who = await resolveInvitee(tx, {
        orgId,
        contactId: s.contact_id ?? null,
        invitedEmail: s.email ?? null,
      } as MintInput)
      out.push(who.email)
    }
    return out
  })
}

interface Sender {
  orgName: string
  senderName: string
  senderEmail: string | null
  senderLocale: string | null
}

async function readSender(tx: PrivilegedDb, orgId: string, userId: string | null): Promise<Sender> {
  const [row] = extractRows<{
    org_name: string
    name: string | null
    email: string | null
    locale: string | null
  }>(
    await tx.execute(sql`
      SELECT o.name AS org_name, u.name, u.locale,
             CASE WHEN u.status = 'active' THEN u.email END AS email
        FROM ${K()}.organizations o
        LEFT JOIN ${K()}.users u ON u.id = ${userId} AND u.org_id = o.id AND u.user_type = 'member'
       WHERE o.id = ${orgId}
    `),
  )
  if (!row) throw new ClientActionError("NOT_FOUND", "Organization not found", 404)
  return {
    orgName: row.org_name,
    senderName: row.name ?? row.org_name,
    senderEmail: row.email,
    senderLocale: row.locale,
  }
}

/** How many link mails of one send leave at the same time. */
const MAILS_AT_ONCE = 5

/** One mail a written action owes: the person's link, or a staff signer's turn with no link. */
type OwedMail =
  | { turn: false; link: LinkMailArgs }
  | {
      turn: true
      actionId: string
      to: string
      title: string
      kind: ClientActionKind
      sender: Sender
    }

/** Sends from the queue until it is empty. Each mail reports its own failure. */
async function mailInTurn(orgId: string, queue: OwedMail[]): Promise<void> {
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (next.turn) await mailStaffTurn(orgId, next)
    else await mailLink(orgId, next.link)
  }
}

/** Sends the mails of one send a few at a time, not awaited. */
function mailInBackground(orgId: string, mails: readonly OwedMail[]): void {
  const queue = [...mails]
  for (let i = 0; i < Math.min(MAILS_AT_ONCE, mails.length); i++) void mailInTurn(orgId, queue)
}

/** A staff signer's turn, told by mail with no link; never throws. */
async function mailStaffTurn(
  orgId: string,
  m: { actionId: string; to: string; title: string; kind: ClientActionKind; sender: Sender },
): Promise<void> {
  await sendStaffTurnMail({
    orgId,
    to: m.to,
    mailId: newActionMailId(),
    title: m.title,
    kind: m.kind,
    orgName: m.sender.orgName,
    senderName: m.sender.senderName,
    locale: m.sender.senderLocale,
  }).catch((err) => log.error({ err, orgId, actionId: m.actionId }, "staff signer notice failed"))
}

interface LinkMailArgs {
  actionId: string
  token: string
  mailId: string
  to: string
  /** The person it is for: an address may be shared by two signers. */
  name: string
  title: string
  kind: ClientActionKind
  sender: Sender
  expiresAt: Date
  message?: string | null
  resend?: boolean
  createdByUserId: string | null
}

/**
 * Marks one link's mail as handed over, right before it is. False: that token no longer stands
 * (withdrawn, answered, rotated), or its mail was handed over already, so nothing is mailed.
 */
async function claimLinkMail(orgId: string, actionId: string, token: string): Promise<boolean> {
  return withPrivilegedDb(orgId, "client-action-mail-claim", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(sql`
        UPDATE ${K()}.client_actions SET sent_at = now()
         WHERE id = ${actionId} AND org_id = ${orgId} AND token_hash = ${hashToken(token)}
           AND sent_at IS NULL AND decided_at IS NULL AND revoked_at IS NULL
         RETURNING id
      `),
    )
    return rows.length > 0
  })
}

/** The person's link mail. A failed send makes that link dead by rotation; never throws. */
async function mailLink(orgId: string, args: LinkMailArgs): Promise<void> {
  try {
    if (!(await claimLinkMail(orgId, args.actionId, args.token))) return
  } catch (err) {
    // Nothing was mailed: `sent_at` is still empty and the job finds it.
    log.error({ err, orgId, actionId: args.actionId }, "client action link mail not started")
    return
  }
  await sendLinkMail({
    orgId,
    to: args.to,
    name: args.name,
    mailId: args.mailId,
    title: args.title,
    kind: args.kind,
    token: args.token,
    orgName: args.sender.orgName,
    senderName: args.sender.senderName,
    senderEmail: args.sender.senderEmail,
    expiresAt: args.expiresAt,
    message: args.message,
    resend: args.resend,
    locale: args.sender.senderLocale,
  }).catch(async (err) => {
    log.error({ err, orgId, actionId: args.actionId }, "client action link mail failed")
    await withPrivilegedDb(orgId, "client-action-send-failed", (tx) =>
      killUnreadLink(tx, {
        orgId,
        actionId: args.actionId,
        title: args.title,
        invitedName: args.to,
        senderUserId: args.createdByUserId,
        only: sql`token_hash = ${hashToken(args.token)}`,
      }),
    ).catch((e) =>
      log.error({ err: e, actionId: args.actionId }, "client action rotate after failed send"),
    )
  })
}

/**
 * A link nobody holds, its mail failed or held back: its token is rotated out and the sender told.
 * Only while the link is as `only` says (the token of that very mail): a later mail's link stands.
 */
async function killUnreadLink(
  tx: PrivilegedDb,
  link: {
    orgId: string
    actionId: string
    title: string
    invitedName: string
    senderUserId: string | null
    only: SQL
    /** Why it was held back, for the trail. */
    why?: string
  },
): Promise<void> {
  const { orgId, actionId, title, invitedName, senderUserId } = link
  const rows = extractRows<{ id: string }>(
    await tx.execute(sql`
        UPDATE ${K()}.client_actions
           SET prior_token_hashes = CASE WHEN token_hash IS NULL THEN prior_token_hashes
                                          ELSE array_append(prior_token_hashes, token_hash) END,
               token_hash = ${hashToken(generateToken(32))}, sent_at = NULL
         WHERE id = ${actionId} AND org_id = ${orgId} AND decided_at IS NULL AND revoked_at IS NULL
           AND ${link.only}
         RETURNING id
      `),
  )
  if (rows.length === 0) return
  await writeClientActionEvent(tx, {
    orgId,
    actionId,
    event: "rotated",
    actorKind: "system",
    meta: { reason: "send_failed", ...(link.why ? { held: link.why } : {}) },
  })
  if (senderUserId) {
    await tx.queueEvent({
      app: "kernel",
      entity: "client_action",
      action: "send_failed",
      entityId: actionId,
      data: {
        title,
        invitedName,
        senderUserIds: await clientActionHearers(tx, orgId, actionId),
      },
      actorId: SYSTEM_ACTOR_ID,
      actorType: "system",
      orgId,
    })
  }
}

/** What every mint refuses before anything is read: an undeclared target, kind or expiry. */
function assertMintable(input: MintInput): void {
  const target = declaredTarget(input.orgId, input.targetApp, input.targetType)
  if (!target) {
    throw new ClientActionError(
      "TARGET_NOT_REGISTERED",
      `No app of this organization takes client actions on ${input.targetApp}.${input.targetType}`,
    )
  }
  if (!target.kinds.includes(input.kind)) {
    throw new ClientActionError(
      "KIND_NOT_ALLOWED",
      `${input.targetApp}.${input.targetType} takes ${target.kinds.join(", ")}, not ${input.kind}`,
    )
  }
  if (!EXPIRY_DAYS.includes(input.expiresInDays)) {
    throw new ClientActionError("INVALID_EXPIRY", "A link lasts 7, 14 or 30 days")
  }
}

/** The document as the person outside will see it, held to the fingerprint the caller read. */
async function readMintView(input: MintInput): Promise<ClientActionView> {
  const view = await viewTarget({
    orgId: input.orgId,
    targetApp: input.targetApp,
    targetType: input.targetType,
    targetId: input.targetId,
    actingUserId: input.createdByUserId,
  })
  if (view === "down") {
    throw new ClientActionError(
      "TARGET_UNAVAILABLE",
      "The document could not be read; nothing was sent",
      503,
    )
  }
  if (
    (input.targetSha256 && input.targetSha256 !== view.sha256) ||
    (input.targetBlocksSha256 && input.targetBlocksSha256 !== (view.blocksSha256 ?? null))
  ) {
    throw new ClientActionError(
      "VERSION_CHANGED",
      "The document changed since it was read; read it again and send that version",
      409,
    )
  }
  return view
}

/**
 * One target's links are made one call at a time: a second call that arrives while the first
 * still writes waits, then finds what the first made. Held until the transaction ends.
 */
async function lockTargetLinks(
  tx: PrivilegedDb,
  input: Pick<MintInput, "orgId" | "targetApp" | "targetId">,
): Promise<void> {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`client_actions:${input.orgId}:${input.targetApp}:${input.targetId}`}, 0))
  `)
}

interface Inserted {
  input: MintInput
  result: MintResult
  token: string | null
  mailId: string
  mail: { sender: Sender; to: string } | null
  staffMail: { sender: Sender; to: string } | null
}

/** Writes one client action and its trail; the mails it owes leave after the commit. */
async function insertClientAction(
  tx: PrivilegedDb,
  input: MintInput,
  view: ClientActionView,
  invitee: Invitee,
  sender: Sender,
): Promise<Inserted> {
  const token = input.waitingTurn ? null : generateToken(32)
  const mailId = newActionMailId()
  const invitedName = nameOf(invitee)
  const [existing] = extractRows<{
    id: string
    expires_at: Date
    token_hash: string | null
    signer_user_id: string | null
  }>(
    await tx.execute(sql`
      SELECT x.id, x.expires_at, x.token_hash, x.signer_user_id FROM ${K()}.client_actions x
       WHERE x.org_id = ${input.orgId} AND x.target_id = ${input.targetId}
         AND x.contact_id IS NOT DISTINCT FROM ${invitee.contactId}
         AND x.invited_email = ${invitee.email}
         AND (x.contact_id IS NOT NULL OR lower(x.invited_name) = lower(${invitedName}))
         AND x.decided_at IS NULL AND x.revoked_at IS NULL AND x.expires_at > now()
         AND NOT ${replacedSql("x")}
       LIMIT 1
    `),
  )
  if (existing) {
    return {
      input,
      token: null,
      mailId,
      result: {
        id: existing.id,
        status: existing.token_hash ? ("open" as const) : ("waiting_turn" as const),
        expiresAt: new Date(existing.expires_at),
        mailQueued: false,
        deduped: true,
        invitedEmail: invitee.email,
        invitedName: invitee.name,
        signerIsStaff: existing.signer_user_id !== null,
        title: view.title,
        sharedOnPortal: false,
      },
      mail: null,
      staffMail: null,
    }
  }
  // A member of this org signs in their own session, never by a mailed link.
  const [staff] = extractRows<{ id: string }>(
    await tx.execute(sql`
      SELECT id FROM ${K()}.users
       WHERE org_id = ${input.orgId} AND lower(email) = ${invitee.email}
         AND user_type = 'member' AND status = 'active' LIMIT 1
    `),
  )
  const signerUserId = staff?.id ?? null
  const [row] = extractRows<{ id: string; expires_at: Date }>(
    await tx.execute(sql`
      INSERT INTO ${K()}.client_actions (
        org_id, group_id, kind, target_app, target_type, target_id, target_sha256,
        target_blocks_sha256, company_id,
        contact_id, signer_user_id, invited_email, invited_name, sign_order, token_hash,
        expires_at, visible_to, required_phrase, created_by_user_id, created_by_agent_id,
        approved_by_user_id, created_at
      ) VALUES (
        ${input.orgId}, coalesce(${input.groupId ?? null}::uuid, gen_random_uuid()), ${input.kind},
        ${input.targetApp}, ${input.targetType}, ${input.targetId}, ${view.sha256},
        ${view.blocksSha256 ?? null},
        ${invitee.companyId}, ${invitee.contactId}, ${signerUserId}, ${invitee.email},
        ${invitedName}, ${input.signOrder ?? null},
        ${token ? hashToken(token) : null},
        now() + make_interval(days => ${input.expiresInDays}),
        ${input.visibleTo && input.visibleTo.length > 0 ? sql`${`{${input.visibleTo.join(",")}}`}::uuid[]` : sql`NULL`},
        ${input.requiredPhrase ?? null}, ${input.createdByUserId}, ${input.createdByAgentId ?? null},
        ${input.approvedByUserId ?? null}::uuid, clock_timestamp()
      ) RETURNING id, expires_at
    `),
  )
  if (!row) throw new Error("client action not written")
  await writeClientActionEvent(tx, {
    orgId: input.orgId,
    actionId: row.id,
    event: "created",
    actorKind: input.createdByAgentId ? "agent" : input.createdByUserId ? "staff" : "system",
    actorUserId: input.createdByUserId,
    meta: {
      kind: input.kind,
      target: `${input.targetApp}.${input.targetType}`,
      ...(input.replacesActionId ? { replaces: input.replacesActionId } : {}),
      ...(input.sendSize ? { send_size: input.sendSize } : {}),
    },
  })
  const mailed = token !== null && signerUserId === null
  if (mailed) {
    await writeClientActionEvent(tx, {
      orgId: input.orgId,
      actionId: row.id,
      event: "sent",
      actorKind: "system",
      mailId,
      meta: owedMailMeta(input.mailDecision ?? null, input.message ?? null),
    })
  }
  // A staff signer's turn: a Home row and a mail with no link; they sign in their session.
  const staffTurn = token !== null && signerUserId !== null
  if (staffTurn) {
    await tx.queueEvent({
      app: "kernel",
      entity: "client_action",
      action: "staff_turn",
      entityId: row.id,
      data: {
        id: row.id,
        kind: input.kind,
        title: view.title,
        signerUserIds: [signerUserId],
        staffTurn: true,
      },
      actorId: SYSTEM_ACTOR_ID,
      actorType: "system",
      orgId: input.orgId,
    })
  }
  const shared = await openAutomaticShare(tx, input, invitee, view.portalShareKind ?? null)
  return {
    input,
    token,
    mailId,
    result: {
      id: row.id,
      status: token ? ("open" as const) : ("waiting_turn" as const),
      expiresAt: new Date(row.expires_at),
      mailQueued: mailed,
      deduped: false,
      invitedEmail: invitee.email,
      invitedName: invitee.name,
      signerIsStaff: signerUserId !== null,
      title: view.title,
      sharedOnPortal: shared,
    },
    mail: mailed ? { sender, to: invitee.email } : null,
    staffMail: staffTurn ? { sender, to: invitee.email } : null,
  }
}

/** The mails the written actions owe, each with its raw token, after the commit. */
function mailsOf(made: readonly Inserted[]): OwedMail[] {
  return made.flatMap(({ input, result, token, mailId, mail, staffMail }): OwedMail[] => {
    if (mail && token)
      return [
        {
          turn: false,
          link: {
            actionId: result.id,
            token,
            mailId,
            to: mail.to,
            name: result.invitedName,
            title: result.title,
            kind: input.kind,
            sender: mail.sender,
            expiresAt: result.expiresAt,
            message: input.message,
            createdByUserId: input.createdByUserId,
          },
        },
      ]
    if (!staffMail) return []
    return [
      {
        turn: true,
        actionId: result.id,
        to: staffMail.to,
        title: result.title,
        kind: input.kind,
        sender: staffMail.sender,
      },
    ]
  })
}

/**
 * Makes one client action and mails its link. Refuses a target no app of the org
 * declared, a kind the target does not take, and a target whose hash moved since
 * the caller read it. A second call for the same target and the same person (the
 * contact at that address, or without a contact the address and its name) while
 * the first is open returns the first and sends nothing.
 */
export async function mintClientAction(input: MintInput): Promise<MintResult> {
  assertMintable(input)
  const view = await readMintView(input)
  const made = await withPrivilegedDb(input.orgId, "client-action-mint", async (tx) => {
    await lockTargetLinks(tx, input)
    const invitee = await resolveInvitee(tx, input)
    const sender = await readSender(tx, input.orgId, input.createdByUserId)
    return insertClientAction(tx, input, view, invitee, sender)
  })
  mailInBackground(input.orgId, mailsOf([made]))
  return made.result
}

/**
 * Where a link's mail is: `owed` (made now, it leaves after the commit, or the server stopped
 * before it left and the job sends it), `sent`, `failed` (its link is dead, the sender was
 * told), or null when no mail goes with it (answered, not their turn, a member's own session).
 */
export type LinkMailState = "owed" | "sent" | "failed" | null

/** One signer of a send as it stands: a fresh link, or where the link made before is now. */
export type SendAction = Omit<MintResult, "status"> & {
  status: MintResult["status"] | "decided" | "declined"
  signOrder: number | null
  mail: LinkMailState
}

export interface SendSigner {
  contactId?: string | null
  email?: string | null
  name?: string | null
}

export interface MintSendInput
  extends Omit<
    MintInput,
    | "contactId"
    | "invitedEmail"
    | "invitedName"
    | "signOrder"
    | "groupId"
    | "waitingTurn"
    | "replacesActionId"
  > {
  /** One after the other: only the first signer gets a link, the others wait for their turn. */
  sequential: boolean
  signers: readonly SendSigner[]
}

export interface MintSendResult {
  groupId: string
  /** The same send had already made these links: nothing was made or mailed now. */
  alreadySent: boolean
  actions: SendAction[]
}

interface SentLink {
  id: string
  group_id: string
  kind: string
  contact_id: string | null
  invited_email: string
  invited_name: string
  sign_order: number | null
  token_hash: string | null
  decision: string | null
  expires_at: Date
  signer_user_id: string | null
  sent_at: Date | null
  mail_failed: boolean
}

/**
 * True for the row `alias` when the last mail it owed failed (its link is dead and its sender was
 * told), so it is not one the server stopped before mailing.
 */
function mailFailedSql(alias: string) {
  const a = sql.raw(alias)
  return sql`EXISTS (
    SELECT 1 FROM ${K()}.client_action_events f
     WHERE f.action_id = ${a}.id AND f.org_id = ${a}.org_id AND f.event = 'rotated'
       AND f.meta->>'reason' = 'send_failed'
       AND NOT EXISTS (SELECT 1 FROM ${K()}.client_action_events s
                        WHERE s.action_id = f.action_id AND s.org_id = f.org_id
                          AND s.event = 'sent' AND s.at > f.at))`
}

function mailStateOf(
  l: Pick<SentLink, "decision" | "token_hash" | "signer_user_id" | "sent_at" | "mail_failed">,
): LinkMailState {
  if (l.decision !== null || l.token_hash === null || l.signer_user_id !== null) return null
  if (l.sent_at !== null) return "sent"
  return l.mail_failed ? "failed" : "owed"
}

/**
 * The links of a target's running send: every link of a group that still has one open or
 * answered. A withdrawn or replaced link is not in it, and a send whose links all ran out
 * unanswered is over.
 */
async function runningSend(tx: PrivilegedDb, input: MintSendInput): Promise<SentLink[]> {
  const rows = extractRows<SentLink>(
    await tx.execute(sql`
      SELECT l.id, l.group_id, l.kind, l.contact_id, l.invited_email, l.invited_name, l.sign_order,
             l.token_hash, l.decision, l.expires_at, l.signer_user_id, l.sent_at,
             ${mailFailedSql("l")} AS mail_failed
        FROM ${K()}.client_actions l
       WHERE l.org_id = ${input.orgId} AND l.target_app = ${input.targetApp}
         AND l.target_type = ${input.targetType} AND l.target_id = ${input.targetId}
         AND l.revoked_at IS NULL AND NOT ${replacedSql("l")}
       ORDER BY l.sign_order NULLS LAST, l.created_at
    `),
  )
  const live = new Set(
    rows
      .filter((r) => r.decision !== null || new Date(r.expires_at).getTime() > Date.now())
      .map((r) => r.group_id),
  )
  return rows.filter((r) => live.has(r.group_id))
}

/**
 * `kernel/client_action:links_made`, in the transaction that wrote them: the target's app hears of
 * every link made on it, so one written beside a void or a newer version is withdrawn by it.
 */
async function queueLinksMade(
  tx: PrivilegedDb,
  input: Pick<MintInput, "orgId" | "targetApp" | "targetType" | "targetId" | "visibleTo">,
  id: string,
  groupId: string,
): Promise<void> {
  await tx.queueEvent({
    app: "kernel",
    entity: "client_action",
    action: "links_made",
    entityId: id,
    data: {
      id,
      groupId,
      target: { app: input.targetApp, type: input.targetType, id: input.targetId },
      // A restricted document's send is known to its list only, like its decision.
      ...(input.visibleTo && input.visibleTo.length > 0 ? { visibleTo: input.visibleTo } : {}),
    },
    actorId: SYSTEM_ACTOR_ID,
    actorType: "system",
    orgId: input.orgId,
  })
}

/** The names a refusal lists: the first few, then how many more. */
function namesOf(links: readonly SentLink[]): string {
  const names = links.map((l) => l.invited_name)
  return names.length <= 5
    ? names.join(", ")
    : `${names.slice(0, 5).join(", ")} and ${names.length - 5} more`
}

/**
 * One send: every signer of it, or none. The document is read once and every signer is held to
 * that reading; the rows, their trail and the `client_action:links_made` event are one
 * transaction, so a caller killed at any moment leaves either the whole send, which the target's
 * app hears of, or nothing. The same send again (a retry, a second click, at the same moment or
 * later) answers the links it made and mails nobody. Other signers on a document whose send is
 * still running are refused.
 */
export async function mintClientActionSend(input: MintSendInput): Promise<MintSendResult> {
  const { sequential, signers, ...rest } = input
  const base: MintInput = rest
  assertMintable(base)
  const view = await readMintView(base)
  const out = await withPrivilegedDb(input.orgId, "client-action-mint-send", async (tx) => {
    await lockTargetLinks(tx, base)
    // One person named twice is one signer; two people at one address are two.
    const invitees = new Map<string, { signer: SendSigner; invitee: Invitee }>()
    for (const s of signers) {
      const invitee = await resolveInvitee(tx, {
        ...base,
        contactId: s.contactId ?? null,
        invitedEmail: s.email ?? null,
        invitedName: s.name ?? null,
      })
      const key = signerKey({ ...invitee, name: nameOf(invitee) })
      if (!invitees.has(key)) invitees.set(key, { signer: s, invitee })
    }
    const before = await runningSend(tx, input)
    if (before.length > 0) {
      const had = new Set(
        before.map((l) =>
          signerKey({ contactId: l.contact_id, email: l.invited_email, name: l.invited_name }),
        ),
      )
      const asked = new Set(invitees.keys())
      const same =
        had.size === asked.size &&
        [...asked].every((key) => had.has(key)) &&
        before.every((l) => l.kind === base.kind)
      if (!same)
        throw new ClientActionError(
          "ALREADY_SENT",
          `The document was already sent to ${namesOf(before)}, and those links still stand`,
          409,
        )
      return { before, made: [] as Inserted[], groupId: before[0]?.group_id as string }
    }
    const sender = await readSender(tx, input.orgId, base.createdByUserId)
    const groupId = crypto.randomUUID()
    const made: Inserted[] = []
    for (const [i, { signer: s, invitee }] of [...invitees.values()].entries()) {
      made.push(
        await insertClientAction(
          tx,
          {
            ...base,
            contactId: s.contactId ?? null,
            invitedEmail: s.email ?? null,
            invitedName: s.name ?? null,
            signOrder: sequential ? i + 1 : null,
            waitingTurn: sequential && i > 0,
            groupId,
            sendSize: invitees.size,
          },
          view,
          invitee,
          sender,
        ),
      )
    }
    await queueLinksMade(tx, input, made[0]?.result.id as string, groupId)
    return { before: [] as SentLink[], made, groupId }
  })
  mailInBackground(input.orgId, mailsOf(out.made))
  if (out.before.length > 0)
    return {
      groupId: out.groupId,
      alreadySent: true,
      actions: out.before.map((l) => ({
        id: l.id,
        status:
          l.decision === "declined"
            ? ("declined" as const)
            : l.decision !== null
              ? ("decided" as const)
              : l.token_hash
                ? ("open" as const)
                : ("waiting_turn" as const),
        signOrder: l.sign_order,
        expiresAt: new Date(l.expires_at),
        mailQueued: false,
        deduped: true,
        invitedEmail: l.invited_email,
        invitedName: l.invited_name,
        signerIsStaff: l.signer_user_id !== null,
        title: view.title,
        sharedOnPortal: false,
        mail: mailStateOf(l),
      })),
    }
  return {
    groupId: out.groupId,
    alreadySent: false,
    actions: out.made.map((m) => ({
      ...m.result,
      signOrder: m.input.signOrder ?? null,
      mail: m.result.mailQueued ? ("owed" as const) : null,
    })),
  }
}

/**
 * The portal share kinds a client action's target opens by itself: the kind the
 * app's view tool names for the target, else a target whose declared type is one
 * of these per-document kinds. Never read from the app's name.
 */
const AUTOMATIC_SHARE_KINDS = new Set<string>(TARGET_PORTAL_SHARE_KINDS)

/**
 * Sending an agreement or a change request to a portal client of that company
 * opens it on their portal too, shared by the person who approved the send.
 * Never for a restricted document: there the link is the only path until a
 * person shares it to named people.
 */
async function openAutomaticShare(
  tx: PrivilegedDb,
  input: MintInput,
  invitee: Invitee,
  viewKind: string | null,
): Promise<boolean> {
  const kind = viewKind ?? (AUTOMATIC_SHARE_KINDS.has(input.targetType) ? input.targetType : null)
  if (!kind || !invitee.companyId || !input.createdByUserId) return false
  if (input.visibleTo && input.visibleTo.length > 0) return false
  const [portalPerson] = extractRows<{ id: string }>(
    await tx.execute(sql`
      SELECT u.id FROM ${K()}.users u
        JOIN ${K()}.companies c ON c.id = u.company_id AND c.org_id = u.org_id
       WHERE u.org_id = ${input.orgId} AND u.user_type = 'external' AND u.status = 'active'
         AND lower(u.email) = ${invitee.email} AND u.company_id = ${invitee.companyId}
         AND c.closed_at IS NULL AND c.portal_ended_at IS NULL
       LIMIT 1
    `),
  )
  if (!portalPerson) return false
  const opened = extractRows<{ id: string }>(
    await tx.execute(sql`
      INSERT INTO ${K()}.portal_shares (org_id, company_id, kind, object_id, shared_by_user_id, shared_at)
      VALUES (${input.orgId}, ${invitee.companyId}, ${kind}, ${input.targetId}, ${input.createdByUserId}, now())
      ON CONFLICT DO NOTHING RETURNING id
    `),
  )
  return opened.length > 0
}

/**
 * A new token for an open action (a staff signer's "Read and sign", a resend, a
 * signer's turn): the old hash moves to the prior list, which opens only the
 * replaced page. Returns the raw token once, or null when the action is not open.
 */
export async function rotateClientActionToken(
  tx: PrivilegedDb,
  orgId: string,
  actionId: string,
): Promise<string | null> {
  const token = generateToken(32)
  const rows = extractRows<{ id: string }>(
    await tx.execute(sql`
      UPDATE ${K()}.client_actions
         SET prior_token_hashes = CASE WHEN token_hash IS NULL THEN prior_token_hashes
                                        ELSE array_append(prior_token_hashes, token_hash) END,
             token_hash = ${hashToken(token)}
       WHERE id = ${actionId} AND org_id = ${orgId}
         AND decided_at IS NULL AND revoked_at IS NULL AND expires_at > now() AND code_locked_at IS NULL
       RETURNING id
    `),
  )
  if (rows.length === 0) return null
  await writeClientActionEvent(tx, { orgId, actionId, event: "rotated", actorKind: "system" })
  return token
}

/** A link whose mail was owed this long ago and never started was left by a server that stopped. */
const UNSENT_AFTER_MINUTES = 5
/** Older than this, its sender has had days to see it: a restored copy never mails old links. */
const UNSENT_WITHIN_DAYS = 3

/**
 * An open mailed link whose mail never started, as of now. One whose send a signer declined is
 * not: nothing is asked of its other signers until that one is asked again.
 */
export function unsentLinkSql() {
  return sql`
    a.token_hash IS NOT NULL AND a.sent_at IS NULL AND a.signer_user_id IS NULL
    AND a.decided_at IS NULL AND a.revoked_at IS NULL AND a.code_locked_at IS NULL
    AND a.expires_at > now() AND NOT ${mailFailedSql("a")}
    AND NOT EXISTS (SELECT 1 FROM ${K()}.client_actions d
                     WHERE d.org_id = a.org_id AND d.group_id = a.group_id
                       AND d.decision = 'declined' AND NOT ${replacedSql("d")})
    AND (SELECT max(e.at) FROM ${K()}.client_action_events e
          WHERE e.action_id = a.id AND e.org_id = a.org_id AND e.event = 'sent')
        BETWEEN now() - make_interval(days => ${UNSENT_WITHIN_DAYS})
            AND now() - make_interval(mins => ${UNSENT_AFTER_MINUTES})`
}

interface UnsentLink {
  /** The owed mail, as its `sent` event kept it. */
  owed: OwedMailMeta
  mailId: string | null
  /** Every signer's address of its send: what the check its card pinned covers. */
  sendAddresses: string[]
  invitedName: string
  targetApp: string
  targetType: string
  targetId: string
  createdByUserId: string | null
}

/** One link whose mail never started, or null. `lock`: held until the transaction ends. */
async function readUnsentLink(
  tx: PrivilegedDb,
  orgId: string,
  actionId: string,
  lock: boolean,
): Promise<UnsentLink | null> {
  // Locked first, read after: the read then sees what another run wrote meanwhile.
  if (lock)
    await tx.execute(sql`
      SELECT id FROM ${K()}.client_actions
       WHERE id = ${actionId} AND org_id = ${orgId} FOR UPDATE`)
  const [a] = extractRows<{
    send_addresses: string[]
    invited_name: string
    target_app: string
    target_type: string
    target_id: string
    created_by_user_id: string | null
    meta: OwedMailMeta | null
    mail_id: string | null
  }>(
    await tx.execute(sql`
      SELECT a.invited_name, a.target_app, a.target_type, a.target_id,
             a.created_by_user_id, s.meta, s.mail_id,
             (SELECT jsonb_agg(DISTINCT g.invited_email) FROM ${K()}.client_actions g
               WHERE g.org_id = a.org_id AND g.group_id = a.group_id
                 AND NOT ${replacedSql("g")}) AS send_addresses
        FROM ${K()}.client_actions a
        LEFT JOIN LATERAL (
          SELECT e.meta, e.mail_id FROM ${K()}.client_action_events e
           WHERE e.action_id = a.id AND e.org_id = a.org_id AND e.event = 'sent'
           ORDER BY e.at DESC, e.id LIMIT 1) s ON true
       WHERE a.id = ${actionId} AND a.org_id = ${orgId} AND ${unsentLinkSql()}
    `),
  )
  if (!a) return null
  return {
    owed: a.meta ?? {},
    mailId: a.mail_id,
    sendAddresses: a.send_addresses,
    invitedName: a.invited_name,
    targetApp: a.target_app,
    targetType: a.target_type,
    targetId: a.target_id,
    createdByUserId: a.created_by_user_id,
  }
}

/**
 * Mails a link whose mail never started, on the decision it was made by: the check its card pinned
 * is asked again at this moment, and the message goes with it when the card still holds that very
 * text. A check that refuses leaves the link unsent, its sender told; one that could not run leaves
 * it to the next run. True when it was mailed.
 */
export async function mailUnsentLink(orgId: string, actionId: string): Promise<boolean> {
  const found = await withPrivilegedDb(orgId, "client-action-unsent-read", (tx) =>
    readUnsentLink(tx, orgId, actionId, false),
  )
  if (!found) return false
  const stop = await heldBack(orgId, found.owed, found.sendAddresses)
  if (stop === "unavailable") return false
  if (stop === null)
    return remailClientAction(orgId, actionId, {
      unsent: found,
      message: await typedMessage(orgId, found.owed),
    })
  const view = await viewTarget({
    orgId,
    targetApp: found.targetApp,
    targetType: found.targetType,
    targetId: found.targetId,
    actingUserId: found.createdByUserId,
  })
  await withPrivilegedDb(orgId, "client-action-mail-held", async (tx) => {
    const now = await readUnsentLink(tx, orgId, actionId, true)
    if (now?.mailId !== found.mailId) return
    const sender = await readSender(tx, orgId, found.createdByUserId)
    await killUnreadLink(tx, {
      orgId,
      actionId,
      title: view === "down" ? sender.orgName : view.title,
      invitedName: found.invitedName,
      senderUserId: found.createdByUserId,
      only: sql`sent_at IS NULL`,
      why: stop,
    })
  })
  return false
}

/** Mails a fresh link for an open action to its invited address (resend, next signer's turn). */
export async function remailClientAction(
  orgId: string,
  actionId: string,
  opts: {
    resend?: boolean
    /** Only while its mail never started, and is still the one that was read. */
    unsent?: UnsentLink
    message?: string | null
  } = {},
): Promise<boolean> {
  const mailId = newActionMailId()
  const { unsent } = opts
  const out = await withPrivilegedDb(orgId, "client-action-remail", async (tx) => {
    if (unsent) {
      const still = await readUnsentLink(tx, orgId, actionId, true)
      if (still?.mailId !== unsent.mailId) return null
    }
    const [a] = extractRows<{
      kind: ClientActionKind
      target_app: string
      target_type: string
      target_id: string
      invited_email: string
      invited_name: string
      signer_user_id: string | null
      created_by_user_id: string | null
      expires_at: Date
    }>(
      await tx.execute(sql`
        SELECT kind, target_app, target_type, target_id, invited_email, invited_name, signer_user_id,
               created_by_user_id, expires_at
          FROM ${K()}.client_actions WHERE id = ${actionId} AND org_id = ${orgId}
      `),
    )
    if (!a || a.signer_user_id) return null
    const token = await rotateClientActionToken(tx, orgId, actionId)
    if (!token) return null
    await tx.execute(sql`UPDATE ${K()}.client_actions SET sent_at = NULL WHERE id = ${actionId}`)
    await writeClientActionEvent(tx, {
      orgId,
      actionId,
      event: "sent",
      actorKind: "system",
      mailId,
      // The same owed mail, still on the decision it was made by.
      ...(unsent ? { meta: { ...unsent.owed } } : {}),
    })
    const sender = await readSender(tx, orgId, a.created_by_user_id)
    return { a, token, sender }
  })
  if (!out) return false
  const view = await viewTarget({
    orgId,
    targetApp: out.a.target_app,
    targetType: out.a.target_type,
    targetId: out.a.target_id,
    actingUserId: out.a.created_by_user_id,
  })
  void mailLink(orgId, {
    actionId,
    token: out.token,
    mailId,
    to: out.a.invited_email,
    name: out.a.invited_name,
    title: view === "down" ? out.sender.orgName : view.title,
    kind: out.a.kind,
    sender: out.sender,
    expiresAt: new Date(out.a.expires_at),
    message: opts.message ?? null,
    resend: opts.resend,
    createdByUserId: out.a.created_by_user_id,
  })
  return true
}

export interface RevokeResult {
  id: string
  revoked: boolean
  /** The state when nothing changed: already decided, revoked or not found. */
  state: "revoked" | "already_closed" | "not_found"
}

/** Withdraws an open action at once: its next call, and any proof already issued, refuse. */
export async function revokeClientAction(input: {
  orgId: string
  id: string
  reason: ClientActionRevokeReason
  byUserId: string | null
  byAgent?: boolean
}): Promise<RevokeResult> {
  return withPrivilegedDb(input.orgId, "client-action-revoke", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(sql`
        UPDATE ${K()}.client_actions
           SET revoked_at = now(), revoked_by = ${input.byUserId}, revoke_reason = ${input.reason}
         WHERE id = ${input.id} AND org_id = ${input.orgId}
           AND decided_at IS NULL AND revoked_at IS NULL
         RETURNING id
      `),
    )
    if (rows.length === 0) {
      const [found] = extractRows<{ id: string }>(
        await tx.execute(
          sql`SELECT id FROM ${K()}.client_actions WHERE id = ${input.id} AND org_id = ${input.orgId}`,
        ),
      )
      return { id: input.id, revoked: false, state: found ? "already_closed" : "not_found" }
    }
    await writeClientActionEvent(tx, {
      orgId: input.orgId,
      actionId: input.id,
      event: "revoked",
      actorKind: input.byAgent ? "agent" : input.byUserId ? "staff" : "system",
      actorUserId: input.byUserId,
      meta: { reason: input.reason },
    })
    return { id: input.id, revoked: true, state: "revoked" }
  })
}

export interface OpenTurnResult {
  /** The action whose turn opened, or null when no signer waits for this one. */
  openedId: string | null
  signerIsStaff: boolean
}

/**
 * After a signature in a group signed "one after the other": opens the turn of
 * the next signer, the one the approved send made waiting (no token, no mail).
 * Nothing opens unless the decided action is this app's, signed or accepted,
 * every signer before the next one has signed, nobody declined, and the next
 * one waits on the same document at the same hash. A second call for the same
 * decision opens nothing more.
 */
export async function openNextSignerTurn(input: {
  orgId: string
  targetApp: string
  afterActionId: string
}): Promise<OpenTurnResult> {
  const next = await withPrivilegedDb(input.orgId, "client-action-next-turn", async (tx) => {
    const [after] = extractRows<{
      group_id: string
      target_id: string
      target_sha256: string
      decision: string | null
      target_app: string
    }>(
      await tx.execute(sql`
        SELECT group_id, target_id, target_sha256, decision, target_app
          FROM ${K()}.client_actions
         WHERE id = ${input.afterActionId} AND org_id = ${input.orgId}
      `),
    )
    if (!after || after.target_app !== input.targetApp) {
      throw new ClientActionError("NOT_FOUND", "No decided action of this app with this id", 404)
    }
    if (after.decision !== "signed" && after.decision !== "accepted") return null
    const group = extractRows<{
      id: string
      sign_order: number | null
      decision: string | null
      revoked_at: Date | null
      token_hash: string | null
      expires_at: Date
      target_id: string
      target_sha256: string
      signer_user_id: string | null
    }>(
      await tx.execute(sql`
        SELECT g.id, g.sign_order, g.decision, g.revoked_at, g.token_hash, g.expires_at,
               g.target_id, g.target_sha256, g.signer_user_id
          FROM ${K()}.client_actions g
         WHERE g.org_id = ${input.orgId} AND g.group_id = ${after.group_id}
           AND NOT ${replacedSql("g")}
         ORDER BY g.sign_order NULLS LAST, g.created_at
         FOR UPDATE OF g
      `),
    )
    if (group.some((g) => g.decision === "declined")) return null
    const waiting = group.find(
      (g) =>
        g.sign_order !== null &&
        g.decision === null &&
        g.revoked_at === null &&
        g.token_hash === null &&
        new Date(g.expires_at).getTime() > Date.now(),
    )
    if (!waiting || waiting.sign_order === null) return null
    const order = waiting.sign_order
    const earlierAllSigned = group
      .filter((g) => g.sign_order !== null && g.sign_order < order)
      .every((g) => g.decision === "signed" || g.decision === "accepted")
    if (!earlierAllSigned) return null
    if (waiting.target_id !== after.target_id || waiting.target_sha256 !== after.target_sha256)
      return null
    return { id: waiting.id, staff: waiting.signer_user_id }
  })
  if (!next) return { openedId: null, signerIsStaff: false }
  if (!next.staff) {
    const sent = await remailClientAction(input.orgId, next.id)
    return { openedId: sent ? next.id : null, signerIsStaff: false }
  }
  // A staff signer: a fresh token behind their session, a Home row and a mail with no link.
  const staff = await withPrivilegedDb(input.orgId, "client-action-staff-turn", async (tx) => {
    const token = await rotateClientActionToken(tx, input.orgId, next.id)
    if (!token) return null
    const [a] = extractRows<{
      kind: ClientActionKind
      target_app: string
      target_type: string
      target_id: string
      invited_email: string
      created_by_user_id: string | null
    }>(
      await tx.execute(sql`
        SELECT kind, target_app, target_type, target_id, invited_email, created_by_user_id
          FROM ${K()}.client_actions WHERE id = ${next.id} AND org_id = ${input.orgId}
      `),
    )
    if (!a) return null
    const sender = await readSender(tx, input.orgId, a.created_by_user_id)
    return { a, sender }
  })
  if (!staff) return { openedId: null, signerIsStaff: true }
  const view = await viewTarget({
    orgId: input.orgId,
    targetApp: staff.a.target_app,
    targetType: staff.a.target_type,
    targetId: staff.a.target_id,
    actingUserId: staff.a.created_by_user_id,
  })
  const title = view === "down" ? staff.sender.orgName : view.title
  await withPrivilegedDb(input.orgId, "client-action-staff-turn-row", (tx) =>
    tx.queueEvent({
      app: "kernel",
      entity: "client_action",
      action: "staff_turn",
      entityId: next.id,
      data: {
        id: next.id,
        kind: staff.a.kind,
        title,
        signerUserIds: [next.staff],
        staffTurn: true,
      },
      actorId: SYSTEM_ACTOR_ID,
      actorType: "system",
      orgId: input.orgId,
    }),
  )
  void sendStaffTurnMail({
    orgId: input.orgId,
    to: staff.a.invited_email,
    mailId: newActionMailId(),
    title,
    kind: staff.a.kind,
    orgName: staff.sender.orgName,
    senderName: staff.sender.senderName,
    locale: staff.sender.senderLocale,
  }).catch((err) =>
    log.error({ err, orgId: input.orgId, actionId: next.id }, "staff signer notice failed"),
  )
  return { openedId: next.id, signerIsStaff: true }
}

/**
 * Withdraws every open action of one target at once, in one transaction: a void,
 * a version replaced by a newer one. Decided actions keep their decision.
 */
export async function revokeTargetClientActions(input: {
  orgId: string
  targetApp: string
  targetType: string
  targetId: string
  reason: ClientActionRevokeReason
  byUserId: string | null
  byAgent?: boolean
}): Promise<string[]> {
  return withPrivilegedDb(input.orgId, "client-action-revoke-target", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(sql`
        UPDATE ${K()}.client_actions
           SET revoked_at = now(), revoked_by = ${input.byUserId}, revoke_reason = ${input.reason}
         WHERE org_id = ${input.orgId} AND target_app = ${input.targetApp}
           AND target_type = ${input.targetType} AND target_id = ${input.targetId}
           AND decided_at IS NULL AND revoked_at IS NULL
         RETURNING id
      `),
    )
    for (const r of rows) {
      await writeClientActionEvent(tx, {
        orgId: input.orgId,
        actionId: r.id,
        event: "revoked",
        actorKind: input.byAgent ? "agent" : input.byUserId ? "staff" : "system",
        actorUserId: input.byUserId,
        meta: { reason: input.reason },
      })
    }
    return rows.map((r) => r.id)
  })
}

/** A signer mailed again this recently is not mailed again by the next reminder. */
const REMINDED_MINUTES = 10

export interface RemindedLink {
  id: string
  invitedName: string
  invitedEmail: string
}

/**
 * A reminder: each named link of this app that is open and was mailed gets a fresh token (the
 * one mailed before stops working) and a new mail. A staff signer, a signer still waiting for
 * their turn and a closed link get nothing. Every token of the reminder is replaced in one
 * transaction, or none is. A signer whose link was mailed again in the last minutes (the same
 * reminder, its answer lost, asked again) keeps that link and gets no second mail: they are
 * answered in `recentlyMailed`. A signer whose last mail failed holds no link that opens, so
 * they are mailed. The document is read once.
 */
export async function remindClientActions(input: {
  orgId: string
  targetApp: string
  ids: readonly string[]
  /** What the reminder goes on, kept for a mail that leaves later. */
  mailDecision?: MailDecision | null
  /** Run over the addresses about to be mailed; a code stops the reminder before any mail. */
  check?: (emails: string[]) => Promise<{ code: string; message: string } | null>
}): Promise<
  | { reminded: RemindedLink[]; recentlyMailed: RemindedLink[] }
  | { stopped: { code: string; message: string } }
> {
  if (input.ids.length === 0) return { reminded: [], recentlyMailed: [] }
  const wanted = sql.join(
    input.ids.map((id) => sql`${id}`),
    sql`, `,
  )
  interface OpenLink {
    id: string
    kind: ClientActionKind
    target_type: string
    target_id: string
    invited_name: string | null
    invited_email: string
    created_by_user_id: string | null
    expires_at: Date
    recent: boolean
  }
  const readOpen = async (tx: PrivilegedDb): Promise<OpenLink[]> =>
    extractRows<OpenLink>(
      await tx.execute(sql`
        SELECT a.id, a.kind, a.target_type, a.target_id, a.invited_name, a.invited_email,
               a.created_by_user_id, a.expires_at,
               coalesce((SELECT count(*) >= 2 AND
                                max(e.at) > now() - make_interval(mins => ${REMINDED_MINUTES})
                           FROM ${K()}.client_action_events e
                          WHERE e.action_id = a.id AND e.org_id = a.org_id AND e.event = 'sent'),
                        false) AND NOT ${mailFailedSql("a")} AS recent
          FROM ${K()}.client_actions a
         WHERE a.org_id = ${input.orgId} AND a.target_app = ${input.targetApp}
           AND a.id::text IN (${wanted})
           AND a.decided_at IS NULL AND a.revoked_at IS NULL AND a.expires_at > now()
           AND a.code_locked_at IS NULL AND a.token_hash IS NOT NULL AND a.signer_user_id IS NULL
         ORDER BY a.sign_order NULLS LAST, a.created_at
      `),
    )
  const asLink = (r: OpenLink): RemindedLink => ({
    id: r.id,
    invitedName: r.invited_name ?? r.invited_email,
    invitedEmail: r.invited_email,
  })
  const open = await withPrivilegedDb(input.orgId, "client-action-remind", readOpen)
  const due = open.filter((r) => !r.recent)
  if (due.length === 0) return { reminded: [], recentlyMailed: open.map(asLink) }
  const stop = input.check ? await input.check(due.map((r) => r.invited_email)) : null
  if (stop) return { stopped: stop }
  // Each document once, however many of its signers are reminded.
  const titles = new Map<string, string | null>()
  for (const r of due) {
    if (titles.has(r.target_id)) continue
    const view = await viewTarget({
      orgId: input.orgId,
      targetApp: input.targetApp,
      targetType: r.target_type,
      targetId: r.target_id,
      actingUserId: r.created_by_user_id,
    })
    titles.set(r.target_id, view === "down" ? null : view.title)
  }
  const checked = new Set(due.map((r) => r.id))
  const out = await withPrivilegedDb(input.orgId, "client-action-remind-send", async (tx) => {
    // The same reminder asked twice waits here, then reads that the first one mailed them.
    await tx.execute(sql`
      SELECT id FROM ${K()}.client_actions
       WHERE org_id = ${input.orgId} AND target_app = ${input.targetApp}
         AND id::text IN (${wanted}) ORDER BY id FOR UPDATE
    `)
    const now = await readOpen(tx)
    const mails: OwedMail[] = []
    const reminded: RemindedLink[] = []
    for (const r of now) {
      if (r.recent || !checked.has(r.id)) continue
      const token = await rotateClientActionToken(tx, input.orgId, r.id)
      if (!token) continue
      const mailId = newActionMailId()
      await tx.execute(sql`UPDATE ${K()}.client_actions SET sent_at = NULL WHERE id = ${r.id}`)
      await writeClientActionEvent(tx, {
        orgId: input.orgId,
        actionId: r.id,
        event: "sent",
        actorKind: "system",
        mailId,
        meta: owedMailMeta(input.mailDecision ?? null, null),
      })
      const sender = await readSender(tx, input.orgId, r.created_by_user_id)
      reminded.push(asLink(r))
      mails.push({
        turn: false,
        link: {
          actionId: r.id,
          token,
          mailId,
          to: r.invited_email,
          name: r.invited_name ?? r.invited_email,
          title: titles.get(r.target_id) ?? sender.orgName,
          kind: r.kind,
          sender,
          expiresAt: new Date(r.expires_at),
          resend: true,
          createdByUserId: r.created_by_user_id,
        },
      })
    }
    return { mails, reminded, recentlyMailed: now.filter((r) => r.recent).map(asLink) }
  })
  mailInBackground(input.orgId, out.mails)
  return { reminded: out.reminded, recentlyMailed: out.recentlyMailed }
}

/** The link a later one takes the place of, as both read it under the target's lock. */
interface PriorLink {
  id: string
  kind: ClientActionKind
  target_type: string
  target_id: string
  target_sha256: string | null
  target_blocks_sha256: string | null
  contact_id: string | null
  company_id: string | null
  invited_email: string
  invited_name: string | null
  sign_order: number | null
  group_id: string
  required_phrase: string | null
  decision: string | null
  code_verified_at: Date | null
  revoked_at: Date | null
  revoke_reason: string | null
  expires_at: Date
  token_hash: string | null
  visible_to: string[] | null
}

async function readPriorLink(
  tx: PrivilegedDb,
  input: { orgId: string; targetApp: string; afterActionId: string },
): Promise<PriorLink> {
  const [prior] = extractRows<PriorLink>(
    await tx.execute(sql`
      SELECT id, kind, target_type, target_id, target_sha256, target_blocks_sha256, contact_id,
             company_id, invited_email, invited_name, sign_order, group_id, required_phrase, decision,
             code_verified_at, revoked_at, revoke_reason, expires_at, token_hash, visible_to
        FROM ${K()}.client_actions
       WHERE id = ${input.afterActionId} AND org_id = ${input.orgId}
         AND target_app = ${input.targetApp}
       FOR UPDATE
    `),
  )
  if (!prior) throw new ClientActionError("NOT_FOUND", "No such link of this app", 404)
  return prior
}

/** A later link that took this one's place, if one did. */
async function replacementOf(
  tx: PrivilegedDb,
  orgId: string,
  prior: PriorLink,
): Promise<(SentLink & { revoked_at: Date | null }) | null> {
  const [later] = extractRows<SentLink & { revoked_at: Date | null }>(
    await tx.execute(sql`
      SELECT n.id, n.group_id, n.kind, n.contact_id, n.invited_email, n.invited_name, n.sign_order,
             n.token_hash, n.decision, n.expires_at, n.signer_user_id, n.sent_at, n.revoked_at,
             false AS mail_failed
        FROM ${K()}.client_actions n
        JOIN ${K()}.client_action_events e ON e.action_id = n.id AND e.org_id = n.org_id
       WHERE n.org_id = ${orgId} AND n.group_id = ${prior.group_id}
         AND e.event = 'created' AND e.meta->>'replaces' = ${prior.id}
       ORDER BY n.created_at LIMIT 1
    `),
  )
  return later ?? null
}

/**
 * The signers before this one's turn, held until the transaction ends: an answer one of them is
 * giving now is read by `earlierUnsigned`, and one given later finds the link this transaction
 * wrote. In signing order, and before the link itself, as `openNextSignerTurn` takes them.
 */
async function holdEarlierSigners(
  tx: PrivilegedDb,
  orgId: string,
  link: Pick<PriorLink, "group_id" | "sign_order">,
): Promise<void> {
  if (link.sign_order === null) return
  await tx.execute(sql`
    SELECT g.id FROM ${K()}.client_actions g
     WHERE g.org_id = ${orgId} AND g.group_id = ${link.group_id}
       AND g.sign_order < ${link.sign_order}
     ORDER BY g.sign_order, g.created_at
     FOR SHARE OF g`)
}

const holdsALink = (name: string) =>
  new ClientActionError(
    "HOLDS_A_LINK",
    `${name} already holds a link of this document at that address; nobody signs on two`,
    409,
  )

/** Refuses a place to someone who has one of their own in the send, whether or not it ran out. */
async function refuseHeldPlace(
  tx: PrivilegedDb,
  orgId: string,
  prior: PriorLink,
  invitee: Invitee,
): Promise<void> {
  const [holds] = extractRows<{ invited_name: string }>(
    await tx.execute(sql`
      SELECT h.invited_name FROM ${K()}.client_actions h
       WHERE h.org_id = ${orgId} AND h.group_id = ${prior.group_id} AND h.id <> ${prior.id}
         AND h.decided_at IS NULL AND h.revoked_at IS NULL
         AND h.contact_id IS NOT DISTINCT FROM ${invitee.contactId}::uuid
         AND h.invited_email = ${invitee.email}
         AND (h.contact_id IS NOT NULL OR lower(h.invited_name) = lower(${nameOf(invitee)}))
         AND NOT ${replacedSql("h")}
       LIMIT 1
    `),
  )
  if (holds) throw holdsALink(holds.invited_name)
}

/** Under "one after the other": whether a signer before this turn has not signed yet. */
async function earlierUnsigned(
  tx: PrivilegedDb,
  orgId: string,
  prior: PriorLink,
): Promise<boolean> {
  if (prior.sign_order === null) return false
  const [row] = extractRows<{ n: number }>(
    await tx.execute(sql`
      SELECT count(*)::int AS n FROM ${K()}.client_actions g
       WHERE g.org_id = ${orgId} AND g.group_id = ${prior.group_id}
         AND g.sign_order < ${prior.sign_order} AND NOT ${replacedSql("g")}
         AND (g.decision IS NULL OR g.decision NOT IN ('signed', 'accepted'))
    `),
  )
  return (row?.n ?? 0) > 0
}

interface InPlaceInput {
  orgId: string
  targetApp: string
  afterActionId: string
  expiresInDays?: (typeof EXPIRY_DAYS)[number]
  createdByUserId: string | null
  createdByAgentId?: string | null
  approvedByUserId?: string | null
  mailDecision?: MailDecision | null
}

type InPlaceResult = MintResult & { replacedId: string }

/**
 * A link in the place of an earlier one: same document held to the same fingerprint, same group,
 * turn, phrase and readers. One transaction withdraws the earlier link when it is still open and
 * writes the new one, or neither. Under "one after the other" it waits for its turn, with no token
 * and no mail, until every signer before it has signed. The same call again answers the link it
 * made; another person in a place already taken is refused.
 */
async function linkInPlaceOf(
  input: InPlaceInput,
  who: (prior: PriorLink) => Pick<MintInput, "contactId" | "companyId"> & {
    email: string
    name: string | null
    message?: string | null
  },
  refuse: (tx: PrivilegedDb, prior: PriorLink) => Promise<void> | void,
): Promise<InPlaceResult> {
  const first = await withPrivilegedDb(input.orgId, "client-action-new-link-read", async (tx) => {
    const prior = await readPriorLink(tx, input)
    if (!(await replacementOf(tx, input.orgId, prior))) await refuse(tx, prior)
    return prior
  })
  const w = who(first)
  const mint: MintInput = {
    orgId: input.orgId,
    kind: first.kind,
    targetApp: input.targetApp,
    targetType: first.target_type,
    targetId: first.target_id,
    ...(first.target_sha256 ? { targetSha256: first.target_sha256 } : {}),
    ...(first.target_blocks_sha256 ? { targetBlocksSha256: first.target_blocks_sha256 } : {}),
    contactId: w.contactId,
    companyId: w.companyId,
    invitedEmail: w.email,
    invitedName: w.name,
    expiresInDays: input.expiresInDays ?? 14,
    signOrder: first.sign_order,
    groupId: first.group_id,
    requiredPhrase: first.required_phrase,
    message: w.message ?? null,
    // A restricted target's link is seen by its list alone: the new link keeps the list the
    // one it replaces holds (the follow step keeps that one current), never NULL for everyone.
    ...(first.visible_to && first.visible_to.length > 0 ? { visibleTo: first.visible_to } : {}),
    createdByUserId: input.createdByUserId,
    createdByAgentId: input.createdByAgentId ?? null,
    approvedByUserId: input.approvedByUserId ?? null,
    mailDecision: input.mailDecision ?? null,
    replacesActionId: first.id,
  }
  assertMintable(mint)
  const view = await readMintView(mint)
  const made = await withPrivilegedDb(input.orgId, "client-action-new-link", async (tx) => {
    await lockTargetLinks(tx, mint)
    await holdEarlierSigners(tx, input.orgId, first)
    const prior = await readPriorLink(tx, input)
    const invitee = await resolveInvitee(tx, mint)
    const later = await replacementOf(tx, input.orgId, prior)
    if (later) {
      const key = signerKey({ ...invitee, name: nameOf(invitee) })
      const had = signerKey({
        contactId: later.contact_id,
        email: later.invited_email,
        name: later.invited_name,
      })
      const stands =
        later.decision === null &&
        later.revoked_at === null &&
        new Date(later.expires_at).getTime() > Date.now()
      if (key !== had || !stands)
        throw new ClientActionError(
          "ALREADY_REPLACED",
          `A later link, to ${later.invited_name}, already took this one's place`,
          409,
        )
      return {
        input: mint,
        token: null,
        mailId: "",
        mail: null,
        staffMail: null,
        result: {
          id: later.id,
          status: later.token_hash ? ("open" as const) : ("waiting_turn" as const),
          expiresAt: new Date(later.expires_at),
          mailQueued: false,
          deduped: true,
          invitedEmail: later.invited_email,
          invitedName: later.invited_name,
          signerIsStaff: later.signer_user_id !== null,
          title: view.title,
          sharedOnPortal: false,
        },
      } satisfies Inserted
    }
    await refuse(tx, prior)
    await refuseHeldPlace(tx, input.orgId, prior, invitee)
    if (prior.decision === null && prior.revoked_at === null) {
      await tx.execute(sql`
        UPDATE ${K()}.client_actions
           SET revoked_at = now(), revoked_by = ${input.createdByUserId}, revoke_reason = 'replaced'
         WHERE id = ${prior.id} AND org_id = ${input.orgId}`)
      await writeClientActionEvent(tx, {
        orgId: input.orgId,
        actionId: prior.id,
        event: "revoked",
        actorKind: input.createdByUserId ? "staff" : "system",
        actorUserId: input.createdByUserId,
        meta: { reason: "replaced" },
      })
    }
    const sender = await readSender(tx, input.orgId, input.createdByUserId)
    const inserted = await insertClientAction(
      tx,
      { ...mint, waitingTurn: await earlierUnsigned(tx, input.orgId, prior) },
      view,
      invitee,
      sender,
    )
    // Another link of that person on this document: theirs, never this place's.
    if (inserted.result.deduped) throw holdsALink(inserted.result.invitedName)
    await queueLinksMade(tx, mint, inserted.result.id, prior.group_id)
    return inserted
  })
  mailInBackground(input.orgId, mailsOf([made]))
  return { ...made.result, replacedId: first.id }
}

/**
 * A new link for one signer of a send, in the same group and turn: after their link
 * expired or was withdrawn, after a decline made without the emailed code, or to a corrected
 * address. Their earlier link, if still open, is withdrawn with it. Signatures already given
 * stand. A signer who signed, or who declined after proving the code, gets no new link; one whose
 * turn has not come waits for it.
 */
export function newLinkAfter(
  input: InPlaceInput & { email?: string | null },
): Promise<InPlaceResult> {
  return linkInPlaceOf(
    input,
    (prior) => ({
      contactId: prior.contact_id,
      companyId: prior.company_id,
      email: input.email?.trim().toLowerCase() || prior.invited_email,
      name: prior.invited_name,
    }),
    (_tx, prior) => {
      if (prior.decision !== null && prior.decision !== "declined")
        throw new ClientActionError("ALREADY_DECIDED", "This signer already gave their answer", 409)
      if (prior.decision === "declined" && prior.code_verified_at !== null)
        throw new ClientActionError(
          "DECLINED_BY_SIGNER",
          "This signer declined after proving the emailed code; a new version is sent for a new answer",
          409,
        )
      // A link that ran out while it waited never opens by itself: its signer may have a new one.
      if (
        prior.decision === null &&
        prior.revoked_at === null &&
        prior.token_hash === null &&
        new Date(prior.expires_at).getTime() > Date.now()
      )
        throw new ClientActionError(
          "NOT_THEIR_TURN",
          "This signer waits for the signer before them; their link opens after that signature",
          409,
        )
    },
  )
}

/** The withdrawals another person may sign in the place of: never a void or a newer version. */
const REPLACEABLE: readonly (string | null)[] = ["withdrawn", "access_ended", "person_removed"]

/**
 * Another person in the place of a signer who was withdrawn: the same document and turn, their
 * own name, link and code. The withdrawn signer's link stays in the trail, and no longer counts in
 * the send. Refuses a signer who was not withdrawn, and anyone who already has a place of their own
 * in this send, unanswered: now, at their turn, or on a link that ran out.
 */
export function signInPlaceOf(
  input: InPlaceInput & {
    signer: { contactId?: string | null; email?: string | null; name?: string | null }
    companyId?: string | null
    message?: string | null
  },
): Promise<InPlaceResult> {
  return linkInPlaceOf(
    input,
    (prior) => ({
      contactId: input.signer.contactId ?? null,
      companyId: input.companyId ?? prior.company_id,
      email: input.signer.email ?? "",
      name: input.signer.name ?? null,
      message: input.message ?? null,
    }),
    async (tx, prior) => {
      if (
        prior.decision !== null ||
        prior.revoked_at === null ||
        !REPLACEABLE.includes(prior.revoke_reason)
      )
        throw new ClientActionError(
          "SIGNER_NOT_WITHDRAWN",
          "Only a signer whose link was withdrawn can be replaced by another person",
          409,
        )
      const who = await resolveInvitee(tx, {
        orgId: input.orgId,
        contactId: input.signer.contactId ?? null,
        invitedEmail: input.signer.email ?? null,
        invitedName: input.signer.name ?? null,
      } as MintInput)
      const [holds] = extractRows<{ invited_name: string }>(
        await tx.execute(sql`
          SELECT h.invited_name FROM ${K()}.client_actions h
           WHERE h.org_id = ${input.orgId} AND h.group_id = ${prior.group_id}
             AND h.decided_at IS NULL AND h.revoked_at IS NULL
             AND (h.invited_email = ${who.email}
                  OR h.contact_id = ${who.contactId}::uuid)
             AND NOT ${replacedSql("h")}
           LIMIT 1
        `),
      )
      if (holds) throw holdsALink(holds.invited_name)
    },
  )
}

/** One link of a target as its app lists it: who, which turn, and where it stands. */
export interface TargetLink {
  id: string
  invitedName: string
  invitedEmail: string
  signOrder: number | null
  state: "open" | "waiting_turn" | "decided" | "declined" | "revoked" | "expired" | "locked"
  decidedAt: Date | null
  codeVerified: boolean
  expiresAt: Date
  /** A later link of the same signer replaced this one: it no longer counts in the send. */
  replaced: boolean
  /** Why a withdrawn link was withdrawn (`access_ended` when the portal access ended), else null. */
  revokeReason: string | null
  /** The member who signs with this link (a staff signer), else null. */
  signerUserId: string | null
  /** How many signers the send that made it has; null when it was not written as part of one. */
  sendSize: number | null
  /** Where its mail is, while it can be answered. */
  mail: LinkMailState
}

/** Every link of one target of this app, newest turn last (no token, code or device field). */
export async function listTargetClientActions(input: {
  orgId: string
  targetApp: string
  targetType: string
  targetId: string
}): Promise<TargetLink[]> {
  const rows = await withPrivilegedDb(input.orgId, "client-action-list-target", async (tx) =>
    extractRows<{
      id: string
      invited_name: string | null
      invited_email: string
      sign_order: number | null
      decision: string | null
      decided_at: Date | null
      revoked_at: Date | null
      code_locked_at: Date | null
      code_verified_at: Date | null
      token_hash: string | null
      expires_at: Date
      replaced: boolean
      revoke_reason: string | null
      signer_user_id: string | null
      sent_at: Date | null
      mail_failed: boolean
      send_size: number | null
    }>(
      await tx.execute(sql`
        SELECT l.id, l.invited_name, l.invited_email, l.sign_order, l.decision, l.decided_at,
               l.revoked_at, l.revoke_reason, l.code_locked_at, l.code_verified_at, l.token_hash, l.expires_at,
               l.signer_user_id, l.sent_at, ${mailFailedSql("l")} AS mail_failed,
               (SELECT (e.meta->>'send_size')::int FROM ${K()}.client_action_events e
                 WHERE e.action_id = l.id AND e.org_id = l.org_id AND e.event = 'created'
                 LIMIT 1) AS send_size,
               ${replacedSql("l")} AS replaced
          FROM ${K()}.client_actions l
         WHERE l.org_id = ${input.orgId} AND l.target_app = ${input.targetApp}
           AND l.target_type = ${input.targetType} AND l.target_id = ${input.targetId}
         ORDER BY l.sign_order NULLS LAST, l.created_at
      `),
    ),
  )
  const now = Date.now()
  return rows.map((r) => ({
    id: r.id,
    invitedName: r.invited_name ?? r.invited_email,
    invitedEmail: r.invited_email,
    signOrder: r.sign_order,
    state:
      r.decision === "declined"
        ? "declined"
        : r.decision !== null
          ? "decided"
          : r.revoked_at
            ? "revoked"
            : new Date(r.expires_at).getTime() <= now
              ? "expired"
              : r.code_locked_at
                ? "locked"
                : r.token_hash
                  ? "open"
                  : "waiting_turn",
    // The driver may hand a timestamp back as text on some paths: always a Date here.
    decidedAt: r.decided_at ? new Date(r.decided_at) : null,
    codeVerified: r.code_verified_at !== null,
    expiresAt: new Date(r.expires_at),
    replaced: r.replaced === true,
    revokeReason: r.revoked_at ? r.revoke_reason : null,
    signerUserId: r.signer_user_id ?? null,
    sendSize: r.send_size === null ? null : Number(r.send_size),
    mail: r.revoked_at ? null : mailStateOf(r),
  }))
}

/** What a decided action recorded, for the app that owns its target to keep as evidence. */
export interface ClientActionRecord {
  id: string
  groupId: string
  kind: ClientActionKind
  targetType: string
  targetId: string
  targetSha256: string
  decision: string | null
  decidedAt: Date | null
  decidedVia: string | null
  contactId: string | null
  signerUserId: string | null
  invitedEmail: string
  invitedName: string
  invitedBy: string
  signOrder: number | null
  typedName: string | null
  capacity: string | null
  wordsShown: string | null
  wordsKey: string | null
  wordsLang: string | null
  requiredPhrase: string | null
  typedPhrase: string | null
  codeVerifiedAt: Date | null
  documentShownAt: Date | null
  reachedEndAt: Date | null
  declineReason: string | null
  ip: string | null
  userAgent: string | null
  /** A later link of the same signer replaced this one: its decision no longer counts. */
  replaced: boolean
  /** Every live action of the same send, in signing order: who signed, who declined, who
   * waits. A link a later one replaced is not in it. */
  group: Array<{ id: string; signOrder: number | null; decision: string | null; open: boolean }>
}

/** One action of the calling app's targets, as decided; null when it is not that app's. */
export async function readClientActionRecord(
  orgId: string,
  targetApp: string,
  id: string,
): Promise<ClientActionRecord | null> {
  return withPrivilegedDb(orgId, "client-action-record", async (tx) => {
    const [r] = extractRows<Record<string, unknown>>(
      await tx.execute(sql`
        SELECT a.id, a.group_id, a.kind, a.target_type, a.target_id, a.target_sha256, a.decision,
               a.decided_at, a.decided_via, a.contact_id, a.signer_user_id, a.invited_email,
               a.invited_name, a.sign_order, a.typed_name, a.capacity, a.words_shown, a.words_key,
               a.words_lang, a.required_phrase, a.typed_phrase, a.code_verified_at,
               a.document_shown_at, a.decline_reason,
               coalesce(u.name, u.email, o.name) AS invited_by,
               (SELECT (e.meta->>'reached_end_at') FROM ${K()}.client_action_events e
                 WHERE e.action_id = a.id AND e.event = 'reached_end'
                 ORDER BY e.at ASC LIMIT 1) AS reached_end_at,
               d.ip, d.user_agent, ${replacedSql("a")} AS replaced
          FROM ${K()}.client_actions a
          JOIN ${K()}.organizations o ON o.id = a.org_id
          LEFT JOIN ${K()}.users u ON u.id = a.created_by_user_id AND u.org_id = a.org_id
          LEFT JOIN LATERAL (
            SELECT dv.ip, dv.user_agent FROM ${K()}.client_action_events e
              JOIN ${K()}.client_action_devices dv ON dv.event_id = e.id
             WHERE e.action_id = a.id AND e.event IN ('decided', 'declined')
             ORDER BY e.at DESC LIMIT 1
          ) d ON true
         WHERE a.id = ${id} AND a.org_id = ${orgId} AND a.target_app = ${targetApp}
      `),
    )
    if (!r) return null
    const group = extractRows<{
      id: string
      sign_order: number | null
      decision: string | null
      open: boolean
    }>(
      await tx.execute(sql`
        SELECT g.id, g.sign_order, g.decision,
               (g.decided_at IS NULL AND g.revoked_at IS NULL AND g.expires_at > now()) AS open
          FROM ${K()}.client_actions g
         WHERE g.org_id = ${orgId} AND g.group_id = ${r.group_id} AND NOT ${replacedSql("g")}
         ORDER BY g.sign_order NULLS LAST, g.created_at
      `),
    )
    const date = (v: unknown) => (v ? new Date(v as string) : null)
    const str = (v: unknown) => (typeof v === "string" ? v : null)
    return {
      id: String(r.id),
      groupId: String(r.group_id),
      kind: r.kind as ClientActionKind,
      targetType: String(r.target_type),
      targetId: String(r.target_id),
      targetSha256: String(r.target_sha256),
      decision: str(r.decision),
      decidedAt: date(r.decided_at),
      decidedVia: str(r.decided_via),
      contactId: str(r.contact_id),
      signerUserId: str(r.signer_user_id),
      invitedEmail: String(r.invited_email),
      invitedName: String(r.invited_name),
      invitedBy: String(r.invited_by ?? ""),
      signOrder: typeof r.sign_order === "number" ? r.sign_order : null,
      typedName: str(r.typed_name),
      capacity: str(r.capacity),
      wordsShown: str(r.words_shown),
      wordsKey: str(r.words_key),
      wordsLang: str(r.words_lang),
      requiredPhrase: str(r.required_phrase),
      typedPhrase: str(r.typed_phrase),
      codeVerifiedAt: date(r.code_verified_at),
      documentShownAt: date(r.document_shown_at),
      reachedEndAt: date(r.reached_end_at),
      declineReason: str(r.decline_reason),
      ip: str(r.ip),
      userAgent: str(r.user_agent),
      replaced: r.replaced === true,
      group: group.map((g) => ({
        id: g.id,
        signOrder: g.sign_order,
        decision: g.decision,
        open: g.open === true,
      })),
    }
  })
}
