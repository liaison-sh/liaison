// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `studio` world's own layer: it writes the plan (`plan.ts`) after the
// shared support layer, through the product's own writers, as the people who
// would do it:
//
// - the lead and finance get the projects app's lead and finance roles from
//   the owner (the role writer);
// - hours in a day, as the owner;
// - the pipeline's deals, as its owner;
// - each project as its owner, with time and budgets turned on through the
//   project writer, so the org's feature row is derived, never seeded;
// - its plan, period timeboxes and billing terms (the biller, through the
//   terms writer), then its tasks in board-number order, timeboxes and
//   milestones through the task plan writer;
// - the time each person took, as that person; cost rates as finance;
// - who is away, through the away writer.
//
// No figure is computed here: budgets, capacity, the dated sheet and margin
// are what the product's reads make of these rows. Every write is idempotent:
// a re-run adopts what is there.
import { and, eq, inArray, sql } from "drizzle-orm"
import { reconcileMark } from "~/apps/projects/service/claims"
import { setCostRate } from "~/apps/projects/service/margin"
import { reconcilePropose } from "~/apps/projects/service/reconcile"
import { reconcileCreateStep } from "~/apps/projects/service/reconcile-create"
import { awaitTimeFeatureSync } from "~/apps/projects/service/time-feature"
import { setBillingTerms, setPeriodTimebox, setTaskTime } from "~/apps/projects/service/time-plan"
import { awaitTimeRowWrites } from "~/apps/projects/service/time-rows"
import { updateProjectWithOutcome } from "~/apps/projects/service/update-project"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { roles } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { listCatalogWithState } from "~/modules/apps/catalog"
import { addAddress } from "~/modules/contacts/addresses"
import { assignRole } from "~/modules/permissions/roles"
import { setAway } from "~/modules/users/away"
import { type SeedContext, seedContext } from "~/seed/context"
import { jsonCell, upsertAppRow } from "~/seed/factories/app-tables"
import {
  type ComputedDocument,
  computeDocuments,
  type InvoicingDocumentSpec,
  type InvoicingParty,
  seedInvoicingHistory,
} from "~/seed/factories/commerce/invoicing"
import { installApps } from "~/seed/factories/org/apps"
import { actorFor, asUser, rowsOf } from "~/seed/factories/people/actors"
import { seedCompanies } from "~/seed/factories/people/companies"
import { grantRoleDimension } from "~/seed/factories/people/role-grants"
import { seedPipeline } from "~/seed/factories/projects/deals"
import { seedProject, type TaskSpec } from "~/seed/factories/projects/projects"
import { seedTimePlan, seedTimeSettings } from "~/seed/factories/projects/time"
import type { SeedDemoOrgResult } from "~/seed/tiers/demo/seed-org"
import { STORY_TIME_ZONE } from "~/seed/worlds/story-clock"
import type { DemoWorldLayerInput } from "../index"
import { seedStudioAgreements } from "./agreements"
import {
  STUDIO_CLIENT_SIREN,
  STUDIO_CLIENTS,
  STUDIO_COMPANY,
  STUDIO_CONTACTS,
  STUDIO_PAST_CLIENTS,
  STUDIO_SIREN,
} from "./fiction"
import {
  STUDIO_INVOICE_PREFIX,
  STUDIO_TERMS_DAYS,
  STUDIO_VAT_BP,
  type StudioInvoiceLine,
  type StudioMoneyPlan,
  studioMoney,
} from "./money"
import { type StudioPlan, type StudioProjectPlan, studioPlan } from "./plan"
import { seedStudioPortal } from "./portal"

/** Midday UTC, so a past work day keeps its civil date in any zone near UTC. */
const NOON_MS = 12 * 60 * 60 * 1000

type ExecTx = { execute: (q: unknown) => Promise<unknown> }

/** The pipeline's project key. */
export const STUDIO_PIPELINE_KEY = "SALES"

/** A task's or a deal's idempotency key. */
export const studioTaskRef = (key: string) => `demo:studio:task:${key}`

/** Who gets which role of the projects app, beside their demo role. */
const STUDIO_APP_ROLES: ReadonlyArray<{ person: string; role: string }> = [
  { person: "bastien", role: "projects.lead" },
  { person: "anais", role: "projects.finance" },
]

/** Who drafts and sends the studio's agreements beside the founders: its project lead. */
const STUDIO_AGREEMENTS_ROLES: ReadonlyArray<{ person: string; role: string }> = [
  { person: "bastien", role: "agreements.lead" },
]

function ownerIdOf(org: SeedDemoOrgResult): string {
  return org.ownerUserId ?? org.adminUserId
}

function userIdOf(org: SeedDemoOrgResult, key: string): string {
  if (key === "owner") return ownerIdOf(org)
  const id = org.peopleByKey[key]?.userId
  if (!id) throw new Error(`studio layer: no person '${key}'`)
  return id
}

