// SPDX-License-Identifier: FSL-1.1-ALv2
//
// No minute lost, none billed twice. Random projects on the real database: task trees, planned and
// not, closed and reopened, moved under each other; time added late, moved between tasks, reduced
// and deleted; lines billed, set to 0, raised, left out; two cards; credits; billing changed between
// hourly, daily, a retainer and a fixed price. After every step, for the project:
//
//   entered = counted by a live claim + left off + inside a fee or a price + still offered
//
// read from the tables with the rules written again here, never with the code under test. A line
// billed by its time claims exactly the minutes it shows, and all the lines together never bill more
// minutes than were ever entered.
//
// Seeds are fixed. A longer run: LIAISON_CONSERVATION_SEEDS=200 (per profile), and
// LIAISON_CONSERVATION_FROM=1000 to start elsewhere, LIAISON_CONSERVATION_PROFILE=trees for one.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { projectsAppManifest } from "~/apps/projects/manifest-descriptor"
import { extractRows, type RlsClient } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { insertAppRow } from "~/seed/factories/app-tables"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { CardMinutesMoved, refreshCardMinutes, reserveClaims } from "./claims"
import { reconcileFacts, reconcileLineUpdate, reconcilePropose } from "./reconcile"
import { awaitTimeFeatureSync } from "./time-feature"

const SEEDS = Number(process.env.LIAISON_CONSERVATION_SEEDS ?? 0)
const FROM = Number(process.env.LIAISON_CONSERVATION_FROM ?? 1)
const ONLY = process.env.LIAISON_CONSERVATION_PROFILE
/** Only the rule of a plan worked inside a fee: what an older build breaks first hides it. */
const PLANS_ONLY = process.env.LIAISON_CONSERVATION_PLANS === "1"

type Basis = "hourly" | "daily" | "retainer" | "fixed"
type Card = Record<string, any>

interface Profile {
  name: string
  /** The seeds CI runs: among them, ones each rule's absence turned red. */
  seeds: number[]
  months: number
  steps: number
  bases: Basis[]
  trees?: boolean
  plans?: boolean
  zeros?: boolean
  moves?: boolean
  credits?: boolean
  raises?: boolean
  twoCards?: boolean
  switches?: boolean
  open?: boolean
  archives?: boolean
}

/** Each profile turns on one family of trouble; `all` turns on everything. */
const PROFILES: Profile[] = [
  {
    name: "late and zero lines",
    seeds: [1, 2],
    months: 3,
    steps: 6,
    bases: ["hourly", "daily"],
    zeros: true,
  },
  {
    name: "trees",
    seeds: [1, 2, 3],
    months: 3,
    steps: 7,
    bases: ["hourly", "daily"],
    trees: true,
    open: true,
  },
  {
    name: "retainer credits",
    seeds: [1, 7, 10],
    months: 3,
    steps: 6,
    bases: ["retainer"],
    zeros: true,
    credits: true,
    open: true,
  },
  {
    name: "moved time",
    seeds: [3, 5, 11],
    months: 3,
    steps: 7,
    bases: ["hourly", "retainer"],
    moves: true,
    open: true,
  },
  {
    name: "plans inside a fee",
    seeds: [10, 16],
    months: 3,
    steps: 6,
    bases: ["retainer"],
    plans: true,
    switches: true,
    open: true,
  },
  {
    name: "open work before a retainer",
    seeds: [2, 4, 6],
    months: 3,
    steps: 6,
    bases: ["hourly"],
    switches: true,
    open: true,
  },
  {
    name: "all",
    seeds: [1, 2, 3, 4, 5, 6],
    months: 4,
    steps: 8,
    bases: ["hourly", "daily", "retainer"],
    trees: true,
    plans: true,
    zeros: true,
    moves: true,
    credits: true,
    raises: true,
    twoCards: true,
    switches: true,
    open: true,
    archives: true,
  },
]

let orgId = ""
let a = ""
let b = ""
let n = 0

const actor = (userId: string): UserContext => ({
  actorType: "user",
  userId,
  orgId,
  scopes: ["*"],
  dimensionGrants: { "*": ["*"] },
})
const as = <T>(userId: string, fn: (tx: RlsClient) => Promise<T>) =>
  withRlsContext(actor(userId), fn as never) as Promise<T>
const rows = async <T>(q: ReturnType<typeof drizzleSql>) => extractRows<T>(await db.execute(q))

async function call<T = Card>(method: string, input: unknown): Promise<T> {
  return as(a, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      a,
      orgId,
      tx as never,
      projectsAppManifest as never,
      ["*"],
      "user",
      undefined,
      { origin: "human-ui" } as never,
    )
    return JSON.parse(await (bridge as any)[method](JSON.stringify(input))) as T
  })
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  await db.execute(
    drizzleSql`UPDATE kernel.organizations SET timezone = 'UTC' WHERE id = ${orgId}::uuid`,
  )
  a = (await minimal.adminSession(orgId)).userId
  b = (await minimal.session(orgId, { role: "admin" })).userId
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
}, 120_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

const monthAt = (i: number) => `2026-${String(i + 1).padStart(2, "0")}`

interface Task {
  id: string
  parent: string | null
  closed: string | null
  plan: number | null
  archived: boolean
}

class World {
  x: number
  project = ""
  key = ""
  basis: Basis
  tasks: Task[] = []
  month = 0
  schedules = 0
  /** The most minutes each month ever held: no set of lines may bill more. */
  ever = new Map<string, number>()
  /** Minutes a person billed above what a line showed. */
  raised = 0
  log: string[] = []
  /** The months under a fixed price. */
  fixed = new Set<string>()

  constructor(
    readonly p: Profile,
    readonly seed: number,
  ) {
    this.x = (seed * 2654435761) >>> 0
    this.basis = this.pick(p.bases)
  }

  rand(k: number): number {
    this.x = (Math.imul(this.x ^ (this.x >>> 15), 2246822519) + 0x9e3779b9) >>> 0
    return ((this.x ^ (this.x >>> 13)) >>> 0) % k
  }
  pick<T>(of: readonly T[]): T {
    return of[this.rand(of.length)] as T
  }
  say(s: string) {
    this.log.push(s)
  }
  get live() {
    return this.tasks.filter((t) => !t.archived)
  }

  async start() {
    n++
    this.key = `CS${n}`
    this.project = (
      await call<{ id: string }>("projects_createProject", {
        name: `Conservation ${n}`,
        key: this.key,
        timeBudgets: true,
      })
    ).id
    await awaitTimeFeatureSync(orgId)
    await call("projects_billingTermsSet", { projectId: this.project, rate: 90, currency: "EUR" })
    await this.setBasis(this.basis)
  }

  async setBasis(basis: Basis) {
    this.basis = basis
    if (basis === "fixed") this.fixed.add(monthAt(this.month))
    this.say(`billing ${basis} from ${monthAt(this.month)}`)
    await call("projects_timePlanSet", { projectId: this.project, basis })
    if (basis === "retainer") this.schedules++
  }

