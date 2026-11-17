// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Money on Home, on the real database: per project and month at most one money item waits on
// anyone. The month-close line becomes the draft's issue approval, then nothing; a release brings
// the line back; the line opens the asker's own proposed card; a draft waiting near its latest
// issue day comes back to the top; a retainer month drafts nothing before a person reconciles.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { AttentionItem } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { computeAttentionItems } from "~/apps/projects/attention"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { computeApprovalAttentionItems } from "~/modules/approvals/attention"
import { createHandlerApprovalRequest } from "~/modules/apps/execute-tool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { seedReconciliation } from "~/seed/factories/projects/reconcile"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import {
  type ClaimsWorld,
  forgetClaimsWorld,
  invoiceCarrying,
  registerInvoicing,
} from "~/tests/helpers/projects-claims"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { reconcileMark } from "./claims"
import { MONTH_CLOSE_KIND } from "./home-lines"
import { awaitTimeFeatureSync } from "./time-feature"
import { awaitTimeRowWrites } from "./time-rows"

const BILLER_SCOPES = [
  "projects:projects:read",
  "projects:tasks:read",
  "projects:tasks:write",
  "projects:reconcile:read",
  "projects:reconcile:write",
  "invoicing:documents:read",
  "invoicing:documents:write",
]
const ISSUE_SCOPES = ["invoicing:documents:read", "invoicing:documents:write"]

let orgId = ""
let owner: minimal.Session
let biller = ""
let world: ClaimsWorld
const project: Record<string, string> = {}

function actorOf(userId: string, scopes: string[] = ["*"]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

async function call<T = Record<string, any>>(method: string, input: unknown): Promise<T> {
  const a = actorOf(owner.userId)
  const out = await withRlsContext(a, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      a.userId,
      orgId,
      tx,
      { name: "projects" },
      a.scopes,
      "user",
      undefined,
      { origin: "human-ui" } as never,
    )
    return JSON.parse(await bridge[method](JSON.stringify(input))) as T
  })
  await awaitTimeRowWrites()
  return out
}

async function newProject(name: string, basis: string): Promise<string> {
  const made = await call<{ id: string }>("projects_createProject", { name })
  await call("projects_updateProject", { projectId: made.id, timeBudgets: true })
  await awaitTimeFeatureSync(orgId)
  await call("projects_timePlanSet", { projectId: made.id, basis, billerId: biller })
  return made.id
}

/** Midday UTC on a civil date. */
const noon = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d, 12))
}

/** What waits on `userId` on `day`: the projects lines and the approvals, as Home sorts them. */
async function homeOf(userId: string, day: string): Promise<AttentionItem[]> {
  const now = noon(day)
  const items = await withRlsContext(actorOf(userId, BILLER_SCOPES), async (tx) => [
    ...(await computeAttentionItems(tx, orgId, userId, [], now)),
    ...(await computeApprovalAttentionItems(tx, orgId, userId, [], now)),
  ])
  return items.sort(
    (a, b) =>
      b.urgency - a.urgency || new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  )
}

/** The project an invoice draft's issue approval bills, read from the draft. */
async function draftProject(draftId: string): Promise<string | null> {
  return (
    extractRows<{ p: string | null }>(
      await db.execute(drizzleSql`
        SELECT billing_project_id::text AS p FROM app_invoicing.documents
         WHERE id = ${draftId}::uuid`),
    )[0]?.p ?? null
  )
}

/** The money items of each project on Home: month-close lines and invoice issue approvals. */
async function moneyByProject(items: AttentionItem[]): Promise<Map<string, AttentionItem[]>> {
  const out = new Map<string, AttentionItem[]>()
  const add = (p: string, i: AttentionItem) => out.set(p, [...(out.get(p) ?? []), i])
  for (const i of items) {
    if ((i.kind as string) === MONTH_CLOSE_KIND) add(i.entityId, i)
    if (i.kind === "approval_pending" && i.metadata?.toolName === "invoicing:invoice_issue") {
      const payload = await db.execute(drizzleSql`
        SELECT current_payload->>'draft_id' AS d FROM kernel.approval_requests
         WHERE id = ${i.entityId}::uuid`)
      const draftId = extractRows<{ d: string }>(payload)[0]?.d
      const p = draftId ? await draftProject(draftId) : null
      if (p) add(p, i)
    }
  }
  return out
}

