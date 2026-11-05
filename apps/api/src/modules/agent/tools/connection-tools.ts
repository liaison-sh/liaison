// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The in-app agent's equivalents of `liaison connect --for` and
// `liaison disconnect` (cli/connect, cli/disconnect):
//
// - `kernel__connect_link_send`: an admin sends a member the one-time link that
//   connects THEIR OWN account (connect-links.ts): emailed to them, and handed
//   back so the admin can pass it on too. It works only for that member,
//   signed in as themselves, once, for 30 minutes. A member connecting their
//   own account needs no link: kernel__request_secret kind oauth_connect, mode
//   personal, is their Connect card.
// - `kernel__connection_disconnect`: GATED. The organization's connections for
//   whoever holds the connection's admin scope, a personal connection for its
//   owner only. Someone else's personal connection is never the agent's to
//   remove (its owner, or the operator's CLI with --force).

import { eq } from "drizzle-orm"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { appsLogger } from "~/lib/logger"
import { type OrgConfigToolCtx, resolveActor } from "~/modules/agent/tools/org-config-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import {
  ConnectLinkError,
  checkConnectLinkMint,
  emailConnectLink,
  mintConnectLink,
} from "~/modules/apps/connections/connect-links"
import {
  type DisconnectTarget,
  decideDisconnect,
  disconnectImpact,
  findDisconnectTargets,
  performDisconnect,
} from "~/modules/apps/connections/disconnect-account"

const log = appsLogger.child({ module: "connection-tools" })

interface ToolCtx extends OrgConfigToolCtx {
  scopes?: string[]
}

export interface ConnectLinkSendParams {
  app: string
  connection: string
  email: string
}

export async function handleConnectLinkSend(params: ConnectLinkSendParams, ctx: ToolCtx) {
  const actor = await resolveActor(ctx)
  let link: Awaited<ReturnType<typeof mintConnectLink>>
  try {
    link = await mintConnectLink({
      orgId: ctx.orgId,
      email: params.email,
      appName: params.app,
      connectionName: params.connection,
      minter: { kind: "user", userId: actor.userId, scopes: actor.scopes },
    })
  } catch (err) {
    if (err instanceof ConnectLinkError) {
      return { error: { code: err.code.toUpperCase(), message: err.message } }
    }
    throw err
  }
  const sender = await withPrivilegedDb(ctx.orgId, "connect-link-sender", (tx) =>
    tx.select({ name: users.name }).from(users).where(eq(users.id, actor.userId)).limit(1),
  )
  let emailed = true
  try {
    await emailConnectLink({
      orgId: ctx.orgId,
      link,
      appName: params.app,
      connectionName: params.connection,
      senderName: sender[0]?.name ?? null,
    })
  } catch (err) {
    emailed = false
    log.error({ err, orgId: ctx.orgId, app: params.app }, "connect link email failed")
  }
  return {
    sentTo: link.user.email,
    emailed,
    url: link.url,
    expiresAt: link.expiresAt.toISOString(),
    nextStep: `${emailed ? `The link was emailed to ${link.user.email}.` : `Emailing failed: give ${link.user.email} the link yourself.`} It works once, until ${link.expiresAt.toISOString()}, and only when ${link.user.email} is signed in to Liaison as themselves: it signs nobody in, and anyone else opening it is asked to sign in as them. The connection it makes is theirs (personal).${params.app === "mail" ? " They choose a standard or private mailbox on the link's page; a private one asks for its mailbox password in the same browser." : ""} Say this in two sentences; never tell anyone to click through Settings for it.`,
  }
}

/** Stage time: refuse a link that could not be sent, before anyone is asked to approve it. */
export async function connectLinkSendPreflight(
  params: ConnectLinkSendParams,
  ctx: ToolCtx,
): Promise<unknown> {
  const actor = await resolveActor({ orgId: ctx.orgId, userId: ctx.userId })
  try {
    await checkConnectLinkMint({
      orgId: ctx.orgId,
      email: params.email,
      appName: params.app,
      connectionName: params.connection,
      minter: { kind: "user", userId: actor.userId, scopes: actor.scopes },
    })
  } catch (err) {
    if (err instanceof ConnectLinkError) {
      return { error: { code: err.code.toUpperCase(), message: err.message } }
    }
    throw err
  }
  return { ok: true }
}

/** The approval card: who gets the link, for which connection. */
export async function summarizeConnectLinkSend(params: unknown) {
  const p = params as Partial<ConnectLinkSendParams>
  return {
    kind: "connect_link_send",
    title: `Email ${p.email ?? "a member"} a link to connect their own ${p.app}/${p.connection}`,
    lines: [
      `Emails ${p.email ?? "the member"} a one-time link (30 minutes, once) that connects THEIR OWN ${p.app}/${p.connection} account as a personal connection.`,
      "It works only when they are signed in to Liaison as themselves; it signs nobody in.",
    ],
  }
}