  async task(opts: { closed?: string | null; plan?: number | null; parent?: string | null }) {
    const { id } = await call<{ id: string }>("projects_createTask", {
      projectId: this.project,
      title: `T${this.tasks.length}`,
      statusLabel: "todo",
      ...(opts.parent ? { parentTaskId: opts.parent } : {}),
    })
    const t: Task = {
      id,
      parent: opts.parent ?? null,
      closed: null,
      plan: opts.plan ?? null,
      archived: false,
    }
    this.tasks.push(t)
    if (t.plan) await this.plan(t, t.plan)
    if (opts.closed) await this.close(t, opts.closed)
    this.say(
      `${this.name(t)} made${t.parent ? ` under ${this.name(this.byId(t.parent))}` : ""}${t.plan ? ` plan ${t.plan}` : ""}${t.closed ? ` closed ${t.closed}` : ""}`,
    )
    return t
  }
  byId(id: string) {
    return this.tasks.find((t) => t.id === id) as Task
  }
  name(t: Task) {
    return `T${this.tasks.indexOf(t)}`
  }
  async plan(t: Task, minutes: number | null) {
    t.plan = minutes
    await db.execute(
      drizzleSql`UPDATE app_projects.tasks SET timebox_minutes = ${minutes} WHERE id = ${t.id}::uuid`,
    )
  }
  async close(t: Task, on: string | null) {
    t.closed = on
    await db.execute(
      drizzleSql`UPDATE app_projects.tasks SET completed_at = ${on ? `${on} 10:00+00` : null}::timestamptz WHERE id = ${t.id}::uuid`,
    )
  }
  async enter(t: Task, on: string, minutes: number) {
    this.say(`${this.name(t)} +${minutes} on ${on}`)
    await insertAppRow(db as never, "projects", "task_time", {
      id: crypto.randomUUID(),
      org_id: orgId,
      task_id: t.id,
      project_id: this.project,
      work_date: on,
      minutes,
      entered_via: "field",
    })
    await this.notice()
  }
  async notice() {
    const all = await rows<{ month: string; m: number }>(drizzleSql`
      SELECT to_char(work_date, 'YYYY-MM') AS month, sum(minutes)::int AS m
        FROM app_projects.task_time WHERE project_id = ${this.project}::uuid GROUP BY 1`)
    for (const { month, m } of all)
      this.ever.set(month, Math.max(this.ever.get(month) ?? 0, Number(m)))
  }
  day(i = this.month) {
    return `${monthAt(i)}-${String(1 + this.rand(28)).padStart(2, "0")}`
  }
  minutes() {
    return 30 * (1 + this.rand(10))
  }

  /** One random thing that happens on the project. */
  async happen() {
    const p = this.p
    const roll = this.rand(100)
    const alive = this.live
    const t = alive.length > 0 ? this.pick(alive) : null
    if (!t || roll < 22) {
      const parent = p.trees && alive.length > 0 && this.rand(2) === 0 ? this.pick(alive).id : null
      const made = await this.task({
        closed: !p.open || this.rand(3) > 0 ? this.day() : null,
        plan: p.plans && this.rand(3) === 0 ? 60 * (1 + this.rand(8)) : null,
        parent,
      })
      if (this.rand(4) > 0) await this.enter(made, this.day(), this.minutes())
      return
    }
    // Late time: any month up to now, on any task.
    if (roll < 50) return this.enter(t, this.day(this.rand(this.month + 1)), this.minutes())
    if (roll < 62) {
      if (t.closed && p.open && this.rand(3) === 0) {
        this.say(`${this.name(t)} reopened`)
        return this.close(t, null)
      }
      if (!t.closed) {
        const on = this.day()
        this.say(`${this.name(t)} closed ${on}`)
        return this.close(t, on)
      }
      return
    }
    if (p.moves && roll < 78) return this.moveTime(t)
    if (p.trees && roll < 84) return this.reparent(t)
    if (p.plans && roll < 87 && !t.plan) {
      const m = 60 * (1 + this.rand(6))
      this.say(`${this.name(t)} given a plan of ${m}`)
      return this.plan(t, m)
    }
    if (p.archives && roll < 89 && !this.live.some((k) => k.parent === t.id)) {
      const held = await this.claims()
      if (!held.some((c) => c.task === t.id)) {
        this.say(`${this.name(t)} archived`)
        t.archived = true
        await db.execute(
          drizzleSql`UPDATE app_projects.tasks SET archived_at = now() WHERE id = ${t.id}::uuid`,
        )
      }
    }
  }

  /** Time moved to another task the same day, reduced, or deleted. */
  async moveTime(t: Task) {
    // Not off a task something was left off: what was left off then shrinks with it.
    const left = (await this.claims()).filter((c) => c.state === "left_off").map((c) => c.task)
    if (left.includes(t.id)) return
    const of = await rows<{ id: string; minutes: number; on: string }>(drizzleSql`
      SELECT id::text AS id, minutes, work_date::text AS "on" FROM app_projects.task_time
       WHERE task_id = ${t.id}::uuid ORDER BY work_date, minutes, created_at LIMIT 5`)
    if (of.length === 0) return
    const e = this.pick(of)
    const kind = this.rand(4)
    const to = this.pick(this.live)
    if (kind === 0) {
      this.say(`${this.name(t)} -${e.minutes} of ${e.on} deleted`)
      await db.execute(drizzleSql`DELETE FROM app_projects.task_time WHERE id = ${e.id}::uuid`)
      return
    }
    if (kind === 1 && e.minutes > 30) {
      const less = 30 * (1 + this.rand(e.minutes / 30 - 1))
      this.say(`${this.name(t)} -${less} of ${e.on}`)
      await db.execute(
        drizzleSql`UPDATE app_projects.task_time SET minutes = minutes - ${less} WHERE id = ${e.id}::uuid`,
      )
      return
    }
    if (to.id === t.id) return
    this.say(`${e.minutes} of ${e.on} moved ${this.name(t)} -> ${this.name(to)}`)
    await db.execute(
      drizzleSql`UPDATE app_projects.task_time SET task_id = ${to.id}::uuid WHERE id = ${e.id}::uuid`,
    )
  }

  async reparent(t: Task) {
    const under = (id: string): string[] =>
      this.tasks.filter((k) => k.parent === id).flatMap((k) => [k.id, ...under(k.id)])
    const barred = new Set([t.id, ...under(t.id)])
    const to = this.rand(3) === 0 ? null : this.pick(this.live)
    if (to && barred.has(to.id)) return
    t.parent = to?.id ?? null
    this.say(`${this.name(t)} moved under ${to ? this.name(to) : "nothing"}`)
    await db.execute(
      drizzleSql`UPDATE app_projects.tasks SET parent_task_id = ${t.parent}::uuid WHERE id = ${t.id}::uuid`,
    )
  }

  // ── Cards ─────────────────────────────────────────────────────────────────

  propose(userId: string, i: number, lines: unknown[] = [], excluded: unknown[] = []) {
    return as(userId, (tx) =>
      reconcilePropose({
        tx: tx as never,
        orgId,
        userId,
        scopes: ["*"],
        input: { project: this.key, month: monthAt(i), lines, excluded },
      }),
    ) as Promise<Card>
  }

  /** The card a month would have now, nothing stored. */
  async dry(i: number): Promise<{ card: Card; byHand: string | null; told: Set<string> }> {
    let told = new Set<string>()
    let card: Card | null = null
    let byHand: string | null = null
    await as(b, async (tx) => {
      card = (await reconcilePropose({
        tx: tx as never,
        orgId,
        userId: b,
        scopes: ["*"],
        input: { project: this.key, month: monthAt(i), lines: [] },
      })) as Card
      const facts = (await reconcileFacts({
        tx: tx as never,
        orgId,
        userId: b,
        scopes: ["*"],
        input: { project: this.key, month: monthAt(i) },
      })) as Card
      byHand = facts.billByHand ?? null
      told = new Set((facts.unbilledEarlier as Card[]).map((t) => t.id))
      card.stored = extractRows(
        await tx.execute(drizzleSql`
          SELECT id::text AS id, work_month, kind, planned_minutes AS planned, real_minutes AS real,
                 bill_minutes AS bill, task_ids::text[] AS tasks, to_jsonb(l)->'counting' AS less
            FROM app_projects.reconciliation_lines l
           WHERE reconciliation_id = ${card.reconciliationId}::uuid ORDER BY position`),
      )
      throw new Rollback()
    }).catch((e) => {
      if (!(e instanceof Rollback)) throw e
    })
    return { card: card as unknown as Card, byHand, told }
  }

