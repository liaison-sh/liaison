// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ═══════════════════════════════════════════════════════════════════════════
//  MARKET-INTELLIGENCE WEB-WATCH + CROSS-TICK STATE — E2E SCENARIO (Module H)
// ═══════════════════════════════════════════════════════════════════════════
//
// What this proves end-to-end: a market-intelligence routine that watches an
// external source across ticks. Tick 1 establishes a baseline (no diff, state
// persisted); tick 2 with a changed source detects the diff AND emits a real
// `routine:watch:changed` outbox event; per-routine state is invisible across
// routines; an unreachable source records-and-degrades (never fabricates).
//
// SURFACE: the REAL production routine-tick path. We drive `runRoutineTick`
// (the kernel:routine-tick worker body) so the worker stamps `routineId` on the
// AsyncLocalStorage run frame exactly as production does. Our `agentInvoker`
// then runs as the routine owner under `withRlsContext` and calls the REAL
// registered-tool adapters (`handleWatchStateTool` / `handleWebWatchTool`),
// which derive `routineId` from `currentRunContext()` — proving the run-frame
// plumbing and the routine-only gate are wired, not just the pure handlers.
//
// The ONLY mocked seam is the external HTTP boundary (`fetchExtract`), the same
// boundary the production tool wires to `handleWebFetch`. Everything below it is
// real: `kernel.routine_state` rows under RLS, the `kernel.pending_events`
// outbox (which enforces `assertKernelEventDeclared`), per-routine isolation.
//
// Observable assertions are REAL DB/return state, not "no throw":
//   • `kernel.routine_state` rows persisted with the watched value + content hash
//   • `kernel.pending_events` carries the `routine_watch:changed` payload
//   • the cross-routine read returns null (isolation, not a leak)
//   • the unreachable tick leaves prior state intact and flags low confidence
//
// Style mirrors durable-runtime.scenario.test.ts (drives the real routine tick
// in-process) and the hij-reachability routine-frame assertions.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { routineState, routines } from "~/db/schema/kernel"
import { runRoutineTick } from "~/modules/agent/routines/routine-worker"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import {
  handleWatchState,
  handleWatchStateTool,
  handleWebWatch,
  handleWebWatchTool,
} from "~/modules/agent/tools/watch-tools"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function seedRecurringRoutine(
  orgId: string,
  ownerUserId: string,
  outputThreadId: string,
  prompt: string,
): Promise<string> {
  const [r] = await withSystemDb("seed-market-routine", (db) =>
    db
      .insert(routines)
      .values({
        orgId,
        ownerUserId,
        name: `market-intel-${crypto.randomUUID().slice(0, 8)}`,
        description: "market-intelligence web-watch e2e",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "Europe/Paris",
        prompt,
        scopes: ["kernel:agent:web"],
        outputThreadId,
        createdByActorType: "user",
        createdByUserId: ownerUserId,
      })
      .returning({ id: routines.id }),
  )
  return r.id
}

/** Read a routine's persisted cross-tick state row for `key` (system DB). */
async function readStateRow(
  routineId: string,
  key: string,
): Promise<{ value: unknown; content_hash: string | null } | null> {
  return withSystemDb("read-state", async (db) => {
    const rows = await db
      .select({ value: routineState.value, contentHash: routineState.contentHash })
      .from(routineState)
      .where(and(eq(routineState.routineId, routineId), eq(routineState.key, key)))
    const row = rows[0]
    if (!row) return null
    return { value: row.value, content_hash: row.contentHash }
  })
}

/** All routine_state rows for a routine (system DB) — used to prove isolation. */
async function stateRowsForRoutine(routineId: string): Promise<Array<{ key: string }>> {
  return withSystemDb("read-state-all", (db) =>
    db
      .select({ key: routineState.key })
      .from(routineState)
      .where(eq(routineState.routineId, routineId)),
  )
}

/** Read the `routine_watch:changed` outbox payloads queued for an org. */
async function watchChangedEvents(
  orgId: string,
): Promise<
  Array<{ entity: string; action: string; entityId: string; data: Record<string, unknown> }>
