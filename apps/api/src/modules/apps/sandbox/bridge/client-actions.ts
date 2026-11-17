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
 *  - `client_actions_signed_copy({ target_type, target_id, create, archive_ids, readers_only })`:
 *    the Knowledge copy of a signed target, written and read back as the member who
 *    sent it for signature (modules/client-actions/signed-copy.ts). Only for a
 *    declared target with a decided action; the kernel finds the sender itself.
 *  - `client_actions_call_as_sender({ target_type, target_id, tool, params, idempotency_key })`:
 *    one call the app declares in `cross_app_calls`, run as that same sender with their live
 *    permissions (a change request's task and time plan), never as a wider system identity.
 *    From the app's handler of a decided target (no agent, routine or approval in the run), an
 *    ungated call runs on the act of the person who approved the send, as that person.
 *  - `client_actions_own_group({ key })`: the id of the contact group the app keeps for itself
 *    under that key (made when its routine template was enabled), or null.
 *
 * Every refusal answers data with a code, never a throw, since only an error's
 * message crosses the sandbox boundary.
 */

import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import {
  ClientActionError,
  type ClientActionRevokeReason,
  EXPIRY_DAYS,
  listTargetClientActions,
  type MintResult,
  mintClientAction,
  newLinkAfter,
  openNextSignerTurn,
  readClientActionRecord,
  remindClientActions,
  revokeClientAction,
  revokeTargetClientActions,
  signerAddresses,
} from "~/modules/client-actions/mint"
import { signingUnavailable } from "~/modules/client-actions/signing-state"
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

/**
 * The decided client action a run is the consequence of, or null; a call chained from it runs
 * on the act of the person who approved that action's send (`callAsSender`). Never in a run with
 * an agent, an MCP client, a routine or an approval of its own. The app's
 * `kernel/client_action:decided` handler: the action of that event, as the kernel delivered it
 * (the app cannot name another). The app's own job resuming that decision's work: the action it
 * names, which `callAsSender` accepts only as a positive decision on the same target. Any other
 * run, another event's handler included: none.
 */
export function decidedActionFor(run: {
  bridgeOptions?: {
    jobsAttributedToSystem?: boolean
    decidedActionId?: string
    currentJob?: unknown
    origin?: string
  }
  actorType?: string
  actingAgentId?: string | null
  routineId?: string | null
  approved: boolean
  named: unknown
}): string | null {
  const o = run.bridgeOptions
  if (run.actorType === "agent" || run.actorType === "mcp") return null
  if (run.actingAgentId || run.routineId || run.approved) return null
  if (o?.jobsAttributedToSystem === true)
    return o.decidedActionId && UUID.test(o.decidedActionId) ? o.decidedActionId : null
  if (o?.currentJob && o.origin !== "human-ui")
    return typeof run.named === "string" && UUID.test(run.named) ? run.named : null
  return null
}

export function createClientActionsMethods(ctx: BridgeContext): Record<string, any> {
  const {
    appName,
    orgId,
    userId,
    actorType,
    approvalContext,
    bridgeOptions,
    bridgeActingAgentId,
    bridgeRoutineId,
  } = ctx

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

  /**
   * The person whose decision this run is (after `personDecided`): the approval's decider, or
   * the person who clicked. Recorded on every action of the send, so a call chained from the
   * approved send runs on that person's own act. Null when no person decided.
   */
  const decidingPerson = async (): Promise<string | null> => {
    if (approvalContext && (await ownHumanOnlyGated(approvalContext.toolName)))
      return UUID.test(approvalContext.approvalDeciderId) ? approvalContext.approvalDeciderId : null
    return bridgeOptions?.origin === "human-ui" ? actorUserId() : null
  }

  const decidedActionOf = (named: unknown): string | null =>
    decidedActionFor({
      bridgeOptions,
      actorType,
      actingAgentId: bridgeActingAgentId,
      routineId: bridgeRoutineId,
      approved: approvalContext !== undefined && approvalContext !== null,
      named,
    })

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
    return guardHolds(guard, addresses)
  }

  /** The pinned check names every address and still clears for them. */
  async function guardHolds(
    guard: unknown,
    addresses: string[],
  ): Promise<{ code: string; message: string } | null> {
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

  /** A reminder: each named open mailed link of this app gets a fresh token and a new mail. */
  async function remind(p: { ids?: unknown; send_guard?: unknown }): Promise<string> {
    const ids = Array.isArray(p.ids) ? p.ids : []
    if (
      ids.length === 0 ||
      ids.length > MAX_SIGNERS_PER_SEND ||
      !ids.every((id): id is string => typeof id === "string" && UUID.test(id))
    )
      return refuse("INVALID_INPUT", `remind takes 1 to ${MAX_SIGNERS_PER_SEND} client action ids.`)
    if (!(await personDecided()))
      return refuse(
        "MINT_NEEDS_A_PERSON",
        "Reminders go only inside a person's decision on this app's reminder. Nothing was sent.",
      )
    const guard = p.send_guard
    const reminded = await remindClientActions({
      orgId,
      targetApp: appName,
      ids,
      ...(guard !== undefined ? { check: (emails: string[]) => guardHolds(guard, emails) } : {}),
    })
    if (!Array.isArray(reminded)) return refuse(reminded.stopped.code, reminded.stopped.message)
    return JSON.stringify({
      status: "ok",
      reminded: reminded.map((r) => ({ id: r.id, invited_name: r.invitedName })),
    })
  }

  /** A new link for one signer, in the same group and turn (newLinkAfter). */
  async function newLink(p: {
    after?: string
    email?: string | null
    expires_in_days?: number
  }): Promise<string> {
    if (typeof p.after !== "string" || !UUID.test(p.after))
      return refuse("INVALID_INPUT", "new_link takes the client action id it replaces (after).")
    if (p.email != null && (typeof p.email !== "string" || !p.email.includes("@")))
      return refuse("INVALID_INPUT", "email is an email address. Nothing was sent.")
    const days = p.expires_in_days ?? 14
    if (!(EXPIRY_DAYS as readonly number[]).includes(days))
      return refuse("INVALID_EXPIRY", "A link lasts 7, 14 or 30 days. Nothing was sent.")
    if (!(await personDecided()))
      return refuse(
        "MINT_NEEDS_A_PERSON",
        "A new link is made only inside a person's decision on this app's tool. Nothing was sent.",
      )
    try {
      const r = await newLinkAfter({
        orgId,
        targetApp: appName,
        afterActionId: p.after,
        email: p.email ?? null,
        expiresInDays: days as (typeof EXPIRY_DAYS)[number],
        createdByUserId: actorUserId(),
        createdByAgentId: bridgeActingAgentId ?? null,
        approvedByUserId: await decidingPerson(),
      })
      return JSON.stringify({
        status: "ok",
        replaced_id: r.replacedId,
        action: actionOut(r, null),
      })
    } catch (err) {
      if (err instanceof ClientActionError)
        return refuse(err.code, `${err.message}. Nothing was sent.`)
      throw err
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
    const approvedBy = await decidingPerson()
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
          approvedByUserId: approvedBy,
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
        remind?: { ids?: unknown; send_guard?: unknown }
        new_link?: { after?: string; email?: string | null; expires_in_days?: number }
      }
      if (p.send) return mintSend(p.send)
      if (p.remind) return remind(p.remind)
      if (p.new_link) return newLink(p.new_link)
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
      return refuse(
        "INVALID_INPUT",
        "client_actions_mint takes { send }, { next_turn_after }, { remind } or { new_link }.",
      )
    },

    client_actions_record: async (paramsJson: string): Promise<string> => {
      const p = JSON.parse(paramsJson || "{}") as {
        id?: string
        target_type?: string
        target_id?: string
      }
      if (p.id === undefined && typeof p.target_type === "string") {
        if (!declaredTarget(orgId, appName, p.target_type))
          return refuse(
            "TARGET_NOT_REGISTERED",
            `${appName} declares no client action target ${p.target_type}.`,
          )
        if (typeof p.target_id !== "string" || !UUID.test(p.target_id))
          return refuse("INVALID_INPUT", "client_actions_record takes a target_id.")
        const links = await listTargetClientActions({
          orgId,
          targetApp: appName,
          targetType: p.target_type,
          targetId: p.target_id,
        })
        return JSON.stringify({
          status: "ok",
          links: links.map((l) => ({
            id: l.id,
            invited_name: l.invitedName,
            invited_email: l.invitedEmail,
            sign_order: l.signOrder,
            state: l.state,
            decided_at: l.decidedAt ? l.decidedAt.toISOString() : null,
            code_verified: l.codeVerified,
            expires_at: l.expiresAt.toISOString(),
            replaced: l.replaced,
            revoke_reason: l.revokeReason,
            signer_user_id: l.signerUserId,
          })),
        })
      }
      if (typeof p.id !== "string" || !UUID.test(p.id))
        return refuse(
          "INVALID_INPUT",
          "client_actions_record takes { id } or { target_type, target_id }.",
        )
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
          replaced: r.replaced,
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

    client_actions_signed_copy: async (paramsJson: string): Promise<string> => {
      let p: {
        target_type?: unknown
        target_id?: unknown
        create?: unknown
        archive_ids?: unknown
        readers_only?: unknown
        routine_owners_of?: unknown
      }
      try {
        p = JSON.parse(paramsJson || "{}")
      } catch {
        return refuse("INVALID_INPUT", "client_actions_signed_copy takes a JSON object.")
      }
      if (typeof p.target_type !== "string" || !declaredTarget(orgId, appName, p.target_type))
        return refuse(
          "TARGET_NOT_REGISTERED",
          `${appName} declares no client action target ${String(p.target_type)}. No copy was written.`,
        )
      if (typeof p.target_id !== "string" || !UUID.test(p.target_id))
        return refuse("INVALID_INPUT", "client_actions_signed_copy takes a target_id.")
      if (!p.create || typeof p.create !== "object" || Array.isArray(p.create))
        return refuse("INVALID_INPUT", "client_actions_signed_copy takes the create params.")
      const archiveIds = Array.isArray(p.archive_ids)
        ? p.archive_ids.filter((x): x is string => typeof x === "string" && UUID.test(x))
        : []
      const { writeSignedCopyAsSender } = await import("~/modules/client-actions/signed-copy")
      const out = await writeSignedCopyAsSender({
        orgId,
        appName,
        targetType: p.target_type,
        targetId: p.target_id,
        create: p.create as Record<string, unknown>,
        archiveIds,
        ...(Array.isArray(p.routine_owners_of)
          ? {
              routineOwnersOf: p.routine_owners_of.filter(
                (x): x is string => typeof x === "string",
              ),
            }
          : {}),
        ...(Array.isArray(p.readers_only)
          ? {
              readersOnly: p.readers_only.filter(
                (x): x is string => typeof x === "string" && UUID.test(x),
              ),
            }
          : {}),
      })
      if (out.status === "created")
        return JSON.stringify({
          status: "ok",
          document_id: out.documentId,
          sender_user_id: out.senderUserId,
          archived: out.archived,
        })
      return JSON.stringify({ status: "not_made", code: out.code, message: out.message })
    },

    client_actions_own_group: async (paramsJson: string): Promise<string> => {
      let p: { key?: unknown }
      try {
        p = JSON.parse(paramsJson || "{}")
      } catch {
        return refuse("INVALID_INPUT", "client_actions_own_group takes a JSON object.")
      }
      if (typeof p.key !== "string")
        return refuse("INVALID_INPUT", "client_actions_own_group takes a key.")
      const { ownSystemGroupId } = await import("~/modules/client-actions/signed-copy")
      const id = await ownSystemGroupId({ orgId, appName, key: p.key })
      return JSON.stringify({ status: "ok", group_id: id })
    },

    client_actions_call_as_sender: async (paramsJson: string): Promise<string> => {
      let p: {
        target_type?: unknown
        target_id?: unknown
        tool?: unknown
        params?: unknown
        idempotency_key?: unknown
        decided_action_id?: unknown
      }
      try {
        p = JSON.parse(paramsJson || "{}")
      } catch {
        return refuse("INVALID_INPUT", "client_actions_call_as_sender takes a JSON object.")
      }
      if (typeof p.target_type !== "string" || !declaredTarget(orgId, appName, p.target_type))
        return refuse(
          "TARGET_NOT_REGISTERED",
          `${appName} declares no client action target ${String(p.target_type)}. Nothing was done.`,
        )
      if (typeof p.target_id !== "string" || !UUID.test(p.target_id))
        return refuse("INVALID_INPUT", "client_actions_call_as_sender takes a target_id.")
      if (typeof p.tool !== "string" || !p.tool.includes(":"))
        return refuse("INVALID_INPUT", "client_actions_call_as_sender takes a tool app:name.")
      if (p.params !== undefined && (typeof p.params !== "object" || Array.isArray(p.params)))
        return refuse("INVALID_INPUT", "client_actions_call_as_sender takes params as an object.")
      const { callAsSender } = await import("~/modules/client-actions/signed-copy")
      const out = await callAsSender({
        orgId,
        appName,
        declaredCalls: (ctx.manifest.cross_app_calls ?? []).map((c) => c.target),
        targetType: p.target_type,
        targetId: p.target_id,
        tool: p.tool,
        params: (p.params ?? {}) as Record<string, unknown>,
        decidedActionId: decidedActionOf(p.decided_action_id),
        ...(typeof p.idempotency_key === "string" && p.idempotency_key.length <= 200
          ? { idempotencyKey: p.idempotency_key }
          : {}),
      })
      if (out.status === "completed")
        return JSON.stringify({ status: "completed", result: out.result })
      if (out.status === "pending_approval")
        return JSON.stringify({ status: "pending_approval", approval_id: out.approvalId })
      return refuse(out.code, out.message)
    },
  }
}