export interface ConnectionDisconnectParams {
  app: string
  connection: string
  account: string
  /** PINNED by the preflight: the one connection the approval card names. */
  connectionId?: string
}

type Resolved =
  | { ok: true; target: DisconnectTarget }
  | { ok: false; error: { code: string; message: string } }

/** How a connection reads on the approval card and in a refusal: whose, which, its id. */
export function describeDisconnectTarget(t: DisconnectTarget): string {
  const whose =
    t.ownerType === "org"
      ? "the organization's connection"
      : `personal connection of ${t.ownerEmail ?? "a member"}`
  return `${t.appName}/${t.connectionName} ${t.identifier} (${whose}, id ${t.id})`
}

function decide(
  ctx: ToolCtx,
  target: DisconnectTarget,
  scopes: string[],
  userId: string,
): Resolved {
  const decision = decideDisconnect(ctx.orgId, target, { kind: "user", userId, scopes })
  if (!decision.allowed) {
    const message =
      decision.code === "FORCE_REQUIRED"
        ? `${target.identifier} is ${target.ownerEmail ?? "another member"}'s personal connection: only they can disconnect it (or the server's operator with liaison disconnect --force).`
        : decision.message
    return {
      ok: false,
      error: { code: decision.code === "FORCE_REQUIRED" ? "NOT_OWNER" : decision.code, message },
    }
  }
  return { ok: true, target }
}

/**
 * Stage time: the ONE connection `account` names. Several connections with that
 * address (an organization one and a personal one) are never chosen between: the
 * caller is asked to pass the id of the one it means.
 */
async function resolveTarget(
  params: ConnectionDisconnectParams,
  ctx: ToolCtx,
  scopes: string[],
  userId: string,
): Promise<Resolved> {
  const targets = await findDisconnectTargets(
    ctx.orgId,
    params.app,
    params.connection,
    params.account,
  )
  if (targets.length === 0) {
    return {
      ok: false,
      error: {
        code: "CONNECTION_NOT_FOUND",
        message: `No active ${params.app}/${params.connection} connection for '${params.account}'.`,
      },
    }
  }
  if (targets.length > 1) {
    return {
      ok: false,
      error: {
        code: "AMBIGUOUS_CONNECTION",
        message: `'${params.account}' matches ${targets.length} connections: ${targets.map(describeDisconnectTarget).join("; ")}. Ask which one is meant, then call again with its id as account.`,
      },
    }
  }
  return decide(ctx, targets[0] as DisconnectTarget, scopes, userId)
}

/** Stage time: refuse what would be refused anyway, and PIN the connection's id. */
export async function connectionDisconnectPreflight(
  params: ConnectionDisconnectParams,
  ctx: ToolCtx,
): Promise<unknown> {
  const actor = await resolveActor({ orgId: ctx.orgId, userId: ctx.userId })
  const r = await resolveTarget(params, ctx, actor.scopes, actor.userId)
  return r.ok ? { ok: true, pinnedParams: { connectionId: r.target.id } } : { error: r.error }
}

/** The pinned connection, by its id only: an approved call never resolves the address again. */
async function pinnedTarget(params: ConnectionDisconnectParams, ctx: ToolCtx) {
  if (!params.connectionId) return null
  const byId = await findDisconnectTargets(
    ctx.orgId,
    params.app,
    params.connection,
    params.connectionId,
  )
  return byId.find((t) => t.id === params.connectionId) ?? null
}

export async function handleConnectionDisconnect(params: ConnectionDisconnectParams, ctx: ToolCtx) {
  // Org connections: the deciding person's scopes (the approver's, once approved).
  // Personal connections: the person whose agent asked must own it.
  const actor = await resolveActor(ctx)
  const requester = ctx.userId
  if (!params.connectionId) {
    return {
      error: {
        code: "CONNECTION_NOT_PINNED",
        message: "This disconnect was not staged through its approval: call it again.",
      },
    }
  }
  const target = await pinnedTarget(params, ctx)
  if (!target) {
    return {
      error: {
        code: "CONNECTION_NOT_FOUND",
        message: `The ${params.app}/${params.connection} connection ${params.connectionId} the approval named is no longer active: nothing was disconnected.`,
      },
    }
  }
  const r = decide(ctx, target, actor.scopes, requester)
  if (!r.ok) return { error: r.error }
  if (r.target.ownerType === "org") {
    const again = decideDisconnect(ctx.orgId, r.target, {
      kind: "user",
      userId: actor.userId,
      scopes: actor.scopes,
    })
    if (!again.allowed) return { error: { code: again.code, message: again.message } }
  }
  await performDisconnect({
    orgId: ctx.orgId,
    target: r.target,
    actor: { kind: "user", userId: actor.userId, scopes: actor.scopes },
    forced: false,
  })
  return {
    disconnected: true,
    account: r.target.identifier,
    connectionId: r.target.id,
    ownerType: r.target.ownerType === "org" ? "organization" : "personal",
    deleted: disconnectImpact(r.target.appName),
  }
}

