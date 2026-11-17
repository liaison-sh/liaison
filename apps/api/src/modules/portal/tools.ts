// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The five kernel tools on the client portal. An agent's invite, share, end of
// access and erasure always park a card a person decides, and no auto-approve
// policy answers them: none can be undone from outside text. Removing one person
// without erasure runs on a person's clean turn and parks otherwise. The access
// log reads under the caller's RLS (kernel:portal:logs) and marks the turn: user
// agents are typed by the visitor.

import type { ApprovalSummary } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { z } from "zod"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { toolRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import {
  endPortalAccess,
  invitePortalPerson,
  keptForPerson,
  PORTAL_SHARE_KINDS,
  PortalAccessError,
  readPortalAccessLog,
  removePortalPerson,
  setPortalShare,
} from "./access"

interface ToolCtx {
  userId: string
  orgId: string
  db: RlsClient
  scopes?: readonly string[]
}

function refusal(err: unknown) {
  if (err instanceof PortalAccessError) {
    return { error: { code: err.code, message: err.message, status: err.status } }
  }
  throw err
}

export const portalInviteParams = z
  .object({
    company_id: z.string().uuid(),
    contact_id: z.string().uuid().optional(),
    email: z.string().email().optional(),
    name: z.string().min(1).max(200).optional(),
    title: z.string().max(200).optional(),
  })
  .refine((p) => Boolean(p.contact_id) || Boolean(p.email && p.name), {
    message: "Give contact_id, or email and name.",
  })

export async function handlePortalInvite(p: z.infer<typeof portalInviteParams>, ctx: ToolCtx) {
  try {
    const r = await invitePortalPerson({
      orgId: ctx.orgId,
      actorId: ctx.userId,
      db: ctx.db,
      companyId: p.company_id,
      contactId: p.contact_id,
      email: p.email,
      name: p.name,
      title: p.title,
    })
    return {
      user_id: r.userId,
      status: "invited",
      result: `${r.name} <${r.email}> can now sign in to ${r.company}'s portal${r.mailed ? "; the invitation mail is on its way" : "; the invitation mail failed, they can still sign in from the portal page"}. Nothing is shared yet: the portal shows only what a person opens.`,
      next: "Open what they should see with portal_share_set.",
    }
  } catch (err) {
    return refusal(err)
  }
}

export const portalShareSetParams = z.object({
  company_id: z.string().uuid(),
  kind: z.enum(PORTAL_SHARE_KINDS),
  object_id: z.string().uuid().optional(),
  open: z.boolean(),
  only_user_ids: z.array(z.string().uuid()).max(50).optional(),
})

export async function handlePortalShareSet(p: z.infer<typeof portalShareSetParams>, ctx: ToolCtx) {
  try {
    const r = await setPortalShare({
      orgId: ctx.orgId,
      actorId: ctx.userId,
      db: ctx.db,
      scopes: ctx.scopes ?? [],
      companyId: p.company_id,
      kind: p.kind,
      objectId: p.object_id ?? null,
      open: p.open,
      onlyUserIds: p.only_user_ids ?? null,
    })
    const what = `${r.kind}${r.objectId ? ` ${r.objectId}` : ""}`
    return {
      share: { id: r.id, kind: r.kind, object_id: r.objectId, open: r.open },
      result: r.changed
        ? `${what} is now ${r.open ? "shown on" : "hidden from"} ${r.company}'s portal.`
        : `${what} was already ${r.open ? "shown on" : "hidden from"} ${r.company}'s portal: nothing changed.`,
    }
  } catch (err) {
    return refusal(err)
  }
}

export const portalEndAccessParams = z.object({
  company_id: z.string().uuid(),
  reason: z.string().max(500).optional(),
})

export async function handlePortalEndAccess(
  p: z.infer<typeof portalEndAccessParams>,
  ctx: ToolCtx,
) {
  try {
    const r = await endPortalAccess({
      orgId: ctx.orgId,
      actorId: ctx.userId,
      db: ctx.db,
      companyId: p.company_id,
      reason: p.reason ?? null,
    })
    return {
      signed_out: r.signedOut,
      cancelled_links: r.cancelledLinks,
      closed_shares: r.closedShares,
      kept: { invoices: "unchanged", agreements: "unchanged" },
      result: `${r.company}'s portal access is ended: ${r.signedOut} people signed out, ${r.cancelledLinks} open links withdrawn, ${r.closedShares} shares closed. Invoices and signed agreements are kept as they are.`,
      next: "Giving access again later reopens no share and no link.",
    }
  } catch (err) {
    return refusal(err)
  }
}

export const portalRemovePersonParams = z.object({
  user_id: z.string().uuid(),
  erase: z.boolean(),
})

export async function handlePortalRemovePerson(
  p: z.infer<typeof portalRemovePersonParams>,
  ctx: ToolCtx,
) {
  try {
    const r = await removePortalPerson({
      orgId: ctx.orgId,
      actorId: ctx.userId,
      db: ctx.db,
      userId: p.user_id,
    })
    if (p.erase) {
      const kept = await keptForPerson(ctx.orgId, p.user_id)
      const { eraseUser } = await import("~/modules/erasure/erase-user")
      const erased = await eraseUser(p.user_id)
      if (erased.exitCode !== 0) {
        return {
          error: {
            code: "ERASE_FAILED",
            message: `${r.person.name} is removed from the portal, but their account was not erased: ${erased.message ?? "the erasure stopped"}. Next: run the erasure again.`,
            status: 500,
          },
        }
      }
      return {
        removed: [p.user_id],
        kept,
        result: `${r.person.name} is removed from the portal and their account is erased. Kept, as the law asks: ${kept.length === 0 ? "nothing they signed or accepted" : kept.map((k) => `${k.decision} ${k.target_type} ${k.target_id}`).join(", ")}; invoices of their company are untouched.`,
      }
    }
    return {
      removed: [p.user_id],
      kept: [],
      result: `${r.person.name} is removed from the portal: signed out, ${r.cancelledLinks} open links withdrawn. Their account and what they did stay; erase it with erase: true.`,
    }
  } catch (err) {
    return refusal(err)
  }
}

export const portalAccessLogParams = z.object({
  company_id: z.string().uuid(),
  before: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).default(50),
})

