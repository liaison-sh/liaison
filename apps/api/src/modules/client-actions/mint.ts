// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Making, rotating and withdrawing a client action. The raw token exists only in
// this call's memory and the link mail: the row holds its SHA-256. A rotation
// moves the old hash to `prior_token_hashes`, which opens only the "replaced"
// page. The link mail is sent from here and not awaited; a send that fails
// rotates the token again (the mailed one is dead) and tells the sender, and no
// rendered body is ever queued for a retry.
//
// Apps never call the gated agent tool: they reach `mintClientAction` and
// `revokeClientAction` through their bridge methods. The agent's tool reaches
// them after a person approved its card.

import { sql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { generateToken, hashToken } from "~/lib/crypto"
import { rootLogger } from "~/lib/logger"
import { writeClientActionEvent } from "./events"
import { newActionMailId, sendLinkMail, sendStaffTurnMail } from "./mail"
import { type ClientActionKind, declaredTarget, viewTarget } from "./targets"

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
      SELECT o.name AS org_name, u.name, u.email, u.locale
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

/** The person's link, sent and not awaited. A failed send makes that link dead by rotation. */
function mailLink(args: {
  orgId: string
  actionId: string
  token: string
  mailId: string
  to: string
  title: string
  kind: ClientActionKind
  sender: Sender
  expiresAt: Date
  message?: string | null
  resend?: boolean
  createdByUserId: string | null
}): void {
  void sendLinkMail({
    orgId: args.orgId,
    to: args.to,
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
    log.error({ err, orgId: args.orgId, actionId: args.actionId }, "client action link mail failed")
    await killMailedLink(
      args.orgId,
      args.actionId,
      args.title,
      args.to,
      args.createdByUserId,
    ).catch((e) =>
      log.error({ err: e, actionId: args.actionId }, "client action rotate after failed send"),
    )
  })
}

/** After a failed send: the token that was rendered into the mail is rotated out and the sender told. */
async function killMailedLink(
  orgId: string,
  actionId: string,
  title: string,
  invitedName: string,
  senderUserId: string | null,
): Promise<void> {
  await withPrivilegedDb(orgId, "client-action-send-failed", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(sql`
        UPDATE ${K()}.client_actions
           SET prior_token_hashes = CASE WHEN token_hash IS NULL THEN prior_token_hashes
                                          ELSE array_append(prior_token_hashes, token_hash) END,
               token_hash = ${hashToken(generateToken(32))}, sent_at = NULL
         WHERE id = ${actionId} AND org_id = ${orgId} AND decided_at IS NULL AND revoked_at IS NULL
         RETURNING id
      `),
    )
    if (rows.length === 0) return
    await writeClientActionEvent(tx, {
      orgId,
      actionId,
      event: "rotated",
      actorKind: "system",
      meta: { reason: "send_failed" },
    })
    if (senderUserId) {
      await tx.queueEvent({
        app: "kernel",
        entity: "client_action",
        action: "send_failed",
        entityId: actionId,
        data: { title, invitedName, senderUserIds: [senderUserId] },
        actorId: SYSTEM_ACTOR_ID,
        actorType: "system",
        orgId,
      })
    }
  })
}

/**
 * Makes one client action and mails its link. Refuses a target no app of the org
 * declared, a kind the target does not take, and a target whose hash moved since
 * the caller read it. A second call for the same target, contact and address
 * while the first is open returns the first and sends nothing.
 */
