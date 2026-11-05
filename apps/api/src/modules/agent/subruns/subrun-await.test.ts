// SPDX-License-Identifier: FSL-1.1-ALv2
//
// awaitSubRunResult with the caller's stop signal: the wait leaves nothing behind
// once it settles. The abort listener comes off the caller's signal (a chat turn
// or parent run awaits many sub-runs on one signal), and an aborted wait drops
// its Redis subscriber at once instead of holding it until the wait's timeout.
import { describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { REDIS_PREFIX, redis } from "~/lib/redis"
import type { SubRunResult } from "~/modules/agent/subruns/spawn-agent"
import { awaitSubRunResult, publishSubRunResult } from "~/modules/agent/subruns/subrun-await"
import { waitFor } from "~/tests/helpers/wait-for"

async function subscribers(runId: string): Promise<number> {
  const out = (await redis.call(
    "PUBSUB",
    "NUMSUB",
    `${REDIS_PREFIX}agent-run-result:${runId}`,
  )) as [string, number]
  return Number(out[1])
}

/** A signal that counts the abort listeners currently on it. */
function countedSignal() {
  const controller = new AbortController()
  const signal = controller.signal
  let listeners = 0
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  signal.addEventListener = ((type: string, fn: EventListener, o?: AddEventListenerOptions) => {
    if (type === "abort") listeners++
    add(type, fn, o)
  }) as typeof signal.addEventListener
  signal.removeEventListener = ((type: string, fn: EventListener, o?: EventListenerOptions) => {
    if (type === "abort") listeners--
    remove(type, fn, o)
  }) as typeof signal.removeEventListener
  return { controller, signal, listeners: () => listeners }
}

const done = (runId: string): SubRunResult => ({
  ok: true,
  runId,
  output: { answer: 42 },
  summary: "ok",
  usage: { promptTokens: 1, completionTokens: 1, creditCost: "0" },
})

describe("awaitSubRunResult with a stop signal", () => {
  it("removes its abort listener when the sub-run finishes first", async () => {
    const runId = crypto.randomUUID()
    const orgId = crypto.randomUUID()
    const s = countedSignal()
    const wait = awaitSubRunResult(runId, orgId, { signal: s.signal, timeoutMs: 10_000 })
    await waitFor(async () => (await subscribers(runId)) === 1, {
      timeoutMs: 5_000,
      label: "subscribed",
    })
    expect(s.listeners()).toBeGreaterThan(0)
    await publishSubRunResult(runId, orgId, done(runId))
    expect((await wait).ok).toBe(true)
    expect(s.listeners()).toBe(0)
    expect(await subscribers(runId)).toBe(0)
  }, 20_000)

  it("an aborted wait settles cancelled and drops its subscriber at once", async () => {
    const runId = crypto.randomUUID()
    const orgId = crypto.randomUUID()
    const s = countedSignal()
    const wait = awaitSubRunResult(runId, orgId, {
      signal: s.signal,
      continueOnError: true,
      timeoutMs: 60_000,
    })
    await waitFor(async () => (await subscribers(runId)) === 1, { timeoutMs: 5_000 })
    s.controller.abort()
    const result = await wait
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("cancelled")
    await waitFor(async () => (await subscribers(runId)) === 0, { timeoutMs: 2_000 })
    expect(s.listeners()).toBe(0)
  }, 20_000)
})