const monthLines = (items: AttentionItem[], projectId: string) =>
  items.filter((i) => (i.kind as string) === MONTH_CLOSE_KIND && i.entityId === projectId)

/**
 * An invoice draft of `projectId` carrying `externalRef`, with its issue approval parked as
 * invoicing parks it (an in-app hop), latest issue day `latestOn`, and `lines` lines.
 */
async function waitingDraft(input: {
  projectId: string
  externalRef: string
  latestOn: string
  lines?: number
}): Promise<{ draftId: string; approvalId: string }> {
  const doc = await invoiceCarrying(
    { ...world, projectId: input.projectId },
    { externalRef: input.externalRef, status: "draft" },
  )
  const parked = await createHandlerApprovalRequest({
    orgId,
    requestedBy: biller,
    actorScopes: [...BILLER_SCOPES, "invoicing:*"],
    defaultAppName: "invoicing",
    origin: "in-app-agent",
    input: {
      tool_name: "invoicing:invoice_issue",
      summary: `Issue the invoice draft ${input.externalRef}`,
      summary_detail: {
        lines: Array.from({ length: input.lines ?? 1 }, (_, n) => `Line ${n + 1}`),
        latest_on: input.latestOn,
      },
      current_payload: { draft_id: doc.id },
      approve_scope: "invoicing:documents:write",
      expiry_hours: 720,
    },
  })
  return { draftId: doc.id, approvalId: String(parked.approval_id) }
}

/** A drafted reconciliation of the month, keyed as Create keys it. */
async function draftedMonth(projectId: string, month: string, createdBy = biller) {
  const thread = await minimal.thread(orgId, createdBy)
  const id = await seedReconciliation(orgId, {
    now: new Date(),
    projectId,
    createdBy,
    threadId: thread,
    state: "drafted",
    month,
    idleDays: 0,
    documentRef: "pending",
  })
  const ref = `reconcile:${id}:1`
  await db.execute(drizzleSql`
    UPDATE app_projects.reconciliations SET document_ref = ${ref} WHERE id = ${id}::uuid`)
  return { id, ref }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  await db.execute(
    drizzleSql`UPDATE kernel.organizations SET timezone = 'UTC' WHERE id = ${orgId}::uuid`,
  )
  owner = await minimal.adminSession(orgId)
  await registerInvoicing(orgId)
  const b = await minimal.session(orgId, { role: "member" })
  biller = b.userId
  for (const s of BILLER_SCOPES) await minimal.grantScope(biller, s)
  world = {
    orgId,
    owner,
    projectId: "",
    tasks: {},
    threadId: await minimal.agentDm(orgId, owner.userId),
  }
  project.daily = await newProject("Maison Alpine data", "daily")
  project.hourly = await newProject("Maison Rhone portal", "hourly")
  project.retainer = await newProject("Maison Sorel upkeep", "retainer")
  project.fixed = await newProject("Maison Marlin rebuild", "fixed")
  project.fixed2 = await newProject("Maison Verdier routes", "fixed")
}, 180_000)

afterAll(async () => {
  if (world) forgetClaimsWorld(world)
  await releaseTestLock()
})

