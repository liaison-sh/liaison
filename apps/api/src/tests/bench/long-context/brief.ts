// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The structured brief (S2 and up). The prompt lives with the production
// prompts, at `apps/api/src/modules/agent/prompts/compaction-brief.md`, so
// the strategy the bench crowns can be shipped by pointing at the same file.
//
// The brief is built INCREMENTALLY: the brief through week N is the brief
// through week N minus 1 plus that week's rows. A resume at week 4 therefore
// reads a brief that was written four times, exactly as a live conversation
// would have compacted it.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderRows } from "./corpus"
import { estimateTokens } from "./tokens"
import type { CorpusRow, SummarizeHook } from "./types"

export const BRIEF_TOKEN_CAP = 1500
export const CORE_TOKEN_CAP = 400
export const EPISODE_TOKEN_CAP = 300

export const BRIEF_SECTIONS = [
  "Current decisions",
  "Open loops",
  "Identifiers and entities",
  "Standing procedures",
  "Unresolved contradictions",
] as const

const PROMPT_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "modules",
  "agent",
  "prompts",
  "compaction-brief.md",
)

let cachedPrompt: string | null = null
export function briefPrompt(): string {
  if (cachedPrompt === null) cachedPrompt = readFileSync(PROMPT_PATH, "utf8")
  return cachedPrompt
}

export interface ParsedBrief {
  sections: Record<string, string[]>
  missingSections: string[]
  /** Lines that carry no [message id] attribution. */
  unattributedLines: string[]
  tokens: number
  withinCap: boolean
}

const ID_RE = /\[[^\]]*\]\s*$/

/**
 * Read a brief back. This is the bench's own check that the prompt did what it
 * was told: the five sections are present, every line is attributed, the cap
 * holds. A brief that fails it is still measured, and the failure is reported.
 */
export function parseBrief(text: string, cap = BRIEF_TOKEN_CAP): ParsedBrief {
  const sections: Record<string, string[]> = {}
  let current: string | null = null
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    const heading = line.replace(/^#+\s*/, "").trim()
    if (/^#+\s/.test(line) && (BRIEF_SECTIONS as readonly string[]).includes(heading)) {
      current = heading
      sections[current] = []
      continue
    }
    if (!line || current === null) continue
    if (/^#+\s/.test(line)) {
      current = null
      continue
    }
    sections[current]?.push(line.replace(/^[-*]\s*/, ""))
  }
  const missingSections = BRIEF_SECTIONS.filter((s) => !(s in sections))
  const unattributedLines: string[] = []
  for (const lines of Object.values(sections)) {
    for (const line of lines) {
      if (line.toLowerCase() === "none") continue
      if (!ID_RE.test(line)) unattributedLines.push(line)
    }
  }
  const tokens = estimateTokens(text)
  return { sections, missingSections, unattributedLines, tokens, withinCap: tokens <= cap }
}

/**
 * The cap is enforced on the way out, not trusted to the model: sections are
 * kept in the prompt's priority order and the first one that does not fit is
 * dropped, so an over long brief loses procedures before it loses decisions.
 */
export function enforceCap(text: string, cap = BRIEF_TOKEN_CAP): string {
  if (estimateTokens(text) <= cap) return text
  const parsed = parseBrief(text, cap)
  const out: string[] = []
  for (const section of BRIEF_SECTIONS) {
    const lines = parsed.sections[section]
    if (!lines || lines.length === 0) continue
    const block = [`### ${section}`, ...lines.map((l) => `- ${l}`)].join("\n")
    const candidate = [...out, block].join("\n\n")
    if (estimateTokens(candidate) > cap) break
    out.push(block)
  }
  const joined = out.join("\n\n")
  if (joined) return joined
  // Nothing fits section wise (a brief with no headings at all): hard clip.
  return text.slice(0, cap * 4)
}

function weekRegion(rows: CorpusRow[], week: number): CorpusRow[] {
  return rows.filter((r) => r.week === week)
}

export interface BriefBuild {
  text: string
  /** Every model token the incremental build cost, summed over the weeks. */
  tokens: number
}

/**
 * The brief through `week`, built week by week from `rows`. `sizeInstruction`
 * is how S6 asks the same prompt for a 400 token core or a 300 token episode.
 */
export async function buildIncrementalBrief(params: {
  rows: CorpusRow[]
  throughWeek: number
  summarize: SummarizeHook
  cap?: number
  sizeInstruction?: string
}): Promise<BriefBuild> {
  const cap = params.cap ?? BRIEF_TOKEN_CAP
  const weeks = [...new Set(params.rows.map((r) => r.week))]
    .filter((w) => w <= params.throughWeek)
    .sort((a, b) => a - b)
  let brief = ""
  let tokens = 0
  for (const week of weeks) {
    const region = weekRegion(params.rows, week)
    if (region.length === 0) continue
    const prompt = [
      briefPrompt(),
      params.sizeInstruction ? `\n## Size for this brief\n\n${params.sizeInstruction}` : "",
      "\n## The brief so far\n\n",
      brief || "(empty, this is the first region)",
    ].join("")
    const result = await params.summarize(
      prompt,
      `## The new region (week ${week})\n\n${renderRows(region)}`,
    )
    tokens += result.tokens
    brief = enforceCap(result.text.trim(), cap)
  }
  return { text: brief, tokens }
}

/**
 * The brief written ONCE over the whole pre tail region, in a single call
 * (S10). The question it answers is whether building week by week loses open
 * loops that a single pass over everything would keep.
 */
export async function buildOneShotBrief(params: {
  rows: CorpusRow[]
  summarize: SummarizeHook
  cap?: number
}): Promise<BriefBuild> {
  const cap = params.cap ?? BRIEF_TOKEN_CAP
  if (params.rows.length === 0) return { text: "", tokens: 0 }
  const result = await params.summarize(
    `${briefPrompt()}\n## The brief so far\n\n(empty, this is the whole conversation in one pass)`,
    `## The region\n\n${renderRows(params.rows)}`,
  )
  return { text: enforceCap(result.text.trim(), cap), tokens: result.tokens }
}

/** One episode brief per week, for S6. Each is built from that week alone. */
export async function buildEpisodeBriefs(params: {
  rows: CorpusRow[]
  throughWeek: number
  summarize: SummarizeHook
}): Promise<{ episodes: Map<number, string>; tokens: number }> {
  const weeks = [...new Set(params.rows.map((r) => r.week))]
    .filter((w) => w <= params.throughWeek)
    .sort((a, b) => a - b)
  const episodes = new Map<number, string>()
  let tokens = 0
  for (const week of weeks) {
    const region = weekRegion(params.rows, week)
    if (region.length === 0) continue
    const result = await params.summarize(
      `${briefPrompt()}\n## Size for this brief\n\nThis is the episode brief for week ${week} alone. Hard cap ${EPISODE_TOKEN_CAP} tokens.`,
      `## The new region (week ${week})\n\n${renderRows(region)}`,
    )
    tokens += result.tokens
    episodes.set(week, enforceCap(result.text.trim(), EPISODE_TOKEN_CAP))
  }
  return { episodes, tokens }
}