  /** The lines an agent would send: some of the month's tasks by name, the rest left to the card. */
  async draw(userId: string, i: number): Promise<Card> {
    const facts = (await as(userId, (tx) =>
      reconcileFacts({
        tx: tx as never,
        orgId,
        userId,
        scopes: ["*"],
        input: { project: this.key, month: monthAt(i) },
      }),
    )) as Card
    const whole = new Set(
      (await this.claims()).filter((c) => c.key.startsWith("all")).map((c) => c.task),
    )
    const free = (facts.tasks as Card[]).filter(
      (t) => !whole.has(t.id) || t.id === this.anchors.get(i),
    )
    const lines = free
      .filter((t) => this.rand(5) > 0 || t.id === this.anchors.get(i))
      .map((t, k) => ({ name: `Line ${k}`, taskIds: [t.id], proofs: [] }))
    const out =
      this.p.zeros && this.rand(4) === 0
        ? free.filter((t) => !lines.some((l) => l.taskIds[0] === t.id)).slice(0, 1)
        : []
    // Some tasks on one line together.
    if (lines.length > 2 && this.rand(3) === 0) {
      const last = lines.pop()!
      lines[0]!.taskIds.push(...last.taskIds)
    }
    const card = await this.propose(
      userId,
      i,
      lines,
      out.map((t) => ({ taskId: t.id, reason: "client_own" })),
    )
    await this.checkPlans(card, i)
    return card
  }

  async edit(userId: string, card: Card): Promise<Card> {
    let now = card
    if (card.state !== "proposed") return card
    for (const l of card.lines as Card[]) {
      const line = now.lines.find((k: Card) => k.lineId === l.lineId)
      if (!line || line.plannedMinutes) continue
      const roll = this.rand(10)
      let bill: string | null = null
      if (this.p.zeros && roll === 0) bill = "0"
      if (this.p.raises && roll === 1) bill = `${line.realMinutes + 60} min`
      if (bill === null) continue
      this.say(
        `line "${line.name}" set to ${bill} (shows ${line.realMinutes}, bills ${line.billMinutes})`,
      )
      if (bill !== "0") this.raised += line.realMinutes + 60 - line.billMinutes
      now = (await as(userId, (tx) =>
        reconcileLineUpdate({
          tx: tx as never,
          orgId,
          userId,
          scopes: ["*"],
          input: {
            reconciliationId: now.reconciliationId,
            revision: now.revision,
            lineId: line.lineId,
            bill: bill === "0" ? 0 : bill,
          },
        }),
      )) as Card
    }
    return now
  }

  /** Create on a card, brought up to date as the product does when its minutes moved. */
  async create(userId: string, card: Card, i: number): Promise<"made" | "already_on" | "empty"> {
    const id = card.reconciliationId as string
    for (let tries = 0; tries < 4; tries++) {
      const head = (
        await rows<{ revision: number; state: string; billed: number }>(drizzleSql`
          SELECT r.revision, r.state,
                 (SELECT count(*)::int FROM app_projects.reconciliation_lines l
                   WHERE l.reconciliation_id = r.id AND l.bill_minutes > 0) AS billed
            FROM app_projects.reconciliations r WHERE r.id = ${id}::uuid`)
      )[0]
      if (head?.state !== "proposed") return "made"
      if (this.basis !== "retainer" && Number(head.billed) === 0) {
        // Nothing to bill: a person bills the month's own task.
        this.say(`card of ${monthAt(i)} bills nothing: its own task is billed`)
        await db.execute(drizzleSql`
          UPDATE app_projects.reconciliation_lines SET bill_minutes = greatest(real_minutes, 60)
           WHERE reconciliation_id = ${id}::uuid AND coalesce(planned_minutes, 0) = 0
             AND task_ids @> ARRAY[${this.anchors.get(i) ?? null}]::uuid[]`)
        const billed = await rows<{ m: number }>(drizzleSql`
          SELECT coalesce(sum(bill_minutes), 0)::int AS m
            FROM app_projects.reconciliation_lines WHERE reconciliation_id = ${id}::uuid`)
        this.raised += Number(billed[0]?.m)
        if (Number(billed[0]?.m) === 0) return "empty"
      }
      const ref =
        this.basis === "retainer" ? `retainer:s${this.schedules}:${monthAt(i)}` : `reconcile:${id}`
      try {
        await as(userId, (tx) =>
          reserveClaims(tx as never, {
            orgId,
            reconciliationId: id,
            documentRef: ref,
            revision: Number(head.revision),
          }),
        )
      } catch (err) {
        if (err instanceof CardMinutesMoved) {
          this.say(
            `card of ${monthAt(i)} moved: ${err.lines.map((l) => `${l.name} ${l.was}->${l.now}`).join(", ")}`,
          )
          await as(userId, (tx) =>
            refreshCardMinutes(tx as never, { orgId, reconciliationId: id, moved: err.lines }),
          )
          continue
        }
        if ((err as { code?: string }).code === "already_on") {
          this.say(`card of ${monthAt(i)}: ${(err as Error).message}`)
          return "already_on"
        }
        throw err
      }
      await db.execute(drizzleSql`
        UPDATE app_projects.reconciliations
           SET state = 'drafted', drafted_at = now(), drafted_by = ${userId}::uuid
         WHERE id = ${id}::uuid`)
      this.say(`card of ${monthAt(i)} made`)
      return "made"
    }
    throw new Error(`the card of ${monthAt(i)} never settled`)
  }

  /** A full credit note, as the mark and the sweep leave it. */
  async credit(id: string) {
    await db.execute(drizzleSql`
      UPDATE app_projects.billing_claims SET state = 'credited'
       WHERE reconciliation_id = ${id}::uuid AND state IN ('reserved', 'billed')`)
    await db.execute(
      drizzleSql`UPDATE app_projects.reconciliations SET state = 'credited' WHERE id = ${id}::uuid`,
    )
  }

