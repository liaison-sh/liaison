// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The resume behaviour, end to end over the fixture corpus with a stub model.
// No network: the answerer, the summarizer and the judge are all local here.
import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { answerKey, loadExisting, runBench } from "./run"
import { buildStrategies } from "./strategies"
import type { Answerer, AnswerRecord } from "./types"

const FIXTURE = join(import.meta.dir, "fixtures", "mini")
const dirs: string[] = []

function outDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "long-context-bench-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function stubAnswerer(counters: { answers: number; summaries: number }): Answerer {
  return {
    modelId: "stub-model",
    async answer() {
      counters.answers++
      return {
        text: "the DHL account number is 7492118",
        toolCalls: 0,
        toolPayloadChars: 0,
        providerInputTokens: 1234,
        latencyMs: 5,
      }
    },
    async summarize() {
      counters.summaries++
      return { text: "### Current decisions\n- a decision [m000004]", tokens: 100 }
    },
  }
}

const stubJudge = {
  modelId: "stub-judge",
  path: "provider" as const,
  fallbackReason: "",
  async score() {
    return 2
  },
}

describe("the strategy roster", () => {
  it("carries the round two variants alongside the originals", () => {
    const ids = buildStrategies({ embeddingApiKey: null }).map((s) => s.id)
    expect(ids.slice(0, 11)).toEqual([
      "S0",
      "S1",
      "S2",
      "S3",
      "S4",
      "S5",
      "S6",
      "S7",
      "S8",
      "S9",
      "S10",
    ])
  })
})

describe("the bench runner", () => {
  it("writes one answers.jsonl row per cell and skips them on a second run", async () => {
    const out = outDir()
    const counters = { answers: 0, summaries: 0 }
    const options = {
      corpusDir: FIXTURE,
      outDir: out,
      strategyIds: ["S2"],
      answerer: "gemini" as const,
      resumePoints: [2],
      answererOverride: stubAnswerer(counters),
      judgeOverride: stubJudge,
      concurrency: 4,
      // The fixture fits inside the real tail, so the brief path only runs at
      // all with a tail small enough to leave a head behind.
      smallTailTokens: 400,
    }
    await runBench(options)
    const first = counters.answers
    expect(first).toBe(6) // the fixture's six probes
    // The brief is built once per resume point, not once per probe.
    expect(counters.summaries).toBe(2) // two weeks of incremental brief
    const answersPath = join(out, "answers.jsonl")
    const rows = loadExisting(answersPath)
    expect(rows.size).toBe(6)
    expect(rows.has(answerKey("S2", 2, "P1"))).toBe(true)

    await runBench(options)
    expect(counters.answers).toBe(first)
    expect(loadExisting(answersPath).size).toBe(6)
  })

  it("ignores a half written last line left by a kill", () => {
    const out = outDir()
    const path = join(out, "answers.jsonl")
    const good: Partial<AnswerRecord> = { key: "S2|2|P1", strategyId: "S2" }
    Bun.write(path, `${JSON.stringify(good)}\n{"key":"S2|2|P2",`)
    // Bun.write is async; read back synchronously after it settles.
    return Bun.write(path, `${JSON.stringify(good)}\n{"key":"S2|2|P2",`).then(() => {
      const rows = loadExisting(path)
      expect(rows.size).toBe(1)
      expect(rows.has("S2|2|P1")).toBe(true)
    })
  })

  it("writes a report naming the models that actually ran", async () => {
    const out = outDir()
    await runBench({
      corpusDir: FIXTURE,
      outDir: out,
      strategyIds: ["S2"],
      answerer: "gemini",
      resumePoints: [2],
      answererOverride: stubAnswerer({ answers: 0, summaries: 0 }),
      judgeOverride: stubJudge,
    })
    expect(existsSync(join(out, "report.md"))).toBe(true)
    const report = readFileSync(join(out, "report.md"), "utf8")
    expect(report).toContain("stub-model")
    expect(report).toContain("stub-judge")
    expect(report).toContain("Compaction brief prompt")
    const json = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as {
      overall: { strategyId: string; accuracyPct: number }[]
    }
    expect(json.overall[0]?.accuracyPct).toBe(100)
  })
})

describe("what the runner records and persists", () => {
  it("records an empty final answer as an error cell, never as a judged answer", async () => {
    const out = outDir()
    let judged = 0
    await runBench({
      corpusDir: FIXTURE,
      outDir: out,
      strategyIds: ["S2"],
      answerer: "gemini",
      resumePoints: [2],
      smallTailTokens: 400,
      probeLimit: 2,
      answererOverride: {
        modelId: "empty-model",
        async answer() {
          return {
            text: "   ",
            toolCalls: 3,
            toolPayloadChars: 0,
            providerInputTokens: 10,
            latencyMs: 1,
          }
        },
        async summarize() {
          return { text: "### Current decisions\n- a decision [m000004]", tokens: 10 }
        },
      },
      judgeOverride: {
        modelId: "stub-judge",
        path: "provider",
        fallbackReason: "",
        async score() {
          judged++
          return 2
        },
      },
    })
    const rows = [...loadExisting(join(out, "answers.jsonl")).values()]
    expect(rows).toHaveLength(2)
    expect(judged).toBe(0)
    for (const row of rows) {
      expect(row.score).toBeNull()
      expect(row.error).toContain("empty final answer")
    }
  })

  it("generates a shared brief once and leaves it on disk with its token count", async () => {
    const out = outDir()
    const counters = { answers: 0, summaries: 0 }
    await runBench({
      corpusDir: FIXTURE,
      outDir: out,
      // S3 reuses S2's brief: two strategies, one generation.
      strategyIds: ["S2", "S3"],
      answerer: "gemini",
      resumePoints: [2],
      smallTailTokens: 400,
      probeLimit: 2,
      answererOverride: stubAnswerer(counters),
      judgeOverride: stubJudge,
    })
    expect(counters.answers).toBe(4)
    expect(counters.summaries).toBe(2) // two weeks of one incremental brief
    const brief = readFileSync(join(out, "context", "S2-week2.md"), "utf8")
    expect(brief).toContain("model tokens to generate")
    expect(brief).toContain("Current decisions")
    // The exact history the model saw, for the first probes of each strategy.
    const dump = readFileSync(join(out, "context", "S3-week2-probe-P1.txt"), "utf8")
    expect(dump).toContain("=== system ===")
    expect(dump).toContain("recalled-memory")
  })
})
