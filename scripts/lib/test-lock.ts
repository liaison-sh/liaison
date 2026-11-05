// SPDX-License-Identifier: FSL-1.1-ALv2
// Machine-wide test SLOTS, plus the per-namespace lock and port-block lease.
//
// History: nothing serialized test runs, several agents launched broad suites
// at once, each sized its parallelism from the whole machine and the OOM killer
// ended the run. One exclusive lock fixed that by running one suite at a time,
// which made every pipeline on the machine queue behind every other.
//
// Isolation is now the run namespace's job (packages/test-helpers/src/
// test-namespace.ts: own database, own Redis/Meili prefixes, own port block),
// so the only thing left to ration is memory. That is a counting semaphore:
// LIAISON_TEST_SLOTS runs at once (default 2), each sizing its workers from its
// share of the RAM budget (mem-budget.ts divides by the slot count).
//
// The slots themselves (FIFO tickets, the load gate, start-time stamps, leases
// held by an ancestor) live in machine-slots.ts, which every heavy job on the
// machine shares; this file adds the per-namespace lock and the port lease.
//
// Three kinds of lock file, all in one directory (TEST_SLOT_DIR, default
// <tmpdir>/liaison-test-slots), all ADVISORY, all carrying the holder's pid so a
// dead holder's file is detected and taken over:
//
//   slot-<i>.lock        a run slot, i in [0, slots)
//   ns-<ns>.lock         one run per namespace at a time: two runs of the same
//                        checkout would drop each other's database
//   ports-<k>.lease      port block k leased to a namespace
//
// Coexistence with the old exclusive lock (<tmpdir>/liaison-test.lock, still
// taken by checkouts that predate this file): it is READ, never written or
// removed. A live holder there counts as one occupied slot.

import fs from "node:fs"
import path from "node:path"
import {
  PORT_BLOCK_COUNT,
  portBlockBase,
  preferredPortBlock,
} from "../../packages/test-helpers/src/test-namespace"
import {
  type AcquireOptions,
  acquireSlot,
  claimOnce,
  DEFAULT_LOG_EVERY_MS,
  DEFAULT_POLL_MS,
  DEFAULT_WAIT_SEC,
  describeHolder,
  holderAlive,
  type LockRecord,
  readRecord,
  releaser,
  resolveProbe,
  slotDir,
  type TestLock,
  tryCreate,
} from "./machine-slots"

export {
  type AcquireOptions,
  DEFAULT_LOG_EVERY_MS,
  DEFAULT_POLL_MS,
  DEFAULT_SLOTS,
  DEFAULT_WAIT_SEC,
  describeSlots,
  formatStatus,
  type LockRecord,
  legacyLockPath,
  maxLoad,
  type ProcessProbe,
  readRecord,
  releaseHeldBy,
  releaseOnFailure,
  slotCount,
  slotDir,
  type TestLock,
} from "./machine-slots"

/** A machine-wide slot (see machine-slots.ts). The name predates non-test jobs. */
export function acquireTestLock(opts: AcquireOptions): Promise<TestLock> {
  return acquireSlot(opts)
}

function stamp(procStart: string | null): { procStart?: string } {
  return procStart ? { procStart } : {}
}

function waitOptions(opts: AcquireOptions) {
  const env = opts.env ?? process.env
  const waitSecRaw = Number(env.TEST_LOCK_WAIT_SEC)
  return {
    log: opts.log ?? ((m: string) => console.log(m)),
    now: opts.now ?? (() => Date.now()),
    sleep: opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    probe: resolveProbe(opts),
    pollMs: opts.pollMs ?? DEFAULT_POLL_MS,
    logEveryMs: opts.logEveryMs ?? DEFAULT_LOG_EVERY_MS,
    waitMs: (Number.isFinite(waitSecRaw) && waitSecRaw >= 0 ? waitSecRaw : DEFAULT_WAIT_SEC) * 1000,
    pid: opts.pid ?? process.pid,
    install: opts.installExitHandlers ?? true,
  }
}

/**
 * One run per namespace at a time. Two runs of the same checkout would each
 * drop and re-clone the same database under the other. Waits like a slot does.
 */
export async function acquireNamespaceLock(
  ns: string,
  opts: AcquireOptions,
): Promise<{ path: string; release(): void }> {
  const env = opts.env ?? process.env
  const c = waitOptions(opts)
  const file = path.join(slotDir(env), `ns-${ns}.lock`)
  const record: LockRecord = {
    pid: c.pid,
    startedAt: new Date(c.now()).toISOString(),
    cmd: opts.cmd,
    ns,
    ...stamp(c.probe.startTime(c.pid)),
    cwd: process.cwd(),
  }
  const start = c.now()
  let lastLogged = start - c.logEveryMs
  for (;;) {
    const held = claimOnce(file, record, c.probe, c.log)
    if (held === null) return { path: file, release: releaser(file, c.pid, c.install) }
    const waited = c.now() - start
    if (waited >= c.waitMs) {
      throw new Error(
        `test lock: namespace "${ns}" still in use by ${describeHolder(held)} after ${Math.round(waited / 1000)}s. Set LIAISON_TEST_NS to run under another namespace.`,
      )
    }
    if (c.now() - lastLogged >= c.logEveryMs) {
      lastLogged = c.now()
      c.log(
        `test lock: namespace "${ns}" is in use by ${describeHolder(held)}, waiting (${Math.round(waited / 1000)}s). Set LIAISON_TEST_NS for a separate namespace.`,
      )
    }
    await c.sleep(c.pollMs)
  }
}

/**
 * Leases a port block to a namespace and returns its first port. Starts at the
 * namespace's preferred block and probes onward: a block leased to ANOTHER
 * namespace whose holder is alive is skipped, so two live runs never share
 * one. Our own namespace's lease is simply rewritten (the namespace lock
 * guarantees there is one live run per namespace).
 */
export function leasePortBlock(
  ns: string,
  opts: Pick<AcquireOptions, "env" | "isAlive" | "probe" | "pid" | "cmd" | "installExitHandlers">,
): { base: number; block: number; release(): void } {
  const env = opts.env ?? process.env
  const probe = resolveProbe(opts)
  const pid = opts.pid ?? process.pid
  const dir = slotDir(env)
  fs.mkdirSync(dir, { recursive: true })
  const first = preferredPortBlock(ns)
  const record: LockRecord = {
    pid,
    startedAt: new Date().toISOString(),
    cmd: opts.cmd,
    ns,
    ...stamp(probe.startTime(pid)),
  }
  for (let step = 0; step < PORT_BLOCK_COUNT; step++) {
    const block = (first + step) % PORT_BLOCK_COUNT
    const file = path.join(dir, `ports-${block}.lease`)
    const held = readRecord(file)
    if (held && held.ns !== ns && holderAlive(held, probe)) continue
    if (held) fs.rmSync(file, { force: true })
    if (!tryCreate(file, record)) continue // lost a race for it; try the next one
    return {
      base: portBlockBase(block),
      block,
      release: releaser(file, pid, opts.installExitHandlers ?? true),
    }
  }
  throw new Error(
    `test lock: all ${PORT_BLOCK_COUNT} port blocks are leased to live runs (${dir}).`,
  )
}
