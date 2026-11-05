// SPDX-License-Identifier: FSL-1.1-ALv2
import { scrubText } from "~/lib/scrub"

const MAX_SIGNATURES = 500
const RING_SIZE = 50
const WINDOW_MS = 60 * 60 * 1000

const DIGIT_RUN = /\d+/g
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g
const LONG_HEX = /\b[0-9a-fA-F]{8,}\b/g
const QUOTED_STRING = /"[^"]*"|'[^']*'/g

function normalizeMessage(message: string): string {
  let result = message
  result = result.replace(UUID, "<uuid>")
  result = result.replace(QUOTED_STRING, "<str>")
  result = result.replace(LONG_HEX, "<hex>")
  result = result.replace(DIGIT_RUN, "#")
  return result
}

// Strips the trailing :line:column (and any surrounding parens) from a stack frame so the
// signature identifies "this throw site's function/file", not "this exact line" -- two
// invocations of the very same `throw`/`new Error(...)` statement can legitimately report
// different line:column in their captured frame depending on caller inlining, so leaving
// the position in would fragment one logical error into many signatures.
const FRAME_POSITION = /:\d+:\d+\)?$/

// A real V8/Bun stack frame line. Everything else in `stack` is the error MESSAGE
// (which may span several lines: Drizzle/postgres.js "Failed query: ...\nparams: 9000,..."
// puts the bound parameters on their own line). Only frames may become the signature's
// third component -- a message continuation line carries raw per-call values that the
// normalizer never saw, so every occurrence would look like a NEW signature (observed:
// one social-sync statement timeout per quarter hour, each a fresh critical email).
const STACK_FRAME = /^\s*at\s/

function topAppFrame(stack: string | undefined): string {
  if (!stack) return ""
  const lines = stack.split("\n")
  for (const line of lines) {
    if (!STACK_FRAME.test(line)) continue
    if (line.includes("node_modules")) continue
    if (line.includes("node:internal") || line.includes("node:")) continue
    return line.trim().replace(FRAME_POSITION, "")
  }
  return ""
}

/**
 * Same extraction rules as the watchdog's ops/monitor/src/signature.ts -- kept dependency-free
 * and duplicated here (rather than imported cross-repo) since Liaison has its own package
 * graph.
 */
function extractSignature(errName: string, message: string, stack: string | undefined): string {
  // Scrub the normalized message BEFORE it becomes the signature: normalizeMessage strips
  // digits/UUIDs/quoted/hex but NOT free-text emails or unquoted secret shapes, and the
  // signature is returned verbatim in the token-gated /diag response. scrubText gives the
  // signature the same value-level PII/secret guarantee as lastSample.
  const normalized = scrubText(normalizeMessage(message))
  const frame = topAppFrame(stack)
  return `${errName}|${normalized}|${frame}`
}

interface TrackedSignature {
  signature: string
  occurrences: number[] // epoch ms timestamps within the rolling window
  lastSample: string
  lastSeenMs: number
}

const signatures = new Map<string, TrackedSignature>()

export interface DiagErrorSignature {
  signature: string
  count1h: number
  lastSample: string
}

export interface DiagErrorState {
  errorSignatures: DiagErrorSignature[]
}

/**
 * Records one error occurrence. Signature = errName + normalized message + top app frame.
 * The sample (message + stack) is scrubbed via scrubText BEFORE storage -- this is the
 * value-level PII/secret guarantee, not path-based Pino redaction. Bounded: max 500
 * signatures, LRU-evicted by last-seen when a new signature would exceed the cap.
 */
export function trackError(
  err: unknown,
  _context?: { path?: string; method?: string },
  now: Date = new Date(),
): void {
  const errObj = err instanceof Error ? err : new Error(String(err))
  const signature = extractSignature(errObj.name || "Error", errObj.message, errObj.stack)
  const nowMs = now.getTime()

  let entry = signatures.get(signature)
  if (!entry) {
    if (signatures.size >= MAX_SIGNATURES) {
      evictOldest()
    }
    entry = { signature, occurrences: [], lastSample: "", lastSeenMs: nowMs }
    signatures.set(signature, entry)
  }

  entry.occurrences.push(nowMs)
  entry.lastSeenMs = nowMs
  const sampleText = `${errObj.message}${errObj.stack ? `\n${errObj.stack}` : ""}`
  entry.lastSample = scrubText(sampleText).slice(0, RING_SIZE * 1000)
}

function evictOldest(): void {
  let oldestKey: string | null = null
  let oldestSeen = Infinity
  for (const [key, entry] of signatures) {
    if (entry.lastSeenMs < oldestSeen) {
      oldestSeen = entry.lastSeenMs
      oldestKey = key
    }
  }
  if (oldestKey) signatures.delete(oldestKey)
}

/**
 * Returns the current diag payload shape: signatures sorted by 1h-window count descending,
 * capped at 50 entries. Aged-out occurrences (older than the rolling 1h window relative to
 * `now`) are excluded from count1h without mutating stored state.
 */
export function getDiagErrorState(now: Date = new Date()): DiagErrorState {
  const nowMs = now.getTime()
  const result: DiagErrorSignature[] = []
  for (const entry of signatures.values()) {
    const count1h = entry.occurrences.filter((ts) => nowMs - ts < WINDOW_MS).length
    if (count1h === 0) continue
    result.push({ signature: entry.signature, count1h, lastSample: entry.lastSample })
  }
  result.sort((a, b) => b.count1h - a.count1h)
  return { errorSignatures: result.slice(0, 50) }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const ErrorTrackerTestAccess = {
  /**
   * Test-only reset seam, guarded by NODE_ENV per house rules (no raw test*() methods left
   * live in production).
   */
  reset(): void {
    if (process.env.NODE_ENV === "production") {
      throw new Error("ErrorTrackerTestAccess.reset must never be called in production")
    }
    signatures.clear()
  },
}
