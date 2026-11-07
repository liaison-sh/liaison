// SPDX-License-Identifier: FSL-1.1-ALv2
// biome-ignore-all lint/correctness/noUnusedVariables: handlers are resolved by manifest export name inside the sandbox
//
// Fixture bundle for runtime-event-worker.test.ts. Reuses the kernel test
// app's manifest but replaces onItemCreated with a CPU-burning spin followed
// by the same event_log write, so the test can (a) measure main-thread
// event-loop lag while a manifest event handler executes and (b) observe the
// handler's bridge side effect as the completion signal. Evaluated raw inside
// QuickJS -- must stay self-contained (no imports).

type SpinCtx = {
  db_insert?: (table: string, data: string) => Promise<unknown>
}

// Long enough that a host-loop stall (in-process execution) stands far above the
// scheduling noise of a loaded shared CI runner, where worker spawn alone
// delayed a tick by up to ~1 s.
const SPIN_MS = 3000

async function onItemCreatedSpin(event: { entityId?: string; data?: unknown }, ctx: SpinCtx) {
  const end = Date.now() + SPIN_MS
  while (Date.now() < end) {
    // burn CPU inside the sandbox -- in-process execution would stall the
    // host event loop for the full window; a worker keeps the host responsive
  }
  if (ctx?.db_insert && event?.entityId) {
    await ctx.db_insert(
      "event_log",
      JSON.stringify({
        eventType: "item:created:spun",
        entityId: event.entityId,
        data: JSON.stringify(event.data || {}),
      }),
    )
  }
}

// Same spin shape for the JOB path (runtime-job-worker.test.ts): a manifest
// job handler that burns CPU then writes its completion marker.
async function processItemsSpin(payload: { marker?: string }, ctx: SpinCtx) {
  const end = Date.now() + SPIN_MS
  while (Date.now() < end) {
    // burn CPU inside the sandbox
  }
  if (ctx?.db_insert && payload?.marker) {
    await ctx.db_insert(
      "event_log",
      JSON.stringify({
        eventType: "job:processed:spun",
        entityId: payload.marker,
        data: "{}",
      }),
    )
  }
}
