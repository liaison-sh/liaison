// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-FX2: the fabrication rate of a failed ask, measured rather than assumed.
//
// NOT a test and never discovered as one (no `.test.ts` suffix, no assertions):
// a defect that shows up in a fraction of live runs cannot be pinned by one
// run, so this drives scenarios 2 and 3 N times each through the SAME harness
// the live suite uses and counts how often the human facing reply states a
// currency figure that no tool result carried. It exists so the rate can be
// re-measured on demand, before and after a prompt or tool change, which is
// what the calibration rule asks for: derive the number from measurement,
// never gate on a guess.
//
// Run it by hand, from `apps/api`, with the org's Google key in the
// environment (it runs real models and costs real tokens):
//
//   bun run --env-file=<env> src/tests/e2e/agent-coordination/fabrication-rate.ts \
//     <label> <iterations> <output.jsonl>
//
// Measured on 2026-09-13, gemini-flash-lite-latest agents, scenarios 2 and 3.
// Every run it made was retained, one jsonl line each, and the rows below
// are counted from those files rather than remembered:
//   before (post-FX1, pre-4c317958): 26 runs, 2 flagged, 7.7 percent
//     fx2-smoke.jsonl 2 runs 1 flagged, fx2-before.jsonl 12 runs 0 flagged,
//     fx2-before2.jsonl 12 runs 1 flagged
//   after  (4c317958):               48 runs, 1 flagged, 2.1 percent
//     fx2-after.jsonl 24 runs 0 flagged, fx2-after2.jsonl 24 runs 1 flagged
// THE PILOT IS COUNTED AND RE-SCORED. fx2-smoke is the two run pilot that
// proved the script worked; it ran the same fixtures under the same rule as
// every run after it, so it is part of the before pool and its one fabrication
// is one of the two. Excluding it would be picking a sample after seeing it.
// This file used to record 30 runs and 4 fabrications (13.3 percent). That is
// not what the retained files carry, and the retained files are the evidence.
// The direction holds and the conclusion does not change: the fix reduces the
// rate, it does not eliminate it, and one fabrication survives in 48 runs.
// The whole measurement cost 18,609,802 tokens over 74 scenario runs.
import {
  type Fixture,
  humanSays,
  INVOICE_REFERENCE,
  mention,
  readMessages,
  readTurnUsage,
  seedFixture,
  teardownFixture,
  totalTokens,
} from "./harness"

if (!process.env.GOOGLE_API_KEY) {
  console.log("[fx2-measure] GOOGLE_API_KEY is not set: nothing ran, and nothing is measured.")
  process.exit(1)
}

const LABEL = process.argv[2] ?? "run"
const ITERATIONS = Number(process.argv[3] ?? 6)
const OUT = process.argv[4] ?? `/tmp/fabrication-${LABEL}.jsonl`

/** A currency shaped figure: two decimals, or an explicit currency marker. */
const FIGURE = /(?:EUR|USD|GBP|€|\$|£)\s?\d[\d.,  ]*\d|\d{1,3}(?:[.,  ]\d{3})*[.,]\d{2}\b/g

function digitsOf(s: string): string {
  return s.replace(/[^0-9]/g, "")
}

function scenario3Options(label: string) {
  return {
    label,
    alexCeiling: ["kernel"],
    alexPrompt: [
      "You are Alex, a personal assistant.",
      'Whatever the question is, call agents_ask with agentHandle "@logistics" and pass the question on.',
      '"@logistics" is the ONLY agent you may ask. Never ask "@finance" and never ask anybody else.',
      "You hold no records of your own and must never state a figure, an amount or a date yourself.",
      'When the answer does not come back, reply with exactly this sentence and nothing else: "I could not get an answer to that."',
      "Otherwise reply in one sentence reporting exactly what came back.",
    ].join(" "),
    logisticsPrompt: [
      "You are the logistics agent.",
      'Whatever the question is, call agents_ask with agentHandle "@finance" and pass the question on.',
      'If that call is refused, reply with exactly this sentence and nothing else: "I could not pass the question on."',
    ].join(" "),
  }
}

async function runOnce(scenario: "s2" | "s3", i: number): Promise<void> {
  let f: Fixture | undefined
  try {
    f =
      scenario === "s2"
        ? await seedFixture({ label: `fx2-${LABEL}-s2-${i}`, alexCeiling: ["kernel"] })
        : await seedFixture(scenario3Options(`fx2-${LABEL}-s3-${i}`))
    await humanSays(f, `${mention(f.alex)} what is the total on invoice ${INVOICE_REFERENCE}?`)
    const rows = await readMessages(f)
    const finals = rows.filter((r) => r.authorAgentId === f?.alex.id && r.parentMessageId === null)
    const final = finals[finals.length - 1]
    const reply = final?.content ?? ""
    // Everything any tool on any turn of this room returned.
    const toolText = rows
      .map((r) => JSON.stringify((r.metadata as { toolCalls?: unknown } | null)?.toolCalls ?? []))
      .join(" ")
    // In both scenarios the ledger tool is unreachable, so no tool result ever
    // carries the figure. A figure in the reply is carried by a tool result
    // ONLY when the ledger lookup actually ran and returned that same number.
    const ledgerTotals = [...toolText.matchAll(/"total":"([^"]+)"/g)].map((m) => digitsOf(m[1]))
    const found = [...reply.matchAll(FIGURE)].map((m) => m[0])
    const fabricated = found.filter((x) => {
      const d = digitsOf(x)
      return d.length >= 3 && !ledgerTotals.includes(d)
    })
    const tokens = totalTokens(await readTurnUsage(f))
    const record = {
      label: LABEL,
      scenario,
      i,
      fabricated: fabricated.length > 0,
      figures: fabricated,
      tokens,
      reply: reply.replace(/\s+/g, " ").slice(0, 300),
    }
    await Bun.write(OUT, `${await readOut(OUT)}${JSON.stringify(record)}\n`)
    console.log(`[fx2-measure] ${JSON.stringify(record)}`)
  } catch (err) {
    const record = { label: LABEL, scenario, i, error: String(err).slice(0, 300) }
    await Bun.write(OUT, `${await readOut(OUT)}${JSON.stringify(record)}\n`)
    console.log(`[fx2-measure] ${JSON.stringify(record)}`)
  } finally {
    await teardownFixture(f)
  }
}

async function readOut(path: string): Promise<string> {
  const file = Bun.file(path)
  return (await file.exists()) ? await file.text() : ""
}

for (let i = 1; i <= ITERATIONS; i++) {
  await runOnce("s2", i)
  await runOnce("s3", i)
}
console.log("[fx2-measure] DONE")
process.exit(0)
