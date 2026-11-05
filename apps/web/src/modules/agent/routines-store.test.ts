// SPDX-License-Identifier: FSL-1.1-ALv2
import { createRoot } from "solid-js"
import { beforeEach, describe, expect, it, vi } from "vitest"

const ROUTINE_FIXTURE = {
  id: "11111111-1111-1111-1111-111111111111",
  orgId: "org-1",
  ownerUserId: "user-1",
  name: "morning-summary",
  description: "Daily digest",
  cron: "0 8 * * 1-5",
  timezone: "America/Toronto",
  prompt: "summarize yesterday",
  outputThreadId: null,
  scopes: [],
  enabled: true,
  status: "active" as const,
  lastRunAt: null,
  lastRunStatus: null,
  lastRunError: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
}

function makeApi(overrides: Partial<Record<"get" | "post" | "put" | "delete", any>> = {}) {
  return {
    get: vi.fn().mockResolvedValue([ROUTINE_FIXTURE]),
    post: vi.fn().mockResolvedValue(ROUTINE_FIXTURE),
    put: vi.fn().mockResolvedValue(ROUTINE_FIXTURE),
    delete: vi.fn().mockResolvedValue(undefined),
    patch: vi.fn(),
    rawPost: vi.fn(),
    rawGet: vi.fn(),
    getEnvelope: vi.fn(),
    ...overrides,
  } as any
}

