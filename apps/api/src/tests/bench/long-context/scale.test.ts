// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The scale bench, on stub data. No network, no model, no key: the generator
// is pure and the flatness judgement is arithmetic.
import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { flatness, judgeScale, parseSize, percentile, readThread, type SizeRow } from "./scale"
import {
  buildNameTable,
  generateScaledThread,
  loadProofMessageIds,
  mutateCopy,
  nameMapFor,
  namesRegex,
  needleDropIndices,
  planCopy,
  reseedText,
} from "./scale-generator"
import type { CorpusRow } from "./types"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "scale-bench-"))
  dirs.push(dir)
  return dir
}

/** A 20 row corpus with every identifier shape the generator reseeds. */
function stubRows(): CorpusRow[] {
  const rows: CorpusRow[] = []
  for (let i = 0; i < 20; i++) {
    const week = Math.floor(i / 10) + 1
    const userTurn = i % 2 === 0
    rows.push({
      id: `m${10001 + i}`,
      week,
      ts: new Date(Date.UTC(2026, 8, 7, 8, i * 7)).toISOString(),
      authorType: userTurn ? "user" : "agent",
      author: userTurn ? "quinn" : "logistics",
      kind: "message",
      content: userTurn
        ? `Quinn asked Klangwerk about shipment BX-48213 on 2026-09-14, account 9614 2277 01, ref 4821.`
        : `Klangwerk confirms BX-48213 and ticket TCK-04821 at commit a3f9c2b1 with 4821 units.`,
    })
  }
  return rows
}

function stubCorpus(proofMessageIds: string[] = []): string {
  const dir = scratch()
  writeFileSync(
    join(dir, "messages.jsonl"),
    `${stubRows()
      .map((r) => JSON.stringify(r))
      .join("\n")}\n`,
  )
  writeFileSync(
    join(dir, "ledger.json"),
    JSON.stringify([
      {
        id: "L001",
        kind: "fact",
        plant_week: 1,
        supersede_week: null,
        plant_text: "shipment BX-48213",
        supersede_text: null,
        question: "What is the shipment reference?",
        answer: "BX-48213",
        answer_at_week: { "1": "BX-48213", "2": "BX-48213" },
        proof_hint: "BX-48213",
      },
    ]),
  )
  writeFileSync(
    join(dir, "probes.json"),
    JSON.stringify([
      {
        id: "P001",
        kind: "fact",
        question: "What is the shipment reference?",
        answer_at_week: { "1": "BX-48213", "2": "BX-48213" },
        ledger_id: "L001",
      },
    ]),
  )
  if (proofMessageIds.length > 0) {
    const map: Record<string, { overlap: number; messageId: string }> = {}
    proofMessageIds.forEach((messageId, index) => {
      map[`L00${index + 1}:plant_text`] = { overlap: 1, messageId }
    })
    writeFileSync(join(dir, "proof-map.json"), JSON.stringify(map, null, 2))
  }
  return dir
}

function reseedOnce(text: string, copy: number, seed = 7): string {
  const rows = stubRows()
  const table = buildNameTable(rows)
  const names = nameMapFor(table, copy, seed)
  return reseedText({
    text,
    plan: planCopy({ copy, seed, weeksPerCopy: 2, decoyRatio: 1 }),
    seed,
    names,
    namesRe: namesRegex(names),
    memo: new Map<string, string>(),
  })
}

