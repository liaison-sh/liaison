// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Segment-webhook handler tests — the core connector logic:
//   • first segment of a call creates the per-call knowledge doc (create-or-get
//     via deterministic title + cross-app idempotencyKey, NO body in the create
//     so the exact-title redirect can never wipe accumulated segments)
//   • subsequent segments append via read-modify-write under knowledge's
//     revision token
//   • duplicate segmentId → no-op (doc-layer idempotency), including under a
//     revision race
//   • REVISION_CONFLICT → bounded re-read-and-retry; two concurrent appends
//     both land (no lost update)
//   • out-of-order ts lands in order; summary deliveries replace `## Résumé`
//     wholesale; malformed envelope → 400; persistent failure → 503
import { describe, expect, it } from "bun:test"
import { callTitleFor, parseCallDoc } from "./doc-format"
import { docByTitle, makeCtx } from "./test-ctx"
import { segmentWebhookHandler } from "./webhooks"

const CALL = "meet-2026-07-06-abc"
const TITLE = callTitleFor(CALL)

function segPayload(id: string, tsIso: string, text = `text ${id}`, speaker = "Alice") {
  return { callRef: CALL, segmentId: id, ts: tsIso, speaker, text }
}

describe("segmentWebhookHandler — create and append", () => {
  it("creates the per-call doc on the first segment and lands the segment exactly once", async () => {
    const { ctx, spy } = makeCtx()
    const res = await segmentWebhookHandler(segPayload("s1", "2026-07-06T10:00:00Z"), ctx)
    expect(res.status).toBe(200)

    const doc = docByTitle(spy, TITLE)
    expect(doc).not.toBeNull()
    const parsed = parseCallDoc(doc!.body)
    expect(parsed.segments.map((s) => s.segmentId)).toEqual(["s1"])

    // The doc-resolving create is deterministic: no body (so a redirect can
    // never wipe the doc) and a per-call idempotencyKey.
    const create = spy.calls.find((c) => c.target === "knowledge:create")!
    expect(create.args.body).toBeUndefined()
    expect(create.args.title).toBe(TITLE)
    expect(create.args.documentScope).toBe("organization")
    expect(create.args.idempotencyKey).toBe(`calls:doc:${CALL}`)
  })

  it("appends subsequent segments to the same doc (no duplicate docs)", async () => {
    const { ctx, spy } = makeCtx()
    await segmentWebhookHandler(segPayload("s1", "2026-07-06T10:00:00Z"), ctx)
    await segmentWebhookHandler(segPayload("s2", "2026-07-06T10:00:20Z"), ctx)
    expect(spy.docs.size).toBe(1)
    const parsed = parseCallDoc(docByTitle(spy, TITLE)!.body)
    expect(parsed.segments.map((s) => s.segmentId)).toEqual(["s1", "s2"])
  })

  it("keeps two different calls in two different docs", async () => {
    const { ctx, spy } = makeCtx()
    await segmentWebhookHandler(segPayload("s1", "2026-07-06T10:00:00Z"), ctx)
    await segmentWebhookHandler({ ...segPayload("s1", "2026-07-06T10:00:05Z"), callRef: "other-call" }, ctx)
    expect(spy.docs.size).toBe(2)
  })

  it("inserts an out-of-order (late) segment at its ts position", async () => {
    const { ctx, spy } = makeCtx()
    await segmentWebhookHandler(segPayload("s1", "2026-07-06T10:00:00Z"), ctx)
    await segmentWebhookHandler(segPayload("s3", "2026-07-06T10:00:40Z"), ctx)
    await segmentWebhookHandler(segPayload("s2", "2026-07-06T10:00:20Z"), ctx)
    const parsed = parseCallDoc(docByTitle(spy, TITLE)!.body)
    expect(parsed.segments.map((s) => s.segmentId)).toEqual(["s1", "s2", "s3"])
  })
})