/** The number on a board key (`MARLIN-12` is 12). */
function numberOf(key: string): number {
  const n = Number(key.slice(key.lastIndexOf("-") + 1))
  if (!Number.isInteger(n) || n <= 0) throw new Error(`studio layer: no number in '${key}'`)
  return n
}

/** The day before the project's first closed task, period or time entry: when it started. */
function startOf(project: StudioProjectPlan, fallback: Date): Date {
  const dates = [
    ...project.tasks.flatMap((t) => (t.completedAt ? [t.completedAt.getTime()] : [])),
    ...project.periods.map((p) => {
      const [y, m, d] = p.periodStart.split("-").map(Number) as [number, number, number]
      return Date.UTC(y, m - 1, d)
    }),
  ]
  const first = dates.length > 0 ? Math.min(...dates) : fallback.getTime()
  return new Date(Math.min(first, fallback.getTime()) - 86_400_000)
}

/** The app roles (lead, finance), given by the owner through the role writer. */
async function seedStudioRoles(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  owner: UserContext,
  grants: ReadonlyArray<{ person: string; role: string }> = STUDIO_APP_ROLES,
): Promise<void> {
  await asUser(owner, async (tx) => {
    const names = grants.map((r) => r.role)
    const found = await tx
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(and(eq(roles.orgId, ctx.orgId), inArray(roles.name, names)))
    const idOf = new Map(found.map((r) => [r.name, r.id]))
    for (const { person, role } of grants) {
      const roleId = idOf.get(role)
      if (!roleId) throw new Error(`studio layer: no app role '${role}'`)
      const out = await assignRole(tx as never, {
        userId: userIdOf(org, person),
        roleId,
        orgId: ctx.orgId,
        actorId: owner.userId,
        actorScopes: owner.scopes as never,
        actorDimensionGrants: owner.dimensionGrants ?? {},
      })
      if (!out || "error" in out) {
        throw new Error(`studio layer: '${role}' was not given to ${person}`)
      }
    }
  })
  ctx.log(`roles: ${grants.map((r) => `${r.person} ${r.role}`).join(", ")}`)
}

/** The pipeline's deals, as its owner, on the clients the support layer wrote. */
async function seedStudioDeals(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  actors: (key: string) => Promise<UserContext>,
  plan: StudioPlan,
): Promise<Record<string, string>> {
  const owner = await actors(plan.pipeline.owner)
  const companyIds = await seedCompanies(
    ctx,
    owner,
    STUDIO_CLIENTS.map((c) => ({ key: c.key, name: c.name })),
    {},
    { onlyExisting: true },
  )
  await seedPipeline(ctx, owner, {
    people: org.peopleByKey,
    companyIds,
    contactIds: {},
    spec: {
      key: plan.pipeline.key,
      name: plan.pipeline.name,
      description: plan.pipeline.description,
      deals: plan.pipeline.deals.map((d) => ({
        key: d.key,
        title: d.title,
        stage: d.stage,
        ...(d.client ? { companyKey: d.client } : {}),
        owner: d.owner,
        amountMinor: d.amountMinor,
        currency: "EUR",
      })),
    },
    externalRefOf: studioTaskRef,
  })
  return companyIds
}