export async function mintClientAction(input: MintInput): Promise<MintResult> {
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
  if (input.targetSha256 && input.targetSha256 !== view.sha256) {
    throw new ClientActionError(
      "VERSION_CHANGED",
      "The document changed since it was read; read it again and send that version",
      409,
    )
  }

  const token = input.waitingTurn ? null : generateToken(32)
  const mailId = newActionMailId()
  const out = await withPrivilegedDb(input.orgId, "client-action-mint", async (tx) => {
    const invitee = await resolveInvitee(tx, input)
    const sender = await readSender(tx, input.orgId, input.createdByUserId)
    const [existing] = extractRows<{
      id: string
      expires_at: Date
      token_hash: string | null
      signer_user_id: string | null
    }>(
      await tx.execute(sql`
        SELECT id, expires_at, token_hash, signer_user_id FROM ${K()}.client_actions
         WHERE org_id = ${input.orgId} AND target_id = ${input.targetId}
           AND contact_id IS NOT DISTINCT FROM ${invitee.contactId}
           AND invited_email = ${invitee.email}
           AND decided_at IS NULL AND revoked_at IS NULL AND expires_at > now()
         LIMIT 1
      `),
    )
    if (existing) {
      return {
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
          org_id, group_id, kind, target_app, target_type, target_id, target_sha256, company_id,
          contact_id, signer_user_id, invited_email, invited_name, sign_order, token_hash,
          expires_at, sent_at, visible_to, required_phrase, created_by_user_id, created_by_agent_id
        ) VALUES (
          ${input.orgId}, coalesce(${input.groupId ?? null}::uuid, gen_random_uuid()), ${input.kind},
          ${input.targetApp}, ${input.targetType}, ${input.targetId}, ${view.sha256},
          ${invitee.companyId}, ${invitee.contactId}, ${signerUserId}, ${invitee.email},
          ${invitee.name.slice(0, 200)}, ${input.signOrder ?? null},
          ${token ? hashToken(token) : null},
          now() + make_interval(days => ${input.expiresInDays}),
          ${token && !signerUserId ? sql`now()` : sql`NULL`},
          ${input.visibleTo && input.visibleTo.length > 0 ? sql`${`{${input.visibleTo.join(",")}}`}::uuid[]` : sql`NULL`},
          ${input.requiredPhrase ?? null}, ${input.createdByUserId}, ${input.createdByAgentId ?? null}
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
      meta: { kind: input.kind, target: `${input.targetApp}.${input.targetType}` },
    })
    const mailed = token !== null && signerUserId === null
    if (mailed) {
      await writeClientActionEvent(tx, {
        orgId: input.orgId,
        actionId: row.id,
        event: "sent",
        actorKind: "system",
        mailId,
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
        data: { id: row.id, kind: input.kind, title: view.title, signerUserIds: [signerUserId] },
        actorId: SYSTEM_ACTOR_ID,
        actorType: "system",
        orgId: input.orgId,
      })
    }
    const shared = await openAutomaticShare(tx, input, invitee)
    return {
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
  })
  if (out.mail && token) {
    mailLink({
      orgId: input.orgId,
      actionId: out.result.id,
      token,
      mailId,
      to: out.mail.to,
      title: view.title,
      kind: input.kind,
      sender: out.mail.sender,
      expiresAt: out.result.expiresAt,
      message: input.message,
      createdByUserId: input.createdByUserId,
    })
  }
  if (out.staffMail) {
    const staff = out.staffMail
    void sendStaffTurnMail({
      orgId: input.orgId,
      to: staff.to,
      mailId: newActionMailId(),
      title: view.title,
      kind: input.kind,
      orgName: staff.sender.orgName,
      senderName: staff.sender.senderName,
      locale: staff.sender.senderLocale,
    }).catch((err) =>
      log.error({ err, orgId: input.orgId, actionId: out.result.id }, "staff signer notice failed"),
    )
  }
  return out.result
}

/**
 * The portal share kinds a client action's target opens by itself: a target whose
 * declared type is one of these per-document kinds (kernel.portal_shares) is
 * shared under that kind. Read from the target's type, never from the app's name.
 */
const AUTOMATIC_SHARE_KINDS = new Set(["agreement", "change_request"])

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
): Promise<boolean> {
  if (!AUTOMATIC_SHARE_KINDS.has(input.targetType) || !invitee.companyId || !input.createdByUserId)
    return false
  if (input.visibleTo && input.visibleTo.length > 0) return false
  const kind = input.targetType
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

/** Mails a fresh link for an open action to its invited address (resend, next signer's turn). */
export async function remailClientAction(
  orgId: string,
  actionId: string,
  opts: { resend?: boolean } = {},
): Promise<boolean> {
  const mailId = newActionMailId()
  const out = await withPrivilegedDb(orgId, "client-action-remail", async (tx) => {
    const [a] = extractRows<{
      kind: ClientActionKind
      target_app: string
      target_type: string
      target_id: string
      invited_email: string
      signer_user_id: string | null
      created_by_user_id: string | null
      expires_at: Date
    }>(
      await tx.execute(sql`
        SELECT kind, target_app, target_type, target_id, invited_email, signer_user_id,
               created_by_user_id, expires_at
          FROM ${K()}.client_actions WHERE id = ${actionId} AND org_id = ${orgId}
      `),
    )
    if (!a || a.signer_user_id) return null
    const token = await rotateClientActionToken(tx, orgId, actionId)
    if (!token) return null
    await tx.execute(sql`UPDATE ${K()}.client_actions SET sent_at = now() WHERE id = ${actionId}`)
    await writeClientActionEvent(tx, {
      orgId,
      actionId,
      event: "sent",
      actorKind: "system",
      mailId,
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
  mailLink({
    orgId,
    actionId,
    token: out.token,
    mailId,
    to: out.a.invited_email,
    title: view === "down" ? out.sender.orgName : view.title,
    kind: out.a.kind,
    sender: out.sender,
    expiresAt: new Date(out.a.expires_at),
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
