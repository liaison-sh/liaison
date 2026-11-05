// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression guard for spec-security.md A14: withheld capability names are
// private to the requester and never placed in a message shared into the
// room. Concretely: no function this slice (P2a) exports that returns a
// string meant for a reply or message body may ever put a raw scope string
// (an `app:resource:action`-shaped string, recognizable here by its `:`
// separators) into that string.
//
// The only such function today is `describeWithheldCapabilities` (T19): it
// maps each withheld scope to a category label, never the scope itself. This
// test fuzzes it across 20+ randomly generated scope strings and asserts the
// `:` character never survives into the output, so a future "simplification"
// of the fallback case (e.g. `return [withheldScopes[0]]`) is caught here
// rather than in production.
//
// What this test does NOT cover (2b's job, not yet wired):
// - The withheld list is not yet threaded onto the turn's run frame or into
//   the model's context (spec-security.md's "first-class context field"), so
//   there is no end-to-end path from a live turn to a rendered reply to
//   assert against yet.
// - 4b's UI-level assertion against the actual rendered card/reply text is a
//   later slice's job; this test only exercises the structural path from
//   `withheldCapabilities` through `describeWithheldCapabilities`.

import { describe, expect, test } from "bun:test"
import { describeWithheldCapabilities } from "./withheld-capability"

/** Deterministic PRNG (mulberry32) so the fuzz set is fixed across runs. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORD_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_"

function randomWord(rand: () => number, minLen = 3, maxLen = 12): string {
  const len = minLen + Math.floor(rand() * (maxLen - minLen + 1))
  let out = ""
  for (let i = 0; i < len; i++) {
    out += WORD_CHARS[Math.floor(rand() * WORD_CHARS.length)]
  }
  return out
}

/** Generates an `app:resource:action`-shaped scope string. */
function randomScope(rand: () => number): string {
  return `${randomWord(rand)}:${randomWord(rand)}:${randomWord(rand)}`
}

const FUZZ_SEED = 0x5ca1ab1e
const FUZZ_SIZE = 37 // comfortably above the required 20

describe("withheld capability names never leak into a public-facing string", () => {
  test("describeWithheldCapabilities never emits a raw scope string, across 37 randomized scopes", () => {
    const rand = mulberry32(FUZZ_SEED)
    const scopes: string[] = []
    for (let i = 0; i < FUZZ_SIZE; i++) {
      scopes.push(randomScope(rand))
    }
    expect(scopes.length).toBeGreaterThanOrEqual(20)

    // Half the apps get a category label, half fall back to the generic
    // label: both paths must stay colon free.
    const categoryLabels: Record<string, string> = {}
    for (const scope of scopes) {
      const app = scope.split(":")[0]
      if (rand() < 0.5) {
        categoryLabels[app] = `${randomWord(rand)} data`
      }
    }

    const out = describeWithheldCapabilities(scopes, categoryLabels)

    for (const label of out) {
      expect(label.includes(":")).toBe(false)
    }
    // No output element may equal, or be built from, any raw input scope.
    for (const scope of scopes) {
      expect(out).not.toContain(scope)
    }
  })

  test("each individual randomized scope, described alone, never leaks its own colon-joined form", () => {
    const rand = mulberry32(FUZZ_SEED + 1)
    for (let i = 0; i < 25; i++) {
      const scope = randomScope(rand)
      const out = describeWithheldCapabilities([scope], {})
      for (const label of out) {
        expect(label.includes(":")).toBe(false)
      }
    }
  })
})