/** The approval card: exactly the connection the approval removes (the pinned id). */
export async function summarizeConnectionDisconnect(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
) {
  const p = params as Partial<ConnectionDisconnectParams>
  const t =
    p.app && p.connection && p.connectionId
      ? await pinnedTarget(p as ConnectionDisconnectParams, {
          orgId: ctx.orgId,
          userId: ctx.userId,
        })
      : null
  if (!t) {
    return {
      kind: "connection_disconnect",
      title: `Disconnect ${p.app}/${p.connection} ${p.account ?? ""}`.trim(),
      lines: [
        "The connection this approval named is no longer active: approving it disconnects nothing.",
      ],
    }
  }
  return {
    kind: "connection_disconnect",
    title: `Disconnect ${t.appName}/${t.connectionName} ${t.identifier}`,
    lines: [
      `Disconnects ${describeDisconnectTarget(t)}: Liaison stops using it and its grant is revoked at the provider.`,
      disconnectImpact(t.appName),
      "Connecting it again later downloads it again from the provider.",
    ],
  }
}

export function registerConnectionTools(orgId: string): void {
  toolRegistry.set([orgId, "kernel", "connect_link_send"], {
    appName: "kernel",
    name: "connect_link_send",
    deferLoading: true,
    searchKeywords: ["connect", "link", "personal", "gmail", "calendar", "drive", "member", "send"],
    description:
      "Send a member the one-time link that connects THEIR OWN account (their Gmail, Google Calendar, Drive...) as a personal connection: it is emailed to them and returned to you. GATED: it raises an approval before anything is emailed. It works once, for 30 minutes, only when that member is signed in as themselves; it never signs anyone in. Sending it to someone else takes the connection's admin scope. Use it when an admin asks to connect a person's own mailbox or calendar: a person's own inbox is always personal, only shared role addresses (support@, hello@) are the organization's. For the person you are talking to, use kernel__request_secret kind oauth_connect mode personal instead (their own Connect card). Never give a Settings click-path for this.",
    requiredScopes: ["kernel:threads:read"],
    approveScope: "kernel:approve",
    trustBoundary: "user",
    params: z.object({
      app: z.string().min(1).max(64).describe("The app, e.g. mail, calendar, google-drive."),
      connection: z.string().min(1).max(64).describe("The connection, e.g. gmail, google."),
      email: z.string().email().max(320).describe("The member's sign-in address."),
    }),
    // An email in Liaison's name to a member, asked of an agent (a routine, or a
    // turn that read outside text): a person approves it first.
    gated: true,
    approvalImpact: "internal",
    handler: (params, ctx: ToolCtx) => handleConnectLinkSend(params as ConnectLinkSendParams, ctx),
    preflight: (params, ctx: ToolCtx) =>
      connectLinkSendPreflight(params as ConnectLinkSendParams, ctx),
  })
  registerApprovalSummarizer(orgId, "kernel", "connect_link_send", summarizeConnectLinkSend)

  toolRegistry.set([orgId, "kernel", "connection_disconnect"], {
    appName: "kernel",
    name: "connection_disconnect",
    deferLoading: true,
    searchKeywords: [
      "disconnect",
      "remove",
      "connection",
      "account",
      "mailbox",
      "gmail",
      "calendar",
    ],
    description:
      "Disconnect one connected account by its address (e.g. mail gmail ana@example.com): Liaison stops using it, revokes the grant, and DELETES what it imported from it (the provider keeps the original). The organization's connections take the connection's admin scope; a personal connection only its owner. Someone else's personal connection is refused: its owner disconnects it. When one address matches both an organization and a personal connection it refuses and lists both with their ids: ask which is meant and pass its id as account. GATED: it raises an approval naming that one connection; say what gets deleted and do not report it done until approved. To move an account between personal and organization, disconnect it, then connect it again the right way (kernel__connect_link_send for a member's own account).",
    requiredScopes: ["kernel:threads:read"],
    approveScope: "kernel:approve",
    trustBoundary: "user",
    gated: true,
    approvalImpact: "internal",
    params: z.object({
      app: z.string().min(1).max(64),
      connection: z.string().min(1).max(64),
      account: z
        .string()
        .min(1)
        .max(320)
        .describe(
          "The account's address or identifier, or the connection id (when one address matches several connections, the id of the one meant).",
        ),
      connectionId: z.string().uuid().optional().describe("Set by Liaison; never pass it."),
    }),
    pinnedParams: ["connectionId"],
    handler: (params, ctx: ToolCtx) =>
      handleConnectionDisconnect(params as ConnectionDisconnectParams, ctx),
    preflight: (params, ctx: ToolCtx) =>
      connectionDisconnectPreflight(params as ConnectionDisconnectParams, ctx),
  })
  registerApprovalSummarizer(
    orgId,
    "kernel",
    "connection_disconnect",
    summarizeConnectionDisconnect,
  )
}
