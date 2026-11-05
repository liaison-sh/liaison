// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The hedged transcription (S6, p95 stop to insert at most 10 s): the measured
// default (Qwen3 ASR 1.7B) on an org that chose no model asks the 0.6B at the
// same time. The 1.7B's transcript is used when it lands within
// PRIMARY_GRACE_MS; past that, the first transcript there is (normally the
// 0.6B's, already done); a failed 1.7B leaves the 0.6B's. A call still running
// once a transcript is chosen is aborted and metered at an estimate.
//
// The real OpenRouter call runs (`defaultTranscribeDeps.callProvider`), with
// OpenRouter's HTTP stubbed at the outbound fetch: each model answers after its
// own delay on fake timers, and a request whose signal aborts first rejects as
// a real fetch does. The spend path is stubbed and records what was metered.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { DemoSpendRefusedError } from "~/modules/demo/demo-spend"
import {
  defaultTranscribeDeps,
  PRIMARY_GRACE_MS,
  type TranscribeDeps,
  transcribe,
} from "./transcribe-service"
import {
  findTranscriptionModel,
  HEDGE_TRANSCRIPTION_KEY,
  MEASURED_DEFAULT_TRANSCRIPTION_KEY,
  type TranscriptionModel,
  type TranscriptionPlan,
} from "./transcription-models"

const ORG_ID = "00000000-0000-4000-8000-0000000f6001"
const USER_ID = "00000000-0000-4000-8000-0000000f6002"
const PRIMARY = findTranscriptionModel(MEASURED_DEFAULT_TRANSCRIPTION_KEY) as TranscriptionModel
const HEDGE = findTranscriptionModel(HEDGE_TRANSCRIPTION_KEY) as TranscriptionModel

/** How one upstream model answers: after `afterMs`, with this status and text. */
interface Behaviour {
  afterMs: number
  status?: number
  text?: string
  cost?: number
}

let behaviours: Record<string, Behaviour> = {}
/** Every request OpenRouter received, by upstream model id, and how it ended. */
let requests: Array<{ model: string; ended: "answered" | "aborted" | "pending" }> = []
let metered: Array<{ modelId: string; providerCostUsd?: number; fixedCostUsd?: number }> = []
let released = 0
const savedBaseUrl = process.env.OPENROUTER_BASE_URL

const stubFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as { model: string }
  const behaviour = behaviours[body.model]
  if (!behaviour) throw new Error(`no behaviour for ${body.model}`)
  const entry = { model: body.model, ended: "pending" as "answered" | "aborted" | "pending" }
  requests.push(entry)
  const signal = init?.signal ?? undefined
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.ended = "answered"
      const status = behaviour.status ?? 200
      resolve(
        Response.json(
          status === 200
            ? { text: behaviour.text ?? body.model, usage: { seconds: 12, cost: behaviour.cost } }
            : { error: { message: "provider down" } },
          { status },
        ),
      )
    }, behaviour.afterMs)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        if (entry.ended === "pending") entry.ended = "aborted"
        reject(signal.reason)
      },
      { once: true },
    )
  })
}) as typeof fetch

