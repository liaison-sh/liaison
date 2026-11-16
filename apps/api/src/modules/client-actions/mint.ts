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
        SELECT id, sign_order, decision, revoked_at, token_hash, expires_at, target_id,
               target_sha256, signer_user_id
          FROM ${K()}.client_actions
         WHERE org_id = ${input.orgId} AND group_id = ${after.group_id}
         ORDER BY sign_order NULLS LAST, created_at
         FOR UPDATE
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
      data: { id: next.id, kind: staff.a.kind, title, signerUserIds: [next.staff] },
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

/**
 * A reminder: each named link of this app that is open and was mailed gets a fresh token (the
 * one mailed before stops working) and a new mail. A staff signer, a signer still waiting for
 * their turn and a closed link get nothing. Returns the reminded actions with their signer.
 */
export async function remindClientActions(input: {
  orgId: string
  targetApp: string
  ids: readonly string[]
  /** Run over the addresses about to be mailed; a code stops the reminder before any mail. */
  check?: (emails: string[]) => Promise<{ code: string; message: string } | null>
}): Promise<
  | Array<{ id: string; invitedName: string; invitedEmail: string }>
  | { stopped: { code: string; message: string } }
> {
  if (input.ids.length === 0) return []
  const wanted = sql.join(
    input.ids.map((id) => sql`${id}`),
    sql`, `,
  )
  const open = await withPrivilegedDb(input.orgId, "client-action-remind", async (tx) =>
    extractRows<{ id: string; invited_name: string | null; invited_email: string }>(
      await tx.execute(sql`
        SELECT id, invited_name, invited_email FROM ${K()}.client_actions
         WHERE org_id = ${input.orgId} AND target_app = ${input.targetApp}
           AND id::text IN (${wanted})
           AND decided_at IS NULL AND revoked_at IS NULL AND expires_at > now()
           AND code_locked_at IS NULL AND token_hash IS NOT NULL AND signer_user_id IS NULL
         ORDER BY sign_order NULLS LAST, created_at
      `),
    ),
  )
  const stop = input.check ? await input.check(open.map((r) => r.invited_email)) : null
  if (stop) return { stopped: stop }
  const out: Array<{ id: string; invitedName: string; invitedEmail: string }> = []
  for (const r of open) {
    if (await remailClientAction(input.orgId, r.id, { resend: true }))
      out.push({
        id: r.id,
        invitedName: r.invited_name ?? r.invited_email,
        invitedEmail: r.invited_email,
      })
  }
  return out
}

/**
 * A new link for one signer of a send, in the same group and turn: after their link
 * expired or was withdrawn, after a decline made without the emailed code, or to a corrected
 * address. Their earlier link, if still open, is withdrawn first. Signatures already given
 * stand. A signer who signed, or who declined after proving the code, gets no new link.
 */
export async function newLinkAfter(input: {
  orgId: string
  targetApp: string
  afterActionId: string
  email?: string | null
  expiresInDays?: (typeof EXPIRY_DAYS)[number]
  createdByUserId: string | null
  createdByAgentId?: string | null
}): Promise<MintResult & { replacedId: string }> {
  const [prior] = await withPrivilegedDb(input.orgId, "client-action-new-link-read", async (tx) =>
    extractRows<{
      id: string
      kind: ClientActionKind
      target_type: string
      target_id: string
      target_sha256: string | null
      contact_id: string | null
      company_id: string | null
      invited_email: string
      invited_name: string | null
      sign_order: number | null
      group_id: string | null
      required_phrase: string | null
      decision: string | null
      code_verified_at: Date | null
      revoked_at: Date | null
      expires_at: Date
      token_hash: string | null
    }>(
      await tx.execute(sql`
        SELECT id, kind, target_type, target_id, target_sha256, contact_id, company_id,
               invited_email, invited_name, sign_order, group_id, required_phrase, decision,
               code_verified_at, revoked_at, expires_at, token_hash
          FROM ${K()}.client_actions
         WHERE id = ${input.afterActionId} AND org_id = ${input.orgId}
           AND target_app = ${input.targetApp}
      `),
    ),
  )
  if (!prior) throw new ClientActionError("NOT_FOUND", "No such link of this app", 404)
  if (prior.decision !== null && prior.decision !== "declined")
    throw new ClientActionError("ALREADY_DECIDED", "This signer already gave their answer", 409)
  if (prior.decision === "declined" && prior.code_verified_at !== null)
    throw new ClientActionError(
      "DECLINED_BY_SIGNER",
      "This signer declined after proving the emailed code; a new version is sent for a new answer",
      409,
    )
  if (prior.decision === null && prior.revoked_at === null && prior.token_hash === null)
    throw new ClientActionError(
      "NOT_THEIR_TURN",
      "This signer waits for the signer before them; their link opens after that signature",
      409,
    )
  const email = input.email?.trim().toLowerCase() || prior.invited_email
  const stillOpen =
    prior.decision === null && prior.revoked_at === null && new Date(prior.expires_at) > new Date()
  if (stillOpen)
    await revokeClientAction({
      orgId: input.orgId,
      id: prior.id,
      reason: "replaced",
      byUserId: input.createdByUserId,
    })
  const r = await mintClientAction({
    orgId: input.orgId,
    kind: prior.kind,
    targetApp: input.targetApp,
    targetType: prior.target_type,
    targetId: prior.target_id,
    ...(prior.target_sha256 ? { targetSha256: prior.target_sha256 } : {}),
    contactId: prior.contact_id,
    companyId: prior.company_id,
    invitedEmail: email,
    invitedName: prior.invited_name,
    expiresInDays: input.expiresInDays ?? 14,
    signOrder: prior.sign_order,
    groupId: prior.group_id,
    requiredPhrase: prior.required_phrase,
    createdByUserId: input.createdByUserId,
    createdByAgentId: input.createdByAgentId ?? null,
  })
  return { ...r, replacedId: prior.id }
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
    }>(
      await tx.execute(sql`
        SELECT id, invited_name, invited_email, sign_order, decision, decided_at, revoked_at,
               code_locked_at, code_verified_at, token_hash, expires_at
          FROM ${K()}.client_actions
         WHERE org_id = ${input.orgId} AND target_app = ${input.targetApp}
           AND target_type = ${input.targetType} AND target_id = ${input.targetId}
         ORDER BY sign_order NULLS LAST, created_at
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
    decidedAt: r.decided_at,
    codeVerified: r.code_verified_at !== null,
    expiresAt: new Date(r.expires_at),
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
  /** Every action of the same send, in signing order: who signed, who declined, who waits. */
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
                 WHERE e.action_id = a.id AND e.event = 'document_shown'
                 ORDER BY e.at DESC LIMIT 1) AS reached_end_at,
               d.ip, d.user_agent
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
        SELECT id, sign_order, decision,
               (decided_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS open
          FROM ${K()}.client_actions
         WHERE org_id = ${orgId} AND group_id = ${r.group_id}
         ORDER BY sign_order NULLS LAST, created_at
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
      group: group.map((g) => ({
        id: g.id,
        signOrder: g.sign_order,
        decision: g.decision,
        open: g.open === true,
      })),
    }
  })
}
