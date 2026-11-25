// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A project billed by the day for browser tests: a company with its billing contact (the one
// contact, with a billing address, so the card's invoice can issue), the project linked
// to it with time and budgets on, a day rate, and tasks closed this month with their time, so a
// planned vs done card for the month prices and can make an invoice. Every row goes through the
// seed engine's factories and the projects writers, as the demo worlds seed theirs.

import { awaitTimeFeatureSync } from "~/apps/projects/service/time-feature"
import { setBillingTerms, setTaskTime, setTimePlan } from "~/apps/projects/service/time-plan"
import { awaitTimeRowWrites } from "~/apps/projects/service/time-rows"
import { updateProjectWithOutcome } from "~/apps/projects/service/update-project"
import { addAddress } from "~/modules/contacts/addresses"
import type { SeedContext } from "~/seed/context"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import { seedCompanies } from "~/seed/factories/people/companies"
import { resolveContacts } from "~/seed/factories/people/contacts"
import { seedProject } from "~/seed/factories/projects/projects"
import { seedTimeSettings } from "~/seed/factories/projects/time"

const HOURS_PER_DAY = 420

export interface BillableProjectArgs {
  /** Who owns and bills the project: holds projects:* (time, rates). */
  ownerId: string
  key: string
  name: string
  company: string
  contactName: string
  contactEmail: string
  /** The contact's billing address: it makes the contact the company's billing contact. */
  billingAddress: { street1: string; postalCode: string; city: string; countryIso2: string }
  /** The day rate, in minor units. */
  rateMinor: number
  currency: string
  /** Closed this month: each task's title and the days it took (its timebox too). */
  tasks: Array<{ title: string; days: number }>
}

export interface BillableProject {
  projectId: string
  key: string
  companyId: string
  contactId: string
  /** The month the tasks closed in, YYYY-MM. */
  month: string
  taskIds: string[]
}

export async function seedBillableProject(
  ctx: SeedContext,
  args: BillableProjectArgs,
): Promise<BillableProject> {
  const owner = await actorFor(ctx, args.ownerId)
  const [person] = await resolveContacts(ctx, owner, [
    { key: "billed", email: args.contactEmail, name: args.contactName },
  ])
  if (!person) throw new Error(`contact ${args.contactEmail} was not resolved`)
  const contactId = person[1].id
  const companies = await seedCompanies(
    ctx,
    owner,
    [{ key: "client", name: args.company, contactKeys: ["billed"] }],
    { billed: contactId },
  )
  const companyId = companies.client
  if (!companyId) throw new Error(`company ${args.company} was not seeded`)
  await asUser(owner, (tx) =>
    addAddress(tx as never, {
      orgId: ctx.orgId,
      userId: owner.userId,
      contactId,
      fields: { role: "billing", ...args.billingAddress },
    }),
  )
  await seedTimeSettings(ctx, owner, { hoursPerDayMinutes: HOURS_PER_DAY })

  const spec = { key: args.key, name: args.name, description: "", icon: "folder", owner: "owner" }
  // One run's own tasks: a re-run in the same org never adopts another run's.
  const run = crypto.randomUUID()
  const ref = (taskKey: string) => `e2e-billable:${args.key}:${run}:${taskKey}`
  const { projectId } = await seedProject(ctx, owner, {
    people: { owner: { userId: owner.userId } },
    spec: { ...spec, tasks: [] },
    externalRefOf: ref,
  })
  await asUser(owner, (tx) =>
    updateProjectWithOutcome({
      tx: tx as never,
      orgId: ctx.orgId,
      projectId,
      actor: owner,
      recordedAt: ctx.now,
      patch: { companyId, timeBudgets: true },
    }),
  )
  await awaitTimeFeatureSync(ctx.orgId)
  await asUser(owner, (tx) =>
    setTimePlan({
      tx: tx as never,
      orgId: ctx.orgId,
      actorId: owner.userId,
      scopes: owner.scopes,
      input: { projectId, basis: "daily", billerId: owner.userId },
    }),
  )
  await asUser(owner, (tx) =>
    setBillingTerms({
      tx: tx as never,
      orgId: ctx.orgId,
      scopes: owner.scopes,
      input: { projectId, rate: args.rateMinor / 100, currency: args.currency },
    }),
  )

  const { taskIds } = await seedProject(ctx, owner, {
    people: { owner: { userId: owner.userId } },
    spec: {
      ...spec,
      tasks: args.tasks.map((t, i) => ({
        key: `t${i + 1}`,
        title: t.title,
        status: "done" as const,
        // Time is entered on one's own tasks.
        assignee: "owner",
        completedAt: ctx.now,
        timeboxMinutes: t.days * HOURS_PER_DAY,
      })),
    },
    externalRefOf: ref,
  })
  const month = ctx.now.toISOString().slice(0, 7)
  // Time through Took, as the person enters it on their own task.
  for (const [i, taskId] of taskIds.entries()) {
    await asUser(owner, (tx) =>
      setTaskTime({
        tx: tx as never,
        orgId: ctx.orgId,
        userId: owner.userId,
        scopes: owner.scopes,
        place: { origin: "human-ui", frame: undefined, actingAgentId: null },
        input: { taskId, time: `${(args.tasks[i]?.days ?? 0) * HOURS_PER_DAY}m` },
      }),
    )
  }
  await awaitTimeRowWrites()
  return { projectId, key: args.key, companyId, contactId, month, taskIds }
}
