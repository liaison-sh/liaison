// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The executor seam of the app contract harness. An executor opens ONE isolate
// for an app's code (its module evaluated once) and runs entry points in it
// any number of times, each with its own bridge, the way a long-lived Workers
// or workerd isolate serves runs. The harness (harness.ts) knows nothing else
// about the executor, so a new one (workerd, a remote loader) plugs in by
// implementing these two interfaces.
//
// Every isolate gives the app a virtual clock: `Date.now()` / `new Date()`
// start at the same instant on every run and move only when the app waits in
// a timer, `Math.random()` is seeded per run, and a timer fires at once in
// real time while the clock jumps to its due time. So two runs of the same
// entry with the same bridge answers can differ only through state the
// module kept between them, and a run's `sleepMs` (how far the app's own
// timers moved the clock) is exact.

import type { RunLimits } from "~/modules/apps/run-limits"
import type { AppBridge } from "~/modules/apps/sandbox/run-app"

/** The app code an isolate evaluates. */
export interface ContractSource {
  /** Script-mode bundle: each export bound on `globalThis` (QuickJS). */
  script?: string
  /** An ES module file whose named exports are the entry points (worker-core). */
  modulePath?: string
  /** The app's Worker module text, as a package's worker.js (workerd). */
  workerModule?: string
}

export interface ContractRunRequest {
  exportName: string
  params: unknown
  extraArgs?: unknown[]
  /** The bridge of this run only. */
  bridge: AppBridge
  limits: RunLimits
}

/** What a run limit stopped, when one did. */
export type BudgetOverrun = "wall" | "memory"

export interface ContractRunOutcome {
  ok: boolean
  /** The handler's result through JSON (undefined -> null). */
  result?: unknown
  /** The handler's error message. */
  error?: string
  /** Real time the run took. */
  wallMs: number
  /** Virtual time the app's own timers waited (see above). */
  sleepMs: number
  overrun?: BudgetOverrun
}

export interface ContractIsolate {
  run(req: ContractRunRequest): Promise<ContractRunOutcome>
  dispose(): void
}

export interface ContractExecutor {
  readonly name: string
  /** Evaluate the app's code once; `memoryBytes` is the isolate's heap. */
  open(source: ContractSource, opts: { memoryBytes: number }): Promise<ContractIsolate>
}

/** The instant every run's virtual clock starts at (2026-01-01T00:00:00Z). */
export const CONTRACT_EPOCH_MS = 1_767_225_600_000

/**
 * The virtual clock, seeded random and timers, as plain JS any isolate can
 * evaluate before the app's code. `globalThis.__contract.reset()` starts a
 * run, `.tick()` fires the earliest timer (false when none is due), `.sleepMs()`
 * reads how far the clock moved.
 */
export const VIRTUAL_TIME_PRELUDE = `(function () {
  var g = globalThis;
  var RealDate = g.Date;
  var EPOCH = ${CONTRACT_EPOCH_MS};
  var state = { now: EPOCH, seed: 1, nextId: 1 };
  var timers = [];
  function VDate() {
    var args = Array.prototype.slice.call(arguments);
    if (!(this instanceof VDate)) return new RealDate(state.now).toString();
    var d = args.length === 0 ? new RealDate(state.now) : new (Function.prototype.bind.apply(RealDate, [null].concat(args)))();
    Object.setPrototypeOf(d, VDate.prototype);
    return d;
  }
  VDate.prototype = Object.create(RealDate.prototype);
  VDate.prototype.constructor = VDate;
  VDate.now = function () { return state.now; };
  VDate.parse = RealDate.parse;
  VDate.UTC = RealDate.UTC;
  g.Date = VDate;
  Math.random = function () {
    var t = (state.seed = (state.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  function schedule(fn, ms, args, repeat) {
    var delay = Math.max(0, Number(ms) || 0);
    var id = state.nextId++;
    timers.push({ id: id, due: state.now + delay, fn: fn, args: args, repeat: repeat ? delay : 0 });
    return id;
  }
  g.setTimeout = function (fn, ms) { return schedule(fn, ms, Array.prototype.slice.call(arguments, 2), false); };
  g.setInterval = function (fn, ms) { return schedule(fn, ms, Array.prototype.slice.call(arguments, 2), true); };
  g.clearTimeout = g.clearInterval = function (id) {
    for (var i = 0; i < timers.length; i++) if (timers[i].id === id) { timers.splice(i, 1); return; }
  };
  g.__contract = {
    reset: function () { state.now = EPOCH; state.seed = 1; timers.length = 0; },
    sleepMs: function () { return state.now - EPOCH; },
    tick: function () {
      if (timers.length === 0) return false;
      var at = 0;
      for (var i = 1; i < timers.length; i++) if (timers[i].due < timers[at].due) at = i;
      var t = timers[at];
      if (t.repeat > 0 && state.now >= EPOCH + 3600000) { timers.splice(at, 1); return true; }
      if (t.due > state.now) state.now = t.due;
      if (t.repeat > 0) t.due = state.now + t.repeat; else timers.splice(at, 1);
      if (typeof t.fn === "function") t.fn.apply(null, t.args);
      return true;
    }
  };
})();`