/** One project: created, switched on, planned and billed, then its tasks. */
async function seedStudioProject(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  actors: (key: string) => Promise<UserContext>,
  project: StudioProjectPlan,
  companyIds: Readonly<Record<string, string>>,
): Promise<{ projectId: string; taskIds: Record<string, string> }> {
  const owner = await actors(project.owner)
  const base = {
    key: project.key,
    name: project.name,
    description: project.description,
    icon: project.icon,
    owner: project.owner,
  }
  const { projectId } = await seedProject(ctx, owner, {
    people: org.peopleByKey,
    spec: { ...base, tasks: [] },
    externalRefOf: studioTaskRef,
  })

  const wanted = project.client ? companyIds[project.client] : undefined
  // A re-run finds the client already set and writes nothing for it.
  const current = await asUser(owner, async (tx) =>
    rowsOf<{ company_id: string | null }>(
      await (tx as ExecTx).execute(
        sql`SELECT company_id::text AS company_id FROM ${sql.raw(schemaRef("app_projects"))}.projects
            WHERE id = ${projectId}::uuid AND org_id = ${ctx.orgId}::uuid`,
      ),
    ),
  )
  const companyId = wanted && current[0]?.company_id !== wanted ? wanted : undefined
  if (project.timeBudgets || companyId) {
    // The client and the switch through the project writer: the org's row follows.
    await asUser(owner, (tx) =>
      updateProjectWithOutcome({
        tx: tx as never,
        orgId: ctx.orgId,
        projectId,
        actor: owner,
        // The world used time and budgets on this project from its start, before any task closed.
        recordedAt: startOf(project, ctx.now),
        patch: {
          ...(companyId ? { companyId } : {}),
          ...(project.timeBudgets ? { timeBudgets: true } : {}),
        },
      }),
    )
  }
  if (project.timeBudgets) {
    // The org's feature row follows after commit; the writers below read it.
    await awaitTimeFeatureSync(ctx.orgId)

    await seedTimePlan(ctx, owner, {
      projectId,
      basis: project.basis,
      ...(project.timeboxMinutes !== undefined ? { timeboxMinutes: project.timeboxMinutes } : {}),
      ...(project.biller ? { billerId: userIdOf(org, project.biller) } : {}),
      datedHours: project.datedHours,
      sourceRepos: project.sourceRepos.map((repo) => ({ provider: "github", repo })),
      // A retainer's periods are its schedule's, written as invoicing writes them; the others go
      // through the period writer.
      periods: project.periods
        .filter((p) => p.source === "retainer")
        .map((p) => ({ ...p, sourceRef: studioScheduleId(ctx, project.key) })),
    })
    for (const period of project.periods.filter((p) => p.source === "manual")) {
      await asUser(owner, (tx) =>
        setPeriodTimebox({
          tx: tx as never,
          orgId: ctx.orgId,
          actorId: owner.userId,
          scopes: owner.scopes,
          input: {
            projectId,
            from: period.periodStart,
            to: period.periodEnd,
            timebox: `${period.minutes}m`,
          },
        }),
      )
    }
    if (
      project.biller &&
      (project.rateMinor !== undefined || project.fixedPriceMinor !== undefined)
    ) {
      const biller = await actors(project.biller)
      await asUser(biller, (tx) =>
        setBillingTerms({
          tx: tx as never,
          orgId: ctx.orgId,
          scopes: biller.scopes,
          input: {
            projectId,
            ...(project.fixedPriceMinor !== undefined
              ? { fixedPrice: project.fixedPriceMinor / 100 }
              : { rate: (project.rateMinor ?? 0) / 100 }),
            currency: project.currency,
          },
        }),
      )
    }
  }

  const tasks: TaskSpec[] = project.tasks.map((t) => ({
    key: t.key,
    title: t.title,
    status: t.status,
    number: numberOf(t.key),
    ...(t.assignee ? { assignee: t.assignee } : {}),
    ...(t.parent ? { parent: t.parent } : {}),
    ...(t.dueInDays !== undefined ? { dueInDays: t.dueInDays } : {}),
    ...(t.completedAt ? { completedAt: t.completedAt } : {}),
    ...(t.timeboxMinutes !== undefined ? { timeboxMinutes: t.timeboxMinutes } : {}),
    ...(t.isMilestone ? { isMilestone: true } : {}),
  }))
  const { taskIds } = await seedProject(ctx, owner, {
    people: org.peopleByKey,
    spec: { ...base, tasks },
    externalRefOf: studioTaskRef,
  })
  const byKey: Record<string, string> = {}
  const ordered = [...tasks].sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
  ordered.forEach((t, i) => {
    const id = taskIds[i]
    if (id) byKey[t.key] = id
  })
  return { projectId, taskIds: byKey }
}

/** The recurring schedule a retainer project's months come from, by project key. */
function studioScheduleId(ctx: SeedContext, projectKey: string): string {
  return ctx.id("recurring_schedule", `studio:retainer:${projectKey}`)
}

/** Midday in Paris on a civil date, near enough: 10:00 UTC. */
function onDay(civil: string, hourUtc = 10): Date {
  const [y, m, d] = civil.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d, hourUtc))
}

const lineSpecs = (lines: readonly StudioInvoiceLine[]) =>
  lines.map((l) => ({
    description: l.description,
    unitPriceMinor: l.unitPriceMinor,
    quantity: l.quantity,
    lineKind: "service" as const,
    ...(l.externalId ? { externalId: l.externalId } : {}),
  }))

/** The kernel role of the people who send the studio's documents to its clients: finance. */
const STUDIO_SENDER_ROLES = ["finance"] as const

/**
 * The mailbox the studio's documents are sent from: the org's shared one, which the roles that
 * send them may use (their `mail:inbox` grant, on the role so a reset keeps it). Null when the
 * world has no mail.
 */
async function seedStudioSendFrom(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
): Promise<string | null> {
  const rows = await withPrivilegedDb(ctx.orgId, "seed-studio:send-from", (tx) =>
    tx.execute(sql`
      SELECT id::text AS id FROM ${sql.raw(schemaRef("app_mail"))}.accounts
       WHERE org_id = ${ctx.orgId}::uuid AND owner_type = 'org'
       ORDER BY created_at, id LIMIT 1`),
  )
  const mailbox = rowsOf<{ id: string }>(rows)[0]?.id ?? null
  if (!mailbox) return null
  await grantRoleDimension(
    ctx.orgId,
    org.adminUserId,
    "mail:inbox",
    STUDIO_SENDER_ROLES.map((role) => [role, [mailbox]] as const),
    "seed-studio",
    ctx.log,
  )
  return mailbox
}

