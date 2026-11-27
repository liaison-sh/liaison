// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One vector width per instance (EMBEDDING_DIMENSIONS): what every provider
// path stores, what the query side embeds at, and what the leader does when
// the index was built at another width.
//
// THE MUTATIONS THAT PROVE THESE BITE
//  * Drop the normalisation in fitEmbedding: a cut vector's norm is not 1.
//  * Keep the full provider vector: the length is 3072, not 768.
//  * Let text-embedding-004 claim 1536: embeddingDimensionsFor answers 1536.
//  * Drop `dimensions` from the OpenRouter body: the field is missing.
//  * Re-enqueue a chain step under its own id: the next step's id repeats.
//  * Let the width check act on a width no provider makes: a rebuild is asked for a test index.
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as backfill from "~/infra/jobs/embedding-backfill"
import * as jobsModule from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import * as envModule from "~/lib/env"
import { redis } from "~/lib/redis"
import { buildOpenRouterEmbeddingRequest } from "~/modules/agent/providers/openrouter-embeddings"
import {
  configuredEmbeddingDimensions,
  DEFAULT_EMBEDDING_DIMENSIONS,
  embeddingDimensionsFor,
  fitEmbedding,
  fitEmbeddings,
} from "~/modules/search/embedding-dimensions"
import { parseReembedMember, reembedItemOf } from "~/modules/search/reembed-queue"
import * as reindexModule from "~/modules/search/reindex"

const spies: Array<{ mockRestore: () => void }> = []
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
})

function norm(v: number[]): number {
  return Math.sqrt(v.reduce((a, x) => a + x * x, 0))
}

describe("the configured width", () => {
  it("defaults to 768", () => {
    expect(DEFAULT_EMBEDDING_DIMENSIONS).toBe(768)
    expect(envModule.env.EMBEDDING_DIMENSIONS).toBe(768)
    expect(configuredEmbeddingDimensions()).toBe(768)
  })

  it("is one of the widths a provider makes, and nothing else", () => {
    const parse = (v: string) =>
      envModule.envSchema.safeParse({ ...process.env, EMBEDDING_DIMENSIONS: v })
    expect(parse("1536").data?.EMBEDDING_DIMENSIONS).toBe(1536)
    expect(parse("").data?.EMBEDDING_DIMENSIONS).toBe(768)
    expect(parse("1000").success).toBe(false)
  })

  it("is what a model embeds at, unless the model cannot reach it", () => {
    expect(embeddingDimensionsFor("gemini-embedding-001", 768)).toBe(768)
    expect(embeddingDimensionsFor("gemini-embedding-001", 3072)).toBe(3072)
    expect(embeddingDimensionsFor("text-embedding-004", 768)).toBe(768)
    expect(embeddingDimensionsFor("text-embedding-004", 1536)).toBeNull()
    expect(embeddingDimensionsFor("gemini-embedding-001")).toBe(768)
  })
})

describe("fitting a provider vector", () => {
  it("cuts a full width vector to the configured width and normalises it", () => {
    const full = Array.from({ length: 3072 }, (_, i) => ((i % 7) - 3) / 10)
    const fitted = fitEmbedding(full, 768)
    expect(fitted).toHaveLength(768)
    expect(norm(fitted as number[])).toBeCloseTo(1, 10)
    // Same direction as the vector's opening: a scaled copy of it.
    const scale = (fitted as number[])[1] / (full[1] as number)
    expect((fitted as number[])[5]).toBeCloseTo((full[5] as number) * scale, 12)
  })

  it("normalises a vector already at the width (a provider that honoured the request)", () => {
    expect(fitEmbedding([3, 4], 2)).toEqual([0.6, 0.8])
  })

  it("refuses a vector too short, not numeric, or all zero", () => {
    expect(fitEmbedding([1, 2, 3], 4)).toBeNull()
    expect(fitEmbedding([1, Number.NaN, 3, 4], 4)).toBeNull()
    expect(fitEmbedding([0, 0, 0, 0], 4)).toBeNull()
    expect(fitEmbedding(null, 4)).toBeNull()
  })

  it("keeps positions over a batch, leaving a misfit out", () => {
    const out = fitEmbeddings([[1, 0, 0], [1], [0, 2, 0]], 2)
    expect(out[0]).toEqual([1, 0])
    expect(out[1]).toBeUndefined()
    expect(out[2]).toEqual([0, 1])
  })
})

