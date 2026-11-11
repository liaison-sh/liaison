// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `saas` world's own layer: it writes the plan (`plan.ts`) after the
// shared support layer, through the product's own services: the companies
// and their account managers, the pipeline's deals in number order with their
// dates, the subtasks under the Arlon expansion, who is away, and the three
// routines. Every write is idempotent: a re-run adopts what is there.
import { sql } from "drizzle-orm"
import { setLostReason, writeDealFields } from "~/apps/projects/service/deals"
import { createTask } from "~/apps/projects/service/tasks"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { routineTemplateRegistry } from "~/modules/apps/app-registries"
import { awaitOrgApps } from "~/modules/apps/init"
import { setCompanyManager } from "~/modules/contacts/companies"
import { buildSendGuard } from "~/modules/mail/send-guard"
import { addSuppression } from "~/modules/mail/suppressions"
import { setAway } from "~/modules/users/away"
import { type SeedContext, seedContext } from "~/seed/context"
import { scopeReader, seedRoutine } from "~/seed/factories/agent/routines"
import { type ApprovalRequestSeed, seedApprovalRequests } from "~/seed/factories/approvals/requests"
import { type EventSpec, seedTeamCalendar } from "~/seed/factories/calendar/events"
import { insertUnarmedMail } from "~/seed/factories/mail/conversations"
import { actorFor, asUser, rowsOf } from "~/seed/factories/people/actors"
import { seedCompanies } from "~/seed/factories/people/companies"
import { resolveContacts } from "~/seed/factories/people/contacts"
import { seedPipeline } from "~/seed/factories/projects/deals"
import type { SeedDemoOrgResult } from "~/seed/tiers/demo/seed-org"
import { STORY_TIME_ZONE, storyClock } from "~/seed/worlds/story-clock"
import type { DemoWorldLayerInput } from "../index"
import { SAAS_ROUTINES } from "./agent-native"
import { SAAS_AWAY, SAAS_CUSTOMERS } from "./fiction"
import { SAAS_PIPELINE_KEY, type SaasPlanResult, saasPlan } from "./plan"
import { SAAS_FOLLOWUPS, SAAS_SUPPORT_SPECS, saasKoraConversation } from "./support-specs"
import { SAAS_CHANNEL_TITLES } from "./threads-specs"

type ExecTx = { execute: (q: unknown) => Promise<unknown> }

/** A deal or subtask's idempotency key. */
export const saasDealRef = (key: string) => `demo:saas:deal:${key}`

/** The workspace's owner, or the founder's seat for an org nobody signs into. */
function ownerIdOf(org: SeedDemoOrgResult): string {
  return org.ownerUserId ?? org.adminUserId
}

function userIdOf(org: SeedDemoOrgResult, key: string): string {
  if (key === "owner") return ownerIdOf(org)
  const id = org.peopleByKey[key]?.userId
  if (!id) throw new Error(`saas layer: no person '${key}'`)
  return id
}

/** A Paris calendar date, `YYYY-MM-DD`. */
function parisDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: STORY_TIME_ZONE }).format(at)
}

const KIND_TAGS: Record<string, string[]> = {
  paying: ["customer"],
  trial: ["trial"],
  "cancelled-this-month": ["cancelled"],
  "cancelled-last-month": ["cancelled"],
  transfer: ["customer", "bank-transfer"],
  prospect: ["prospect"],
  past: ["past-customer"],
}

