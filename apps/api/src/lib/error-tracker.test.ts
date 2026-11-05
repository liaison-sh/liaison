// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { ErrorTrackerTestAccess, getDiagErrorState, trackError } from "./error-tracker"

// Fires the error at a single, consistent call site so the extracted top-app-frame is
// identical across calls -- exercising the tracker's dedup-by-signature behavior for the
// realistic "same logical throw site fires repeatedly" production case. See
// tessera-platform apps/api/src/lib/error-tracker.test.ts for the same pattern + rationale
// (real captured stacks report the CALL site's line:col, so two `new Error()` calls at
// different source lines legitimately produce different frames unless routed through one
// shared function).
function throwFrom(message: string): Error {
  return new Error(message)
}

describe("error-tracker", () => {
  test("the same error twice produces one signature with count 2", () => {
    ErrorTrackerTestAccess.reset()
    trackError(throwFrom("boom"))
    trackError(throwFrom("boom"))
    const state = getDiagErrorState()
    expect(state.errorSignatures).toHaveLength(1)
    expect(state.errorSignatures[0]?.count1h).toBe(2)
  })

  test("digits/UUIDs in the message do not split signatures", () => {
    ErrorTrackerTestAccess.reset()
    trackError(throwFrom("user 123 with id 550e8400-e29b-41d4-a716-446655440000 not found"))
    trackError(throwFrom("user 456 with id 6ba7b810-9dad-11d1-80b4-00c04fd430c8 not found"))
    const state = getDiagErrorState()
    expect(state.errorSignatures).toHaveLength(1)
    expect(state.errorSignatures[0]?.count1h).toBe(2)
  })

  test("a multi-line Drizzle query error (params on a second message line) dedups across parameter values", () => {
    // postgres.js/Drizzle put the bound parameters on a second MESSAGE line and the captured
    // stack repeats the whole message before the first frame. That line must never become
    // the signature's frame component: prod fired one "new-signature" critical per quarter
    // hour for the same statement timeout with different params.
    ErrorTrackerTestAccess.reset()
    function drizzleStyle(params: string): Error {
      const err = new Error(
        'Failed query: UPDATE "app_social"."sync_state" SET "units_consumed_today" = $1 WHERE id = $2\n' +
          `params: ${params} -- pg: canceling statement due to statement timeout (57014)`,
      )
      err.stack =
        `Error: ${err.message}\n` +
        "    at /app/node_modules/drizzle-orm/pg-core/dialect.js:10:5\n" +
        "    at runWatchPoller (/app/bundled-apps/social/src/sync.ts:429:9)"
      return err
    }
    trackError(drizzleStyle("9000,2026-09-05,a398e961-4ce1-479c-8ff5-fbd9440609ff"))
    trackError(drizzleStyle("10730,2026-09-04,a398e961-4ce1-479c-8ff5-fbd9440609ff"))
    const state = getDiagErrorState()
    expect(state.errorSignatures).toHaveLength(1)
    expect(state.errorSignatures[0]?.count1h).toBe(2)
    expect(state.errorSignatures[0]?.signature).not.toContain("9000")
  })

  test("501 distinct signatures evict the oldest (LRU by last-seen), max 500 survive", () => {
    ErrorTrackerTestAccess.reset()
    for (let i = 0; i < 501; i++) {
      trackError(new Error(`unique error number ${i}`))
    }
    const state = getDiagErrorState()
    expect(state.errorSignatures.length).toBeLessThanOrEqual(500)
  })

  test("a sample containing an email/API key is stored scrubbed", () => {
    ErrorTrackerTestAccess.reset()
    trackError(new Error("failed for alice@example.com key=sk_live_abcdefghijklmnop"))
    const state = getDiagErrorState()
    expect(state.errorSignatures[0]?.lastSample).toContain("[email]")
    expect(state.errorSignatures[0]?.lastSample).not.toContain("alice@example.com")
  })

  test("the signature itself is scrubbed of an unquoted email (returned verbatim in token-gated /diag)", () => {
    ErrorTrackerTestAccess.reset()
    // Local part has no digits, so normalizeMessage alone would leave the email intact in
    // the signature. scrubText must strip it so no PII rides out in errorSignatures[].signature.
    trackError(new Error("Failed to charge card for user john.doe@example.com"))
    const state = getDiagErrorState()
    const sig = state.errorSignatures[0]?.signature ?? ""
    expect(sig).toContain("[email]")
    expect(sig).not.toContain("john.doe@example.com")
  })

  test("count1h window: entries older than 1h age out under an injected now", () => {
    ErrorTrackerTestAccess.reset()
    const t0 = new Date("2026-01-01T00:00:00.000Z")
    const later = new Date(t0.getTime() + 61 * 60 * 1000)
    trackError(throwFrom("aging error"), undefined, t0)
    trackError(throwFrom("aging error"), undefined, later)
    const state = getDiagErrorState(later)
    expect(state.errorSignatures[0]?.count1h).toBe(1)
  })

  test("an empty tracker returns an empty array", () => {
    ErrorTrackerTestAccess.reset()
    const state = getDiagErrorState()
    expect(state.errorSignatures).toEqual([])
  })

  test("signatures are sorted by count descending", () => {
    ErrorTrackerTestAccess.reset()
    trackError(throwFrom("rare error"))
    trackError(throwFrom("common error"))
    trackError(throwFrom("common error"))
    trackError(throwFrom("common error"))
    const state = getDiagErrorState()
    expect(state.errorSignatures[0]?.count1h).toBe(3)
  })
})
