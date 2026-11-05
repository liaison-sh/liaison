// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Loading a corpus: three files on disk, nothing seeded through any service.
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Corpus, CorpusRow, LedgerItem, Probe } from "./types"

export function parseMessagesJsonl(text: string): CorpusRow[] {
  const rows: CorpusRow[] = []
  let lineNo = 0
  for (const line of text.split("\n")) {
    lineNo++
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: CorpusRow
    try {
      parsed = JSON.parse(trimmed) as CorpusRow
    } catch (err) {
      throw new Error(`messages.jsonl line ${lineNo} is not JSON: ${String(err)}`)
    }
    if (!parsed.id || typeof parsed.content !== "string" || typeof parsed.week !== "number") {
      throw new Error(`messages.jsonl line ${lineNo} is missing id, week or content`)
    }
    rows.push(parsed)
  }
  return rows
}

/**
 * Probes when `probes.json` is absent: every non throwaway ledger item, asked
 * as its own question. No distractors exist in this shape, and the report says
 * so rather than reporting a distractor accuracy it did not measure.
 */
export function deriveProbes(ledger: LedgerItem[]): Probe[] {
  return ledger
    .filter((item) => item.kind !== "throwaway")
    .slice(0, 100)
    .map((item) => ({
      id: `derived-${item.id}`,
      kind: item.kind,
      question: item.question,
      answer_at_week: item.answer_at_week,
      ledger_id: item.id,
    }))
}

/**
 * The first line of the answerer's system prompt: who the agent is and who it
 * talks to. A corpus overrides it with a `persona.md` beside its messages; the
 * default is the logistics DM the bench was first built on.
 */
export const DEFAULT_PERSONA =
  "You are @logistics, the operations agent in a long running direct message with Quinn."

export function loadCorpus(dir: string): Corpus {
  const messagesPath = join(dir, "messages.jsonl")
  const ledgerPath = join(dir, "ledger.json")
  const probesPath = join(dir, "probes.json")
  if (!existsSync(messagesPath)) throw new Error(`no messages.jsonl under ${dir}`)
  if (!existsSync(ledgerPath)) throw new Error(`no ledger.json under ${dir}`)
  const raw = readFileSync(messagesPath, "utf8")
  const rows = parseMessagesJsonl(raw)
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as LedgerItem[]
  const probesDerived = !existsSync(probesPath)
  const probes = probesDerived
    ? deriveProbes(ledger)
    : (JSON.parse(readFileSync(probesPath, "utf8")) as Probe[])
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16)
  const personaPath = join(dir, "persona.md")
  const persona = existsSync(personaPath)
    ? readFileSync(personaPath, "utf8").trim()
    : DEFAULT_PERSONA
  return { rows, ledger, probes, probesDerived, hash, persona }
}

/** Every row up to and including the resume week. */
export function rowsThroughWeek(rows: CorpusRow[], week: number): CorpusRow[] {
  return rows.filter((r) => r.week <= week)
}

/** How one row is rendered wherever the bench shows verbatim transcript. */
export function renderRow(row: CorpusRow): string {
  const label = row.kind === "tool_result" ? `${row.author} (tool result)` : row.author
  return `[${row.id} ${row.ts}] ${label}: ${row.content}`
}

export function renderRows(rows: CorpusRow[]): string {
  return rows.map(renderRow).join("\n")
}

/**
 * The rows that prove a ledger item: every row whose content carries the
 * item's `proof_hint`. Search quality is measured against these ids, never
 * against the answer text.
 */
export function proofRowIds(rows: CorpusRow[], hint: string): string[] {
  const needle = hint.trim().toLowerCase()
  if (!needle) return []
  return rows.filter((r) => r.content.toLowerCase().includes(needle)).map((r) => r.id)
}
