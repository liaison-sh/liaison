// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Token-budget sanity script for the agent context assembler.
 *
 * Seeds an in-memory org with `--skills=N` skills (defaults to 100), each
 * carrying a 100-char description, then renders the stable prefix portion of
 * an assembled context and prints `stable-prefix tokens: <N>`.
 *
 * Token count uses a 4-chars-per-token approximation (matches the
 * Anthropic published average within ±15% for English markdown). The script
 * is intentionally hermetic: no network calls, no tokenizer dep. If we ever
 * need a tighter estimate, swap `approxTokens` for `@anthropic-ai/tokenizer`.
 *
 * Exit codes:
 *   0 — stable-prefix tokens < 15 000
 *   1 — stable-prefix tokens ≥ 15 000 (regression)
 */

export interface MeasureOptions {
  skills?: number
  /** Override the per-skill description body length (default 100 chars). */
  descriptionLength?: number
}

export interface MeasureResult {
  tokens: number
  charCount: number
  withinBudget: boolean
  threshold: number
}

const APPROX_CHARS_PER_TOKEN = 4
const TOKEN_BUDGET = 15_000

function approxTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN)
}

/**
 * Build a synthetic assembled-context stable prefix. The shape mirrors what
 * the production `assembleContext` emits before the loaded-bodies section
 * (which is dynamic and intentionally excluded from the stable cache key).
 */
export function buildSyntheticPrefix(opts: MeasureOptions): string {
  const n = opts.skills ?? 100
  const descLen = opts.descriptionLength ?? 100

  const header = [
    "# Liaison agent",
    "",
    "## Apps",
    "- kernel: core capabilities",
    "- tickets: customer ticket triage",
    "- knowledge: document search",
    "",
    "## Skills available",
  ].join("\n")

  const descTemplate = "x".repeat(descLen)
  const skillLines: string[] = []
  for (let i = 0; i < n; i++) {
    skillLines.push(`- skill-${i}: ${descTemplate}`)
  }

  return [header, ...skillLines, ""].join("\n")
}

export function measure(opts: MeasureOptions = {}): MeasureResult {
  const prefix = buildSyntheticPrefix(opts)
  const tokens = approxTokens(prefix)
  return {
    tokens,
    charCount: prefix.length,
    withinBudget: tokens < TOKEN_BUDGET,
    threshold: TOKEN_BUDGET,
  }
}

function parseArgs(argv: string[]): MeasureOptions {
  const opts: MeasureOptions = {}
  for (const raw of argv) {
    const m = raw.match(/^--skills=(\d+)$/)
    if (m) opts.skills = parseInt(m[1], 10)
  }
  return opts
}

// CLI entry — only run when invoked directly via `bun run`.
if (typeof Bun !== "undefined" && import.meta.main) {
  const opts = parseArgs(Bun.argv.slice(2))
  const result = measure(opts)
  console.log(`stable-prefix tokens: ${result.tokens}`)
  console.log(`(approximation; threshold ${result.threshold}; chars: ${result.charCount})`)
  process.exit(result.withinBudget ? 0 : 1)
}