async function seedSaasCompanies(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  actor: UserContext,
  plan: SaasPlanResult,
): Promise<{ companyIds: Record<string, string>; contactIds: Record<string, string> }> {
  const contacts = await resolveContacts(
    ctx,
    actor,
    SAAS_CUSTOMERS.map((c) => ({
      key: `customer:${c.key}`,
      email: c.email,
      name: c.name,
      externalId: { demo: `customer:${c.key}` },
      tags: ["customer"],
    })),
  )
  const contactIds = Object.fromEntries(contacts.map(([key, c]) => [key, c.id]))
  const companyIds = await seedCompanies(
    ctx,
    actor,
    plan.companies.map((c) => ({
      key: c.key,
      name: c.name,
      domain: c.domain,
      tags: KIND_TAGS[c.kind] ?? [],
      contactKeys: c.contactKeys,
    })),
    contactIds,
  )
  // Each person's lawful basis, as a person records it on the contact: a paying
  // company's people are customers, everyone else was met in the course of business.
  const clock = storyClock(ctx.now)
  const paying = new Set(["paying", "transfer"])
  const byBasis = new Map<string, string[]>()
  for (const c of plan.companies) {
    const basis = paying.has(c.kind) ? "customer" : "professional_interest"
    for (const key of c.contactKeys) {
      const id = contactIds[key]
      if (id) byBasis.set(basis, [...(byBasis.get(basis) ?? []), id])
    }
  }
  await withPrivilegedDb(ctx.orgId, "saas-seed-lawful-basis", async (tx) => {
    for (const [basis, ids] of byBasis) {
      await tx.execute(
        sql`UPDATE ${sql.raw(schemaRef("kernel"))}.contacts
            SET lawful_basis = ${basis}, lawful_basis_at = ${clock.d(-30).toISOString()}::timestamptz,
                lawful_basis_source = 'Recorded when the contact was added', is_consumer = false
            WHERE org_id = ${ctx.orgId}::uuid AND id = ANY(${`{${ids.join(",")}}`}::uuid[])
              AND lawful_basis IS NULL`,
      )
    }
  })
  // Account managers, one call per manager.
  const byManager = new Map<string, string[]>()
  for (const c of plan.companies) {
    const id = companyIds[c.key]
    if (!c.manager || !id) continue
    byManager.set(c.manager, [...(byManager.get(c.manager) ?? []), id])
  }
  for (const [manager, ids] of byManager) {
    const result = await asUser(actor, (tx) =>
      setCompanyManager(tx as never, {
        orgId: ctx.orgId,
        userId: actor.userId,
        companyIds: ids,
        ownerUserId: userIdOf(org, manager),
      }),
    )
    if (result.skipped.length > 0) {
      throw new Error(
        `saas layer: account manager ${manager} skipped ${result.skipped.map((s) => `${s.name} (${s.code})`).join(", ")}`,
      )
    }
  }
  return { companyIds, contactIds }
}

async function seedSaasDeals(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  actor: UserContext,
  plan: SaasPlanResult,
  companyIds: Record<string, string>,
  contactIds: Record<string, string>,
): Promise<Record<string, string>> {
  const { projectId } = await seedPipeline(ctx, actor, {
    people: org.peopleByKey,
    companyIds,
    contactIds,
    spec: { ...SAAS_SUPPORT_SPECS.pipeline, deals: [] },
    externalRefOf: saasDealRef,
  })
  const ids: Record<string, string> = {}
  const closed: Array<{ id: string; at: Date }> = []
  // In number order, so each one lands on its own `SALES-<n>`.
  const rows = [
    ...plan.deals.map((d) => ({ n: d.number, deal: d, sub: null })),
    ...plan.subtasks.map((s) => ({ n: s.number, deal: null, sub: s })),
  ].sort((a, b) => a.n - b.n)
  await asUser(actor, async (tx) => {
    for (const { deal, sub } of rows) {
      const key = (deal ?? sub)?.key as string
      const externalRef = saasDealRef(key)
      const existing = rowsOf<{ id: string }>(
        await (tx as ExecTx).execute(
          sql`SELECT id FROM app_projects.tasks
              WHERE org_id = ${ctx.orgId} AND external_ref = ${externalRef} LIMIT 1`,
        ),
      )[0]
      if (existing) {
        ids[key] = existing.id
        continue
      }
      if (sub) {
        const parent = plan.deals.find((d) => d.number === sub.parentNumber)
        const parentId = parent ? ids[parent.key] : undefined
        if (!parentId) throw new Error(`saas layer: no deal ${sub.parentNumber} for ${sub.key}`)
        const task = await createTask({
          tx: tx as never,
          orgId: ctx.orgId,
          actor,
          input: {
            projectId,
            parentTaskId: parentId,
            title: sub.title,
            assigneeId: userIdOf(org, sub.owner),
            dueDate: parisDate(sub.dueAt),
            externalRef,
          } as never,
        })
        ids[key] = task.id
        continue
      }
      const d = deal as NonNullable<typeof deal>
      const task = await createTask({
        tx: tx as never,
        orgId: ctx.orgId,
        actor,
        input: {
          projectId,
          title: d.title,
          statusLabel: d.stage,
          assigneeId: userIdOf(org, d.owner),
          externalRef,
          createdAt: d.createdAt.toISOString(),
        } as never,
      })
      const companyId = companyIds[d.companyKey]
      const contactId = d.contactKey ? contactIds[d.contactKey] : undefined
      await writeDealFields(tx as never, ctx.orgId, actor.scopes, task.id, {
        ...(companyId ? { companyId } : {}),
        ...(contactId ? { contactId } : {}),
        amountMinor: d.amountMinor,
        currency: "EUR",
        ...(d.nextStep ? { nextStep: d.nextStep } : {}),
      })
      if (d.lostReason) await setLostReason(tx as never, ctx.orgId, task.id, d.lostReason)
      if (d.closedAt) closed.push({ id: task.id, at: d.closedAt })
      ids[d.key] = task.id
    }
  })
  // A won or lost deal closed on its story date, not at the moment of the seed.
  if (closed.length > 0) {
    await withPrivilegedDb(ctx.orgId, "saas-seed-deal-close-dates", async (tx) => {
      for (const c of closed) {
        await tx.execute(
          sql`UPDATE ${sql.raw(schemaRef("app_projects"))}.deals SET closed_at = ${c.at.toISOString()}::timestamptz
              WHERE org_id = ${ctx.orgId}::uuid AND task_id = ${c.id}::uuid`,
        )
      }
    })
  }
  ctx.log(
    `deals: ${plan.deals.length} deals and ${plan.subtasks.length} subtasks in ${SAAS_PIPELINE_KEY}`,
  )
  return ids
}

