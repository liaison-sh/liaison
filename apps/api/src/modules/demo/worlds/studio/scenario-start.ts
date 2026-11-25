// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What starting a services-world scenario writes into the visitor's
// workspace, once and idempotently. Each piece goes through the same
// factories and services the seed uses, as the people the pack names, and none
// of it approves or sends anything:
// - support: the routine that drafts a reply to each new ticket, on;
// - projects: the retainer client's reports and hours opened on its client
//   access by the project lead, and this week's report drafted, as the Friday
//   routine would;
// - sales: the routine that prepares a proposal for a new brief, off (the
//   scenario's beat switches it on);
// - knowledge: a past project's costs, restricted to finance and admins.
// The client scenario brings nothing in: its one card is seeded with the
// workspace. Chat and developers bring nothing either.
import type { DemoNeed } from "@liaison/shared"
import { STUDIO_KNOWLEDGE_DOC_TITLE, STUDIO_REPORT_PROJECT_NAME } from "@liaison/shared"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import {
  clientReportSaveDraft,
  type ReportSection,
  reportHours,
} from "~/apps/projects/service/client-reports"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { schemaRef } from "~/db/schema-ref"
import { setPortalShare } from "~/modules/portal/access"
import { seedContext } from "~/seed/context"
import { agentDmWith, personalAgentOf } from "~/seed/factories/agent/presence"
import { enableEventRoutine, scopeReader, seedRoutine } from "~/seed/factories/agent/routines"
import { seedKnowledgeArticles } from "~/seed/factories/knowledge/articles"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import { STUDIO_PAST_SIGN_ON_HOURS } from "~/seed/worlds/studio/knowledge"
import { SAAS_SUPPORT_ROUTINE_NAME, SUPPORT_ROUTINE_PROMPT } from "../saas/scenario-routines"
import {
  STUDIO_PROSPECT_SCENARIO_ROUTINE_NAME,
  studioProposalRoutinePrompt,
} from "./scenario-routines"

/** The support routine's owner (the studio's support person) and the desk it runs as. */
const SUPPORT_OWNER = "Noémie Garnier"
const SUPPORT_DESK = "Support Desk"
/** The retainer client's lead and the person its weekly report goes to. */
const REPORT_LEAD = "Bastien Morel"
export const STUDIO_REPORT_CLIENT_EMAIL = "thomas.blanc@editions-sorel.example"
/** The person in finance who keeps the past projects' costs. */
const COSTS_OWNER = "Anaïs Colin"

/** A teammate of the org's own world, by name: members only, never a client's account. */
async function userIdByName(orgId: string, name: string): Promise<string> {
  const [row] = await withPrivilegedDb(orgId, "demo-studio-start:user", (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.userType, "member"), eq(users.name, name)))
      .limit(1),
  )
  if (!row) throw new Error(`demo world: no teammate named ${name} in this org`)
  return row.id
}

async function agentIdByName(orgId: string, displayName: string): Promise<string> {
  const [row] = await withPrivilegedDb(orgId, "demo-studio-start:agent", (tx) =>
    tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.displayName, displayName)))
      .limit(1),
  )
  if (!row) throw new Error(`demo world: no ${displayName} agent in this org`)
  return row.id
}

/** The support routine: it drafts a reply to every new ticket, switched on at start. */
async function startSupport(orgId: string, ownerUserId: string): Promise<void> {
  const ctx = seedContext({ orgId, now: new Date() })
  const lead = await userIdByName(orgId, SUPPORT_OWNER)
  const routineId = await seedRoutine(ctx, {
    createdByUserId: ownerUserId,
    ownerScopes: await scopeReader(ctx)(lead),
    routine: {
      name: SAAS_SUPPORT_ROUTINE_NAME,
      description:
        "The moment a ticket is opened: read it and the client's history, leave a note for the team and draft the reply for a person to approve.",
      kind: "event",
      event: "tickets:ticket:create",
      eventFilter: null,
      reportThreadId: null,
      ownerUserId: lead,
      ownerAgentId: await agentIdByName(orgId, SUPPORT_DESK),
      scopes: [
        "tickets:tickets:read",
        "tickets:tickets:write",
        "tickets:tickets:reply",
        "tickets:inboxes:read",
        "knowledge:documents:read",
        "kernel:contacts:read",
      ],
      prompt: SUPPORT_ROUTINE_PROMPT,
    },
  })
  await enableEventRoutine(orgId, routineId)
}

