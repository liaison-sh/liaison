// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The background queue bound on the Workers path (the sandbox service's rule,
// run-limits.ts runQueueBoundMs): a background run with its own queue bound
// waits up to it for admission and then gets its whole timeout; a run without
// one (and every interactive run) counts its wait in its timeout. A
// `queue_timeout` answer of the sandbox service is a run that never started.

import { describe, expect, it } from "bun:test"
import { SandboxQueueTimeoutError } from "~/lib/failure-severity"
import { WorkersAdmission } from "./admission"
import type { WorkersConfig } from "./config"
import { executeOnWorkers, type WorkersRunInfo, type WorkersRunOptions } from "./executor"
import { AppFallbacks, LoaderBreaker } from "./fallback"
import { RunRegistry } from "./run-registry"
import { runErrorKindOf } from "./run-settled"

const ORG = "00000000-0000-4000-8000-0000000000b2"

const config: WorkersConfig = {
  loaderUrl: "http://loader.invalid",
  cellId: "cell-q",
  loaderKey: "q-cell-key-0123456789abcdef0",
  bridgeBaseUrl: "http://cell.invalid/api/app-bridge",
}

interface Sent {
  deadlineMs: number
  queueMs?: number
  lane?: string
}

function setup(over: Partial<WorkersRunOptions>, answer?: () => Response) {
  // One background slot for the org; a holder keeps it until released.
  const admission = new WorkersAdmission({ perOrg: 4, backgroundPerOrg: 1 })
  const sent: Sent[] = []
  const opts: WorkersRunOptions = {
    config,
    appName: "q",
    orgId: ORG,
    version: "1.0.0",
    bundleSha256: "b".repeat(64),
    exportName: "go",
    params: {},
    bridge: { emit: async () => 1 },
    holdsTx: false,
    timeoutMs: 200,
    lane: "background",
    // The target is the sandbox service (it states its release), which queues too.
    sandboxRelease: "test-release",
    admission,
    registry: new RunRegistry(),
    breaker: new LoaderBreaker(),
    appFallbacks: new AppFallbacks(),
    retryJitterMs: () => 10,
    fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(String(init.body)) as Sent)
      return answer ? answer() : Response.json({ ok: true, result: "done" })
    },
    ...over,
  }
  return { admission, opts, sent }
}

async function run(opts: WorkersRunOptions) {
  let info: WorkersRunInfo = {}
  try {
    const result = await executeOnWorkers(opts, (i) => {
      info = i
    })
    return { result, info }
  } catch (e) {
    return { error: e as Error, info }
  }
}

/** Hold the org's one background slot for `ms`. */
async function holdBackgroundSlot(admission: WorkersAdmission, ms: number): Promise<void> {
  const release = await admission.acquire({
    orgId: ORG,
    lane: "background",
    holdsTx: false,
    nested: false,
    waitMs: 1_000,
  })
  setTimeout(release, ms)
}

describe("Workers admission: background queue bound", () => {
  it("a background run queued past its timeout still runs, with its whole deadline", async () => {
    const { admission, opts, sent } = setup({ queueMs: 5_000 })
    await holdBackgroundSlot(admission, 400)
    const r = await run(opts)
    expect(r.result).toBe("done")
    expect(r.info.admissionMs ?? 0).toBeGreaterThanOrEqual(350)
    // Its deadline counts from its start: the whole 200 ms, not what the wait left.
    expect(sent[0]?.deadlineMs).toBeGreaterThan(150)
    // What is left of its queue bound goes to the sandbox service.
    expect(sent[0]?.queueMs).toBeLessThanOrEqual(5_000 - 350)
    expect(sent[0]?.queueMs).toBeGreaterThan(4_000)
    expect(sent[0]?.lane).toBe("background")
  })

  it("without a queue bound, the wait counts in its timeout: queue_timeout, never started", async () => {
    const { admission, opts, sent } = setup({})
    await holdBackgroundSlot(admission, 400)
    const r = await run(opts)
    expect(r.error).toBeInstanceOf(SandboxQueueTimeoutError)
    expect(runErrorKindOf(r.error)).toBe("queue_timeout")
    expect(sent).toHaveLength(0)
  })

  it("the Workers loader (no queue of its own) gets no queueMs, only the admission waits", async () => {
    const { admission, opts, sent } = setup({ queueMs: 5_000, sandboxRelease: undefined })
    await holdBackgroundSlot(admission, 300)
    const r = await run(opts)
    expect(r.result).toBe("done")
    expect(sent[0]?.queueMs).toBeUndefined()
    expect(sent[0]?.deadlineMs).toBeGreaterThan(150)
  })

  it("past its queue bound a background run fails with queue_timeout", async () => {
    const { admission, opts, sent } = setup({ queueMs: 150, timeoutMs: 10_000 })
    await holdBackgroundSlot(admission, 600)
    const t0 = Date.now()
    const r = await run(opts)
    expect(Date.now() - t0).toBeLessThan(500)
    expect(r.error).toBeInstanceOf(SandboxQueueTimeoutError)
    expect(sent).toHaveLength(0)
  })

  it("an interactive run ignores queueMs: none sent, its timeout counts the wait", async () => {
    const { admission, opts, sent } = setup({ lane: "interactive", queueMs: 5_000 })
    // Fill the org's interactive slots (perOrg 4).
    const releases = await Promise.all(
      [1, 2, 3, 4].map(() =>
        admission.acquire({ orgId: ORG, holdsTx: false, nested: false, waitMs: 1_000 }),
      ),
    )
    setTimeout(() => {
      for (const rel of releases) rel()
    }, 400)
    const r = await run(opts)
    expect(r.error).toBeInstanceOf(SandboxQueueTimeoutError)
    expect(sent).toHaveLength(0)
    const free = setup({ lane: "interactive", queueMs: 5_000 })
    await run(free.opts)
    expect(free.sent[0]?.queueMs).toBeUndefined()
  })

  it("the sandbox service's queue_timeout answer is a run that never started", async () => {
    const { opts } = setup({ queueMs: 5_000 }, () =>
      Response.json({
        ok: false,
        error: {
          message: "Queued sandbox request timed out waiting for a free worker",
          kind: "timeout",
          code: "queue_timeout",
        },
      }),
    )
    const r = await run(opts)
    expect(r.error).toBeInstanceOf(SandboxQueueTimeoutError)
    expect(r.info.fault).toEqual({ class: "final", kind: "queue_timeout" })
    expect(r.info.attempts).toBe(1)
  })
})