/**
 * The money of the year, in the order it happened: the issuer; the portal's quote and billing
 * plan; every invoice of the year in one chronological loop, numbered from 0001 as the app numbers
 * them; the retainer's last month reconciled, drafted on its card's key and marked billed by the
 * projects writers at the day it was issued; the two monthly schedules. The Beta milestone is
 * not drafted: its task is still in progress. Idempotent: rows are keyed, the approval is asked once.
 */
async function seedStudioMoney(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  actors: (key: string) => Promise<UserContext>,
  tasksOf: Record<string, { projectId: string; taskIds: Record<string, string> }>,
  companyIds: Readonly<Record<string, string>>,
  money: StudioMoneyPlan,
): Promise<void> {
  const projectId = (key: string) => {
    const id = tasksOf[key]?.projectId
    if (!id) throw new Error(`studio money: no project ${key}`)
    return id
  }
  const taskId = (project: string, key: string) => {
    const id = tasksOf[project]?.taskIds[key]
    if (!id) throw new Error(`studio money: no task ${key}`)
    return id
  }
  const contactRows = await withPrivilegedDb(ctx.orgId, "seed-studio:money-contacts", async (tx) =>
    rowsOf<{ id: string; email: string }>(
      await tx.execute(sql`
        SELECT id::text AS id, email FROM ${sql.raw(schemaRef("kernel"))}.contacts
         WHERE org_id = ${ctx.orgId}::uuid AND email IS NOT NULL`),
    ),
  )
  const contactIdByEmail = new Map(contactRows.map((r) => [r.email.toLowerCase(), r.id]))
  const contactOf = (customerKey: string) => {
    const c = STUDIO_CONTACTS.find((x) => x.key === customerKey)
    const id = c ? contactIdByEmail.get(c.email.toLowerCase()) : undefined
    if (!c || !id) throw new Error(`studio money: no contact ${customerKey}`)
    return { id, email: c.email }
  }
  const billedContact: Record<string, string> = {
    marlin: "pauline-gros",
    sorel: "thomas-blanc",
    verdier: "marc-verdier",
  }

  // Each client's invoiced contact holds its billing address, and its registry identity: the
  // e-invoice of a French business needs both, so a card's Create can make an invoice that issues.
  const biller0 = await actors("anais")
  for (const c of STUDIO_CLIENTS) {
    const contact = contactOf(billedContact[c.key] ?? c.contactKeys[0] ?? "")
    const hasBilling = await withPrivilegedDb(
      ctx.orgId,
      "seed-studio:billing-address",
      async (tx) =>
        rowsOf<{ id: string }>(
          await tx.execute(sql`
          SELECT id::text AS id FROM ${sql.raw(schemaRef("kernel"))}.contact_addresses
           WHERE org_id = ${ctx.orgId}::uuid AND contact_id = ${contact.id}::uuid
             AND role = 'billing' AND archived_at IS NULL LIMIT 1`),
        ),
    )
    if (hasBilling.length === 0) {
      await asUser(biller0, (tx) =>
        addAddress(tx, {
          orgId: ctx.orgId,
          userId: biller0.userId,
          contactId: contact.id,
          fields: {
            role: "billing",
            street1: c.street,
            postalCode: c.postcode,
            city: c.city,
            countryIso2: "FR",
          },
        }),
      )
    }
    await withSystemDb("seed-studio-client-identity", (tx) =>
      upsertAppRow(tx, "invoicing", "counterparty_identities", {
        id: ctx.id("counterparty_identity", `studio:${c.key}`),
        org_id: ctx.orgId,
        contact_id: contact.id,
        customer_kind: "business",
        siren: STUDIO_CLIENT_SIREN,
        registry_name: c.name,
        registry_line1: c.street,
        registry_postcode: c.postcode,
        registry_city: c.city,
        registry_country_code: "FR",
        registry_status: "A",
        registry_checked_at: ctx.now.toISOString(),
        source: "registry",
        confirmed_via: "auto",
        changed_at: ctx.now.toISOString(),
      }),
    )
  }

  // Who the invoices go to: the clients of the projects, and the clients of earlier work.
  const parties = new Map<string, InvoicingParty>()
  const contactIdsByPartyKey: Record<string, string> = {}
  for (const c of STUDIO_CLIENTS) {
    const contactKey = billedContact[c.key]
    const contact = contactKey ? contactOf(contactKey) : null
    parties.set(c.key, {
      key: c.key,
      name: c.name,
      email: contact?.email ?? `billing@${c.domain}`,
      country: "FR",
      vatId: null,
      address: `${c.name}\n${c.street}\n${c.postcode} ${c.city}\nFR`,
    })
    if (contact) contactIdsByPartyKey[c.key] = contact.id
  }
  for (const c of STUDIO_PAST_CLIENTS) {
    parties.set(c.key, {
      key: c.key,
      name: c.name,
      email: `billing@${c.domain}`,
      country: "FR",
      vatId: null,
      address: `${c.name}, France`,
    })
  }

  const stepId = (key: string) => ctx.id("billing_step", `studio:${key}`)
  const docKey = (key: string) => `studio:${key}`
  const docId = (key: string) => ctx.id("document", docKey(key))
  const sorel = money.retainers.find((r) => r.project === "SOREL")
  if (!sorel) throw new Error("studio money: no publishing retainer")
  const sorelScheduleId = studioScheduleId(ctx, "SOREL")
  const retainerKey = `retainer:${sorelScheduleId}:${money.retainerLastMonth.month}`

  // The retainer's last month on its card, as the biller reconciled it on the day it was issued:
  // the card, then Create's reservation under the month's key, through the projects writers.
  const lastInvoice = money.invoices.find((i) => i.key === money.retainerLastMonth.invoiceKey)
  if (!lastInvoice) throw new Error("studio money: no retainer invoice")
  const biller = await actors("anais")
  const reconciledAt = onDay(lastInvoice.issuedOn, 9)
  const sorelTask = (k: string) => taskId("SOREL", k)
  const existing = await asUser(biller, async (tx) =>
    rowsOf<{ id: string; revision: number; state: string }>(
      await (tx as ExecTx).execute(sql`
        SELECT id::text AS id, revision, state FROM ${sql.raw(schemaRef("app_projects"))}.reconciliations
         WHERE org_id = ${ctx.orgId}::uuid AND project_id = ${projectId("SOREL")}::uuid
           AND period_start = ${`${money.retainerLastMonth.month}-01`}::date
           AND state IN ('proposed', 'drafted', 'invoiced')
         ORDER BY created_at LIMIT 1`),
    ),
  )
  let card = existing[0] ?? null
  if (!card) {
    const out = (await asUser(biller, (tx) =>
      reconcilePropose({
        tx: tx as never,
        orgId: ctx.orgId,
        userId: biller.userId,
        scopes: biller.scopes,
        now: reconciledAt,
        input: {
          project: "SOREL",
          month: money.retainerLastMonth.month,
          lines: [
            { name: "Monthly review", taskIds: [sorelTask("SOREL-16")], proofs: [] },
            { name: "Support questions", taskIds: [sorelTask("SOREL-17")], proofs: [] },
            { name: "Catalogue import", taskIds: [sorelTask("SOREL-18")], proofs: [] },
            {
              name: "Rights database fixes",
              taskIds: [sorelTask("SOREL-19"), sorelTask("SOREL-20")],
              proofs: [],
            },
            { name: "Reader site upkeep", taskIds: [sorelTask("SOREL-21")], proofs: [] },
          ],
        } as never,
      }),
    )) as {
      reconciliationId?: string
      revision?: number
      card?: { reconciliationId: string; revision: number }
    }
    const id = out.reconciliationId ?? out.card?.reconciliationId
    const revision = out.revision ?? out.card?.revision
    if (!id || revision === undefined)
      throw new Error("studio money: the retainer card was not drawn")
    card = { id, revision, state: "proposed" }
  }
  const step = (name: "prepare" | "reserve" | "finish", extra: Record<string, unknown> = {}) =>
    asUser(biller, (tx) =>
      reconcileCreateStep({
        tx: tx as never,
        orgId: ctx.orgId,
        userId: biller.userId,
        scopes: biller.scopes,
        origin: "human-ui",
        now: reconciledAt,
        step: name,
        input: { reconciliationId: card.id, revision: card.revision, ...extra },
      }),
    )
  if (card.state === "proposed") {
    const prepared = (await step("prepare")) as { documentRef?: string }
    if (prepared.documentRef !== retainerKey) {
      throw new Error(`studio money: the retainer card is keyed ${prepared.documentRef}`)
    }
    await step("reserve")
  }

  // The year's documents in the one order they were issued.
  const specs: InvoicingDocumentSpec[] = []
  const when = new Map<
    string,
    {
      issuedAt: Date | null
      paidAt: Date | null
      number: string | null
      numberInt: number | null
      year: number | null
    }
  >()
  specs.push({
    key: docKey(money.quote.key),
    type: "quote",
    status: "accepted",
    paymentStatus: "unpaid",
    party: money.quote.client,
    lines: lineSpecs(money.quote.lines),
    issuedDaysAgo: 0,
    termsDays: null,
    billingProjectId: projectId(money.quote.projectKey),
  })
  const quoteYear = Number(money.quote.issuedOn.slice(0, 4))
  when.set(docKey(money.quote.key), {
    issuedAt: onDay(money.quote.issuedOn),
    paidAt: null,
    number: `D-${quoteYear}-0001`,
    numberInt: 1,
    year: quoteYear,
  })
  for (const inv of money.invoices) {
    const key = docKey(inv.key)
    const retainer = inv.kind === "retainer"
    const step = inv.stepKey ? stepId(inv.stepKey) : null
    specs.push({
      key,
      type: "invoice",
      status: inv.paidOn ? "paid" : "issued",
      paymentStatus: inv.paidOn ? "paid" : "unpaid",
      party: inv.client,
      lines: lineSpecs(
        retainer
          ? inv.lines.map((l, i) => ({
              ...l,
              externalId:
                i === 0
                  ? `retainer_fee:${sorelScheduleId}:${money.retainerLastMonth.month}:1`
                  : `retainer_overage:${sorelScheduleId}:${money.retainerLastMonth.month}`,
            }))
          : inv.kind === "milestone" && step
            ? inv.lines.map((l) => ({ ...l, externalId: `milestone:${step}` }))
            : inv.kind === "advance" && step
              ? inv.lines.map((l) => ({ ...l, externalId: `advance:${step}` }))
              : inv.lines,
      ),
      issuedDaysAgo: 0,
      termsDays: STUDIO_TERMS_DAYS,
      ...(inv.projectKey ? { billingProjectId: projectId(inv.projectKey) } : {}),
      ...(retainer
        ? { externalRef: retainerKey }
        : inv.kind === "milestone" && step
          ? { externalRef: `milestone:${step}` }
          : inv.kind === "advance" && step
            ? { externalRef: `advance:${step}` }
            : {}),
      ...(retainer
        ? {
            externalRefs: {
              recurring_schedule_id: sorelScheduleId,
              reconciliation_id: card.id,
              reconciliation_revision: String(card.revision),
            },
          }
        : step
          ? { externalRefs: { billing_step_id: step } }
          : {}),
      columns: {
        invoice_role: inv.invoiceRole,
        operation_category: "services",
        ...(inv.paidOn ? { payment_state: "paid" } : {}),
        ...(inv.servicePeriod
          ? {
              service_period_start: inv.servicePeriod.start,
              service_period_end: inv.servicePeriod.end,
            }
          : {}),
      },
    })
    when.set(key, {
      issuedAt: onDay(inv.issuedOn),
      paidAt: inv.paidOn ? onDay(inv.paidOn, 11) : null,
      number: inv.number,
      numberInt: inv.numberInt,
      year: inv.year,
    })
  }
  const documents: ComputedDocument[] = computeDocuments(ctx, {
    documents: specs,
    parties,
    skus: new Map(),
  }).map((d) => {
    const w = when.get(d.spec.key)
    if (!w)
      return {
        ...d,
        issuedAt: null,
        dueAt: null,
        paidAt: null,
        number: null,
        numberInt: null,
        yearOfIssue: null,
      }
    return {
      ...d,
      issuedAt: w.issuedAt,
      dueAt:
        w.issuedAt && d.spec.termsDays
          ? new Date(w.issuedAt.getTime() + d.spec.termsDays * 86_400_000)
          : null,
      paidAt: w.paidAt,
      number: w.number,
      numberInt: w.numberInt,
      yearOfIssue: w.year,
    }
  })
  // computeDocuments sorts by its own day offsets; write in the plan's issue order.
  const order = new Map(specs.map((s, i) => [s.key, i]))
  documents.sort((a, b) => (order.get(a.spec.key) ?? 0) - (order.get(b.spec.key) ?? 0))

  const mailAccountId = await seedStudioSendFrom(ctx, org)
  const { issuerProfileId } = await seedInvoicingHistory(ctx, {
    issuer: {
      key: "studio",
      mailAccountId,
      legalName: STUDIO_COMPANY.legalName ?? STUDIO_COMPANY.name,
      country: STUDIO_COMPANY.country ?? "FR",
      vatId: STUDIO_COMPANY.vat ?? null,
      address: `${STUDIO_COMPANY.addressLine1}, ${STUDIO_COMPANY.postalCode} ${STUDIO_COMPANY.city}`,
      iban: STUDIO_COMPANY.iban ?? "",
      swiftBic: STUDIO_COMPANY.swiftBic ?? "",
      bankName: STUDIO_COMPANY.bankName ?? "",
      defaultCurrency: "EUR",
      prefixes: {
        invoice: STUDIO_INVOICE_PREFIX,
        quote: "D-{YYYY}-",
        proforma: "PRO-{YYYY}-",
        po: "BC-{YYYY}-",
        creditNote: "A-{YYYY}-",
      },
      shopifyShopId: null,
      invoiceApprovalThresholdMinor: "0",
      poApprovalThresholdMinor: "0",
      timezone: STORY_TIME_ZONE,
      identity: {
        siren: STUDIO_SIREN,
        line1: STUDIO_COMPANY.addressLine1 ?? "",
        postcode: STUDIO_COMPANY.postalCode ?? "",
        city: STUDIO_COMPANY.city ?? "",
        countryCode: STUDIO_COMPANY.country ?? "FR",
      },
    },
    hsCodes: [],
    relationships: Object.entries(contactIdsByPartyKey).map(([key, contactId]) => ({
      key: `studio:${key}`,
      contactId,
      relationship: "customer" as const,
    })),
    documents,
    contactIdsByPartyKey,
  })

  // The portal's billing plan on its quote, and the two monthly schedules.
  const nowIso = ctx.now.toISOString()
  await withSystemDb("seed-studio-money-plan", async (tx) => {
    for (const s of money.steps) {
      await upsertAppRow(tx, "invoicing", "billing_steps", {
        id: stepId(s.key),
        org_id: ctx.orgId,
        billing_project_id: projectId("MARLIN"),
        position: s.position,
        kind: s.kind,
        label: s.label,
        amount_minor: String(s.amountMinor),
        currency: "EUR",
        tax_rate_bp: STUDIO_VAT_BP,
        task_id: s.taskKey ? taskId("MARLIN", s.taskKey) : null,
        quote_document_id: docId(money.quote.key),
        quote_line_position: s.kind === "advance" ? null : s.position - 1,
        document_id: s.invoiceKey ? docId(s.invoiceKey) : null,
        state: s.state,
      })
    }
    for (const r of money.retainers) {
      const contact = contactOf(r.contactKey)
      const isRetainer = r.includedMinutes !== null
      await upsertAppRow(tx, "invoicing", "recurring_schedules", {
        id: studioScheduleId(ctx, r.project),
        org_id: ctx.orgId,
        issuer_profile_id: issuerProfileId,
        company_id: companyIds[r.client] ?? null,
        contact_id: contact.id,
        status: "active",
        repeats: "month",
        billing_day: "last",
        ends_on: null,
        covers: r.covers,
        issue_mode: "review",
        paid_by: "transfer",
        due_rule: "days_30",
        language: "fr",
        lines: jsonCell([
          {
            description: r.feeLabel,
            qty: 1,
            unit_price_minor: r.feeMinor,
            vat_bp: STUDIO_VAT_BP,
            line_kind: "service",
          },
        ]),
        next_issue_on: r.nextIssueOn,
        next_draft_on: r.nextDraftOn,
        version: 1,
        created_by: "seed",
        ...(isRetainer
          ? {
              retainer_project_id: projectId(r.project),
              retainer_minutes: r.includedMinutes,
              retainer_overage_rate_minor: String(r.overageRateMinor ?? 0),
              retainer_rollover: "none",
              retainer_from: r.from,
            }
          : {}),
        created_at: nowIso,
        updated_at: nowIso,
      })
    }
  })

  // The card is on the invoice made under its key; once issued, its claims are billed, as
  // invoicing's call after the issue marks them.
  if (card.state === "proposed") {
    await step("finish", { documentId: docId(lastInvoice.key) })
  }
  await asUser(biller, (tx) =>
    reconcileMark({
      tx: tx as never,
      orgId: ctx.orgId,
      input: {
        reconciliationId: card.id,
        to: "billed",
        documentId: docId(lastInvoice.key),
        documentNumber: lastInvoice.number,
      },
    }),
  )

  ctx.log(
    `money: ${money.invoices.length} invoices to ${money.invoices.at(-1)?.number}, plan of ${money.steps.length} steps, ${money.retainers.length} schedules`,
  )
}