  async invoiceMonth(i: number) {
    // The month always has a line to bill.
    if (this.basis !== "retainer" && this.basis !== "fixed") {
      const anchor = await this.task({ closed: this.day(i) })
      await this.enter(anchor, `${monthAt(i)}-15`, 60)
      this.anchors.set(i, anchor.id)
    }
    if (this.basis === "fixed") return
    const card = await this.edit(a, await this.draw(a, i))
    let other: Card | null = null
    if (this.p.twoCards && this.rand(3) === 0) other = await this.propose(b, i + 1, [])
    if (this.rand(2) === 0) await this.happen()
    await this.settle(a, card, i)
    if (other) {
      // The next month's card, drawn before this one was made.
      this.say("the other card")
      await this.settle(b, other, i + 1)
    }
    await this.check("after the card")
    if (this.p.credits && this.rand(2) === 0) {
      const made = await rows<{ id: string; from: string; basis: string }>(drizzleSql`
        SELECT id::text AS id, period_start::text AS "from", basis FROM app_projects.reconciliations
         WHERE project_id = ${this.project}::uuid AND state = 'drafted' ORDER BY period_start`)
      const back = made.length > 0 ? this.pick(made) : null
      if (back && back.basis === this.basis) {
        this.say(`card of ${back.from} credited`)
        await this.credit(back.id)
        const m = Number(back.from.slice(5, 7)) - 1
        await this.settle(a, await this.edit(a, await this.draw(a, m)), m)
        await this.check("after a credit and a new card")
      }
    }
  }
  /** The task of each month that is always on a line of its card. */
  anchors = new Map<number, string>()
  async settle(userId: string, card: Card, i: number) {
    for (let k = 0; k < 4; k++) {
      const out = await this.create(userId, k === 0 ? card : await this.propose(userId, i), i)
      if (out !== "already_on") return out
    }
    // All its work is on other cards since: there is nothing to make.
    this.say(`card of ${monthAt(i)} given up`)
    return "already_on"
  }

  /** A plan worked partly inside a fee bills the rest of it: checked on the lines as drawn. */
  async checkPlans(card: Card, i: number) {
    if (this.basis === "retainer" || this.basis === "fixed" || card.state !== "proposed") return
    const inside = await rows<{ task: string; m: number }>(drizzleSql`
      SELECT t.task_id::text AS task, sum(t.minutes)::int AS m
        FROM app_projects.task_time t
       WHERE t.project_id = ${this.project}::uuid
         AND to_char(t.work_date, 'YYYY-MM') IN (
           SELECT to_char(period_start, 'YYYY-MM') FROM app_projects.reconciliations
            WHERE project_id = ${this.project}::uuid AND basis = 'retainer'
              AND state IN ('drafted', 'invoiced'))
       GROUP BY 1`)
    const parentOf = new Map(this.tasks.map((t) => [t.id, t.parent]))
    const named = new Map<string, Card>()
    for (const l of card.lines as Card[]) for (const id of l.taskIds) named.set(id, l)
    const lineOf = (id: string): Card | undefined => {
      for (let k: string | null | undefined = id; k; k = parentOf.get(k)) {
        const l = named.get(k)
        if (l) return l
      }
      return undefined
    }
    for (const l of card.lines as Card[]) {
      if ((l.plannedMinutes ?? 0) === 0) continue
      const fee = inside.reduce((x, t) => x + (lineOf(t.task) === l ? Number(t.m) : 0), 0)
      const most = Math.max(0, Number(l.plannedMinutes) - fee)
      if (Number(l.billMinutes) > most)
        this.fail(
          `the card of ${monthAt(i)}`,
          `a plan of ${l.plannedMinutes} with ${fee} inside a fee bills ${l.billMinutes}`,
          l,
        )
    }
  }

  // ── The identity ──────────────────────────────────────────────────────────

  claims() {
    return rows<{
      task: string
      state: string
      key: string
      counted: number | null
      planned: number
      ahead: boolean
      line: string | null
    }>(drizzleSql`
      SELECT c.source_ref AS task, c.state, c.period_key AS key, c.counted_minutes AS counted,
             coalesce(l.planned_minutes, 0) AS planned, coalesce(l.real_minutes, 0) = 0 AS ahead,
             c.line_id::text AS line
        FROM app_projects.billing_claims c
        LEFT JOIN app_projects.reconciliation_lines l ON l.id = c.line_id
        LEFT JOIN app_projects.reconciliations r ON r.id = c.reconciliation_id
       WHERE c.project_id = ${this.project}::uuid AND c.source_kind = 'task'
         AND c.state IN ('reserved', 'billed', 'left_off') AND r.state IS DISTINCT FROM 'credited'`)
  }

  private fail(where: string, what: string, detail: unknown = ""): never {
    throw new Error(
      `${this.p.name}, seed ${this.seed}, ${where}: ${what}\n${JSON.stringify(detail)}\n${this.log.join("\n")}`,
    )
  }