describe("the OpenRouter request", () => {
  it("asks for the width", () => {
    const body = buildOpenRouterEmbeddingRequest("google/gemini-embedding-001", ["a"], 768)
    expect(body.dimensions).toBe(768)
    expect(body.provider).toMatchObject({ zdr: true })
  })
})

describe("noting documents for re-embedding", () => {
  it("names the row each document is rebuilt from", () => {
    expect(reembedItemOf({ entity_type: "message", entity_id: "m1" })).toEqual({
      kind: "message",
      id: "m1",
    })
    // A window is rebuilt by re-indexing its anchor message.
    expect(reembedItemOf({ entity_type: "message_window", entity_id: "t1:m9" })).toEqual({
      kind: "message",
      id: "m9",
    })
    expect(reembedItemOf({ entity_type: "brief_row", entity_id: "b1" })).toEqual({
      kind: "brief_row",
      id: "b1",
    })
    expect(reembedItemOf({ entity_type: "ticket", entity_id: "x" })).toBeNull()
    expect(parseReembedMember("episode:e1")).toEqual({ kind: "episode", id: "e1" })
    expect(parseReembedMember("ticket:x")).toBeNull()
  })
})

describe("the re-embed chain", () => {
  it("continues under a new id while rows are left, waits for the index, stops when done", async () => {
    const enqueued: Array<{ id?: string; delay?: number }> = []
    spies.push(
      spyOn(jobsModule, "enqueueAppJob").mockImplementation((async (
        _a: string,
        _n: string,
        _p: unknown,
        opts?: { jobId?: string; delay?: number },
      ) => {
        enqueued.push({ id: opts?.jobId, delay: opts?.delay })
        return "job"
      }) as never),
    )
    await backfill.runReembedStep({ orgId: "o1", step: 3 }, async () => ({
      status: "embedded",
      embedded: 50,
      left: 10,
    }))
    await backfill.runReembedStep({ orgId: "o1", step: 4 }, async () => ({
      status: "waiting_for_index",
    }))
    await backfill.runReembedStep({ orgId: "o1", step: 5 }, async () => ({
      status: "embedded",
      embedded: 10,
      left: 0,
    }))
    await backfill.runReembedStep({ orgId: "o1", step: 6 }, async () => ({ status: "locked" }))
    expect(enqueued.map((e) => e.id)).toEqual([
      `${backfill.EMBEDDING_REEMBED_JOB}:o1:4`,
      `${backfill.EMBEDDING_REEMBED_JOB}:o1:5`,
    ])
    expect(enqueued[1]?.delay).toBeGreaterThan(enqueued[0]?.delay ?? 0)
  })
})

describe("the leader's width check", () => {
  function indexDeclaring(width: number | null) {
    spies.push(spyOn(envModule, "offlineSideCalls").mockReturnValue(false))
    const getSettings = async () => ({
      embedders: width === null ? {} : { memory: { source: "userProvided", dimensions: width } },
    })
    spies.push(
      spyOn(searchClientModule, "getMeili").mockReturnValue({
        index: () => ({ getSettings }),
      } as unknown as ReturnType<typeof searchClientModule.getMeili>),
    )
    const asked: Array<number | undefined> = []
    spies.push(
      spyOn(reindexModule, "requestIndexRebuild").mockImplementation((async (
        _reason: string,
        opts?: { embedderDimensions?: number },
      ) => {
        asked.push(opts?.embedderDimensions)
      }) as never),
    )
    // No org waits for a re-embed.
    spies.push(spyOn(redis, "smembers").mockImplementation((async () => []) as never))
    return asked
  }

  it("asks for a rebuild at the configured width when the index has another", async () => {
    const asked = indexDeclaring(3072)
    await backfill.checkMemoryEmbedderWidth()
    expect(asked).toEqual([768])
  })

  it("does nothing when the widths agree, or none is declared, or the width is no provider's", async () => {
    for (const width of [768, null, 4]) {
      const asked = indexDeclaring(width)
      await backfill.checkMemoryEmbedderWidth()
      expect(asked).toEqual([])
      for (const s of spies.splice(0)) s.mockRestore()
    }
  })
})