/** Who is away from the anchor, and who is next in line. */
async function seedSaasAway(ctx: SeedContext, org: SeedDemoOrgResult): Promise<void> {
  const clock = storyClock(ctx.now)
  const admin = await actorFor(ctx, org.adminUserId)
  for (const away of SAAS_AWAY) {
    // Idempotent: a re-seed leaves a range already recorded as it is.
    const recorded = await withPrivilegedDb(ctx.orgId, "saas-seed-away-read", async (tx) =>
      rowsOf<{ id: string }>(
        await tx.execute(
          sql`SELECT id FROM ${sql.raw(schemaRef("kernel"))}.away_ranges
              WHERE org_id = ${ctx.orgId}::uuid AND user_id = ${userIdOf(org, away.key)}::uuid LIMIT 1`,
        ),
      ),
    )
    if (recorded.length > 0) continue
    await setAway({
      orgId: ctx.orgId,
      actorId: admin.userId,
      actorScopes: admin.scopes,
      userId: userIdOf(org, away.key),
      form: { from: parisDate(clock.d(0)), to: parisDate(clock.d(away.untilDay)) },
      ...(away.nextInLine === "owner" ? { nextInLineId: ownerIdOf(org) } : {}),
      now: ctx.now,
    })
  }
  ctx.log(`away: ${SAAS_AWAY.map((a) => a.key).join(", ")}`)
}

function customerEmail(key: string): string {
  const email = SAAS_CUSTOMERS.find((c) => c.key === key)?.email
  if (!email) throw new Error(`saas layer: no customer '${key}'`)
  return email
}

