// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Autosave does not flood `knowledge.document.update` (S9): at most one event per page
 * per minute of typing plus one final one, counted in the outbox every subscriber
 * (routines, attention, audit, search, sockets) reads. Every other update still emits
 * at once, the owed event is never lost, and the flush emits it once.
 *
 * The database clock cannot be faked, so time passes by ageing the page's event stamp
 * by each simulated step.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test"
import { sql } from "drizzle-orm"
import { flushPendingUpdateEvents } from "~/apps/knowledge/event-coalesce"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  createKnowledgeDocument,
  type KnowledgeActor,
  type KnowledgeDocumentRow,
  knowledgeActorFromContext,
  loadKnowledgeDocument,
  updateKnowledgeDocument,
} from "~/apps/knowledge/service"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { initializedOrgRuntimes } from "~/modules/apps/app-registries"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

setDefaultTimeout(180_000)

const WRITER = [
  "knowledge:documents:read",
  "knowledge:documents:create",
  "knowledge:documents:update",
]
let orgId: string
let alice: string

beforeAll(async () => {
  await acquireTestLock()
  initializedOrgRuntimes.clear()
  orgId = (await createTestOrg()).id
  alice = (await minimal.person(orgId, { name: "Alice" })).id
})
afterAll(releaseTestLock)

const ctx = (): UserContext =>
  ({ actorType: "user", orgId, userId: alice, scopes: WRITER, dimensionGrants: {} }) as UserContext
const actor = (extra: Partial<KnowledgeActor> = {}): KnowledgeActor => ({
  ...knowledgeActorFromContext({ orgId, userId: alice, scopes: WRITER, dimensionGrants: {} }),
  ...extra,
})

async function create(): Promise<KnowledgeDocumentRow> {
  return withRlsContext(ctx(), (tx) =>
    createKnowledgeDocument(
      tx,
      { title: "Typed", body: "", documentScope: "organization" } as never,
      actor(),
      [],
    ),
  )
}

async function save(
  id: string,
  body: string,
  opts: { autosave?: boolean; author?: KnowledgeActor["author"] } = {},
): Promise<KnowledgeDocumentRow> {
  return withRlsContext(ctx(), async (tx) => {
    const row = await loadKnowledgeDocument(tx, id, actor())
    if (!row) throw new Error("gone")
    return updateKnowledgeDocument(
      tx,
      { id, revision: row.revision, body } as never,
      actor(opts.author ? { author: opts.author } : {}),
      [],
      opts.autosave ? { coalesceEvents: true, session: { id: SESSION } } : {},
    )
  })
}
const SESSION = crypto.randomUUID()

async function updateEvents(id: string): Promise<number> {
  const [row] = extractRows<{ n: number }>(
    await withPrivilegedDb(orgId, "test-events", (tx) =>
      tx.execute(sql`
        SELECT count(*)::int AS n FROM kernel.pending_events
         WHERE org_id = ${orgId}::uuid AND payload->>'app' = 'knowledge'
           AND payload->>'entity' = 'document' AND payload->>'action' = 'update'
           AND payload->>'entityId' = ${id}`),
    ),
  )
  return row?.n ?? 0
}

/** Let `seconds` pass for this page's event stamps. */
async function age(id: string, seconds: number): Promise<void> {
  await withPrivilegedDb(orgId, "test-age", (tx) =>
    tx.execute(sql`
      UPDATE ${knowledgeRel("documents")}
         SET update_event_at = update_event_at - make_interval(secs => ${seconds}),
             update_event_pending_at = update_event_pending_at - make_interval(secs => ${seconds})
       WHERE id = ${id}::uuid`),
  )
}

async function pending(id: string): Promise<boolean> {
  const [row] = extractRows<{ pending: boolean }>(
    await withPrivilegedDb(orgId, "test-pending", (tx) =>
      tx.execute(sql`
        SELECT update_event_pending_at IS NOT NULL AS pending
          FROM ${knowledgeRel("documents")} WHERE id = ${id}::uuid`),
    ),
  )
  return row?.pending === true
}