/** Who is away from the anchor, said by the owner, with who is next in line. */
async function seedStudioAway(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  owner: UserContext,
  plan: StudioPlan,
): Promise<void> {
  for (const away of plan.away) {
    const userId = userIdOf(org, away.person)
    const recorded = await asUser(owner, async (tx) =>
      rowsOf<{ id: string }>(
        await (tx as ExecTx).execute(
          sql`SELECT id FROM ${sql.raw(schemaRef("kernel"))}.away_ranges
              WHERE org_id = ${ctx.orgId}::uuid AND user_id = ${userId}::uuid LIMIT 1`,
        ),
      ),
    )
    if (recorded.length > 0) continue
    await setAway({
      orgId: ctx.orgId,
      actorId: owner.userId,
      actorScopes: owner.scopes,
      userId,
      form: { from: away.startsOn, to: away.endsOn },
      nextInLineId: userIdOf(org, away.nextInLine),
      now: ctx.now,
    })
  }
  ctx.log(`away: ${plan.away.map((a) => a.person).join(", ")}`)
}

export async function seedStudioLayer(input: DemoWorldLayerInput): Promise<void> {
  const { org, baseTime, log } = input
  const ctx = seedContext({ orgId: org.orgId, now: baseTime, log })
  const plan = studioPlan(baseTime)
  const owner = await actorFor(ctx, ownerIdOf(org))

  await seedStudioRoles(ctx, org, owner)
  // Read after the roles, so each person acts with what they now hold.
  const cache = new Map<string, Promise<UserContext>>()
  const actors = (key: string) => {
    let actor = cache.get(key)
    if (!actor) {
      actor = actorFor(ctx, userIdOf(org, key))
      cache.set(key, actor)
    }
    return actor
  }

  await seedTimeSettings(ctx, owner, { hoursPerDayMinutes: plan.hoursPerDayMinutes })
  const companyIds = await seedStudioDeals(ctx, org, actors, plan)

  const tasksOf: Record<string, { projectId: string; taskIds: Record<string, string> }> = {}
  for (const project of plan.projects) {
    if (project.key === plan.pipeline.key) continue
    tasksOf[project.key] = await seedStudioProject(ctx, org, actors, project, companyIds)
  }
  ctx.log(`projects: ${Object.keys(tasksOf).join(", ")}`)

  // Each person enters their own time through the product's writer, on the day they worked it:
  // a dated project takes the day, an undated one records the day the entry is made.
  const datedProjects = new Set(plan.projects.filter((p) => p.datedHours).map((p) => p.key))
  const rowsSorted = [...plan.taskTime].sort(
    (a, b) => a.person.localeCompare(b.person) || a.workDate.localeCompare(b.workDate),
  )
  for (const r of rowsSorted) {
    const project = tasksOf[r.project]
    const taskId = project?.taskIds[r.task]
    if (!project || !taskId) throw new Error(`studio layer: no task ${r.task}`)
    const person = await actors(r.person)
    const dated = datedProjects.has(r.project)
    await asUser(person, (tx) =>
      setTaskTime({
        tx: tx as never,
        orgId: ctx.orgId,
        userId: person.userId,
        scopes: person.scopes,
        place: { origin: "human-ui", frame: undefined, actingAgentId: null },
        input: { taskId, time: `${r.minutes}m`, ...(dated ? { date: r.workDate } : {}) },
        now: dated ? ctx.now : new Date(Date.parse(r.workDate) + NOON_MS),
      }),
    )
  }
  await awaitTimeRowWrites()
  ctx.log(`time: ${plan.taskTime.length} rows`)

  // Cost rates through the rate writer, as finance sets them.
  const finance = await actors("anais")
  for (const r of plan.costRates) {
    await asUser(finance, (tx) =>
      setCostRate({
        tx: tx as never,
        orgId: ctx.orgId,
        scopes: finance.scopes,
        input: {
          userId: userIdOf(org, r.person),
          rate: r.rateMinor / 100,
          from: r.effectiveFrom,
          currency: r.currency,
        },
      }),
    )
  }
  await seedStudioAway(ctx, org, owner, plan)
  // The money layer needs the invoicing app: a plan without it seeds no money.
  if (input.plan.apps.includes("invoicing")) {
    await seedStudioMoney(ctx, org, actors, tasksOf, companyIds, studioMoney(baseTime))
  }
  // The agreements layer needs the agreements app. The world brings it (its client work signs
  // agreements) through the app factory, when this instance's catalog holds it; without it the
  // world seeds no agreement.
  const agreementsOn =
    input.plan.apps.includes("agreements") ||
    ((await listCatalogWithState()).some((c) => c.name === "agreements") &&
      (await installApps(org.orgId, org.adminUserId, ["agreements"], log)).some(
        (a) => a.name === "agreements" && a.enabled && a.installed,
      ))
  if (agreementsOn) {
    await seedStudioRoles(ctx, org, owner, STUDIO_AGREEMENTS_ROLES)
    const dealRows = await withPrivilegedDb(ctx.orgId, "seed-studio:agreement-deals", (tx) =>
      tx.execute(sql`
        SELECT id::text AS id, external_ref FROM ${sql.raw(schemaRef("app_projects"))}.tasks
         WHERE org_id = ${ctx.orgId}::uuid AND external_ref LIKE ${`${studioTaskRef("SALES-")}%`}`),
    )
    const dealIds = Object.fromEntries(
      rowsOf<{ id: string; external_ref: string }>(dealRows).map((r) => [
        r.external_ref.slice(studioTaskRef("").length),
        r.id,
      ]),
    )
    const money = studioMoney(baseTime)
    await seedStudioAgreements({
      ctx,
      org,
      owner,
      companyIds,
      projectIds: Object.fromEntries(Object.entries(tasksOf).map(([k, v]) => [k, v.projectId])),
      dealIds,
      quoteDocumentId: input.plan.apps.includes("invoicing")
        ? ctx.id("document", `studio:${money.quote.key}`)
        : null,
    })
    // The client's portal: its two people and what is open for them, which the agreements
    // shared there need first.
    await seedStudioPortal({
      ctx,
      org,
      companyIds,
      projectIds: Object.fromEntries(Object.entries(tasksOf).map(([k, v]) => [k, v.projectId])),
      invoicing: input.plan.apps.includes("invoicing"),
    })
  }

  // The product writes each task now, at the seed's run, and setting its timebox touches it
  // again; a task the plan closed weeks ago was last changed when it closed. Its row says so,
  // so a list's "updated" day is the close, not the day the world was seeded.
  await withPrivilegedDb(ctx.orgId, "seed-studio:task-closed-at", (tx) =>
    tx.execute(sql`
      UPDATE ${sql.raw(schemaRef("app_projects"))}.tasks
         SET updated_at = completed_at, created_at = least(created_at, completed_at)
       WHERE org_id = ${ctx.orgId}::uuid AND completed_at IS NOT NULL
         AND external_ref LIKE ${`${studioTaskRef("")}%`}`),
  )
}