/** The meetings the named rows hold: Arlon's last one, and Sauvan's pricing call. */
async function seedSaasMeetings(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  actor: UserContext,
): Promise<void> {
  const clock = storyClock(ctx.now)
  const isoDow = ((d: Date) => {
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone: STORY_TIME_ZONE,
      weekday: "short",
    }).format(d)
    return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(name)
  })(ctx.now)
  const hourOf = (d: Date) =>
    Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: STORY_TIME_ZONE,
        hour: "numeric",
        hourCycle: "h23",
      }).format(d),
    )
  // Sauvan's call: two hours after the anchor inside working hours, else the next working day at 10:00.
  const inTwo = clock.h(2)
  const workingNow = isoDow < 5 && hourOf(inTwo) >= 9 && hourOf(inTwo) < 18
  const nextWorkingDay = isoDow >= 4 ? 7 - isoDow : 1
  const events: EventSpec[] = [
    {
      key: "arlon-review",
      title: "Maison Arlon, rollout review",
      day: isoDow - 4,
      startHour: 11,
      durationMinutes: 45,
      // Claire attends, so the meeting is on Maison Arlon's timeline.
      attendees: ["tom", "elodie", customerEmail("claire-vidal")],
    },
    workingNow
      ? {
          key: "sauvan-pricing",
          title: "Sauvan, group pricing",
          day: isoDow,
          startHour: hourOf(inTwo),
          durationMinutes: 30,
          attendees: ["tom"],
        }
      : {
          key: "sauvan-pricing",
          title: "Sauvan, group pricing",
          day: isoDow + nextWorkingDay,
          startHour: 10,
          durationMinutes: 30,
          attendees: ["tom"],
        },
  ]
  await seedTeamCalendar(ctx, actor, {
    accountEmail: `team@${org.world.company.supportEmail.split("@")[1]}`,
    calendarExternalId: "demo-team-calendar",
    calendarName: SAAS_SUPPORT_SPECS.calendarName,
    timezone: org.timezone,
    people: org.peopleByKey,
    events,
  })
}

/** Samir's thread, whose out-of-office names a date from the anchor. */
async function seedSaasMail(ctx: SeedContext, org: SeedDemoOrgResult): Promise<void> {
  const domain = org.world.company.supportEmail.split("@")[1] as string
  await insertUnarmedMail(ctx, {
    domain,
    // The shared mailbox the support layer wrote: adopted, never rewritten.
    mailboxes: [
      { box: "org", ownerUserId: null, email: `support@${domain}`, displayName: org.orgName },
    ],
    conversations: [saasKoraConversation(ctx.now)],
  })
}

/**
 * The morning's follow-ups, as the deal follow-ups routine stages them: each
 * one's send check is the product's own (`buildSendGuard`, pinned when it was
 * staged), so the card reads what the check says now. Hugo's opt-out is then
 * recorded the way a person records one, which withdraws the draft to him.
 */
async function seedSaasFollowups(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  dealIds: Record<string, string>,
  contactIds: Record<string, string>,
): Promise<void> {
  const clock = storyClock(ctx.now)
  const ownerId = ownerIdOf(org)
  const agentId = org.agentsByHandle["@sales"]?.agentId
  if (!agentId) throw new Error("saas layer: no @sales agent for the follow-ups")
  const [thread] = await withPrivilegedDb(ctx.orgId, "saas-seed-followup-thread", async (tx) =>
    rowsOf<{ id: string }>(
      await tx.execute(
        sql`SELECT id FROM ${sql.raw(schemaRef("kernel"))}.threads
            WHERE org_id = ${ctx.orgId}::uuid AND title = ${SAAS_CHANNEL_TITLES.pipeline} LIMIT 1`,
      ),
    ),
  )
  if (!thread) throw new Error("saas layer: no Pipeline channel for the follow-ups")
  const rows: ApprovalRequestSeed[] = []
  for (const f of SAAS_FOLLOWUPS) {
    const dealId = dealIds[f.dealKey]
    const contactId = contactIds[f.contactKey]
    const email = SAAS_CUSTOMERS.find((c) => `customer:${c.key}` === f.contactKey)?.email
    if (!dealId || !contactId || !email) {
      throw new Error(`saas layer: follow-up ${f.key} names no deal, contact or address`)
    }
    const stagedAt = clock.h(-f.hoursAgo)
    const refs = [{ kind: "projects:deal", id: dealId }]
    const built = await buildSendGuard({
      orgId: ctx.orgId,
      toolName: "mail:compose",
      followUpRun: true,
      followUp: { refs },
      recipients: [email],
      contactIds: [contactId],
      agentStaged: true,
      now: stagedAt,
      timeZone: org.timezone,
    })
    if (!("sendGuard" in built)) {
      throw new Error(`saas layer: follow-up ${f.key} not staged: ${JSON.stringify(built)}`)
    }
    rows.push({
      id: ctx.id("approval", f.key),
      handle: `demo-${f.key}`,
      threadId: thread.id,
      toolName: "mail:compose",
      payload: {
        accountId: ctx.id("mail-account", "org"),
        to: [email],
        subject: f.subject,
        textBody: f.body,
        followUp: { refs },
        sendGuard: built.sendGuard,
        ...(built.guardKey ? { guardKey: built.guardKey } : {}),
      },
      requestedBy: ownerId,
      agentId,
      notifyUserIds: [ownerId],
      status: "pending",
      createdAt: stagedAt,
    })
  }
  await seedApprovalRequests(ctx, rows)
  // The opt-out arrives after the draft: recording it withdraws the draft, as it does live.
  for (const f of SAAS_FOLLOWUPS.filter((x) => x.optOutAfter)) {
    const email = SAAS_CUSTOMERS.find((c) => `customer:${c.key}` === f.contactKey)?.email as string
    await addSuppression(null, {
      orgId: ctx.orgId,
      email,
      reason: "reply",
      source: "Asked by reply to stop receiving sales mail",
      createdBy: ownerId,
      actorType: "user",
    })
  }
  ctx.log(`follow-ups: ${rows.length} drafts staged with their send check`)
}