export async function handlePortalAccessLog(
  p: z.infer<typeof portalAccessLogParams>,
  ctx: ToolCtx,
) {
  const rows = await readPortalAccessLog({
    db: ctx.db,
    companyId: p.company_id,
    before: p.before ?? null,
    limit: p.limit,
  })
  return {
    items: rows,
    result:
      rows.length === 0
        ? "No portal access recorded for this company."
        : `${rows.length} portal access rows, newest first. Device details are the visitor's own words.`,
  }
}

const SHARE_WORDS: Record<string, { one: string; named: string }> = {
  project_progress: { one: "a project's progress", named: "the progress of project" },
  project_reports: { one: "a project's reports", named: "the reports of project" },
  project_hours: { one: "a project's hours", named: "the hours of project" },
  invoices: { one: "the invoices", named: "the invoices" },
  requests: { one: "the requests", named: "the requests" },
  agreement: { one: "an agreement", named: "agreement" },
  change_request: { one: "a change request", named: "change request" },
  file: { one: "a file", named: "file" },
  ticket: { one: "a ticket", named: "ticket" },
}

/** A share card's title in words: what, named when it could be read, on which company's portal. */
export function shareCardTitle(input: {
  open: boolean
  kind: string
  companyName: string | null
  objectName: string | null
}): string {
  const words = SHARE_WORDS[input.kind] ?? { one: "a shared item", named: "item" }
  const what =
    input.objectName && words.named !== words.one
      ? `${words.named} "${input.objectName}"`
      : words.one
  const where = input.companyName ? `${input.companyName}'s portal` : "this company's portal"
  return `${input.open ? "Show" : "Hide"} ${what} on ${where}`
}

/** The company's and the shared thing's names, as the caller reads them; null when not. */
async function shareNames(
  tx: RlsClient,
  p: { company_id?: string; kind?: string; object_id?: string },
): Promise<{ companyName: string | null; objectName: string | null }> {
  const one = async (query: ReturnType<typeof sql>): Promise<string | null> => {
    try {
      const [row] = extractRows<{ name: string | null }>(await tx.execute(query))
      return row?.name?.trim() || null
    } catch {
      return null
    }
  }
  const companyName = p.company_id
    ? await one(
        sql`SELECT name FROM ${sql.raw(schemaRef("kernel"))}.companies WHERE id = ${p.company_id}`,
      )
    : null
  const objectName =
    p.object_id && p.kind?.startsWith("project_")
      ? await one(
          sql`SELECT name FROM ${sql.raw(schemaRef("app_projects"))}.projects WHERE id = ${p.object_id}`,
        )
      : null
  return { companyName, objectName }
}

async function summarize(kind: string, title: string, lines: string[]): Promise<ApprovalSummary> {
  return { kind, title, lines }
}