describe("routines-store", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("loadRoutines GETs /api/agent/routines and hydrates", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./routines-store")
      const api = makeApi()
      await store.loadRoutines(api)
      expect(api.get).toHaveBeenCalledWith("/agent/routines")
      expect(store.routinesStore.routines).toHaveLength(1)
      dispose()
    })
  })

  it("createRoutine POSTs and prepends row on success", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./routines-store")
      const api = makeApi()
      await store.createRoutine(api, {
        name: "x",
        description: "y",
        cron: "* * * * *",
        timezone: "UTC",
        prompt: "p",
        scopes: [],
      })
      expect(api.post).toHaveBeenCalledWith(
        "/agent/routines",
        expect.objectContaining({ name: "x", cron: "* * * * *" }),
      )
      expect(store.routinesStore.routines).toHaveLength(1)
      dispose()
    })
  })

  // D20 walk: a routine just created on an agent's Routines tab opened with no Edit button (and so
  // no scope picker) until the list reloaded, because the created row carried no `canWrite`. The
  // creator has just written for that agent, which is the A15 answer itself.
  it("createRoutine on an agent's tab lands the row as writable by its creator", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./routines-store")
      const api = makeApi()
      await store.createRoutine(api, {
        name: "x",
        description: "y",
        cron: "* * * * *",
        timezone: "UTC",
        prompt: "p",
        scopes: [],
        ownerAgentId: "agent-1",
      })
      expect(store.routinesForAgent("agent-1")[0]?.canWrite).toBe(true)
      dispose()
    })
  })

  it("createRoutine throws and does NOT append when network never responds (10s timeout)", async () => {
    await createRoot(async (dispose) => {
      vi.useFakeTimers()
      const store = await import("./routines-store")
      const api = makeApi({
        post: vi.fn().mockImplementation(() => new Promise(() => {})),
      })
      const promise = store.createRoutine(api, {
        name: "x",
        description: "y",
        cron: "* * * * *",
        timezone: "UTC",
        prompt: "p",
        scopes: [],
      })
      // Race the timers without awaiting the unresolvable promise
      vi.advanceTimersByTime(10_000)
      await expect(promise).rejects.toThrow(/timeout/i)
      expect(store.routinesStore.routines).toHaveLength(0)
      vi.useRealTimers()
      dispose()
    })
  })

  it("updateRoutine optimistically updates then merges; rolls back on failure", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./routines-store")
      const api = makeApi({
        get: vi.fn().mockResolvedValue([ROUTINE_FIXTURE]),
        put: vi.fn().mockRejectedValue(new Error("server")),
      })
      await store.loadRoutines(api)
      await expect(
        store.updateRoutine(api, ROUTINE_FIXTURE.id, { enabled: false }),
      ).rejects.toThrow("server")
      // Rolled back
      expect(store.routinesStore.routines[0].enabled).toBe(true)
      dispose()
    })
  })

  it("deleteRoutine removes optimistically; rolls back on failure", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./routines-store")
      const api = makeApi({
        get: vi.fn().mockResolvedValue([ROUTINE_FIXTURE]),
        delete: vi.fn().mockRejectedValue(new Error("denied")),
      })
      await store.loadRoutines(api)
      await expect(store.deleteRoutine(api, ROUTINE_FIXTURE.id)).rejects.toThrow("denied")
      expect(store.routinesStore.routines).toHaveLength(1)
      dispose()
    })
  })

  it("runRoutineNow POSTs to /:id/run-now and bumps lastRunAt", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./routines-store")
      const api = makeApi({
        get: vi.fn().mockResolvedValue([ROUTINE_FIXTURE]),
        post: vi.fn().mockResolvedValue({ queued: true }),
      })
      await store.loadRoutines(api)
      expect(store.routinesStore.routines[0].lastRunAt).toBe(null)
      await store.runRoutineNow(api, ROUTINE_FIXTURE.id)
      expect(api.post).toHaveBeenCalledWith(`/agent/routines/${ROUTINE_FIXTURE.id}/run-now`, {})
      expect(store.routinesStore.routines[0].lastRunAt).not.toBe(null)
      dispose()
    })
  })

  it("cronPreview returns next 3 fire times", async () => {
    const { cronPreview } = await import("./cron-preview")
    const fires = cronPreview("0 8 * * 1-5", "America/Toronto", 3)
    expect(fires).toHaveLength(3)
    for (const t of fires) expect(t).toBeInstanceOf(Date)
  })

  it("cronPreview returns [] on invalid cron", async () => {
    const { cronPreview } = await import("./cron-preview")
    expect(cronPreview("not a cron", "UTC", 3)).toEqual([])
  })

  it("describeCron renders preset crons in plain English", async () => {
    const store = await import("./routines-store")
    expect(store.describeCron("0 9 * * *")).toBe("Every day at 9 AM")
    expect(store.describeCron("30 14 * * 1-5")).toBe("Every weekday at 2:30 PM")
    expect(store.describeCron("0 8 * * 3")).toBe("Every Wednesday at 8 AM")
    expect(store.describeCron("0 0 1 * *")).toBe("Monthly on the 1st at 12 AM")
  })

  it("describeCron falls back to the raw expression for a custom cron", async () => {
    const store = await import("./routines-store")
    expect(store.describeCron("*/15 * * * *")).toBe("*/15 * * * *")
    expect(store.describeCron("")).toBe("No schedule")
  })

  it("describeSchedule describes recurring and one-shot routines", async () => {
    const store = await import("./routines-store")
    expect(
      store.describeSchedule({
        kind: "recurring",
        cron: "0 9 * * 1-5",
        timezone: "America/Toronto",
        runAt: null,
      }),
    ).toBe("Every weekday at 9 AM")
    expect(
      store.describeSchedule(
        { kind: "recurring", cron: "0 9 * * 1-5", timezone: "America/Toronto", runAt: null },
        { withTimezone: true },
      ),
    ).toBe("Every weekday at 9 AM · America/Toronto")
    expect(
      store.describeSchedule({
        kind: "scheduled",
        cron: null,
        timezone: null,
        runAt: null,
      }),
    ).toBe("Once")
    expect(
      store.describeSchedule({
        kind: "scheduled",
        cron: null,
        timezone: null,
        runAt: "2026-02-01T09:00:00Z",
      }),
    ).toMatch(/^Once · /)
  })

  it("describeSchedule renders an event routine as what fires it", async () => {
    const store = await import("./routines-store")
    expect(
      store.describeSchedule({
        kind: "event",
        cron: null,
        timezone: null,
        runAt: null,
        event: "tickets:ticket:replied",
      }),
    ).toBe("When Tickets: ticket replied")
    // A kind:'event' row with no event yet still reads as a trigger, never as
    // a cron fallback ("No schedule").
    expect(store.describeSchedule({ kind: "event", cron: null, timezone: null, runAt: null })).toBe(
      "When an event happens",
    )
  })

  it("describeRoutineEvent turns app:entity:action into a sentence", async () => {
    const store = await import("./routines-store")
    expect(store.describeRoutineEvent("monitoring:incident:opened")).toBe(
      "Monitoring: incident opened",
    )
    expect(store.describeRoutineEvent("shopify:draft_order:completed")).toBe(
      "Shopify: draft order completed",
    )
    // Not three segments: the raw string is the honest answer.
    expect(store.describeRoutineEvent("nonsense")).toBe("nonsense")
  })

  it("loadRoutineEvents fetches the catalog and narrows it by app", async () => {
    const store = await import("./routines-store")
    const rows = [
      { event: "tickets:ticket:replied", app: "tickets", entity: "ticket", action: "replied" },
    ]
    const api = makeApi({ get: vi.fn().mockResolvedValue(rows) })
    await store.loadRoutineEvents(api as never)
    expect(api.get).toHaveBeenCalledWith("/agent/routines/events")
    expect(store.routinesStore.events).toEqual(rows)
    await store.loadRoutineEvents(api as never, { app: "tickets" })
    expect(api.get).toHaveBeenLastCalledWith("/agent/routines/events?app=tickets")
  })

  it("onRoutineStatus updates status + last-run fields in place", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./routines-store")
      const api = makeApi({ get: vi.fn().mockResolvedValue([ROUTINE_FIXTURE]) })
      await store.loadRoutines(api)
      store.onRoutineStatus({
        type: "routine:status",
        routineId: ROUTINE_FIXTURE.id,
        status: "paused_scope_mismatch",
        lastRunStatus: "skipped_scope_mismatch",
      })
      expect(store.routinesStore.routines[0].status).toBe("paused_scope_mismatch")
      expect(store.routinesStore.routines[0].lastRunStatus).toBe("skipped_scope_mismatch")
      dispose()
    })
  })

  it("onRoutineRunCompleted appends to in-memory run history when present", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./routines-store")
      const api = makeApi({
        get: vi
          .fn()
          .mockImplementation((path: string) =>
            path === "/agent/routines" ? Promise.resolve([ROUTINE_FIXTURE]) : Promise.resolve([]),
          ),
      })
      await store.loadRoutines(api)
      await store.loadRoutineRuns(api, ROUTINE_FIXTURE.id)
      expect(store.routinesStore.runs[ROUTINE_FIXTURE.id]).toEqual([])
      store.onRoutineRunCompleted({
        type: "routine:run_completed",
        routineId: ROUTINE_FIXTURE.id,
        run: {
          id: "run-1",
          routineId: ROUTINE_FIXTURE.id,
          ranAt: "2024-01-02T00:00:00Z",
          status: "succeeded",
          durationMs: 123,
          errorMessage: null,
        },
      })
      expect(store.routinesStore.runs[ROUTINE_FIXTURE.id]).toHaveLength(1)
      expect(store.routinesStore.routines[0].lastRunStatus).toBe("succeeded")
      dispose()
    })
  })

  it("onRoutineRunCompleted settles a run already listed (a node run listed as dispatched)", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./routines-store")
      const dispatched = {
        id: "run-node",
        routineId: ROUTINE_FIXTURE.id,
        ranAt: "2024-01-02T00:00:00Z",
        status: "dispatched",
        durationMs: null,
        errorMessage: null,
      }
      const api = makeApi({
        get: vi
          .fn()
          .mockImplementation((path: string) =>
            path === "/agent/routines"
              ? Promise.resolve([ROUTINE_FIXTURE])
              : Promise.resolve([dispatched]),
          ),
      })
      await store.loadRoutines(api)
      await store.loadRoutineRuns(api, ROUTINE_FIXTURE.id)
      store.onRoutineRunCompleted({
        type: "routine:run_completed",
        routineId: ROUTINE_FIXTURE.id,
        run: { ...dispatched, status: "succeeded", durationMs: 9743 },
      })
      const runs = store.routinesStore.runs[ROUTINE_FIXTURE.id]
      expect(runs).toHaveLength(1)
      expect(runs[0].status).toBe("succeeded")
      expect(store.routinesStore.routines[0].lastRunStatus).toBe("succeeded")
      dispose()
    })
  })
})

// A French org read "Every Monday at 8:30 AM" under a French page.
describe("schedules in the reader's language", () => {
  it("describes a cron in French with a 24h clock and a French weekday", async () => {
    const store = await import("./routines-store")
    // The wording comes from the catalog; the clock and the day from the locale.
    const { dictionariesFor } = await import("@liaison/shared")
    const kernel = dictionariesFor("fr").kernel as any
    const frT = (key: string, params?: Record<string, string>) => {
      const path = key.replace(/^kernel\./, "").split(".")
      let node: any = kernel
      for (const p of path) node = node?.[p]
      return String(node).replace(/\{\{(\w+)\}\}/g, (_m, n) => params?.[n] ?? "")
    }
    expect(store.describeCron("30 8 * * 1", { t: frT, locale: "fr" })).toBe("Chaque lundi à 08:30")
    expect(store.describeCron("0 8 * * 1-5", { t: frT, locale: "fr" })).toBe(
      "Du lundi au vendredi à 08:00",
    )
    expect(store.describeCron("30 8 * * 1")).toBe("Every Monday at 8:30 AM")
  })
})