  /** Where the project's minutes are, read from the tables; `next` is the card asked next. */
  async check(where: string) {
    if (PLANS_ONLY) return
    const claims = (await this.claims()).map((c) => ({
      ...c,
      counted: c.counted === null ? null : Number(c.counted),
    }))
    const time = (
      await rows<{ task: string; month: string; m: number }>(drizzleSql`
        SELECT task_id::text AS task, to_char(work_date, 'YYYY-MM') AS month, sum(minutes)::int AS m
          FROM app_projects.task_time WHERE project_id = ${this.project}::uuid GROUP BY 1, 2`)
    ).map((t) => ({ ...t, m: Number(t.m) }))
    const cards = await rows<{
      id: string
      basis: string
      from: string
      excluded: string[] | null
    }>(drizzleSql`
      SELECT id::text AS id, basis, to_char(period_start, 'YYYY-MM') AS "from",
             excluded_task_ids::text[] AS excluded
        FROM app_projects.reconciliations
       WHERE project_id = ${this.project}::uuid AND state IN ('drafted', 'invoiced')`)
    const made = await rows<{
      id: string
      basis: string
      month: string | null
      planned: number | null
      real: number
      bill: number
      tasks: string[]
      netted: number
    }>(drizzleSql`
      SELECT l.id::text AS id, r.basis, l.planned_minutes AS planned,
             coalesce(l.work_month, CASE WHEN r.basis = 'retainer'
               THEN to_char(r.period_start, 'YYYY-MM') END) AS month,
             l.real_minutes AS real, l.bill_minutes AS bill, l.task_ids::text[] AS tasks,
             coalesce((to_jsonb(l)->'counting'->>'netted')::int, 0) AS netted
        FROM app_projects.reconciliation_lines l
        JOIN app_projects.reconciliations r ON r.id = l.reconciliation_id
       WHERE r.project_id = ${this.project}::uuid AND r.state IN ('drafted', 'invoiced')`)

    // A line billed by its time claims the minutes it shows, no more and no less.
    for (const l of made) {
      if ((l.planned ?? 0) > 0) continue
      const of = claims.filter((c) => c.line === l.id)
      const counted = of.reduce((s, c) => s + (c.counted ?? 0), 0)
      const shows = l.real > 0 ? l.real : l.bill
      // Left off, some of it may be back on a line that named its task since.
      const back = l.bill === 0 && counted < shows
      if (of.length > 0 && counted !== shows && !back)
        this.fail(where, `a line shows ${shows} and its claims count ${counted}`, { l, of })
    }
    // The lines never bill more minutes than there ever were, a retainer month's apart.
    const billsOf = (of: typeof made) => of.reduce((x, l) => x + Number(l.bill), 0)
    const byTime = made.filter((l) => (l.planned ?? 0) === 0)
    const everAll = [...this.ever.values()].reduce((x, y) => x + y, 0)
    if (billsOf(byTime) > everAll + this.raised)
      this.fail(where, `${billsOf(byTime)} minutes billed by time, ${everAll} ever entered`, made)
    for (const month of new Set(byTime.map((l) => l.month).filter((m) => m !== null))) {
      const bills = billsOf(byTime.filter((l) => l.month === month))
      const there = this.ever.get(month as string) ?? 0
      if (bills > there + this.raised)
        this.fail(where, `${bills} minutes of ${month} billed, ${there} ever entered`, made)
    }

    let next = this.month
    while (cards.some((c) => c.from === monthAt(next))) next++
    const fee = new Set(cards.filter((c) => c.basis === "retainer").map((c) => c.from))
    const monthOf = (key: string) => key.split("+")[0] as string
    const bucketOf = (key: string) =>
      key.startsWith("all") || !fee.has(monthOf(key)) ? "all" : monthOf(key)
    const buckets = ["all", ...fee]
    // A retainer's own month is that card's, whatever its tasks were billed by before.
    const ownMonth = this.basis === "retainer" ? monthAt(next) : null
    const excluded = new Set(cards.flatMap((c) => c.excluded ?? []))
    const parentOf = new Map(this.tasks.map((t) => [t.id, t.parent]))
    const above = (id: string) => {
      const out = [id]
      for (let p = parentOf.get(id); p && !out.includes(p); p = parentOf.get(p)) out.push(p)
      return out
    }
    const priced = new Set(
      claims
        .filter((c) => c.counted === null && c.state !== "left_off" && c.planned > 0)
        .map((c) => c.task),
    )
    const { card, byHand, told } = await this.dry(next)
    const lines = card.stored as Array<{
      work_month: string | null
      kind: string
      planned: number | null
      real: number
      bill: number
      tasks: string[]
      less: { netted?: number; plan?: number; later?: boolean } | null
    }>
    const pending = new Map<string, Map<string, number>>()
    const over = new Map<string, number>()
    const surplusOf = new Map<string, number>()
    for (const bucket of buckets) {
      const of = new Map<string, number>()
      pending.set(bucket, of)
      let o = 0
      for (const t of this.tasks) {
        const entered = time
          .filter(
            (e) =>
              e.task === t.id &&
              (bucket === "all" ? !fee.has(e.month) && e.month !== ownMonth : e.month === bucket),
          )
          .reduce((s, e) => s + e.m, 0)
        const mine = claims.filter((c) => c.task === t.id && bucketOf(c.key) === bucket)
        const held = mine.filter((c) => c.state !== "left_off")
        const live = held.reduce((s, c) => s + (c.counted ?? 0), 0)
        const ahead = held.filter((c) => c.ahead).reduce((s, c) => s + (c.counted ?? 0), 0)
        const left = mine
          .filter((c) => c.state === "left_off")
          .reduce((s, c) => s + (c.counted ?? 0), 0)
        o += Math.max(0, live - ahead - entered)
        if (bucket === "all") surplusOf.set(t.id, Math.max(0, live - entered))
        const open = Math.max(0, entered - live - left)
        if (open === 0 || t.archived) continue
        if (bucket === "all" && above(t.id).some((k) => priced.has(k))) continue
        of.set(t.id, open)
      }
      const used = made
        .filter((l) => (l.month && fee.has(l.month) ? l.month : "all") === bucket)
        .reduce((s, l) => s + Number(l.netted), 0)
      over.set(bucket, Math.max(0, o - used))
    }
    // Minutes counted by the hour, in a month a retainer was invoiced for since, are counted.
    for (const t of this.tasks) {
      let surplus = surplusOf.get(t.id) ?? 0
      for (const month of [...fee].sort()) {
        const of = pending.get(month) as Map<string, number>
        const take = Math.min(surplus, of.get(t.id) ?? 0)
        if (take === 0) continue
        surplus -= take
        if (take === of.get(t.id)) of.delete(t.id)
        else of.set(t.id, (of.get(t.id) ?? 0) - take)
      }
    }
    // A task's minutes go to the line that names it or the nearest task above it, "Other" last.
    const listedBy = (id: string, of: typeof lines) => {
      for (const other of [false, true])
        for (const k of above(id)) {
          const l = of.find(
            (x) =>
              (x.kind === "other") === other && x.tasks.includes(k) && (k === id || !x.less?.later),
          )
          if (l) return l
        }
      return null
    }
    const own = lines.filter((l) => !l.work_month)
    const retainer = this.basis === "retainer"
    // Every minute pending is on a line of the next card, or is work still open, or is said.
    for (const [bucket, of] of pending) {
      if (this.basis === "fixed") continue
      if (bucket === "all" && retainer) {
        // A retainer's card bills no hour of another way of billing: it says how many there are.
        const before = [...of].reduce((s, [id, m]) => {
          const dated = time
            .filter((e) => e.task === id && !fee.has(e.month) && e.month < monthAt(next))
            .reduce((x, e) => x + e.m, 0)
          return s + (excluded.has(id) ? 0 : Math.min(m, dated))
        }, 0)
        const said = /([\d.]+) h were entered/.exec(byHand ?? "")
        if (Math.round(Number(said?.[1] ?? 0) * 60) !== before)
          this.fail(where, `${before} minutes are on no card and the note says: ${byHand}`, [...of])
        continue
      }
      const here = bucket === "all" ? own : lines.filter((l) => l.work_month === bucket)
      let expected = 0
      let toSay = 0
      for (const [id, m] of of) {
        const t = this.byId(id)
        const touched = claims.some((c) => c.task === id && bucketOf(c.key) === bucket)
        // The client's own work, on that month's card or on any by the day or the hour.
        const theirs =
          bucket === "all"
            ? !touched && excluded.has(id)
            : cards.some((c) => c.from === bucket && (c.excluded ?? []).includes(id))
        if (theirs) continue
        const l =
          bucket === "all" && !touched ? listedBy(id, here) : here.find((x) => x.tasks.includes(id))
        if (l && (l.planned ?? 0) > 0) continue
        if (l) expected += m
        else if (bucket === "all" && !touched && t.closed && fee.has(t.closed.slice(0, 7)))
          toSay += m
        // Closed under a fixed price, with nothing of it on a card: inside that price.
        else if (bucket === "all" && !touched && t.closed && this.fixed.has(t.closed.slice(0, 7)))
          continue
        // Closed in a month no card was made for: told to whoever makes the next one.
        else if (bucket === "all" && !touched && told.has(id)) continue
        else if (bucket !== "all" || touched || t.closed)
          this.fail(where, `${m} minutes of ${this.name(t)} (${bucket}) are lost`, {
            lines,
            claims,
          })
      }
      if (bucket === "all") {
        const said = /([\d.]+) h were entered/.exec(byHand ?? "")
        if (Math.round(Number(said?.[1] ?? 0) * 60) !== toSay)
          this.fail(
            where,
            `${toSay} minutes of tasks a retainer's month closed, the note says: ${byHand}`,
          )
      }
      const shown = here
        .filter((l) => (l.planned ?? 0) === 0)
        .reduce((s, l) => s + Number(l.real) - Number(l.less?.plan ?? 0), 0)
      const monthsOwn = retainer && bucket === monthAt(next)
      if (!monthsOwn && shown !== expected)
        this.fail(
          where,
          `${expected} minutes are still offered (${bucket}), the card shows ${shown}`,
          {
            lines,
            claims,
            of: [...of],
          },
        )
      // Minutes taken off billed work come off what is offered.
      const spare = over.get(bucket) ?? 0
      const billable = here
        .filter((l) => (l.planned ?? 0) === 0)
        .reduce((s, l) => s + Number(l.bill) + Number(l.less?.netted ?? 0), 0)
      const netted = here.reduce((s, l) => s + Number(l.less?.netted ?? 0), 0)
      if (!this.p.switches && netted !== Math.min(spare, billable))
        this.fail(
          where,
          `${spare} minutes were taken off billed work (${bucket}), ${netted} come off`,
          {
            lines,
            claims,
          },
        )
    }
  }

