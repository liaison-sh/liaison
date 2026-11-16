// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * An app's doors into client actions (modules/client-actions/mint.ts). Apps never
 * call the gated agent tool `client_action_create`: they mint, open the next
 * signer's turn, read a decision and withdraw through these methods.
 *
 *  - `client_actions_mint({ send })`: one approved send, every signer of it, in
 *    the order asked. Only for a target type the app declared in
 *    `clientActionTargets`, and only while the handler runs under a person's
 *    decision on one of the app's own gated, never auto-approved tools (an
 *    approval, or that person's own click). Under "one after the other" only the
 *    first signer gets a link; the others wait with no token and no mail.
 *  - `client_actions_mint({ next_turn_after })`: the next waiting signer of an
 *    already approved send, once every signer before them signed. No approval
 *    of its own: the send was approved, and the kernel checks the order.
 *  - `client_actions_record({ id })`: what a decided action recorded (read-only).
 *  - `client_actions_revoke({ target_type, target_id, reason })`: every open
 *    action of one target, in one transaction. "replaced" needs no decision (a
 *    newer version kills the old links); any other reason does, like a send.
 *
 * Every refusal answers data with a code, never a throw, since only an error's
 * message crosses the sandbox boundary.
 */

import { isManagedEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import {
  ClientActionError,
  type ClientActionRevokeReason,
  EXPIRY_DAYS,
  type MintResult,
  mintClientAction,
  openNextSignerTurn,
  readClientActionRecord,
  revokeClientAction,
  revokeTargetClientActions,
  signerAddresses,
} from "~/modules/client-actions/mint"
import { type ClientActionKind, declaredTarget } from "~/modules/client-actions/targets"
import { describeStop, evaluateSendGuard, isPinnedSendGuard } from "~/modules/mail/send-guard"
import { hasScope } from "~/modules/permissions/permissions"

/** The most signers one send may carry. */
export const MAX_SIGNERS_PER_SEND = 40

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REVOKE_REASONS: ClientActionRevokeReason[] = [
  "withdrawn",
  "replaced",
  "access_ended",
  "person_removed",
  "sender_voided",
]

function refuse(code: string, message: string): string {
  return JSON.stringify({ status: "error", error: { code, message } })
}

/**
 * Why a signature cannot be asked on this server, or null. The hosted edition
 * offers no signature unless its operator turned it on; a signature with no
 * timestamp authority would seal nothing a court could date.
 */
export function signingUnavailable(kind: string): { code: string; message: string } | null {
  if (kind !== "sign") return null
  if (isManagedEdition() && !env.LIAISON_MANAGED_SIGNING_ENABLED) {
    return {
      code: "SIGNING_NOT_AVAILABLE",
      message: "Signatures are not offered on this hosted service. Nothing was sent.",
    }
  }
  if (!env.LIAISON_TSA_URL) {
    return {
      code: "TIMESTAMP_NOT_CONFIGURED",
      message:
        "This server has no timestamp authority (LIAISON_TSA_URL), so a signature cannot be sealed. Nothing was sent; the operator sets one up.",
    }
  }
  return null
}

interface SendSigner {
  contact_id?: string | null
  email?: string | null
  name?: string | null
}

interface SendParams {
  target_type: string
  target_id: string
  sha256: string
  kind: ClientActionKind
  expires_in_days: number
  order: "sequential" | "any"
  message?: string | null
  required_phrase?: string | null
  company_id?: string | null
  visible_to?: string[] | null
  signers: SendSigner[]
  /** The service-mail check the card pinned; held again here, before any link. */
  send_guard?: unknown
}

function actionOut(r: MintResult, signOrder: number | null) {
  return {
    id: r.id,
    status: r.status,
    sign_order: signOrder,
    invited_name: r.invitedName,
    invited_email: r.invitedEmail,
    signer_is_staff: r.signerIsStaff,
    mail_queued: r.mailQueued,
    deduped: r.deduped,
    shared_on_portal: r.sharedOnPortal,
    expires_at: r.expiresAt.toISOString(),
  }
}

export function createClientActionsMethods(ctx: BridgeContext): Record<string, any> {
  const { appName, orgId, userId, approvalContext, bridgeOptions, bridgeActingAgentId } = ctx

  /** One of this app's own gated, never auto-approved tools. */
  const ownHumanOnlyGated = async (full: string | undefined): Promise<boolean> => {
    if (!full || !full.startsWith(`${appName}:`)) return false
    const { toolRegistry } = await import("~/modules/apps/app-registries")
    const t = toolRegistry.get([orgId, appName, full.slice(appName.length + 1)])
    return t?.gated === true && t.noAutoApprove === true
  }

  /**
   * The run is a person's decision: their approval of the app's tool, or their own click on
   * it. A click is decided by the tool's own scope, as the gate decided it: `personScopes` is
   * set only for a person's direct call reached through no cross-app hop, and must hold the
   * tool's required scopes. No approve scope is asked of a person.
   */
  const personDecided = async (): Promise<boolean> => {
    if (approvalContext && (await ownHumanOnlyGated(approvalContext.toolName))) return true
    if (bridgeOptions?.origin !== "human-ui" || !bridgeOptions.personScopes) return false
    const outer = bridgeOptions.callChain?.[bridgeOptions.callChain.length - 1]
    if (!(await ownHumanOnlyGated(outer)) || !outer) return false
    const { toolRegistry } = await import("~/modules/apps/app-registries")
    const t = toolRegistry.get([orgId, appName, outer.slice(appName.length + 1)])
    const required = (t?.requiredScopes ?? []) as string[]
    const own = bridgeOptions.personScopes as string[]
    return required.length > 0 && required.every((s) => hasScope(s, own))
  }

  const actorUserId = (): string | null => (UUID.test(userId) ? userId : null)

  /** A pinned check must name every signer's address and still clear, or no link is made. */
  async function guardStops(
    guard: unknown,
    signers: SendSigner[],
  ): Promise<{ code: string; message: string } | null> {
    let addresses: string[]
    try {
      addresses = await signerAddresses(orgId, signers)
    } catch (err) {
      if (err instanceof ClientActionError)
        return { code: err.code, message: `${err.message}. Nothing was sent.` }
      throw err
    }
    if (
      !isPinnedSendGuard(guard) ||
      !addresses.every((a) => guard.addresses.map((x) => x.toLowerCase()).includes(a))
    )
      return {
        code: "SEND_GUARD_MISMATCH",
        message:
          "The send no longer matches the check its card pinned (another signer or address). Nothing was sent.",
      }
    const verdict = await evaluateSendGuard({ orgId, guard, recipients: addresses, at: "send" })
    if (verdict.state === "clear") return null
    return {
      code: `SEND_GUARD_${verdict.state.toUpperCase()}`,
      message: `${describeStop(verdict, "approved")} Nothing was sent.`,
    }
  }

  async function mintSend(p: SendParams): Promise<string> {
    const target = declaredTarget(orgId, appName, p.target_type)
    if (!target)
      return refuse(
        "TARGET_NOT_REGISTERED",
        `${appName} declares no client action target ${p.target_type}. Nothing was sent.`,
      )
    if (!target.kinds.includes(p.kind))
      return refuse(
        "KIND_NOT_ALLOWED",
        `${p.target_type} takes ${target.kinds.join(", ")}, not ${p.kind}. Nothing was sent.`,
      )
    if (!(await personDecided()))
      return refuse(
        "MINT_NEEDS_A_PERSON",
        "Links are made only inside a person's decision on this app's send. Nothing was sent.",
      )
    const unavailable = signingUnavailable(p.kind)
    if (unavailable) return refuse(unavailable.code, unavailable.message)
    if (!(EXPIRY_DAYS as readonly number[]).includes(p.expires_in_days))
      return refuse("INVALID_EXPIRY", "A link lasts 7, 14 or 30 days. Nothing was sent.")
    const signers = Array.isArray(p.signers) ? p.signers : []
    if (signers.length === 0 || signers.length > MAX_SIGNERS_PER_SEND)
      return refuse(
        "INVALID_SIGNERS",
        `A send has 1 to ${MAX_SIGNERS_PER_SEND} signers. Nothing was sent.`,
      )
    if (p.send_guard !== undefined) {
      const stop = await guardStops(p.send_guard, signers)
      if (stop) return refuse(stop.code, stop.message)
    }
    const sequential = p.order === "sequential"
    const groupId = crypto.randomUUID()
    const made: Array<ReturnType<typeof actionOut>> = []
    try {
      for (const [i, s] of signers.entries()) {
        const signOrder = sequential ? i + 1 : null
        const r = await mintClientAction({
          orgId,
          kind: p.kind,
          targetApp: appName,
          targetType: p.target_type,
          targetId: p.target_id,
          targetSha256: p.sha256,
          contactId: s.contact_id ?? null,
          companyId: p.company_id ?? null,
          invitedEmail: s.email ?? null,
          invitedName: s.name ?? null,
          expiresInDays: p.expires_in_days as (typeof EXPIRY_DAYS)[number],
          signOrder,
          groupId,
          waitingTurn: sequential && i > 0,
          visibleTo: p.visible_to ?? null,
          requiredPhrase: p.required_phrase ?? null,
          message: p.message ?? null,
          createdByUserId: actorUserId(),
          createdByAgentId: bridgeActingAgentId ?? null,
        })
        made.push(actionOut(r, signOrder))
      }
    } catch (err) {
      // A send is all of its signers or none: what was made before the failure is withdrawn.
      for (const m of made) {
        if (m.deduped) continue
        await revokeClientAction({ orgId, id: m.id, reason: "withdrawn", byUserId: actorUserId() })
      }
      if (err instanceof ClientActionError)
        return refuse(err.code, `${err.message}. Nothing was sent.`)
      throw err
    }
    return JSON.stringify({ status: "ok", group_id: groupId, actions: made })
  }

  return {
    client_actions_mint: async (paramsJson: string): Promise<string> => {
      const p = JSON.parse(paramsJson || "{}") as {
        send?: SendParams
        next_turn_after?: string
      }
      if (p.send) return mintSend(p.send)
      if (typeof p.next_turn_after === "string" && UUID.test(p.next_turn_after)) {
        try {
          const out = await openNextSignerTurn({
            orgId,
            targetApp: appName,
            afterActionId: p.next_turn_after,
          })
          return JSON.stringify({
            status: "ok",
            opened_id: out.openedId,
            signer_is_staff: out.signerIsStaff,
          })
        } catch (err) {
          if (err instanceof ClientActionError) return refuse(err.code, err.message)
          throw err
        }
      }
      return refuse("INVALID_INPUT", "client_actions_mint takes { send } or { next_turn_after }.")
    },

    client_actions_record: async (paramsJson: string): Promise<string> => {
      const p = JSON.parse(paramsJson || "{}") as { id?: string }
      if (typeof p.id !== "string" || !UUID.test(p.id))
        return refuse("INVALID_INPUT", "client_actions_record takes { id }.")
      const r = await readClientActionRecord(orgId, appName, p.id)
      if (!r) return refuse("NOT_FOUND", `No client action ${p.id} of ${appName}.`)
      const iso = (d: Date | null) => (d ? d.toISOString() : null)
      return JSON.stringify({
        status: "ok",
        record: {
          id: r.id,
          group_id: r.groupId,
          kind: r.kind,
          target_type: r.targetType,
          target_id: r.targetId,
          target_sha256: r.targetSha256,
          decision: r.decision,
          decided_at: iso(r.decidedAt),
          decided_via: r.decidedVia,
          contact_id: r.contactId,
          signer_user_id: r.signerUserId,
          invited_email: r.invitedEmail,
          invited_name: r.invitedName,
          invited_by: r.invitedBy,
          sign_order: r.signOrder,
          typed_name: r.typedName,
          capacity: r.capacity,
          words_shown: r.wordsShown,
          words_key: r.wordsKey,
          words_lang: r.wordsLang,
          required_phrase: r.requiredPhrase,
          typed_phrase: r.typedPhrase,
          code_verified_at: iso(r.codeVerifiedAt),
          document_shown_at: iso(r.documentShownAt),
          reached_end_at: iso(r.reachedEndAt),
          decline_reason: r.declineReason,
          ip: r.ip,
          user_agent: r.userAgent,
          group: r.group.map((g) => ({
            id: g.id,
            sign_order: g.signOrder,
            decision: g.decision,
            open: g.open,
          })),
        },
      })
    },

    client_actions_revoke: async (paramsJson: string): Promise<string> => {
      const p = JSON.parse(paramsJson || "{}") as {
        target_type?: string
        target_id?: string
        reason?: string
      }
      const reason = p.reason as ClientActionRevokeReason
      if (!REVOKE_REASONS.includes(reason))
        return refuse("INVALID_INPUT", `reason is one of ${REVOKE_REASONS.join(", ")}.`)
      if (typeof p.target_type !== "string" || !declaredTarget(orgId, appName, p.target_type))
        return refuse(
          "TARGET_NOT_REGISTERED",
          `${appName} declares no client action target ${String(p.target_type)}. Nothing was withdrawn.`,
        )
      if (typeof p.target_id !== "string" || !UUID.test(p.target_id))
        return refuse("INVALID_INPUT", "client_actions_revoke takes a target_id.")
      if (reason !== "replaced" && !(await personDecided()))
        return refuse(
          "REVOKE_NEEDS_A_PERSON",
          "Links are withdrawn only inside a person's decision on this app's tool. Nothing was withdrawn.",
        )
      const ids = await revokeTargetClientActions({
        orgId,
        targetApp: appName,
        targetType: p.target_type,
        targetId: p.target_id,
        reason,
        byUserId: actorUserId(),
        byAgent: bridgeActingAgentId != null,
      })
      return JSON.stringify({ status: "ok", revoked_ids: ids })
    },
  }
}