describe("the month line on Home", () => {
  it("the month line opens the asker's proposed card", async () => {
    const thread = await minimal.thread(orgId, biller)
    await seedReconciliation(orgId, {
      now: new Date(),
      projectId: project.daily!,
      createdBy: biller,
      threadId: thread,
      state: "proposed",
      month: "2027-07",
      idleDays: 0,
    })
    const [line] = monthLines(await homeOf(biller, "2027-07-30"), project.daily!)
    expect(line?.action).toEqual({ type: "open_entity", tabType: "thread", entityId: thread })
    expect(line?.metadata?.link).toEqual({ tabType: "thread", entityId: thread })
    // Another month's card is not this month's.
    const [august] = monthLines(await homeOf(biller, "2027-08-30"), project.daily!)
    expect(august?.action).toEqual({
      type: "open_entity",
      tabType: "projects:project",
      entityId: project.daily,
    })
  })

  it("another biller's month line opens the project", async () => {
    // A proposed card is its creator's alone: the owner's card is not the biller's to open.
    await seedReconciliation(orgId, {
      now: new Date(),
      projectId: project.hourly!,
      createdBy: owner.userId,
      threadId: await minimal.thread(orgId, owner.userId),
      state: "proposed",
      month: "2027-07",
      idleDays: 0,
      basis: "hourly",
    })
    const [line] = monthLines(await homeOf(biller, "2027-07-30"), project.hourly!)
    expect(line?.action).toEqual({
      type: "open_entity",
      tabType: "projects:project",
      entityId: project.hourly,
    })
    expect(line?.metadata?.link).toBeUndefined()
  })

  it("a released draft brings the month line back", async () => {
    const day = "2027-09-29"
    const drafted = await draftedMonth(project.daily!, "2027-09")
    await waitingDraft({
      projectId: project.daily!,
      externalRef: drafted.ref,
      latestOn: "2027-09-30",
    })
    const before = await moneyByProject(await homeOf(biller, day))
    // The month line became the draft's issue approval: one item.
    expect(before.get(project.daily!)?.map((i) => i.kind)).toEqual(["approval_pending"])

    // The draft is discarded: no document carries the key, and the month is released.
    await db.execute(drizzleSql`
      DELETE FROM app_invoicing.documents WHERE org_id = ${orgId}::uuid
         AND external_ref = ${drafted.ref}`)
    await db.execute(drizzleSql`
      UPDATE kernel.approval_requests SET status = 'cancelled'
       WHERE org_id = ${orgId}::uuid AND tool_name = 'invoicing:invoice_issue'
         AND status = 'pending'`)
    const out = await withRlsContext(actorOf(biller, BILLER_SCOPES), (tx) =>
      reconcileMark({ tx, orgId, input: { reconciliationId: drafted.id, to: "released" } }),
    )
    expect(out.state).toBe("proposed")
    const after = await moneyByProject(await homeOf(biller, day))
    expect(after.get(project.daily!)?.map((i) => i.kind as string)).toEqual([MONTH_CLOSE_KIND])
  })

  it("a draft released for a newer card of the same person brings the month line back", async () => {
    const day = "2027-11-29"
    const drafted = await draftedMonth(project.hourly!, "2027-11")
    expect(monthLines(await homeOf(biller, day), project.hourly!)).toEqual([])
    // The same person asked again: a newer proposed card of the same period.
    await seedReconciliation(orgId, {
      now: new Date(),
      projectId: project.hourly!,
      createdBy: biller,
      threadId: await minimal.thread(orgId, biller),
      state: "proposed",
      month: "2027-11",
      idleDays: 0,
      basis: "hourly",
    })
    const out = await withRlsContext(actorOf(biller, BILLER_SCOPES), (tx) =>
      reconcileMark({ tx, orgId, input: { reconciliationId: drafted.id, to: "released" } }),
    )
    expect(out.state).toBe("superseded")
    expect(monthLines(await homeOf(biller, day), project.hourly!)).toHaveLength(1)
  })

  it("a retainer month end is one line and drafts nothing before a person reconciles", async () => {
    // October 2027 ends on a Sunday: the line's day is Friday the 29th.
    const days = ["2027-10-27", "2027-10-28", "2027-10-29", "2027-10-30", "2027-11-01"]
    const shown: string[] = []
    for (const d of days) {
      const items = (await moneyByProject(await homeOf(biller, d))).get(project.retainer!) ?? []
      expect(items.length).toBeLessThanOrEqual(1)
      if (items.length === 1) shown.push(`${d}:${items[0]!.kind}`)
    }
    expect(shown).toEqual([`2027-10-29:${MONTH_CLOSE_KIND}`])
    // Nobody pressed Reconcile: nothing was drafted for the month.
    const docs = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM app_invoicing.documents
         WHERE org_id = ${orgId}::uuid AND billing_project_id = ${project.retainer}::uuid`),
    )
    expect(docs[0]?.n).toBe(0)
  })
})

describe("a draft waiting on its latest issue day", () => {
  it("the day a draft comes back to the top is the org's own day, not the UTC one", async () => {
    // Noon UTC on 26 March is already 27 March in Auckland: four days before the 31st there.
    await db.execute(
      drizzleSql`UPDATE kernel.organizations SET timezone = 'Pacific/Auckland' WHERE id = ${orgId}::uuid`,
    )
    try {
      const waiting = await waitingDraft({
        projectId: project.fixed!,
        externalRef: "milestone:zone-test",
        latestOn: "2028-03-31",
      })
      const urgency = async (day: string) =>
        (await homeOf(biller, day)).find((i) => i.entityId === waiting.approvalId)?.urgency
      expect(await urgency("2028-03-25")).toBe(60)
      expect(await urgency("2028-03-26")).toBe(90)
      await db.execute(drizzleSql`
        UPDATE kernel.approval_requests SET status = 'cancelled' WHERE id = ${waiting.approvalId}::uuid`)
    } finally {
      await db.execute(
        drizzleSql`UPDATE kernel.organizations SET timezone = 'UTC' WHERE id = ${orgId}::uuid`,
      )
    }
  })

  it("a draft four days before its latest day comes back to the top", async () => {
    const waiting = await waitingDraft({
      projectId: project.fixed!,
      externalRef: "milestone:clock-test",
      latestOn: "2028-03-31",
    })
    // An ordinary request asked later sorts above it until the draft's day comes near.
    const other = await createHandlerApprovalRequest({
      orgId,
      requestedBy: biller,
      actorScopes: [...BILLER_SCOPES, "invoicing:*"],
      defaultAppName: "invoicing",
      origin: "in-app-agent",
      input: {
        tool_name: "invoicing:invoice_issue",
        summary: "Issue an invoice with no latest day",
        current_payload: { draft_id: crypto.randomUUID() },
        approve_scope: "invoicing:documents:write",
        expiry_hours: 720,
      },
    })
    const order = async (day: string) =>
      (await homeOf(biller, day))
        .filter((i) => i.kind === "approval_pending")
        .filter((i) => i.entityId === waiting.approvalId || i.entityId === other.approval_id)
        .map((i) => [i.entityId === waiting.approvalId ? "draft" : "other", i.urgency])
    expect(await order("2028-03-26")).toEqual([
      ["other", 60],
      ["draft", 60],
    ])
    for (const d of ["2028-03-27", "2028-03-31", "2028-04-02"]) {
      expect({ d, order: await order(d) }).toEqual({
        d,
        order: [
          ["draft", 90],
          ["other", 60],
        ],
      })
    }
    const [item] = (await homeOf(biller, "2028-03-27")).filter(
      (i) => i.entityId === waiting.approvalId,
    )
    expect(item?.metadata?.latestOn).toBe("2028-03-31")
    await db.execute(drizzleSql`
      UPDATE kernel.approval_requests SET status = 'cancelled'
       WHERE id IN (${waiting.approvalId}::uuid, ${String(other.approval_id)}::uuid)`)
  })

  it("a client's open approval of the milestone holds nothing: four days before its latest day the draft is back on top", async () => {
    const { mintClientAction } = await import("~/modules/client-actions/mint")
    const milestone = await call<{ id: string }>("projects_createTask", {
      projectId: project.fixed!,
      title: "Design signed off",
      isMilestone: true,
    })
    // A real link, sent to the client and still open: nobody has approved or declined it.
    const action = await mintClientAction({
      orgId,
      kind: "approve",
      targetApp: "projects",
      targetType: "milestone",
      targetId: milestone.id,
      invitedEmail: "client@maison-marlin.example.com",
      invitedName: "Client Marlin",
      expiresInDays: 30,
      createdByUserId: owner.userId,
    })
    expect(action.status).toBe("open")
    const waiting = await waitingDraft({
      projectId: project.fixed!,
      externalRef: `milestone:${milestone.id}`,
      latestOn: "2028-03-31",
    })
    const urgency = async (day: string) =>
      (await homeOf(biller, day)).find((i) => i.entityId === waiting.approvalId)?.urgency
    expect(await urgency("2028-03-26")).toBe(60)
    expect(await urgency("2028-03-27")).toBe(90)
    const [open] = extractRows<{ decided_at: string | null; revoked_at: string | null }>(
      await db.execute(drizzleSql`
        SELECT decided_at::text, revoked_at::text FROM kernel.client_actions WHERE id = ${action.id}::uuid`),
    )
    expect(open).toEqual({ decided_at: null, revoked_at: null })
    await db.execute(drizzleSql`
      UPDATE kernel.approval_requests SET status = 'cancelled' WHERE id = ${waiting.approvalId}::uuid`)
  })

  it("a draft created late raises no second item", async () => {
    // Reconciled in the next month's first days: the draft is late from its creation.
    for (const [month, last, after] of [
      ["2026-11", "2026-11-30", "2026-12-01"],
      ["2026-12", "2026-12-31", "2027-01-01"],
    ] as const) {
      const drafted = await draftedMonth(project.fixed2!, month)
      const { approvalId } = await waitingDraft({
        projectId: project.fixed2!,
        externalRef: drafted.ref,
        latestOn: last,
      })
      for (const d of [last, after]) {
        const items = (await moneyByProject(await homeOf(biller, d))).get(project.fixed2!) ?? []
        expect({ d, kinds: items.map((i) => [i.kind, i.urgency]) }).toEqual({
          d,
          kinds: [["approval_pending", 90]],
        })
      }
      await db.execute(drizzleSql`
        UPDATE kernel.approval_requests SET status = 'cancelled' WHERE id = ${approvalId}::uuid`)
    }
  })
})

describe("the bundling bar", () => {
  it("a month with three projects drafted, a milestone and an advance adds no line per invoice line", async () => {
    const month = "2028-06"
    const day = "2028-06-29"
    const before = await homeOf(biller, day)
    const beforeMoney = await moneyByProject(before)
    // Before: three month lines (daily, hourly, retainer), nothing for the two fixed projects.
    expect(
      [project.daily, project.hourly, project.retainer].map((p) => beforeMoney.get(p!)?.length),
    ).toEqual([1, 1, 1])
    const parked: string[] = []
    for (const p of [project.daily!, project.hourly!, project.retainer!]) {
      const drafted = await draftedMonth(p, month)
      parked.push(
        (
          await waitingDraft({
            projectId: p,
            externalRef: drafted.ref,
            latestOn: "2028-06-30",
            lines: 6,
          })
        ).approvalId,
      )
    }
    parked.push(
      (
        await waitingDraft({
          projectId: project.fixed!,
          externalRef: "milestone:bar-beta",
          latestOn: "2028-06-30",
          lines: 3,
        })
      ).approvalId,
    )
    parked.push(
      (
        await waitingDraft({
          projectId: project.fixed2!,
          externalRef: "advance:bar-advance",
          latestOn: "2028-06-30",
          lines: 2,
        })
      ).approvalId,
    )
    const after = await homeOf(biller, day)
    const afterMoney = await moneyByProject(after)
    // After: one item per project (the five issue approvals), 19 invoice lines among them.
    expect([...afterMoney.values()].map((list) => list.length)).toEqual([1, 1, 1, 1, 1])
    expect([...afterMoney.values()].flat().every((i) => i.kind === "approval_pending")).toBe(true)
    expect(after.length - before.length).toBe(5 - 3)
    await db.execute(drizzleSql`
      UPDATE kernel.approval_requests SET status = 'cancelled'
       WHERE id IN (${drizzleSql.join(
         parked.map((id) => drizzleSql`${id}::uuid`),
         drizzleSql`, `,
       )})`)
  })
})

// Shared: the issue scope set is what a person who issues holds.
void ISSUE_SCOPES
