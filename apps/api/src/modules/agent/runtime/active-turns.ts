// SPDX-License-Identifier: FSL-1.1-ALv2
// The agent turns this process is running, so a shutdown can wait for them
// (lib/shutdown.ts, S9 step 5): the `/chat` stream and `invokeAgentForThread`
// (thread mentions, routine ticks, re-invocations) are tracked from the moment
// they are accepted to finalize. Process-local on purpose: it is this
// process's exit that waits.
//
// A turn is PREPARING from its accept until its durable turn is registered
// (turn-handoff.ts): its message write, org app setup and ledger row come
// first, and until then a drain has nothing to hand off. The turn drain waits
// for preparation to end before it hands off (awaitPrepared), so a turn
// accepted inside the edge grace is drained or handed off, never skipped.
import { AsyncLocalStorage } from "node:async_hooks"

interface Entry {
  key: string
  preparing: boolean
}

const running = new Map<number, Entry>()
const settledWaiters = new Set<() => void>()
const preparedWaiters = new Set<() => void>()
const current = new AsyncLocalStorage<Entry>()
let nextId = 0

function preparingCount(): number {
  let n = 0
  for (const e of running.values()) if (e.preparing) n++
  return n
}

function settle(): void {
  if (preparingCount() === 0) {
    for (const wake of preparedWaiters) wake()
    preparedWaiters.clear()
  }
  if (running.size > 0) return
  for (const wake of settledWaiters) wake()
  settledWaiters.clear()
}

/** A turn taken but maybe not yet running: the handle its caller ends. */
export interface AcceptedTurn {
  /** Preparation is over: the durable turn is registered, a handoff sees it. */
  prepared(): void
  /** Run the turn's body as this turn (renamed `key`); ends it when `fn` settles. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>
  /** The turn ends (idempotent). Every exit before `run` must call it. */
  end(): void
}

/**
 * Take a turn now, synchronously, before anything it does is awaited: from
 * here a drain waits for it. The caller ends it on every path.
 */
export function acceptTurn(key: string): AcceptedTurn {
  const id = nextId++
  const entry: Entry = { key, preparing: true }
  running.set(id, entry)
  const end = () => {
    if (!running.delete(id)) return
    settle()
  }
  return {
    prepared() {
      entry.preparing = false
      settle()
    },
    async run<T>(runKey: string, fn: () => Promise<T>): Promise<T> {
      entry.key = runKey
      try {
        return await current.run(entry, fn)
      } finally {
        end()
      }
    },
    end,
  }
}

/**
 * Run `fn` as a tracked turn; resolves or rejects as `fn` does. It counts as
 * preparing until `fn` registers its durable turn (markTurnPrepared).
 */
export function trackTurn<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return acceptTurn(key).run(key, fn)
}

/** The running turn's preparation is over (called where its durable turn registers). */
export function markTurnPrepared(): void {
  const entry = current.getStore()
  if (!entry?.preparing) return
  entry.preparing = false
  settle()
}

/** The keys of the turns running now. */
export function activeTurns(): string[] {
  return [...running.values()].map((e) => e.key)
}

/** The keys of the turns still preparing (accepted, durable turn not yet registered). */
export function preparingTurns(): string[] {
  return [...running.values()].filter((e) => e.preparing).map((e) => e.key)
}

/** Resolves once no turn runs, or after `deadlineMs`; says which turns remain. */
export function awaitTurns(deadlineMs: number): Promise<{ drained: boolean; remaining: string[] }> {
  const result = () => ({ drained: running.size === 0, remaining: activeTurns() })
  if (running.size === 0) return Promise.resolve(result())
  return waitFor(settledWaiters, deadlineMs, result)
}

/** Resolves once no turn is preparing, or after `deadlineMs`; says which still are. */
export function awaitPrepared(
  deadlineMs: number,
): Promise<{ prepared: boolean; preparing: string[] }> {
  const result = () => ({ prepared: preparingCount() === 0, preparing: preparingTurns() })
  if (preparingCount() === 0) return Promise.resolve(result())
  return waitFor(preparedWaiters, deadlineMs, result)
}

function waitFor<R>(waiters: Set<() => void>, deadlineMs: number, result: () => R): Promise<R> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.max(0, deadlineMs))
    function done() {
      clearTimeout(timer)
      waiters.delete(done)
      resolve(result())
    }
    waiters.add(done)
  })
}

/** Test seam: production code never calls it. */
export const ActiveTurnsTestAccess = {
  /** Forget turns other test files left running (a mocked stream nobody reads). */
  clear(): void {
    running.clear()
    settle()
  },
}