/** The three routines, on, each from its product template. */
async function seedSaasRoutines(ctx: SeedContext, org: SeedDemoOrgResult): Promise<string[]> {
  // The templates live in the org's app registries, filled on first touch.
  await awaitOrgApps(ctx.orgId)
  const scopesOf = scopeReader(ctx)
  const ids: string[] = []
  for (const spec of SAAS_ROUTINES) {
    const tpl = routineTemplateRegistry.get([
      ctx.orgId,
      spec.template.appName,
      spec.template.templateKey,
    ])
    // An app's routine exists only where that app is on for the org.
    if (spec.template.appName !== "kernel" && !org.appsByName[spec.template.appName]?.enabled) {
      ctx.log(`routines: '${spec.name}' left out, the ${spec.template.appName} app is not on`)
      continue
    }
    if (!tpl) {
      throw new Error(
        `saas layer: routine template ${spec.template.appName}/${spec.template.templateKey} is not registered for this org`,
      )
    }
    const ownerUserId = userIdOf(org, spec.ownerKey)
    const agent =
      spec.ownerHandle === "personal"
        ? org.agents.find(
            (a) => a.kind === "personal" && (a as { ownerKey?: string }).ownerKey === undefined,
          )
        : org.agentsByHandle[spec.ownerHandle]
    if (!agent) throw new Error(`saas layer: no agent ${spec.ownerHandle} for '${spec.name}'`)
    ids.push(
      await seedRoutine(ctx, {
        createdByUserId: org.adminUserId,
        ownerScopes: await scopesOf(ownerUserId),
        enabled: true,
        routine: {
          name: spec.name,
          description: tpl.description,
          kind: "recurring",
          cron: spec.cron,
          timezone: org.timezone,
          ownerUserId,
          ownerAgentId: agent.agentId,
          scopes: [...tpl.scopes],
          prompt: tpl.promptTemplate,
        },
      }),
    )
  }
  ctx.log(`routines: ${ids.length} seeded on`)
  return ids
}

/** The `saas` layer: everything of the plan the shared layers do not write. */
export async function seedSaasLayer(input: DemoWorldLayerInput): Promise<void> {
  const { org, baseTime, log } = input
  const ctx = seedContext({ orgId: org.orgId, now: baseTime, log })
  const plan = saasPlan(baseTime)
  const actor = await actorFor(ctx, ownerIdOf(org))
  const { companyIds, contactIds } = await seedSaasCompanies(ctx, org, actor, plan)
  const dealIds = await seedSaasDeals(ctx, org, actor, plan, companyIds, contactIds)
  await seedSaasAway(ctx, org)
  await seedSaasMeetings(ctx, org, actor)
  await seedSaasMail(ctx, org)
  await seedSaasFollowups(ctx, org, dealIds, contactIds)
  await seedSaasRoutines(ctx, org)
}