describe("segmentWebhookHandler — idempotency and races", () => {
  it("is a no-op for a re-delivered segmentId (marker already in the doc)", async () => {
    const { ctx, spy } = makeCtx()
    await segmentWebhookHandler(segPayload("s1", "2026-07-06T10:00:00Z"), ctx)
    const bodyBefore = docByTitle(spy, TITLE)!.body
    const res = await segmentWebhookHandler(segPayload("s1", "2026-07-06T10:00:00Z", "ALTERED"), ctx)
    expect(res.status).toBe(200)
    expect(docByTitle(spy, TITLE)!.body).toBe(bodyBefore)
    const parsed = parseCallDoc(docByTitle(spy, TITLE)!.body)
    expect(parsed.segments.length).toBe(1)
  })

  it("retries on REVISION_CONFLICT: a competing write between read and update does not lose either segment", async () => {
    const { ctx, spy } = makeCtx()
    await segmentWebhookHandler(segPayload("s1", "2026-07-06T10:00:00Z"), ctx)
    // Interleave: while s2's handler holds the just-read revision, another
    // delivery (s9) lands and bumps it — s2's first update MUST conflict,
    // re-read, and re-apply.
    spy.onBeforeFirstUpdate = async () => {
      await segmentWebhookHandler(segPayload("s9", "2026-07-06T10:00:30Z"), ctx)
    }
    // Reset the hook trigger AFTER attaching (the nested handler's own update
    // must not re-fire it) — makeCtx arms it for the next update only.
    const res = await segmentWebhookHandler(segPayload("s2", "2026-07-06T10:00:20Z"), ctx)
    expect(res.status).toBe(200)
    const parsed = parseCallDoc(docByTitle(spy, TITLE)!.body)
    expect(parsed.segments.map((s) => s.segmentId)).toEqual(["s1", "s2", "s9"])
  })

  it("dedups under a race: a duplicate racing the original delivery lands exactly one marker", async () => {
    const { ctx, spy } = makeCtx()
    // The outer handler (duplicate) reads the doc BEFORE s1 exists; while it
    // holds that snapshot, the ORIGINAL s1 delivery lands (hook). The outer
    // update then loses the revision race, re-reads, finds the s1 marker in
    // the fresh body, and no-ops — the in-loop dedup is what makes this safe,
    // not a pre-check (no TOCTOU: the revision compare IS the CAS).
    spy.onBeforeFirstUpdate = async () => {
      await segmentWebhookHandler(segPayload("s1", "2026-07-06T10:00:00Z", "ORIGINAL"), ctx)
    }
    const res = await segmentWebhookHandler(segPayload("s1", "2026-07-06T10:00:00Z", "DUPLICATE"), ctx)
    expect(res.status).toBe(200)
    const parsed = parseCallDoc(docByTitle(spy, TITLE)!.body)
    expect(parsed.segments.filter((s) => s.segmentId === "s1").length).toBe(1)
    expect(parsed.segments[0]!.text).toBe("ORIGINAL") // the winner's text, never overwritten
  })

  it("two concurrent first segments of the same call converge to ONE doc holding both", async () => {
    const { ctx, spy } = makeCtx()
    const [a, b] = await Promise.all([
      segmentWebhookHandler(segPayload("s1", "2026-07-06T10:00:00Z"), ctx),
      segmentWebhookHandler(segPayload("s2", "2026-07-06T10:00:20Z"), ctx),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(spy.docs.size).toBe(1)
    const parsed = parseCallDoc(docByTitle(spy, TITLE)!.body)
    expect(parsed.segments.map((s) => s.segmentId).sort()).toEqual(["s1", "s2"])
  })

  it("returns 503 when the update keeps failing so the sender retries (replay claim released by the kernel)", async () => {
    const { ctx, spy } = makeCtx()
    await segmentWebhookHandler(segPayload("s1", "2026-07-06T10:00:00Z"), ctx)
    spy.failUpdatesRemaining = 99
    const res = await segmentWebhookHandler(segPayload("s2", "2026-07-06T10:00:20Z"), ctx)
    expect(res.status).toBe(503)
  })

  // C1/C2 (M5 code review, minor, carried to U8.4): when the post-REVISION_CONFLICT
  // re-read (readDoc → knowledge:get) itself transiently fails, the PRE-FIX loop
  // fell back to resolveOrCreateDoc — which, because the create call reuses the
  // SAME deterministic idempotencyKey, replays the CACHED create-time response
  // (stale revision) rather than a fresh read. That stale-revision update is
  // doomed to re-conflict, burning one of MAX_ATTEMPTS=5 on a no-op round-trip
  // (self-correcting via the CAS, but needlessly easier to exhaust attempts
  // under a bad network blip + concurrent contention). The fix (C1's own
  // "required_fix", applied here): retry the re-read itself (bounded, sharing
  // the same MAX_ATTEMPTS budget) before ever falling back to
  // resolveOrCreateDoc, so a transient knowledge:get hiccup costs nothing more
  // than one extra get. This test pins BOTH halves of the contract: (a) no data
  // loss / no attempts-exhausted even with one failed re-read (the safety net
  // C1 already described), and (b) — the actual fix — the loop resolves via a
  // real re-read, NEVER re-issuing knowledge:create after the first attempt.
  it("retries the post-conflict re-read on a transient knowledge:get failure instead of falling back to the idempotency-cache create", async () => {
    const { ctx, spy } = makeCtx()
    await segmentWebhookHandler(segPayload("s1", "2026-07-06T10:00:00Z"), ctx)

    spy.onBeforeFirstUpdate = async () => {
      // Force exactly one REVISION_CONFLICT on s2's first update.
      await segmentWebhookHandler(segPayload("s9", "2026-07-06T10:00:30Z"), ctx)
      // The loop's post-conflict re-read (readDoc) will hit this once and
      // return null (simulated transient knowledge:get hiccup). Reset the
      // call log AFTER the nested s9 handler's own (unrelated) create-or-get
      // completes, so only calls from s2's own retry loop are counted below.
      spy.failGetsRemaining = 1
      spy.calls.length = 0
    }

    const res = await segmentWebhookHandler(segPayload("s2", "2026-07-06T10:00:20Z"), ctx)
    expect(res.status).toBe(200)
    const parsed = parseCallDoc(docByTitle(spy, TITLE)!.body)
    expect(parsed.segments.map((s) => s.segmentId)).toEqual(["s1", "s2", "s9"]) // nothing lost

    // The call log was reset right after the forced REVISION_CONFLICT (s2's
    // own legitimate first-attempt create already happened before that point
    // and is intentionally excluded). From here on, a FIXED loop retries the
    // post-conflict re-read (knowledge:get) — it must NEVER fall back to
    // resolveOrCreateDoc (which would show up as a knowledge:create call).
    const ownCreates = spy.calls.filter((c) => c.target === "knowledge:create").length
    expect(ownCreates).toBe(0)
    // At least two knowledge:get calls: the failed one + the successful retry.
    const ownGets = spy.calls.filter((c) => c.target === "knowledge:get").length
    expect(ownGets).toBeGreaterThanOrEqual(2)
  })
})

describe("segmentWebhookHandler — summary deliveries", () => {
  it("writes the rolling summary into `## Résumé` and replaces it wholesale on the next delivery", async () => {
    const { ctx, spy } = makeCtx()
    await segmentWebhookHandler(segPayload("s1", "2026-07-06T10:00:00Z"), ctx)
    await segmentWebhookHandler(
      { callRef: CALL, kind: "summary", ts: "2026-07-06T10:10:00Z", text: "V1", isFinal: false },
      ctx,
    )
    await segmentWebhookHandler(
      { callRef: CALL, kind: "summary", ts: "2026-07-06T10:20:00Z", text: "V2", isFinal: false },
      ctx,
    )
    const body = docByTitle(spy, TITLE)!.body
    const parsed = parseCallDoc(body)
    expect(parsed.summary!.text).toBe("V2")
    expect(body).not.toContain("V1")
    expect(parsed.segments.length).toBe(1)
  })

  it("a final summary (isFinal) replaces the rolling one and round-trips the flag", async () => {
    const { ctx, spy } = makeCtx()
    await segmentWebhookHandler(
      { callRef: CALL, kind: "summary", ts: "2026-07-06T10:10:00Z", text: "rolling", isFinal: false },
      ctx,
    )
    await segmentWebhookHandler(
      { callRef: CALL, kind: "summary", ts: "2026-07-06T11:00:00Z", text: "final", isFinal: true },
      ctx,
    )
    const parsed = parseCallDoc(docByTitle(spy, TITLE)!.body)
    expect(parsed.summary!.text).toBe("final")
    expect(parsed.summary!.isFinal).toBe(true)
  })

  it("a summary arriving before any segment creates the doc too", async () => {
    const { ctx, spy } = makeCtx()
    const res = await segmentWebhookHandler(
      { callRef: CALL, kind: "summary", ts: "2026-07-06T10:10:00Z", text: "early", isFinal: false },
      ctx,
    )
    expect(res.status).toBe(200)
    expect(docByTitle(spy, TITLE)).not.toBeNull()
  })
})

describe("segmentWebhookHandler — rejection", () => {
  it("rejects a malformed envelope with 400 and performs no knowledge write", async () => {
    const { ctx, spy } = makeCtx()
    const res = await segmentWebhookHandler({ callRef: CALL, text: "no segmentId, no kind" }, ctx)
    expect(res.status).toBe(400)
    expect(spy.calls.length).toBe(0)
  })

  it("rejects a non-object payload with 400", async () => {
    const { ctx, spy } = makeCtx()
    const res = await segmentWebhookHandler("nope", ctx)
    expect(res.status).toBe(400)
    expect(spy.calls.length).toBe(0)
  })
})