describe("the scale generator", () => {
  it("reseeds a code consistently inside one copy", () => {
    const rows = stubRows()
    const table = buildNameTable(rows)
    const names = nameMapFor(table, 1, 7)
    const out = mutateCopy({
      rows,
      plan: planCopy({ copy: 1, seed: 7, weeksPerCopy: 2, decoyRatio: 1 }),
      seed: 7,
      names,
      idStride: 1_000_000,
      tsStartMs: Date.UTC(2026, 9, 1),
      originTsMs: Date.parse(rows[0]?.ts as string),
    })
    const codes = new Set<string>()
    for (const row of out) {
      const match = /BX-\d+/.exec(row.content)
      if (match) codes.add(match[0])
    }
    expect(codes.size).toBe(1)
    expect([...codes][0]).not.toBe("BX-48213")
  })

  it("reseeds the same code differently in different copies", () => {
    const one = /BX-\d+/.exec(reseedOnce("shipment BX-48213 moved", 1))?.[0]
    const two = /BX-\d+/.exec(reseedOnce("shipment BX-48213 moved", 2))?.[0]
    const three = /BX-\d+/.exec(reseedOnce("shipment BX-48213 moved", 3))?.[0]
    expect(one).toBeDefined()
    expect(new Set([one, two, three]).size).toBe(3)
  })

  it("keeps every identifier shape but the shape", () => {
    const out = reseedOnce(
      "BX-48213 CL-2261 TCK-04821 INC-3107 EM-20412 a3f9c2b1 9614 2277 01 on 2026-09-14",
      1,
    )
    expect(out).toMatch(/\bBX-\d{5}\b/)
    expect(out).toMatch(/\bCL-\d{4}\b/)
    expect(out).toMatch(/\bTCK-\d{5}\b/)
    expect(out).toMatch(/\bINC-\d{4}\b/)
    expect(out).toMatch(/\bEM-\d{5}\b/)
    expect(out).toMatch(/\b[0-9a-f]{8}\b/)
    expect(out).not.toContain("BX-48213")
    expect(out).not.toContain("a3f9c2b1")
  })

  it("shifts ISO dates by the copy's week offset", () => {
    // weeksPerCopy 2 means copy 1 starts 14 days later, copy 2 another 14.
    expect(reseedOnce("due 2026-09-14", 1)).toContain("2026-09-28")
    expect(reseedOnce("due 2026-09-14", 2)).toContain("2026-10-12")
  })

  it("writes the original corpus first and unchanged", () => {
    const corpusDir = stubCorpus()
    const out = scratch()
    const threadPath = join(out, "thread-test.jsonl")
    const result = generateScaledThread({
      corpusDir,
      targetTokens: 4_000,
      seed: 7,
      threadPath,
    })
    const written = readThread(threadPath)
    const original = stubRows()
    expect(result.rows).toBeGreaterThan(original.length)
    expect(written.slice(0, original.length)).toEqual(original)
  })

  it("scales a 20 row corpus to 100 rows keeping row order and unique ids", () => {
    const corpusDir = stubCorpus()
    const out = scratch()
    const threadPath = join(out, "thread-test.jsonl")
    // Five copies of a 20 row corpus. The target is set from the measured
    // token size of one copy so the generator stops at exactly five.
    const oneCopy = generateScaledThread({
      corpusDir,
      targetTokens: 1,
      seed: 7,
      threadPath: join(out, "probe.jsonl"),
    })
    const result = generateScaledThread({
      corpusDir,
      targetTokens: oneCopy.tokens * 4 + 1,
      seed: 7,
      threadPath,
    })
    expect(result.rows).toBe(100)
    expect(result.copies).toBe(5)
    const rows = readThread(threadPath)
    expect(new Set(rows.map((r) => r.id)).size).toBe(100)
    const stamps = rows.map((r) => Date.parse(r.ts))
    expect(stamps.every((t, i) => i === 0 || t >= (stamps[i - 1] as number))).toBe(true)
    const weeks = rows.map((r) => r.week)
    expect(weeks.every((w, i) => i === 0 || w >= (weeks[i - 1] as number))).toBe(true)
    expect(Math.max(...weeks)).toBe(10)
  })

  it("leaves the ledger alone and carries the probes to the final week", () => {
    const corpusDir = stubCorpus()
    const out = scratch()
    const corpusOutDir = join(out, "corpus")
    mkdirSync(corpusOutDir, { recursive: true })
    const result = generateScaledThread({
      corpusDir,
      targetTokens: 4_000,
      seed: 7,
      threadPath: join(out, "thread-test.jsonl"),
      corpusOutDir,
    })
    const ledger = readFileSync(join(corpusOutDir, "ledger.json"), "utf8")
    expect(JSON.parse(ledger)[0].answer).toBe("BX-48213")
    const probes = JSON.parse(readFileSync(join(corpusOutDir, "probes.json"), "utf8"))
    expect(probes[0].answer_at_week[String(result.finalWeek)]).toBe("BX-48213")
  })

  it("is deterministic from the seed and different under another one", () => {
    const corpusDir = stubCorpus()
    const out = scratch()
    const a = join(out, "a.jsonl")
    const b = join(out, "b.jsonl")
    const c = join(out, "c.jsonl")
    generateScaledThread({ corpusDir, targetTokens: 4_000, seed: 7, threadPath: a })
    generateScaledThread({ corpusDir, targetTokens: 4_000, seed: 7, threadPath: b })
    generateScaledThread({ corpusDir, targetTokens: 4_000, seed: 8, threadPath: c })
    expect(readFileSync(a, "utf8")).toBe(readFileSync(b, "utf8"))
    expect(readFileSync(c, "utf8")).not.toBe(readFileSync(a, "utf8"))
  })

  it("keeps the original wording at decoy ratio 1 and changes it at 0", () => {
    const corpusDir = stubCorpus()
    const out = scratch()
    const decoys = join(out, "decoys.jsonl")
    const mutated = join(out, "mutated.jsonl")
    generateScaledThread({
      corpusDir,
      targetTokens: 4_000,
      seed: 7,
      decoyRatio: 1,
      threadPath: decoys,
    })
    generateScaledThread({
      corpusDir,
      targetTokens: 4_000,
      seed: 7,
      decoyRatio: 0,
      threadPath: mutated,
    })
    const tail = (path: string): string =>
      readThread(path)
        .slice(20)
        .map((r) => r.content)
        .join(" ")
    expect(tail(decoys)).toContain("shipment")
    expect(tail(mutated)).not.toContain("shipment")
    expect(tail(mutated)).toContain("consignment")
  })
})

