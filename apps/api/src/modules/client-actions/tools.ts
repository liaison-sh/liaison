// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The three kernel tools on client actions. `client_action_create` is gated and
// never auto-approved: an agent's call parks a card a person decides, and only
// then is anything sent. `client_action_revoke` closes at once on a person's
// clean turn and parks otherwise. `client_actions_list` reads under the caller's
// own RLS (scope, restricted documents), never a token hash, and marks the turn:
// a decline reason and a typed name are client text. No tool signs, decides or
// accepts for a client.

import type { ApprovalSummary } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { z } from "zod"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { toolRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import {
  describeStop,
  evaluateSendGuard,
  isPinnedSendGuard,
  plainGuardSince,
} from "~/modules/mail/send-guard"
import { ClientActionError, type EXPIRY_DAYS, mintClientAction, revokeClientAction } from "./mint"
import { clientActionState } from "./state"
import { declaredTarget, viewTarget } from "./targets"

interface ToolCtx {
  userId: string
  orgId: string
  db: RlsClient
  actingAgentId?: string | null
}

function refusal(err: unknown) {
  if (err instanceof ClientActionError) {
    return { error: { code: err.code, message: err.message, status: err.status } }
  }
  throw err
}

export const clientActionCreateParams = z.object({
  kind: z.enum(["sign", "accept", "approve"]),
  target_app: z.string().min(1).max(64),
  target_type: z.string().min(1).max(64),
  target_id: z.string().uuid(),
  target_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional()
    .describe("Set by Liaison; never pass it."),
  target_blocks_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional()
    .describe("Set by Liaison; never pass it."),
  contact_id: z.string().uuid(),
  invited_email: z
    .string()
    .email()
    .optional()
    .describe("Only to correct the contact's address; otherwise the contact's own."),
  expires_in_days: z.union([z.literal(7), z.literal(14), z.literal(30)]),
  sign_order: z.number().int().min(1).max(20).optional(),
  group_id: z.string().uuid().optional(),
  message: z.string().max(2000).optional(),
  sendGuard: z.unknown().optional().describe("Set by Liaison; never pass it."),
  guardKey: z.string().max(500).optional().describe("Set by Liaison; never pass it."),
})

/** One open request per target, contact and address: the approval's and the mint's key. */
export function clientActionGuardKey(targetId: string, contactId: string, email: string): string {
  return `${targetId}:${contactId}:${email.trim().toLowerCase()}`
}

async function invitedAddress(
  params: { contact_id: string; invited_email?: string },
  ctx: ToolCtx,
): Promise<string | null> {
  if (params.invited_email) return params.invited_email.trim().toLowerCase()
  const [c] = extractRows<{ email: string | null }>(
    await ctx.db.execute(
      sql`SELECT lower(email) AS email FROM ${sql.raw(schemaRef("kernel"))}.contacts WHERE id = ${params.contact_id}`,
    ),
  )
  return c?.email ?? null
}

/**
 * Stage time: refuses what the send would refuse, and pins the send check (a
 * plain service mail to the invited address, checked again when it goes) and
 * the dedupe key, so the card shows them and the approved call is held to them.
 */
/**
 * A target whose app sends its own links (it checks the document, its state and its signers
 * before any link goes) is never reached by this generic tool.
 */
function sentByItsApp(
  params: z.infer<typeof clientActionCreateParams>,
  orgId: string,
): { error: { code: string; message: string; status: number } } | null {
  const target = declaredTarget(orgId, params.target_app, params.target_type)
  if (target?.mintedBy !== "app") return null
  return {
    error: {
      code: "TARGET_SENT_BY_ITS_APP",
      message: `Nothing was sent: links to ${params.target_app}.${params.target_type} are made only by the ${params.target_app} app's own send, which checks the document and its signers first. Next: send it with that app's send tool.`,
      status: 409,
    },
  }
}

export async function clientActionCreatePreflight(
  params: z.infer<typeof clientActionCreateParams>,
  ctx: ToolCtx,
): Promise<unknown> {
  const byApp = sentByItsApp(params, ctx.orgId)
  if (byApp) return byApp
  const email = await invitedAddress(params, ctx)
  if (!email) {
    return {
      error: {
        code: "EMAIL_REQUIRED",
        message: `Contact ${params.contact_id} has no email address you can read: nothing was staged. Next: add their address, or give invited_email.`,
      },
    }
  }
  // The version the card stands for: the target as it reads now, hashed by its app (or the
  // kernel). The approved call mints only while the target still hashes to it.
  const why: { refused?: string } = {}
  const view = await viewTarget(
    {
      orgId: ctx.orgId,
      targetApp: params.target_app,
      targetType: params.target_type,
      targetId: params.target_id,
      actingUserId: ctx.userId,
    },
    undefined,
    why,
  )
  if (view === "down") {
    return {
      error: {
        code: "TARGET_UNAVAILABLE",
        message: why.refused
          ? `${params.target_app}.${params.target_type} ${params.target_id} cannot be shown to the client: ${why.refused.replace(/\.+\s*$/, "")}. Nothing was staged.`
          : `${params.target_app}.${params.target_type} ${params.target_id} could not be read: nothing was staged. Next: check the id with that app's own read, then ask again.`,
        status: 503,
      },
    }
  }
  const sendGuard = {
    ...plainGuardSince([email], [params.contact_id], new Date()),
    classification: "service" as const,
  }
  return {
    ok: true,
    pinnedParams: {
      sendGuard,
      guardKey: clientActionGuardKey(params.target_id, params.contact_id, email),
      target_sha256: view.sha256,
      ...(view.blocksSha256 ? { target_blocks_sha256: view.blocksSha256 } : {}),
    },
  }
}

export async function handleClientActionCreate(
  params: z.infer<typeof clientActionCreateParams>,
  ctx: ToolCtx,
) {
  const byApp = sentByItsApp(params, ctx.orgId)
  if (byApp) return byApp
  // An approved agent call carries the pinned check: the link goes only if the
  // address still takes mail and the call is the one the card showed.
  if (
    params.sendGuard !== undefined ||
    params.guardKey !== undefined ||
    params.target_sha256 === undefined
  ) {
    const email = await invitedAddress(params, ctx)
    if (
      !email ||
      params.target_sha256 === undefined ||
      !isPinnedSendGuard(params.sendGuard) ||
      params.guardKey !== clientActionGuardKey(params.target_id, params.contact_id, email) ||
      !params.sendGuard.addresses.includes(email)
    ) {
      return {
        error: {
          code: "SEND_GUARD_MISMATCH",
          message:
            "Nothing was sent: the request no longer matches the card that was approved (another contact, address or document). Next: send a new request.",
          status: 409,
        },
      }
    }
    const verdict = await evaluateSendGuard({
      orgId: ctx.orgId,
      guard: params.sendGuard,
      recipients: [email],
      at: "send",
    })
    if (verdict.state !== "clear") {
      return {
        error: {
          code: `SEND_GUARD_${verdict.state.toUpperCase()}`,
          message: `${describeStop(verdict, "approved")} No link was made for ${email}.`,
          status: verdict.state === "unavailable" ? 503 : 409,
        },
      }
    }
  }
  try {
    const r = await mintClientAction({
      orgId: ctx.orgId,
      kind: params.kind,
      targetApp: params.target_app,
      targetType: params.target_type,
      targetId: params.target_id,
      targetSha256: params.target_sha256,
      ...(params.target_blocks_sha256 ? { targetBlocksSha256: params.target_blocks_sha256 } : {}),
      contactId: params.contact_id,
      invitedEmail: params.invited_email ?? null,
      expiresInDays: params.expires_in_days as (typeof EXPIRY_DAYS)[number],
      signOrder: params.sign_order ?? null,
      groupId: params.group_id ?? null,
      message: params.message ?? null,
      createdByUserId: ctx.userId,
      createdByAgentId: ctx.actingAgentId ?? null,
      mailDecision: { guard: isPinnedSendGuard(params.sendGuard) ? params.sendGuard : null },
    })
    const until = r.expiresAt.toISOString().slice(0, 10)
    const happened = r.deduped
      ? `A request to ${r.invitedName} to ${params.kind} "${r.title}" was already open (${r.id}); nothing new was sent.`
      : r.signerIsStaff
        ? `${r.invitedName} is a member here: they ${params.kind} "${r.title}" from their own session. They were told on their Home and by a mail with no link; no link was mailed.`
        : r.mailQueued
          ? `The link to ${params.kind} "${r.title}" is on its way to ${r.invitedName} <${r.invitedEmail}>, valid until ${until}.`
          : `Request ${r.id} for ${r.invitedName} waits for its turn; their link goes when the earlier signers are done.`
    return {
      id: r.id,
      status: r.status,
      expires_at: r.expiresAt.toISOString(),
      sent: r.mailQueued,
      result: `${happened}${r.sharedOnPortal ? " It is also shown on their client portal." : ""} Nothing is signed or accepted until they do it themselves.`,
      next: "Check it with client_actions_list; withdraw it with client_action_revoke.",
    }
  } catch (err) {
    return refusal(err)
  }
}

export const clientActionRevokeParams = z.object({
  id: z.string().uuid(),
  reason: z.enum(["withdrawn", "sender_voided"]).default("withdrawn"),
})

export async function handleClientActionRevoke(
  params: z.infer<typeof clientActionRevokeParams>,
  ctx: ToolCtx,
) {
  // The caller must be able to read it: the same RLS the list uses (scope, restricted rows).
  const visible = extractRows<{ id: string }>(
    await ctx.db.execute(
      sql`SELECT id FROM ${sql.raw(schemaRef("kernel"))}.client_actions WHERE id = ${params.id}`,
    ),
  )
  if (visible.length === 0) {
    return { error: { code: "not_found", message: `No client request ${params.id}`, status: 404 } }
  }
  const r = await revokeClientAction({
    orgId: ctx.orgId,
    id: params.id,
    reason: params.reason,
    byUserId: ctx.userId,
    byAgent: Boolean(ctx.actingAgentId),
  })
  if (!r.revoked) {
    return {
      id: r.id,
      status: r.state,
      result: `Request ${r.id} was not open (already decided, withdrawn or expired): nothing changed.`,
    }
  }
  return {
    id: r.id,
    status: "revoked",
    result: `Request ${r.id} is withdrawn: its link and any code already sent no longer work.`,
    next: "Send a new request with client_action_create if the client should still act.",
  }
}

export const clientActionsListParams = z.object({
  target_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  state: z
    .enum([
      "open",
      "waiting_turn",
      "signed",
      "accepted",
      "approved",
      "declined",
      "expired",
      "locked",
      "revoked",
    ])
    .optional(),
  limit: z.number().int().min(1).max(100).default(25),
})

interface ListRow {
  id: string
  kind: "sign" | "accept" | "approve"
  target_app: string
  target_type: string
  target_id: string
  company_id: string | null
  contact_id: string | null
  invited_name: string
  invited_email: string
  sign_order: number | null
  expires_at: string
  sent_at: string | null
  first_opened_at: string | null
  decided_at: string | null
  decision: "signed" | "accepted" | "approved" | "declined" | null
  decided_via: string | null
  typed_name: string | null
  decline_reason: string | null
  code_locked_at: string | null
  code_verified_at: string | null
  revoked_at: string | null
  revoke_reason: string | null
  created_at: string
  now: string
}

export async function handleClientActionsList(
  params: z.infer<typeof clientActionsListParams>,
  ctx: ToolCtx,
) {
  // Named columns only: the request role has no right on the token hashes at all.
  const rows = extractRows<ListRow & { has_token: boolean }>(
    await ctx.db.execute(sql`
      SELECT id, kind, target_app, target_type, target_id, company_id, contact_id, invited_name,
             invited_email, sign_order, expires_at, sent_at, first_opened_at, decided_at, decision,
             decided_via, typed_name, decline_reason, code_locked_at, code_verified_at, revoked_at,
             revoke_reason, created_at, now() AS now,
             (sent_at IS NOT NULL OR first_opened_at IS NOT NULL OR decided_at IS NOT NULL
              OR signer_user_id IS NOT NULL OR sign_order IS NULL) AS has_token
        FROM ${sql.raw(schemaRef("kernel"))}.client_actions
       WHERE (${params.target_id ?? null}::uuid IS NULL OR target_id = ${params.target_id ?? null}::uuid)
         AND (${params.company_id ?? null}::uuid IS NULL OR company_id = ${params.company_id ?? null}::uuid)
       ORDER BY created_at DESC
       LIMIT 200
    `),
  )
  const items = rows
    .map((r) => {
      const state = clientActionState(
        {
          revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
          decidedAt: r.decided_at ? new Date(r.decided_at) : null,
          decision: r.decision,
          expiresAt: new Date(r.expires_at),
          codeLockedAt: r.code_locked_at ? new Date(r.code_locked_at) : null,
          // The token hash is not readable here: an ordered signer never mailed waits for their turn.
          hasToken: r.has_token,
        },
        new Date(r.now),
      )
      return {
        id: r.id,
        kind: r.kind,
        target: { app: r.target_app, type: r.target_type, id: r.target_id },
        company_id: r.company_id,
        contact_id: r.contact_id,
        invited: { name: r.invited_name, email: r.invited_email },
        state,
        expires_at: r.expires_at,
        opened: r.first_opened_at !== null,
        decided_at: r.decided_at,
        decided_via: r.decided_via,
        typed_name: r.typed_name,
        decline_reason: r.decline_reason,
        code_verified: r.code_verified_at !== null,
        revoke_reason: r.revoke_reason,
      }
    })
    .filter((r) => !params.state || r.state === params.state)
    .slice(0, params.limit)
  return {
    items,
    result:
      items.length === 0
        ? "No client requests match."
        : `${items.length} client request${items.length === 1 ? "" : "s"}. Typed names and decline reasons are the client's own words.`,
  }
}

async function contactLabel(tx: RlsClient, contactId: string | undefined): Promise<string> {
  if (!contactId) return "(no contact)"
  const [c] = extractRows<{ name: string | null; email: string | null }>(
    await tx.execute(
      sql`SELECT name, email FROM ${sql.raw(schemaRef("kernel"))}.contacts WHERE id = ${contactId}`,
    ),
  )
  if (!c) return "(unknown contact)"
  return c.email ? `${c.name ?? c.email} <${c.email}>` : (c.name ?? "(no name)")
}

export async function summarizeClientActionCreate(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = params as Partial<z.infer<typeof clientActionCreateParams>>
  const who = await contactLabel(ctx.tx, p.contact_id)
  const to = p.invited_email ? ` at ${p.invited_email}` : ""
  return {
    kind: "client_action_create",
    title: `Send ${who}${to} a link to ${p.kind ?? "act on"} ${p.target_app ?? ""}.${p.target_type ?? ""}`,
    lines: [
      `A link and, when they open it, an emailed code go to ${who}${to} only.`,
      `It works for ${p.expires_in_days ?? "?"} days. Nothing is signed or accepted until they do it themselves.`,
      ...(p.target_sha256
        ? [
            `It is for the document as it read when this was asked (version ${p.target_sha256.slice(0, 12)}); if the document changes first, no link goes.`,
          ]
        : []),
      ...(p.message ? [`Message: ${p.message}`] : []),
    ],
  }
}

export async function summarizeClientActionRevoke(params: unknown): Promise<ApprovalSummary> {
  const p = params as Partial<z.infer<typeof clientActionRevokeParams>>
  return {
    kind: "client_action_revoke",
    title: `Withdraw the client request ${p.id ?? ""}`,
    lines: ["Its link and any code already sent stop working at once. This cannot be undone."],
  }
}

/** Registers the three tools for one org (called from the kernel tool registration). */
export function registerClientActionTools(orgId: string): void {
  toolRegistry.set([orgId, "kernel", "client_action_create"], {
    appName: "kernel",
    name: "client_action_create",
    deferLoading: true,
    description:
      "Send a person outside the organization a link to sign, accept or approve one document an app offers for it. Liaison fixes the version the link is for when the request is staged. A person approves the send first; the recipient then acts alone with an emailed code. Never signs anything.",
    searchKeywords: [
      "signer",
      "faire signer",
      "accept",
      "accepter",
      "approve",
      "approuver",
      "lien",
      "link",
    ],
    requiredScopes: ["kernel:client_actions:write"],
    approveScope: "kernel:client_actions:write",
    gated: true,
    noAutoApprove: true,
    externalEffect: true,
    approvalImpact: "external",
    writesToTable: "kernel.client_actions",
    params: clientActionCreateParams,
    pinnedParams: ["sendGuard", "guardKey", "target_sha256", "target_blocks_sha256"],
    preflight: clientActionCreatePreflight as (p: unknown, c: any) => Promise<unknown>,
    handler: handleClientActionCreate as (p: unknown, c: any) => Promise<unknown>,
  })
  registerApprovalSummarizer(orgId, "kernel", "client_action_create", summarizeClientActionCreate)

  toolRegistry.set([orgId, "kernel", "client_action_revoke"], {
    appName: "kernel",
    name: "client_action_revoke",
    deferLoading: true,
    description:
      "Withdraw an open request to sign, accept or approve: its link and codes stop working at once. Runs on a person's clean turn, otherwise a person approves it.",
    searchKeywords: ["withdraw", "retirer", "annuler", "cancel", "revoke", "lien", "link"],
    requiredScopes: ["kernel:client_actions:write"],
    approveScope: "kernel:client_actions:write",
    conditionalGate: true,
    externalEffect: true,
    // A person's own clean turn runs it; a routine, MCP or a turn after outside text parks.
    requiresHumanTurn: true,
    approvalImpact: "external",
    writesToTable: "kernel.client_actions",
    params: clientActionRevokeParams,
    handler: handleClientActionRevoke as (p: unknown, c: any) => Promise<unknown>,
  })
  registerApprovalSummarizer(orgId, "kernel", "client_action_revoke", summarizeClientActionRevoke)

  toolRegistry.set([orgId, "kernel", "client_actions_list"], {
    appName: "kernel",
    name: "client_actions_list",
    deferLoading: true,
    readOnly: true,
    taintSource: true,
    description:
      "List requests sent outside the organization to sign, accept or approve, with their state (open, signed, declined, expired, withdrawn). Typed names and decline reasons are the outside person's words.",
    searchKeywords: [
      "signé",
      "en attente",
      "waiting",
      "signed",
      "declined",
      "refusé",
      "demandes",
      "requests",
    ],
    requiredScopes: ["kernel:client_actions:read"],
    params: clientActionsListParams,
    handler: handleClientActionsList as (p: unknown, c: any) => Promise<unknown>,
  })
}