  async run() {
    await this.start()
    await this.task({ closed: this.p.open ? null : this.day(), plan: null })
    for (; this.month < this.p.months; this.month++) {
      if (this.p.switches && this.month > 0 && this.rand(2) === 0)
        await this.setBasis(
          this.pick(
            (["hourly", "daily", "retainer", "fixed"] as Basis[]).filter((k) => k !== this.basis),
          ),
        )
      else if (
        this.p.switches &&
        this.month === this.p.months - 1 &&
        this.basis === this.p.bases[0]
      )
        await this.setBasis(this.basis === "retainer" ? "hourly" : "retainer")
      if (this.basis === "fixed") this.fixed.add(monthAt(this.month))
      for (let k = 0; k < this.p.steps; k++) {
        await this.happen()
        await this.check("after a step")
      }
      await this.invoiceMonth(this.month)
    }
    // Closing everything and billing what is listed leaves nothing over.
    if (this.basis === "fixed") return
    this.month = this.p.months
    for (const t of this.live) if (!t.closed) await this.close(t, this.day())
    this.say("everything closed")
    await this.invoiceMonth(this.month)
    this.month++
    await this.check("at the end")
  }
}

class Rollback extends Error {}

describe("every minute of a project is counted once, or still offered", () => {
  for (const p of PROFILES) {
    if (ONLY && ONLY !== p.name) continue
    const seeds = SEEDS > 0 ? Array.from({ length: SEEDS }, (_, i) => FROM + i) : p.seeds
    for (const seed of seeds) {
      it(`${p.name}, seed ${seed}`, async () => {
        await new World(p, seed).run()
        expect(true).toBe(true)
      }, 120_000)
    }
  }
})

// ── One case per rule ───────────────────────────────────────────────────────

const PLAIN: Profile = { name: "case", seeds: [], months: 0, steps: 0, bases: ["hourly"] }

async function world(basis: Basis, startMonth = 8): Promise<World> {
  const w = new World({ ...PLAIN, bases: [basis] }, 1)
  w.month = startMonth
  await w.start()
  return w
}

const SEP = 8
const OCT = 9
const NOV = 10

interface Line {
  name: string
  taskIds: string[]
}
const line = (name: string, ...tasks: Task[]): Line => ({ name, taskIds: tasks.map((t) => t.id) })

const proposed = (w: World, i: number, lines: Line[] = [], excluded: Task[] = [], by = a) =>
  w.propose(
    by,
    i,
    lines.map((l) => ({ ...l, proofs: [] })),
    excluded.map((t) => ({ taskId: t.id, reason: "client_own" })),
  )

/** A card made as it is, refused if anything on it moved. */
async function made(w: World, i: number, lines: Line[] = [], by = a): Promise<Card> {
  const card = await proposed(w, i, lines, [], by)
  await reserved(w, card, i, by)
  return card
}

async function reserved(w: World, card: Card, i: number, by = a) {
  const id = card.reconciliationId as string
  const head = (
    await rows<{ revision: number }>(
      drizzleSql`SELECT revision FROM app_projects.reconciliations WHERE id = ${id}::uuid`,
    )
  )[0]
  await as(by, (tx) =>
    reserveClaims(tx as never, {
      orgId,
      reconciliationId: id,
      documentRef: w.basis === "retainer" ? `retainer:s:${monthAt(i)}` : `reconcile:${id}`,
      revision: Number(head?.revision),
    }),
  )
  await db.execute(drizzleSql`
    UPDATE app_projects.reconciliations SET state = 'drafted', drafted_at = now(), drafted_by = ${by}::uuid
     WHERE id = ${id}::uuid`)
}

async function bill(card: Card, name: string, quantity: string | number): Promise<Card> {
  const l = (card.lines as Card[]).find((k) => k.name === name) as Card
  return (await as(a, (tx) =>
    reconcileLineUpdate({
      tx: tx as never,
      orgId,
      userId: a,
      scopes: ["*"],
      input: {
        reconciliationId: card.reconciliationId,
        revision: card.revision,
        lineId: l.lineId,
        bill: quantity,
      },
    }),
  )) as Card
}

/** What a card's lines say: the name, the minutes shown and billed. */
const said = (card: Card) =>
  (card.lines as Card[]).map((l) => [l.name, l.realMinutes, l.billMinutes])

const offered = async (w: World, i: number) => said((await w.dry(i)).card)

const LATER = "Time entered after its invoice"
const LEFT = "Time entered since a card left its task off"

describe("time entered after a line that billed nothing", () => {
  for (const basis of ["hourly", "daily"] as const) {
    it(`by the ${basis === "hourly" ? "hour" : "day"}, a task closed before its time was entered is offered once it is`, async () => {
      const w = await world(basis)
      const x = await w.task({ closed: "2026-09-10" })
      await w.enter(x, "2026-09-09", 120)
      const late = await w.task({ closed: "2026-09-28" })
      const card = await made(w, SEP, [line("Logged", x), line("Not yet logged", late)])
      expect(said(card)).toEqual([
        ["Logged", 120, 120],
        ["Not yet logged", 0, 0],
      ])
      await w.enter(late, "2026-09-28", 300)
      expect(await offered(w, OCT)).toEqual([[LEFT, 300, 300]])
      await made(w, OCT)
      expect(await offered(w, NOV)).toEqual([])
    })
  }

  it("is offered without what the person left off, which a line that names the task brings back", async () => {
    const w = await world("hourly")
    const x = await w.task({ closed: "2026-09-10" })
    await w.enter(x, "2026-09-09", 60)
    const goodwill = await w.task({ closed: "2026-09-12" })
    await w.enter(goodwill, "2026-09-11", 120)
    const card = await proposed(w, SEP, [line("Logged", x), line("Goodwill", goodwill)])
    await reserved(w, await bill(card, "Goodwill", 0), SEP)
    expect(await offered(w, OCT)).toEqual([])
    await w.enter(goodwill, "2026-09-20", 60)
    expect(await offered(w, OCT)).toEqual([[LEFT, 60, 60]])
    const named = await proposed(w, OCT, [line("All of it", goodwill)])
    expect(said(named)).toEqual([["All of it", 180, 180]])
    await reserved(w, named, OCT)
    expect(await offered(w, NOV)).toEqual([])
    // Entered since, it is after an invoice now.
    await w.enter(goodwill, "2026-10-20", 30)
    expect(await offered(w, NOV)).toEqual([[LATER, 30, 30]])
  })

  it("in a period with a plan, the task is listed at 0 and its later time is offered", async () => {
    const w = await world("hourly")
    const plan = await w.task({ closed: "2026-09-10", plan: 120 })
    const extra = await w.task({ closed: "2026-09-12" })
    await w.enter(extra, "2026-09-12", 90)
    const card = await made(w, SEP, [line("Planned", plan)])
    expect(said(card)).toEqual([
      ["Planned", 0, 120],
      ["Other closed tasks", 90, 0],
    ])
    await w.enter(extra, "2026-09-13", 300)
    expect(await offered(w, OCT)).toEqual([[LEFT, 300, 300]])
  })
})