/** The last day of the week reported: the most recent Friday, today included, as a civil date. */
export function reportWeekEnd(now: Date): string {
  const civil = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
  const [y, m, d] = civil.split("-").map(Number) as [number, number, number]
  const day = new Date(Date.UTC(y, m - 1, d))
  const back = (day.getUTCDay() + 2) % 7 // Friday is 5: days since the last one.
  day.setUTCDate(day.getUTCDate() - back)
  return day.toISOString().slice(0, 10)
}

/** "Hours used: 61 h of 80 h this month", from the same totals the client's portal shows. */
function hoursText(h: NonNullable<Awaited<ReturnType<typeof reportHours>>>): string {
  const hours = (m: number) => `${Math.round((m / 60) * 10) / 10} h`
  const used = hours(h.usedMinutes)
  const of = h.ofMinutes === null ? "" : ` of the ${hours(h.ofMinutes)} included`
  const period = h.period ? ` for ${h.period}` : ""
  return `Hours used${period}: ${used}${of}.`
}

/**
 * The retainer client's weekly report, as the Friday routine drafts it: its
 * reports and hours opened on the client's access by the project lead, then a
 * draft for this week to the client's contact. A report already sent this week
 * is left as it is.
 */
async function startProjects(orgId: string): Promise<void> {
  const ctx = seedContext({ orgId, now: new Date() })
  const lead = await actorFor(ctx, await userIdByName(orgId, REPORT_LEAD))
  const target = extractRows<{ project_id: string; company_id: string; contact_id: string }>(
    await withPrivilegedDb(orgId, "demo-studio-start:report", (tx) =>
      tx.execute(
        drizzleSql`SELECT p.id::text AS project_id, p.company_id::text AS company_id,
                          c.id::text AS contact_id
                     FROM app_projects.projects p
                     JOIN ${drizzleSql.raw(schemaRef("kernel"))}.contacts c ON c.org_id = p.org_id
                                           AND lower(c.email) = ${STUDIO_REPORT_CLIENT_EMAIL}
                    WHERE p.org_id = ${orgId}::uuid AND p.name = ${STUDIO_REPORT_PROJECT_NAME}
                      AND p.company_id IS NOT NULL
                    LIMIT 1`,
      ),
    ),
  )[0]
  if (!target) throw new Error("demo world: the retainer project or its client is not seeded")
  const periodEnd = reportWeekEnd(ctx.now)
  await asUser(lead, async (tx) => {
    for (const kind of ["project_progress", "project_reports", "project_hours"] as const) {
      await setPortalShare({
        orgId,
        actorId: lead.userId,
        db: tx,
        scopes: lead.scopes,
        companyId: target.company_id,
        kind,
        objectId: target.project_id,
        open: true,
        onlyUserIds: null,
      })
    }
  })
  await asUser(lead, async (tx) => {
    const b = { tx: tx as never, orgId }
    const sent = extractRows<{ id: string }>(
      await tx.execute(
        drizzleSql`SELECT id::text AS id FROM app_projects.client_reports
          WHERE org_id = ${orgId}::uuid AND project_id = ${target.project_id}::uuid
            AND period_end = ${periodEnd}::date AND status = 'sent' LIMIT 1`,
      ),
    )[0]
    if (sent) return
    const hours = await reportHours(b, target.project_id)
    const sections: ReportSection[] = [
      {
        kind: "project_progress",
        heading: "This week",
        text:
          "The catalogue import now takes the new series format, and the reader site's " +
          "search shows the newest titles first. The monthly review is set for next week.",
      },
      {
        kind: "project_progress",
        heading: "Next",
        text: "Next week we finish the catalogue import's checks and answer the open questions.",
      },
      ...(hours
        ? [{ kind: "project_hours" as const, heading: "Hours", text: hoursText(hours) }]
        : []),
    ]
    await clientReportSaveDraft({
      ...b,
      userId: lead.userId,
      human: false,
      input: {
        projectId: target.project_id,
        periodEnd,
        sections,
        leftOut: [
          {
            what: "The time spent on the reader site's sign-in question",
            why: "It is support work the client's retainer covers; it is in the hours.",
          },
        ],
        recipientContactId: target.contact_id,
      },
    })
  })
}