describe("autosave update events", () => {
  it("typing for 3 minutes, a save every 1.5 s: 4 to 5 events, never two within 60 s, one after the last", async () => {
    const doc = await create()
    const start = await updateEvents(doc.id)
    const at: number[] = []
    let seen = start
    const note = async (t: number) => {
      const n = await updateEvents(doc.id)
      for (; seen < n; seen++) at.push(t)
    }
    const STEP = 1.5
    const SAVES = 120
    let t = 0
    for (let i = 0; i < SAVES; i++) {
      t = i * STEP
      await save(doc.id, `typed ${i}`, { autosave: true })
      await note(t)
      await age(doc.id, STEP)
      // The flush job runs every minute.
      if (Math.round((t + STEP) * 10) % 600 === 0) {
        await flushPendingUpdateEvents()
        await note(t + STEP)
      }
    }
    const last = t
    for (const extra of [60, 60]) {
      await age(doc.id, extra)
      await flushPendingUpdateEvents()
      await note(last + extra)
    }
    expect(at[0]).toBe(0)
    expect(at.length).toBeGreaterThanOrEqual(4)
    expect(at.length).toBeLessThanOrEqual(5)
    for (let i = 1; i < at.length; i++)
      expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBeGreaterThanOrEqual(60)
    expect(at.filter((x) => x > last).length).toBe(1)
    expect(await pending(doc.id)).toBe(false)
  })

  it("an agent's update inside the window emits at once and clears the owed event", async () => {
    const doc = await create()
    await save(doc.id, "a", { autosave: true })
    await save(doc.id, "b", { autosave: true })
    expect(await pending(doc.id)).toBe(true)
    const before = await updateEvents(doc.id)
    await save(doc.id, "agent", { author: { type: "agent", agentId: null } })
    expect(await updateEvents(doc.id)).toBe(before + 1)
    expect(await pending(doc.id)).toBe(false)
    await age(doc.id, 120)
    await flushPendingUpdateEvents()
    expect(await updateEvents(doc.id)).toBe(before + 1)
  })

  it("an update that is not an autosave still emits every time", async () => {
    const doc = await create()
    const before = await updateEvents(doc.id)
    for (const body of ["1", "2", "3"]) await save(doc.id, body)
    expect(await updateEvents(doc.id)).toBe(before + 3)
  })

  it("two flushes at once emit the owed event once", async () => {
    const doc = await create()
    await save(doc.id, "a", { autosave: true })
    await save(doc.id, "b", { autosave: true })
    await age(doc.id, 61)
    const before = await updateEvents(doc.id)
    // The first holds its claim open while the second runs.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let claimed: () => void = () => {}
    const hasClaimed = new Promise<void>((r) => {
      claimed = r
    })
    const first = flushPendingUpdateEvents({
      beforeQueue: async () => {
        claimed()
        await gate
      },
    })
    await hasClaimed
    const second = flushPendingUpdateEvents()
    await Bun.sleep(300)
    release()
    await Promise.all([first, second])
    expect(await updateEvents(doc.id)).toBe(before + 1)
    expect(await pending(doc.id)).toBe(false)
  })

  it("the flush leaves an owed event whose page had one less than 60 s ago", async () => {
    const due = await create()
    const fresh = await create()
    for (const id of [due.id, fresh.id]) {
      await save(id, "a", { autosave: true })
      await save(id, "b", { autosave: true })
    }
    await age(due.id, 61)
    const before = await updateEvents(fresh.id)
    await flushPendingUpdateEvents()
    expect(await updateEvents(fresh.id)).toBe(before)
    expect(await pending(fresh.id)).toBe(true)
    expect(await pending(due.id)).toBe(false)
    await age(fresh.id, 61)
    await flushPendingUpdateEvents()
    expect(await updateEvents(fresh.id)).toBe(before + 1)
  })

  it("a crash between claim and queue keeps the owed event; the next run emits it once", async () => {
    const doc = await create()
    await save(doc.id, "a", { autosave: true })
    await save(doc.id, "b", { autosave: true })
    await age(doc.id, 61)
    const before = await updateEvents(doc.id)
    await flushPendingUpdateEvents({
      beforeQueue: () => {
        throw new Error("crash")
      },
    })
    expect(await pending(doc.id)).toBe(true)
    expect(await updateEvents(doc.id)).toBe(before)
    await flushPendingUpdateEvents()
    await flushPendingUpdateEvents()
    expect(await updateEvents(doc.id)).toBe(before + 1)
    expect(await pending(doc.id)).toBe(false)
  })

  it("an autosave of the stored text writes nothing", async () => {
    const doc = await create()
    const saved = await save(doc.id, "same", { autosave: true })
    const before = await updateEvents(doc.id)
    const again = await save(doc.id, "same", { autosave: true })
    expect(again.revision).toBe(saved.revision)
    expect(again.updatedAt).toBe(saved.updatedAt)
    expect(await updateEvents(doc.id)).toBe(before)
  })
})