> {
  return withSystemDb("read-outbox", async (db) => {
    const result = await db.execute(sql`
      SELECT payload FROM kernel.pending_events
       WHERE org_id = ${orgId}::uuid
         AND payload->>'app' = 'kernel'
         AND payload->>'entity' = 'routine_watch'
         AND payload->>'action' = 'changed'
    `)
    return extractRows<{
      payload: {
        entity: string
        action: string
        entityId: string
        data: Record<string, unknown>
      }
    }>(result).map((r) => r.payload)
  })
}

// ═══════════════════════════════════════════════════════════════════════════

describe("Market-Intelligence Web-Watch Scenario (Module H)", () => {
  let orgId: string
  let userId: string
  let outputThreadId: string

  beforeAll(async () => {
    await acquireTestLock()
    const u = await minimal.orgAdmin((await createTestOrg()).id)
    orgId = u.orgId
    userId = u.id
    outputThreadId = await minimal.thread(orgId, userId)
  }, 30_000)

  afterEach(async () => {
    // Clean the routine_state + outbox so each scenario starts from empty state.
    await withSystemDb("market-clean", async (db) => {
      await db.delete(routineState).where(eq(routineState.orgId, orgId))
      await db.execute(sql`DELETE FROM kernel.pending_events WHERE org_id = ${orgId}::uuid`)
    })
  })

  afterAll(async () => {
    await releaseTestLock()
  }, 15_000)

  // ═════════════════════════════════════════════════════════════════════════
  //  H1 — the routine tick stamps routineId on the run frame; the registered
  //       watch_state tool derives it from there and persists state. Tick 1 is
  //       a baseline: nothing prior, changed:false, state durably written.
  // ═════════════════════════════════════════════════════════════════════════

  it("H1: tick 1 baseline — watch_state derives routineId from the run frame and persists state (changed:false)", async () => {
    const routineId = await seedRecurringRoutine(
      orgId,
      userId,
      outputThreadId,
      "Watch the Corvane price page each morning.",
    )

    let observedRoutineId: string | undefined
    let toolResult: { value: unknown; previous: unknown; changed: boolean } | undefined

    const result = await runRoutineTick({
      orgId,
      routineId,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["kernel:agent:web"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        // The worker entered a routine-tick run frame. The registered tool reads
        // `routineId` from it — prove it is present (the H1 plumbing).
        observedRoutineId = currentRunContext()?.routineId
        await withRlsContext(
          {
            actorType: "user",
            userId: input.ownerUserId,
            orgId: input.orgId,
            scopes: input.scopes,
            dimensionGrants: {},
          },
          async (tx) => {
            toolResult = await handleWatchStateTool(
              { key: "price:corvane", value: { eur: 599 } },
              { orgId: input.orgId, userId: input.ownerUserId, db: tx },
            )
          },
        )
        return { turnsAdded: 1 }
      },
    })

    expect(result.status).toBe("succeeded")
    // The worker stamped the tick's routineId on the ALS frame.
    expect(observedRoutineId).toBe(routineId)
    // First write under this key: no prior, so changed is false (baseline).
    expect(toolResult).toEqual({ value: { eur: 599 }, previous: null, changed: false })

    // REAL DB: the baseline value is durably persisted to kernel.routine_state.
    const persisted = await readStateRow(routineId, "price:corvane")
    expect(persisted).not.toBeNull()
    expect(persisted?.value).toEqual({ eur: 599 })
  }, 60_000)

  // ═════════════════════════════════════════════════════════════════════════
  //  H1 — a second tick with a different value reports the diff against the
  //       value the FIRST tick persisted (cross-tick state continuity).
  // ═════════════════════════════════════════════════════════════════════════

  it("H1: tick 2 sees the prior tick's value — changed:true with the old value carried", async () => {
    const routineId = await seedRecurringRoutine(
      orgId,
      userId,
      outputThreadId,
      "Watch the Corvane price page each morning.",
    )

    const runTick = (value: { eur: number }) =>
      runRoutineTick({
        orgId,
        routineId,
        scheduledAt: new Date().toISOString(),
        loadOwnerScopes: async () => ["kernel:agent:web"],
        checkCredits: async () => null,
        agentInvoker: async (input) => {
          await withRlsContext(
            {
              actorType: "user",
              userId: input.ownerUserId,
              orgId: input.orgId,
              scopes: input.scopes,
              dimensionGrants: {},
            },
            (tx) =>
              handleWatchStateTool(
                { key: "price:corvane", value },
                { orgId: input.orgId, userId: input.ownerUserId, db: tx },
              ),
          )
          return { turnsAdded: 1 }
        },
      })

    // Tick 1 — baseline 599.
    const t1 = await runTick({ eur: 599 })
    expect(t1.status).toBe("succeeded")

    // Tick 2 — a different value. The tool must read the value tick 1 persisted.
    let t2Result: { value: unknown; previous: unknown; changed: boolean } | undefined
    const t2 = await runRoutineTick({
      orgId,
      routineId,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["kernel:agent:web"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        await withRlsContext(
          {
            actorType: "user",
            userId: input.ownerUserId,
            orgId: input.orgId,
            scopes: input.scopes,
            dimensionGrants: {},
          },
          async (tx) => {
            t2Result = await handleWatchStateTool(
              { key: "price:corvane", value: { eur: 549 } },
              { orgId: input.orgId, userId: input.ownerUserId, db: tx },
            )
          },
        )
        return { turnsAdded: 1 }
      },
    })

    expect(t2.status).toBe("succeeded")
    expect(t2Result?.changed).toBe(true)
    expect(t2Result?.previous).toEqual({ eur: 599 })
    expect(t2Result?.value).toEqual({ eur: 549 })

    // REAL DB: the persisted value advanced to the latest tick's value.
    const persisted = await readStateRow(routineId, "price:corvane")
    expect(persisted?.value).toEqual({ eur: 549 })
  }, 60_000)

  // ═════════════════════════════════════════════════════════════════════════
  //  H2 — web_watch cross-tick diff: tick 2 with a changed source detects the
  //       diff AND emits a REAL routine:watch:changed outbox event. The outbox
  //       enforces assertKernelEventDeclared, so this also proves the event
  //       type is declared (the pure-handler unit test mocks queueEvent away).
  // ═════════════════════════════════════════════════════════════════════════

  it("H2: tick 1 no-diff → tick 2 changed source → diff detected + routine:watch:changed outbox event", async () => {
    const routineId = await seedRecurringRoutine(
      orgId,
      userId,
      outputThreadId,
      "Watch the competitor's price page each morning.",
    )

    // The external HTTP boundary is mocked; everything below it is real.
    let sourceValue: { price_eur: number } = { price_eur: 599 }
    const fetchExtract = async (): Promise<{ price_eur: number }> => sourceValue

    const runWatchTick = () =>
      runRoutineTick({
        orgId,
        routineId,
        scheduledAt: new Date().toISOString(),
        loadOwnerScopes: async () => ["kernel:agent:web"],
        checkCredits: async () => null,
        agentInvoker: async (input) => {
          const routineFrameId = currentRunContext()?.routineId
          if (!routineFrameId) throw new Error("routine frame missing in tick")
          return withRlsContext(
            {
              actorType: "user",
              userId: input.ownerUserId,
              orgId: input.orgId,
              scopes: input.scopes,
              dimensionGrants: {},
            },
            async (tx) => {
              // handleWebWatch is the same pure tool the registered adapter wraps;
              // here we wire the REAL RLS tx (its queueEvent writes pending_events)
              // and mock only the external fetch — production parity below the wire.
              await handleWebWatch(
                {
                  url: "https://competitor.example/pricing",
                  extractionQuery: "price",
                  key: "comp:price",
                },
                {
                  orgId: input.orgId,
                  routineId: routineFrameId,
                  tx,
                  fetchExtract,
                  queueEvent: (e) =>
                    tx.queueEvent({
                      app: e.app,
                      entity: e.entity,
                      action: e.action,
                      entityId: e.entityId,
                      data: e.data,
                      orgId: input.orgId,
                      actorId: input.ownerUserId,
                      actorType: "agent",
                    }),
                },
              )
              return { turnsAdded: 1 }
            },
          )
        },
      })

    // Tick 1 — baseline. No prior content hash → changed:false → NO outbox event.
    const t1 = await runWatchTick()
    expect(t1.status).toBe("succeeded")
    expect(await watchChangedEvents(orgId)).toHaveLength(0)
    const afterT1 = await readStateRow(routineId, "comp:price")
    expect(afterT1?.value).toEqual({ price_eur: 599 })
    expect(afterT1?.content_hash).not.toBeNull()

    // Tick 2 — the source changed. Diff detected → one outbox event with the delta.
    sourceValue = { price_eur: 549 }
    const t2 = await runWatchTick()
    expect(t2.status).toBe("succeeded")

    const events = await watchChangedEvents(orgId)
    expect(events).toHaveLength(1)
    expect(events[0].entity).toBe("routine_watch")
    expect(events[0].action).toBe("changed")
    expect(events[0].entityId).toBe("comp:price")
    expect(events[0].data.routineId).toBe(routineId)
    // The numeric delta is computed and carried on the event payload.
    expect(events[0].data.delta).toEqual({ price_eur: -50 })

    // REAL DB: state advanced to the new value.
    const afterT2 = await readStateRow(routineId, "comp:price")
    expect(afterT2?.value).toEqual({ price_eur: 549 })
  }, 60_000)

  // ═════════════════════════════════════════════════════════════════════════
  //  H1/H2 — routine-scoped isolation: routine S cannot read routine R's state
  //          even within the SAME org (composite (routine_id, key) PK + frame).
  // ═════════════════════════════════════════════════════════════════════════

  it("H1: watch_state is routine-scoped — a second routine cannot read the first routine's key", async () => {
    const routineR = await seedRecurringRoutine(orgId, userId, outputThreadId, "Routine R watcher.")
    const routineS = await seedRecurringRoutine(orgId, userId, outputThreadId, "Routine S watcher.")

    // Routine R writes a value under "shared-key".
    await runRoutineTick({
      orgId,
      routineId: routineR,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["kernel:agent:web"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        await withRlsContext(
          {
            actorType: "user",
            userId: input.ownerUserId,
            orgId: input.orgId,
            scopes: input.scopes,
            dimensionGrants: {},
          },
          (tx) =>
            handleWatchStateTool(
              { key: "shared-key", value: { who: "R" } },
              { orgId: input.orgId, userId: input.ownerUserId, db: tx },
            ),
        )
        return { turnsAdded: 1 }
      },
    })

    // Routine S ticks and reads "shared-key" — it must NOT see R's value.
    let fromS: { value: unknown; previous: unknown; changed: boolean } | undefined
    const sResult = await runRoutineTick({
      orgId,
      routineId: routineS,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["kernel:agent:web"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        const frameId = currentRunContext()?.routineId
        // The S tick's frame carries routine S — not R.
        expect(frameId).toBe(routineS)
        await withRlsContext(
          {
            actorType: "user",
            userId: input.ownerUserId,
            orgId: input.orgId,
            scopes: input.scopes,
            dimensionGrants: {},
          },
          async (tx) => {
            // pure read (omit value) — must return null for S even though R wrote it.
            fromS = await handleWatchStateTool(
              { key: "shared-key" },
              { orgId: input.orgId, userId: input.ownerUserId, db: tx },
            )
          },
        )
        return { turnsAdded: 1 }
      },
    })

    expect(sResult.status).toBe("succeeded")
    expect(fromS?.value).toBeNull()

    // REAL DB: R has the row, S has none under that key — composite-PK isolation.
    const rRows = await stateRowsForRoutine(routineR)
    const sRows = await stateRowsForRoutine(routineS)
    expect(rRows.map((r) => r.key)).toContain("shared-key")
    expect(sRows.map((r) => r.key)).not.toContain("shared-key")
  }, 60_000)

  // ═════════════════════════════════════════════════════════════════════════
  //  H2 — source unreachable: record-and-degrade. No fabricated value, no false
  //        change, no outbox event, prior state preserved, low confidence.
  // ═════════════════════════════════════════════════════════════════════════

  it("H2: source unreachable → record-and-degrade (prior state intact, low confidence, no fabrication, no event)", async () => {
    const routineId = await seedRecurringRoutine(
      orgId,
      userId,
      outputThreadId,
      "Watch a flaky source.",
    )

    // Tick 1 establishes a real baseline (source up).
    await runRoutineTick({
      orgId,
      routineId,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["kernel:agent:web"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        await withRlsContext(
          {
            actorType: "user",
            userId: input.ownerUserId,
            orgId: input.orgId,
            scopes: input.scopes,
            dimensionGrants: {},
          },
          (tx) =>
            handleWebWatch(
              { url: "https://flaky.example/data", extractionQuery: "price", key: "flaky" },
              {
                orgId: input.orgId,
                routineId: currentRunContext()!.routineId!,
                tx,
                fetchExtract: async () => ({ price_eur: 1000 }),
                queueEvent: (e) =>
                  tx.queueEvent({
                    app: e.app,
                    entity: e.entity,
                    action: e.action,
                    entityId: e.entityId,
                    data: e.data,
                    orgId: input.orgId,
                    actorId: input.ownerUserId,
                    actorType: "agent",
                  }),
              },
            ),
        )
        return { turnsAdded: 1 }
      },
    })

    const baseline = await readStateRow(routineId, "flaky")
    expect(baseline?.value).toEqual({ price_eur: 1000 })

    // Tick 2 — the source is unreachable.
    let degraded:
      | {
          current: unknown
          previous: unknown
          changed: boolean
          unreachable: boolean
          confidence: string
        }
      | undefined
    const t2 = await runRoutineTick({
      orgId,
      routineId,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["kernel:agent:web"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        await withRlsContext(
          {
            actorType: "user",
            userId: input.ownerUserId,
            orgId: input.orgId,
            scopes: input.scopes,
            dimensionGrants: {},
          },
          async (tx) => {
            degraded = await handleWebWatch(
              { url: "https://flaky.example/data", extractionQuery: "price", key: "flaky" },
              {
                orgId: input.orgId,
                routineId: currentRunContext()!.routineId!,
                tx,
                fetchExtract: async () => {
                  throw new Error("ECONNREFUSED")
                },
                queueEvent: (e) =>
                  tx.queueEvent({
                    app: e.app,
                    entity: e.entity,
                    action: e.action,
                    entityId: e.entityId,
                    data: e.data,
                    orgId: input.orgId,
                    actorId: input.ownerUserId,
                    actorType: "agent",
                  }),
              },
            )
          },
        )
        return { turnsAdded: 1 }
      },
    })

    expect(t2.status).toBe("succeeded")
    // Record-and-degrade: unreachable flagged, no fabricated current, no false change.
    expect(degraded?.unreachable).toBe(true)
    expect(degraded?.changed).toBe(false)
    expect(degraded?.current).toBeNull()
    expect(degraded?.confidence).toBe("low")
    // The prior value is carried (degrade does not erase known state).
    expect(degraded?.previous).toEqual({ price_eur: 1000 })

    // REAL DB: the baseline is preserved — the failed tick did NOT overwrite it
    // with a null/fabricated value.
    const afterDown = await readStateRow(routineId, "flaky")
    expect(afterDown?.value).toEqual({ price_eur: 1000 })
    // No outbox event was emitted for the unreachable tick.
    expect(await watchChangedEvents(orgId)).toHaveLength(0)
  }, 60_000)

  // ═════════════════════════════════════════════════════════════════════════
  //  H1 — routine-only gate: the tools throw outside a routine run (defense in
  //        depth; the buildToolSet filter is the primary gate, asserted in
  //        hij-reachability.test.ts).
  // ═════════════════════════════════════════════════════════════════════════

  it("H1: watch_state and web_watch throw when invoked with no routine frame (routine-only)", async () => {
    await withPrivilegedDb(orgId, "no-frame-watch-state", async (tx) => {
      // ctx.routineId undefined → the pure handler refuses (belt-and-braces gate).
      await expect(
        handleWatchState({ key: "k" }, { orgId, routineId: undefined, tx }),
      ).rejects.toThrow(/routine/i)
    })

    // The registered adapter derives routineId from currentRunContext(); outside
    // any tick the frame is absent, so it throws too.
    await expect(
      withRlsContext(
        { actorType: "user", userId, orgId, scopes: ["kernel:agent:web"], dimensionGrants: {} },
        (tx) =>
          handleWebWatchTool(
            { url: "https://x.example", extractionQuery: "price", key: "k" },
            { orgId, userId, db: tx },
          ),
      ),
    ).rejects.toThrow(/routine/i)
  }, 30_000)
})