/** Registers the five tools for one org (called from the kernel tool registration). */
export function registerPortalTools(orgId: string): void {
  toolRegistry.set([orgId, "kernel", "portal_invite"], {
    appName: "kernel",
    name: "portal_invite",
    deferLoading: true,
    description:
      "Give a client's contact access to their company's portal: makes their portal account and mails them how to sign in. Opens nothing; a person approves it first.",
    searchKeywords: ["portail", "portal", "espace client", "client", "inviter", "invite", "accès"],
    requiredScopes: ["kernel:portal:admin"],
    approveScope: "kernel:portal:admin",
    gated: true,
    noAutoApprove: true,
    externalEffect: true,
    approvalImpact: "external",
    writesToTable: "kernel.portal_people",
    params: portalInviteParams,
    handler: handlePortalInvite as (p: unknown, c: any) => Promise<unknown>,
  })
  registerApprovalSummarizer(orgId, "kernel", "portal_invite", (params) => {
    const p = params as Partial<z.infer<typeof portalInviteParams>>
    return summarize(
      "portal_invite",
      `Invite ${p.name ?? p.email ?? p.contact_id ?? "a contact"} to the client portal`,
      [
        `Company ${p.company_id ?? "?"}. They get a mail and can sign in; nothing is shared until a person opens it.`,
      ],
    )
  })

  toolRegistry.set([orgId, "kernel", "portal_share_set"], {
    appName: "kernel",
    name: "portal_share_set",
    deferLoading: true,
    description:
      "Show or hide one thing on a client company's portal: a project's progress, reports or hours, invoices, requests, an agreement, a file or one ticket. A person approves it first.",
    searchKeywords: [
      "partager",
      "share",
      "portail",
      "portal",
      "espace client",
      "montrer",
      "masquer",
    ],
    requiredScopes: ["kernel:portal:share"],
    approveScope: "kernel:portal:share",
    gated: true,
    noAutoApprove: true,
    externalEffect: true,
    approvalImpact: "external",
    writesToTable: "kernel.portal_shares",
    params: portalShareSetParams,
    handler: handlePortalShareSet as (p: unknown, c: any) => Promise<unknown>,
  })
  registerApprovalSummarizer(orgId, "kernel", "portal_share_set", async (params, sctx) => {
    const p = params as Partial<z.infer<typeof portalShareSetParams>>
    const names = await shareNames(sctx.tx, p)
    return summarize(
      "portal_share_set",
      shareCardTitle({ open: p.open === true, kind: p.kind ?? "", ...names }),
      [
        p.open
          ? "Everyone invited from that company sees it, except what names people."
          : "It disappears from their portal at the next read.",
      ],
    )
  })

  toolRegistry.set([orgId, "kernel", "portal_end_access"], {
    appName: "kernel",
    name: "portal_end_access",
    deferLoading: true,
    description:
      "End a client company's portal access at once: its people are signed out, open links withdrawn, shares closed. Invoices and agreements are kept. A person approves it first.",
    searchKeywords: ["fermer", "close", "portail", "portal", "accès", "access", "ex-client"],
    requiredScopes: ["kernel:portal:admin"],
    approveScope: "kernel:portal:admin",
    gated: true,
    noAutoApprove: true,
    externalEffect: true,
    approvalImpact: "external",
    writesToTable: "kernel.portal_people",
    params: portalEndAccessParams,
    handler: handlePortalEndAccess as (p: unknown, c: any) => Promise<unknown>,
  })
  registerApprovalSummarizer(orgId, "kernel", "portal_end_access", (params) => {
    const p = params as Partial<z.infer<typeof portalEndAccessParams>>
    return summarize("portal_end_access", `End company ${p.company_id ?? "?"}'s portal access`, [
      "Everyone of that company is signed out, open links stop working and every share closes. Giving access again reopens none of them.",
      ...(p.reason ? [`Reason: ${p.reason}`] : []),
    ])
  })

  toolRegistry.set([orgId, "kernel", "portal_remove_person"], {
    appName: "kernel",
    name: "portal_remove_person",
    deferLoading: true,
    description:
      "Remove one person from their company's portal, and with erase: true erase their account (invoices and signed agreements are kept). Erasing always needs a person's approval.",
    searchKeywords: ["retirer", "remove", "effacer", "erase", "portail", "portal", "rgpd"],
    requiredScopes: ["kernel:portal:admin"],
    approveScope: "kernel:portal:admin",
    conditionalGate: true,
    gatedWhen: async (params) => (params as { erase?: boolean }).erase === true,
    noAutoApprove: true,
    externalEffect: true,
    requiresHumanTurn: true,
    approvalImpact: "external",
    writesToTable: "kernel.portal_people",
    params: portalRemovePersonParams,
    handler: handlePortalRemovePerson as (p: unknown, c: any) => Promise<unknown>,
  })
  registerApprovalSummarizer(orgId, "kernel", "portal_remove_person", (params) => {
    const p = params as Partial<z.infer<typeof portalRemovePersonParams>>
    return summarize(
      "portal_remove_person",
      `${p.erase ? "Remove and erase" : "Remove"} portal person ${p.user_id ?? "?"}`,
      [
        p.erase
          ? "Their account is erased; invoices and signed agreements naming them are kept. This cannot be undone."
          : "They are signed out and their open links stop working.",
      ],
    )
  })

  toolRegistry.set([orgId, "kernel", "portal_access_log"], {
    appName: "kernel",
    name: "portal_access_log",
    deferLoading: true,
    readOnly: true,
    taintSource: true,
    description:
      "Read a client company's portal access log: sign-ins, views, downloads, approvals and failures, newest first. Device details are the visitor's own words.",
    searchKeywords: ["journal", "log", "accès", "access", "portail", "portal", "connexions"],
    requiredScopes: ["kernel:portal:logs"],
    params: portalAccessLogParams,
    handler: handlePortalAccessLog as (p: unknown, c: any) => Promise<unknown>,
  })
}