/** Let the service's awaits (and the real dns pin of 127.0.0.1) run, timers frozen. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r))
  if (!cond()) throw new Error("condition never held")
}

function deps(plan: TranscriptionPlan): TranscribeDeps {
  return {
    ...defaultTranscribeDeps,
    resolvePlan: async () => plan,
    clean: async (input) => ({ cleaned: input.text, cleanModel: null }),
    log: { warn: () => {}, error: () => {} } as never,
    spend: {
      resolveKey: async () => ({ key: "sk-or-test-placeholder", source: "byok" }),
      spendGate: async () => null,
      finalizeUsage: async (_orgId, params) => {
        metered.push({
          modelId: params.model.modelId,
          ...(params.providerCostUsd !== undefined
            ? { providerCostUsd: params.providerCostUsd }
            : {}),
          ...(params.fixedCostUsd !== undefined ? { fixedCostUsd: params.fixedCostUsd } : {}),
        })
        return { creditCost: "0" }
      },
      recordReservedDemoSideSpend: async () => {},
      releaseDemoTurnReservation: async () => {
        released++
      },
    },
  }
}

function run(plan: TranscriptionPlan) {
  const pending = transcribe(
    {
      orgId: ORG_ID,
      userId: USER_ID,
      audio: new Uint8Array([1, 2, 3, 4]),
      contentType: "audio/webm",
      clean: false,
      signal: new AbortController().signal,
    },
    deps(plan),
  )
  const state = { settled: false }
  void pending.then(
    () => {
      state.settled = true
    },
    () => {
      state.settled = true
    },
  )
  return { pending, state }
}

const DEFAULT_PLAN: TranscriptionPlan = { model: PRIMARY, hedge: HEDGE }

describe("hedged transcription of the measured default", () => {
  beforeAll(() => {
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/api/v1"
    OutboundFetchTestAccess.setFetch(stubFetch)
  })
  afterAll(() => {
    OutboundFetchTestAccess.setFetch(null)
    if (savedBaseUrl === undefined) delete process.env.OPENROUTER_BASE_URL
    else process.env.OPENROUTER_BASE_URL = savedBaseUrl
  })
  beforeEach(() => {
    jest.useFakeTimers()
    behaviours = {}
    requests = []
    metered = []
    released = 0
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("gives the 1.7B 3 s to answer before taking the 0.6B's transcript", () => {
    expect(PRIMARY_GRACE_MS).toBe(3_000)
  })

  // The design changed here (V2, from validation): the 0.6B no longer waits 6 s
  // for the 1.7B. Both start together, and the 0.6B's answer is the fallback
  // from 3 s on, so a slow 1.7B costs at most 3 s instead of 6 s plus a call.
  it("both models are asked at once", async () => {
    behaviours = {
      [PRIMARY.upstreamId]: { afterMs: 800, cost: 0.00009 },
      [HEDGE.upstreamId]: { afterMs: 400, cost: 0.00004 },
    }
    const { pending } = run(DEFAULT_PLAN)
    await until(() => requests.length === 2)
    expect(requests.map((r) => r.model)).toEqual([PRIMARY.upstreamId, HEDGE.upstreamId])
    jest.advanceTimersByTime(800)
    await pending
  })

  it("a primary answering within 3 s is used even when the 0.6B was faster; both are metered at what they billed", async () => {
    behaviours = {
      [PRIMARY.upstreamId]: { afterMs: 2_000, text: "from the primary", cost: 0.00009 },
      [HEDGE.upstreamId]: { afterMs: 500, text: "from the hedge", cost: 0.00004 },
    }
    const { pending, state } = run(DEFAULT_PLAN)
    await until(() => requests.length === 2)
    jest.advanceTimersByTime(500)
    await until(() => true)
    expect(state.settled).toBe(false)
    jest.advanceTimersByTime(1_500)
    const res = await pending
    expect(res.model).toBe(PRIMARY.key)
    expect(res.raw).toBe("from the primary")
    expect(requests.every((r) => r.ended === "answered")).toBe(true)
    expect(metered.map(({ modelId, providerCostUsd }) => ({ modelId, providerCostUsd }))).toEqual([
      { modelId: PRIMARY.key, providerCostUsd: 0.00009 },
      { modelId: HEDGE.key, providerCostUsd: 0.00004 },
    ])
    expect(released).toBe(0)
  })

  it("a slow primary: the 0.6B's transcript is used at 3 s, and the aborted primary is metered at an estimate", async () => {
    behaviours = {
      [PRIMARY.upstreamId]: { afterMs: 30_000, cost: 0.00009 },
      [HEDGE.upstreamId]: { afterMs: 700, text: "from the hedge", cost: 0.00004 },
    }
    const { pending, state } = run(DEFAULT_PLAN)
    await until(() => requests.length === 2)
    jest.advanceTimersByTime(PRIMARY_GRACE_MS - 1)
    await until(() => true)
    expect(state.settled).toBe(false)
    jest.advanceTimersByTime(1)
    const res = await pending
    expect(res.model).toBe(HEDGE.key)
    expect(res.raw).toBe("from the hedge")
    expect(requests).toEqual([
      { model: PRIMARY.upstreamId, ended: "aborted" },
      { model: HEDGE.upstreamId, ended: "answered" },
    ])
    expect(metered).toEqual([
      { modelId: PRIMARY.key, fixedCostUsd: 12 * PRIMARY.pricePerSecondUsd },
      { modelId: HEDGE.key, providerCostUsd: 0.00004, fixedCostUsd: 12 * HEDGE.pricePerSecondUsd },
    ])
    expect(released).toBe(0)
  })

  it("both slower than 3 s: the first transcript after that is used", async () => {
    behaviours = {
      [PRIMARY.upstreamId]: { afterMs: 9_000, cost: 0.00009 },
      [HEDGE.upstreamId]: { afterMs: 5_000, text: "from the hedge", cost: 0.00004 },
    }
    const { pending, state } = run(DEFAULT_PLAN)
    await until(() => requests.length === 2)
    jest.advanceTimersByTime(4_999)
    await until(() => true)
    expect(state.settled).toBe(false)
    jest.advanceTimersByTime(1)
    expect((await pending).model).toBe(HEDGE.key)
    expect(requests[0]?.ended).toBe("aborted")
  })

  it("a primary that fails: the 0.6B's transcript is used as soon as it is there", async () => {
    behaviours = {
      [PRIMARY.upstreamId]: { afterMs: 300, status: 503 },
      [HEDGE.upstreamId]: { afterMs: 700, text: "from the hedge", cost: 0.00004 },
    }
    const { pending } = run(DEFAULT_PLAN)
    await until(() => requests.length === 2)
    jest.advanceTimersByTime(700)
    const res = await pending
    expect(res.model).toBe(HEDGE.key)
    expect(metered.map((m) => m.modelId)).toEqual([HEDGE.key])
    expect(released).toBe(1)
  })

  it("a primary refused with a 4xx: the 0.6B's transcript is used too", async () => {
    behaviours = {
      [PRIMARY.upstreamId]: { afterMs: 300, status: 400 },
      [HEDGE.upstreamId]: { afterMs: 700, text: "from the hedge", cost: 0.00004 },
    }
    const { pending } = run(DEFAULT_PLAN)
    await until(() => requests.length === 2)
    jest.advanceTimersByTime(700)
    expect((await pending).model).toBe(HEDGE.key)
  })

  it("a 0.6B that fails leaves the primary, however slow", async () => {
    behaviours = {
      [PRIMARY.upstreamId]: { afterMs: 8_000, text: "from the primary", cost: 0.00009 },
      [HEDGE.upstreamId]: { afterMs: 300, status: 503 },
    }
    const { pending } = run(DEFAULT_PLAN)
    await until(() => requests.length === 2)
    jest.advanceTimersByTime(8_000)
    const res = await pending
    expect(res.model).toBe(PRIMARY.key)
    expect(metered.map((m) => m.modelId)).toEqual([PRIMARY.key])
    expect(released).toBe(1)
  })

  it("a 0.6B still running when the primary is chosen is aborted and metered at an estimate", async () => {
    behaviours = {
      [PRIMARY.upstreamId]: { afterMs: 1_000, cost: 0.00009 },
      [HEDGE.upstreamId]: { afterMs: 10_000, cost: 0.00004 },
    }
    const { pending } = run(DEFAULT_PLAN)
    await until(() => requests.length === 2)
    jest.advanceTimersByTime(1_000)
    const res = await pending
    expect(res.model).toBe(PRIMARY.key)
    expect(requests[1]?.ended).toBe("aborted")
    expect(metered).toEqual([
      {
        modelId: PRIMARY.key,
        providerCostUsd: 0.00009,
        fixedCostUsd: 12 * PRIMARY.pricePerSecondUsd,
      },
      { modelId: HEDGE.key, fixedCostUsd: 12 * HEDGE.pricePerSecondUsd },
    ])
    expect(released).toBe(0)
  })

  it("a demo visitor on the box key: one request, to the 0.6B, answered at once", async () => {
    behaviours = {
      [PRIMARY.upstreamId]: { afterMs: 48_000, status: 502 },
      [HEDGE.upstreamId]: { afterMs: 700, text: "hello from the visitor", cost: 0.00004 },
    }
    const base = deps(DEFAULT_PLAN)
    const visitorDeps: TranscribeDeps = {
      ...base,
      spend: {
        ...base.spend,
        // The org's own key is refused (a demo visitor): the box key, per call.
        resolveKey: async (_orgId, _provider, opts) => {
          if (!opts) throw new DemoSpendRefusedError("demo_budget_exhausted")
          return { key: "sk-or-box-placeholder", source: "liaison" }
        },
        reserveVisitorStep: (async () => ({ id: "r1" })) as never,
        settleStep: (async () => {}) as never,
        releaseReservation: (async () => {}) as never,
      },
    }
    const pending = transcribe(
      {
        orgId: ORG_ID,
        userId: USER_ID,
        audio: new Uint8Array([1, 2, 3, 4]),
        contentType: "audio/webm",
        clean: false,
        signal: new AbortController().signal,
      },
      visitorDeps,
    )
    await until(() => requests.length === 1)
    jest.advanceTimersByTime(700)
    const res = await pending
    expect(res.model).toBe(HEDGE.key)
    expect(requests.map((r) => r.model)).toEqual([HEDGE.upstreamId])
  })

  it("an admin's explicit choice is one request, however slow", async () => {
    behaviours = {
      [PRIMARY.upstreamId]: { afterMs: 20_000, cost: 0.00009 },
      [HEDGE.upstreamId]: { afterMs: 700, cost: 0.00004 },
    }
    const { pending, state } = run({ model: PRIMARY, hedge: null })
    await until(() => requests.length === 1)
    jest.advanceTimersByTime(PRIMARY_GRACE_MS + 5_000)
    await until(() => true)
    expect(requests).toHaveLength(1)
    expect(state.settled).toBe(false)
    jest.advanceTimersByTime(20_000)
    const res = await pending
    expect(res.model).toBe(PRIMARY.key)
    expect(requests.map((r) => r.model)).toEqual([PRIMARY.upstreamId])
  })

  it("both failing: 502 upstream_failed, nothing metered, both reservations given back", async () => {
    behaviours = {
      [PRIMARY.upstreamId]: { afterMs: 300, status: 503 },
      [HEDGE.upstreamId]: { afterMs: 300, status: 503 },
    }
    const { pending } = run(DEFAULT_PLAN)
    const result = pending.catch((err: unknown) => err)
    await until(() => requests.length === 2)
    jest.advanceTimersByTime(300)
    const err = (await result) as { code?: string; status?: number }
    expect(err.code).toBe("upstream_failed")
    expect(err.status).toBe(502)
    expect(metered).toEqual([])
    expect(released).toBe(2)
  })
})