/** The sales routine, off: the scenario's own beat switches it on. */
async function startSales(orgId: string, ownerUserId: string): Promise<void> {
  const ctx = seedContext({ orgId, now: new Date() })
  const agentId = await personalAgentOf(ctx, ownerUserId)
  if (!agentId) throw new Error("demo world: the owner has no personal agent")
  await seedRoutine(ctx, {
    createdByUserId: ownerUserId,
    ownerScopes: await scopeReader(ctx)(ownerUserId),
    routine: {
      name: STUDIO_PROSPECT_SCENARIO_ROUTINE_NAME,
      description:
        "When a prospect sends a brief: check Liaison, read up on a new firm, then prepare its company, a deal, a proposal with no price and the reply, as one request I approve once.",
      kind: "event",
      event: "mail:message:create",
      eventFilter: null,
      reportThreadId: await agentDmWith(ctx, ownerUserId, agentId),
      ownerUserId,
      ownerAgentId: agentId,
      scopes: [
        "mail:conversations:read",
        "mail:conversations:write",
        "mail:accounts:read",
        "kernel:contacts:read",
        "kernel:contacts:write",
        "kernel:companies:read",
        "kernel:companies:write",
        "agreements:agreements:read",
        "agreements:agreements:write",
        "projects:tasks:write",
        "projects:projects:read",
        "kernel:threads:write",
        "kernel:agent:web",
      ],
      prompt: studioProposalRoutinePrompt(),
    },
  })
}

/** A past project's costs: finance's record, restricted, beside its notes that everyone reads. */
async function startKnowledge(orgId: string, ownerUserId: string): Promise<void> {
  const ctx = seedContext({ orgId, now: new Date() })
  const admin = await actorFor(ctx, ownerUserId)
  const finance = await userIdByName(orgId, COSTS_OWNER)
  await seedKnowledgeArticles(ctx, admin, {
    people: { anais: { userId: finance } },
    collections: [
      {
        key: "finance-records",
        name: "Finance records",
        description: "What each project cost and what it was sold for. Finance and admins only.",
        owner: "anais",
      },
    ],
    articles: [
      {
        key: "osier-costs",
        title: STUDIO_KNOWLEDGE_DOC_TITLE,
        collection: "finance-records",
        owner: "anais",
        summary: "What the OSIER tenant portal cost the studio, against its fixed price.",
        tags: ["past project", "costs"],
        body:
          "# Past project costs: OSIER\n\nThe tenant portal for Osier Habitat was sold at a " +
          "fixed price. Partner sign-on alone took " +
          `${STUDIO_PAST_SIGN_ON_HOURS.osier} h of real time, more than its share of that price: ` +
          "the next sign-on is quoted from the hours it really takes, not from this price.",
        reviewDueInDays: 180,
        verified: true,
        sensitivity: "restricted",
        orgAccess: "none",
      },
    ],
  })
}

/** Write what the scenario of `need` brings in. Returns the approval ids written: none. */
export async function studioScenarioStart(
  orgId: string,
  need: DemoNeed,
  ownerUserId: string,
): Promise<string[]> {
  if (need === "support") await startSupport(orgId, ownerUserId)
  else if (need === "projects") await startProjects(orgId)
  else if (need === "sales") await startSales(orgId, ownerUserId)
  else if (need === "knowledge") await startKnowledge(orgId, ownerUserId)
  return []
}