describe("a parent and its subtask, not planned", () => {
  it("on two lines of one card, each minute is on one line", async () => {
    const w = await world("hourly")
    const p = await w.task({ closed: "2026-09-10" })
    const c = await w.task({ closed: "2026-09-11", parent: p.id })
    await w.enter(p, "2026-09-09", 120)
    await w.enter(c, "2026-09-11", 180)
    const card = await made(w, SEP, [line("Parent", p), line("Part", c)])
    expect(said(card)).toEqual([
      ["Parent", 120, 120],
      ["Part", 180, 180],
    ])
    // Named alone, the parent's line counts the subtask, which is at 0 among the others.
    const w2 = await world("hourly")
    const p2 = await w2.task({ closed: "2026-09-10" })
    const c2 = await w2.task({ closed: "2026-09-11", parent: p2.id })
    await w2.enter(p2, "2026-09-09", 120)
    await w2.enter(c2, "2026-09-11", 180)
    const alone = await made(w2, SEP, [line("Whole", p2)])
    expect(said(alone)).toEqual([
      ["Whole", 300, 300],
      ["Other closed tasks", 0, 0],
    ])
    expect(await offered(w2, OCT)).toEqual([])
  })

  it("the subtask billed first, the parent bills its own time alone", async () => {
    const w = await world("hourly")
    const p = await w.task({})
    const c = await w.task({ closed: "2026-09-11", parent: p.id })
    await w.enter(p, "2026-09-09", 120)
    await w.enter(c, "2026-09-11", 180)
    expect(said(await made(w, SEP, [line("Part", c)]))).toEqual([["Part", 180, 180]])
    await w.close(p, "2026-10-05")
    expect(said(await made(w, OCT, [line("Whole", p)]))).toEqual([["Whole", 120, 120]])
    expect(await offered(w, NOV)).toEqual([])
  })

  it("the parent billed first with its open subtask, the subtask bills what is new, once, wherever it is moved", async () => {
    const w = await world("hourly")
    const p = await w.task({ closed: "2026-09-10" })
    const c = await w.task({ parent: p.id })
    await w.enter(p, "2026-09-09", 60)
    await w.enter(c, "2026-09-09", 180)
    expect(said(await made(w, SEP, [line("Whole", p)]))).toEqual([["Whole", 240, 240]])
    await w.enter(c, "2026-10-02", 60)
    await w.close(c, "2026-10-03")
    expect(await offered(w, OCT)).toEqual([[LATER, 60, 60]])
    // Named by the agent, it is the same line.
    const named = await made(w, OCT, [line("The part", c)])
    expect(said(named)).toEqual([["The part", 60, 60]])
    await w.enter(c, "2026-11-02", 30)
    await db.execute(
      drizzleSql`UPDATE app_projects.tasks SET parent_task_id = NULL WHERE id = ${c.id}::uuid`,
    )
    expect(await offered(w, NOV)).toEqual([[LATER, 30, 30]])
  })

  it("a subtask of a plan billed by its time first comes off the parent's plan, and the line says it", async () => {
    const w = await world("daily")
    const p = await w.task({ plan: null })
    const c = await w.task({ closed: "2026-09-11", parent: p.id })
    await w.enter(c, "2026-09-11", 420)
    expect(said(await made(w, SEP, [line("Part", c)]))).toEqual([["Part", 420, 420]])
    await w.plan(p, 840)
    await w.close(p, "2026-10-05")
    const card = await made(w, OCT, [line("Whole", p)])
    expect(said(card)).toEqual([["Whole", 0, 420]])
    expect(card.lines[0].why).toContain("1 d of its plan is on another line or an earlier invoice")
    // Work under it since is inside that price: listed at 0, and it says so.
    const more = await w.task({ closed: "2026-11-05", parent: p.id })
    await w.enter(more, "2026-11-04", 60)
    const nov = await proposed(w, NOV, [line("More", more)])
    expect(said(nov)).toEqual([["More", 60, 0]])
    expect(nov.lines[0].why).toContain("is part of work billed at its plan")
  })

  it("a planned subtask on a line of its own comes off the line of its parent", async () => {
    const w = await world("hourly")
    const p = await w.task({ closed: "2026-09-10", plan: 600 })
    const c = await w.task({ closed: "2026-09-11", parent: p.id, plan: 240 })
    const card = await made(w, SEP, [line("Whole", p), line("Part", c)])
    expect(said(card)).toEqual([
      ["Whole", 0, 360],
      ["Part", 0, 240],
    ])
  })
})

describe("what a credited card left off", () => {
  it("stops counting with it, on a retainer and by the hour", async () => {
    const w = await world("retainer")
    const x = await w.task({})
    const y = await w.task({})
    await w.enter(x, "2026-09-03", 45 * 60)
    await w.enter(y, "2026-09-04", 300)
    const card = await proposed(w, SEP, [line("One", x), line("Two", y)])
    await reserved(w, await bill(card, "Two", 0), SEP)
    await w.credit(card.reconciliationId)
    const again = await made(w, SEP, [line("One", x), line("Two", y)])
    expect(said(again)[1]).toEqual(["Two", 300, 300])
    await w.enter(y, "2026-09-20", 240)
    expect((await offered(w, OCT)).map((l) => l.slice(1))).toEqual([[240, 240]])

    const h = await world("hourly")
    const p = await h.task({ closed: "2026-09-03" })
    const q = await h.task({ closed: "2026-09-04" })
    await h.enter(p, "2026-09-03", 60)
    await h.enter(q, "2026-09-04", 300)
    const first = await proposed(h, SEP, [line("One", p), line("Two", q)])
    await reserved(h, await bill(first, "Two", 0), SEP)
    await h.credit(first.reconciliationId)
    const second = await made(h, SEP, [line("One", p), line("Two", q)])
    expect(said(second)[1]).toEqual(["Two", 300, 300])
    await h.enter(q, "2026-09-20", 240)
    expect(await offered(h, OCT)).toEqual([[LATER, 240, 240]])
  })
})