describe("the flatness judgement", () => {
  it("passes a flat series and fails a growing one", () => {
    expect(flatness([1000, 1010, 1020]).flat).toBe(true)
    expect(flatness([1000, 2000, 10_000]).flat).toBe(false)
    expect(flatness([1000, 1000, 1000]).spreadPct).toBe(0)
  })

  it("reduces the three scale properties to pass or fail", () => {
    const row = (label: string, fed: number, advance: number, reads: number): SizeRow =>
      ({
        label,
        targetTokens: 0,
        rows: 0,
        tokens: 0,
        copies: 1,
        decoyCopies: 0,
        droppedPerCopy: 0,
        finalWeek: 1,
        bm25BuildMs: 0,
        bm25IndexBytes: 0,
        bm25Docs: 0,
        embeddingBuildMs: null,
        embeddingVectors: null,
        embeddingBytes: null,
        embeddingSkipped: null,
        latency: { bm25: { p50Ms: 0, p95Ms: 0, queries: 0 }, embedding: null, fused: null },
        meanFedTokens: fed,
        fedTokenSamples: 1,
        resumeRowReads: reads,
        fedRows: 100,
        advanceTokens: [advance],
        meanAdvanceTokens: advance,
        needle: { bm25: { probes: 1, recallAt5: 1, mrr: 1 }, embedding: null, fused: null },
        rssPeakBytes: 0,
        generateMs: 0,
        accuracyPct: null,
        accuracyReportPath: null,
        strategyNote: null,
      }) satisfies SizeRow
    const flat = judgeScale([row("100k", 9000, 2000, 0), row("1m", 9100, 2010, 0)])
    expect(flat.every((v) => v.pass)).toBe(true)
    const growing = judgeScale([row("100k", 9000, 2000, 0), row("1m", 90_000, 20_000, 500_000)])
    expect(growing.map((v) => v.pass)).toEqual([false, false, false])
  })
})

describe("the drop needles mode", () => {
  it("drops a proof row and its reply from every mutated copy", () => {
    // The last two rows of the stub are proof rows: the second has no reply
    // after it, so a copy loses exactly two rows and keeps eighteen.
    const corpusDir = stubCorpus(["m10019", "m10020"])
    expect(loadProofMessageIds(corpusDir)).toEqual(new Set(["m10019", "m10020"]))
    const out = scratch()
    const kept = join(out, "kept.jsonl")
    const dropped = join(out, "dropped.jsonl")
    generateScaledThread({ corpusDir, targetTokens: 4_000, seed: 7, threadPath: kept })
    const result = generateScaledThread({
      corpusDir,
      targetTokens: 4_000,
      seed: 7,
      dropNeedles: true,
      threadPath: dropped,
    })
    expect(result.droppedPerCopy).toBe(2)
    const keptRows = readThread(kept)
    const droppedRows = readThread(dropped)
    // The original corpus spans weeks 1 and 2, so the first mutated copy is
    // weeks 3 and 4. It carries 20 rows normally and 18 in drop mode.
    const firstCopy = (all: CorpusRow[]): CorpusRow[] =>
      all.filter((r) => r.week === 3 || r.week === 4)
    expect(keptRows.slice(0, 20)).toEqual(droppedRows.slice(0, 20))
    expect(firstCopy(keptRows).length).toBe(20)
    expect(firstCopy(droppedRows).length).toBe(18)
    expect(droppedRows.filter((r) => r.week <= 2).length).toBe(20)
  })

  it("takes the reply row with a proof row in the middle of a copy", () => {
    const rows = stubRows()
    expect([...needleDropIndices(rows, new Set(["m10005"]))].sort((a, b) => a - b)).toEqual([4, 5])
    const corpusDir = stubCorpus(["m10005"])
    const out = scratch()
    const path = join(out, "thread.jsonl")
    const result = generateScaledThread({
      corpusDir,
      targetTokens: 4_000,
      seed: 7,
      dropNeedles: true,
      threadPath: path,
    })
    expect(result.droppedPerCopy).toBe(2)
    const written = readThread(path)
    expect(written.filter((r) => r.week === 3 || r.week === 4).length).toBe(18)
    expect(written.filter((r) => r.week <= 2).length).toBe(20)
  })

  it("leaves the needle unique to the original copy", () => {
    const corpusDir = stubCorpus(["m10005"])
    const out = scratch()
    const path = join(out, "thread.jsonl")
    generateScaledThread({
      corpusDir,
      targetTokens: 8_000,
      seed: 7,
      dropNeedles: true,
      threadPath: path,
    })
    const written = readThread(path)
    // m10005 is a user row carrying BX-48213, and its agent reply repeats it.
    // With both dropped from every copy, the original code appears in the
    // original copy alone.
    const carriers = written.filter((r) => r.content.includes("BX-48213"))
    expect(carriers.length).toBeGreaterThan(0)
    expect(carriers.every((r) => Number(r.id.replace(/^m/, "")) < 100_000)).toBe(true)
  })
})

describe("the measurement helpers", () => {
  it("reads sizes and percentiles", () => {
    expect(parseSize("100k")).toBe(100_000)
    expect(parseSize("1m")).toBe(1_000_000)
    expect(parseSize("10m")).toBe(10_000_000)
    expect(() => parseSize("banana")).toThrow()
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10)
  })
})