describe("time taken off a billed task", () => {
  it("on a retainer, hours moved to another task of the month bill nothing more; the line says so, and a person may bill them", async () => {
    const w = await world("retainer")
    const x = await w.task({})
    const y = await w.task({})
    await w.enter(x, "2026-09-03", 47 * 60)
    await w.enter(x, "2026-09-05", 4 * 60)
    await made(w, SEP, [line("One", x)])
    await db.execute(drizzleSql`
      UPDATE app_projects.task_time SET task_id = ${y.id}::uuid
       WHERE task_id = ${x.id}::uuid AND work_date = '2026-09-05'`)
    const card = await proposed(w, OCT)
    expect(said(card).map((l) => l.slice(1))).toEqual([[240, 0]])
    expect(card.lines[0].why).toContain("4 h was taken off billed work since")
    // Raised by the person, it bills.
    expect(said(await bill(card, card.lines[0].name, 4)).map((l) => l.slice(1))).toEqual([
      [240, 240],
    ])
    await reserved(w, await proposed(w, OCT), OCT)
    // Off once: what is new afterwards bills.
    await w.enter(y, "2026-09-20", 60)
    expect((await offered(w, NOV)).map((l) => l.slice(1))).toEqual([[60, 60]])
  })

  it("undone, the hours are offered at nothing again", async () => {
    const w = await world("retainer")
    const x = await w.task({})
    const y = await w.task({})
    await w.enter(x, "2026-09-03", 300)
    await made(w, SEP, [line("One", x)])
    await db.execute(drizzleSql`
      UPDATE app_projects.task_time SET minutes = 180 WHERE task_id = ${x.id}::uuid`)
    await w.enter(y, "2026-09-04", 180)
    const card = await made(w, OCT)
    expect(said(card).map((l) => l.slice(1))).toEqual([[180, 60]])
    await db.execute(drizzleSql`
      UPDATE app_projects.billing_claims SET state = 'released'
       WHERE reconciliation_id = ${card.reconciliationId}::uuid`)
    await db.execute(drizzleSql`
      UPDATE app_projects.reconciliations SET state = 'proposed', document_ref = NULL, drafted_at = NULL
       WHERE id = ${card.reconciliationId}::uuid`)
    expect(said(await proposed(w, OCT)).map((l) => l.slice(1))).toEqual([[180, 60]])
  })

  it("by the hour, it comes off the project's next lines, its own new tasks' included, once", async () => {
    const w = await world("hourly")
    const x = await w.task({ closed: "2026-09-03" })
    const y = await w.task({ closed: "2026-09-04" })
    await w.enter(x, "2026-09-03", 300)
    await w.enter(y, "2026-09-04", 60)
    await made(w, SEP, [line("One", x), line("Two", y)])
    await db.execute(drizzleSql`
      UPDATE app_projects.task_time SET minutes = 240 WHERE task_id = ${x.id}::uuid`)
    await w.enter(y, "2026-09-05", 30)
    const z = await w.task({ closed: "2026-10-04" })
    await w.enter(z, "2026-10-03", 120)
    const card = await made(w, OCT, [line("New", z)])
    expect(said(card)).toEqual([
      ["New", 120, 60],
      [LATER, 30, 30],
    ])
    await w.enter(z, "2026-10-20", 60)
    expect(await offered(w, NOV)).toEqual([[LATER, 60, 60]])
  })

  it("a line a person billed below its time owes nothing back for what it never billed", async () => {
    const w = await world("hourly")
    const x = await w.task({ closed: "2026-09-03" })
    await w.enter(x, "2026-09-03", 300)
    const card = await proposed(w, SEP, [line("One", x)])
    await reserved(w, await bill(card, "One", 3), SEP)
    await db.execute(drizzleSql`
      UPDATE app_projects.task_time SET minutes = 180 WHERE task_id = ${x.id}::uuid`)
    const z = await w.task({ closed: "2026-10-04" })
    await w.enter(z, "2026-10-03", 60)
    expect(said(await proposed(w, OCT, [line("New", z)]))).toEqual([["New", 60, 60]])
  })

  it("changed while a card waits, the card is refused and brought up to date", async () => {
    const w = await world("hourly")
    const x = await w.task({ closed: "2026-09-03" })
    await w.enter(x, "2026-09-03", 300)
    await made(w, SEP, [line("One", x)])
    const z = await w.task({ closed: "2026-10-04" })
    await w.enter(z, "2026-10-03", 120)
    const card = await proposed(w, OCT, [line("New", z)])
    await db.execute(drizzleSql`
      UPDATE app_projects.task_time SET minutes = 240 WHERE task_id = ${x.id}::uuid`)
    const moved = await reserved(w, card, OCT).catch((e) => e)
    expect(moved).toBeInstanceOf(CardMinutesMoved)
    expect(moved.lines).toMatchObject([{ was: 120, now: 120, billWas: 120, bill: 60 }])
    await as(a, (tx) =>
      refreshCardMinutes(tx as never, {
        orgId,
        reconciliationId: card.reconciliationId,
        moved: moved.lines,
      }),
    )
    await reserved(w, card, OCT)
    const stored = await rows<{ bill: number }>(drizzleSql`
      SELECT bill_minutes AS bill FROM app_projects.reconciliation_lines
       WHERE reconciliation_id = ${card.reconciliationId}::uuid`)
    expect(stored).toEqual([{ bill: 60 }])
  })
})

describe("a plan worked inside a retainer's fee", () => {
  it("bills what the fee did not pay once billing is by the hour, not below 0, and says why", async () => {
    const w = await world("retainer")
    const whole = await w.task({ plan: 600 })
    const part = await w.task({ plan: 600 })
    await w.enter(whole, "2026-09-05", 700)
    await w.enter(part, "2026-09-06", 240)
    await made(w, SEP)
    w.month = OCT
    await w.setBasis("hourly")
    await w.close(whole, "2026-10-02")
    await w.close(part, "2026-10-02")
    const card = await proposed(w, OCT, [line("Whole", whole), line("Part", part)])
    expect(said(card)).toEqual([
      ["Whole", 0, 0],
      ["Part", 0, 360],
    ])
    expect(card.lines[0].why).toContain("10 h of its plan was worked inside the retainer's fee")
    expect(card.lines[1].why).toContain("4 h of its plan was worked inside the retainer's fee")
  })
})

describe("hours no card of a retainer bills", () => {
  it("of an open task, before the first retainer month, are said with what to do", async () => {
    const w = await world("hourly")
    const x = await w.task({})
    await w.enter(x, "2026-09-20", 360)
    w.month = OCT
    await w.setBasis("retainer")
    await w.enter(x, "2026-10-02", 60)
    await w.close(x, "2026-10-03")
    const { card, byHand } = await w.dry(OCT)
    expect(said(card).map((l) => l.slice(1))).toEqual([[60, 60]])
    expect(byHand).toContain('6 h were entered on "T0" for days outside the retainer')
    expect(byHand).toContain("bill it by hand")
    // Once on the card.
    const notes = JSON.stringify(card.cardNotes)
    expect(notes.split("6 h were entered")).toHaveLength(2)
  })

  it("are not said of days a retainer month holds, nor of what a card billed", async () => {
    const w = await world("hourly")
    const x = await w.task({ closed: "2026-08-10" })
    await w.enter(x, "2026-08-09", 120)
    await made(w, 7, [line("August", x)])
    w.month = SEP
    await w.setBasis("retainer")
    const y = await w.task({})
    await w.enter(y, "2026-09-09", 120)
    await made(w, SEP)
    expect((await w.dry(OCT)).byHand).toBeNull()
  })
})

describe("what the lines of later time say", () => {
  it("a task billed by its time and given a plan since still lists its later time", async () => {
    const w = await world("hourly")
    const x = await w.task({ closed: "2026-09-10" })
    await w.enter(x, "2026-09-09", 120)
    await made(w, SEP, [line("One", x)])
    await w.enter(x, "2026-09-20", 60)
    await w.plan(x, 600)
    expect(await offered(w, OCT)).toEqual([[LATER, 60, 60]])
    await made(w, OCT)
    expect(await offered(w, NOV)).toEqual([])
  })

  it("a late line whose hours were deleted is brought up to date, not said to be on the month's own invoice", async () => {
    const w = await world("retainer")
    const x = await w.task({})
    const y = await w.task({})
    await w.enter(x, "2026-09-03", 60)
    await made(w, SEP, [line("One", x)])
    await w.enter(x, "2026-09-20", 60)
    await w.enter(y, "2026-10-05", 60)
    const card = await proposed(w, OCT, [line("October", y)])
    await db.execute(
      drizzleSql`DELETE FROM app_projects.task_time WHERE work_date = '2026-09-20' AND task_id = ${x.id}::uuid`,
    )
    const moved = await reserved(w, card, OCT).catch((e) => e)
    expect(moved).toBeInstanceOf(CardMinutesMoved)
    expect(moved.lines).toMatchObject([{ was: 60, now: 0, bill: 0 }])
  })

  it("a task whose invoice was credited since is not said to have time entered after it", async () => {
    const w = await world("hourly")
    const x = await w.task({ closed: "2026-09-10" })
    await w.enter(x, "2026-09-09", 120)
    const sep = await made(w, SEP, [line("One", x)])
    await w.enter(x, "2026-09-20", 60)
    await made(w, OCT)
    await w.credit(sep.reconciliationId)
    expect(await offered(w, NOV)).toEqual([["Earlier work, its invoice credited since", 120, 120]])
  })
})
