// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `segment` webhook handler — turns a signed transcript delivery (segment
// or summary) into an idempotent write on the per-call knowledge document.
// The kernel has already verified the HMAC signature, the signed-ts freshness
// window, and the transport-level replay key before this runs (lib/hmac.ts +
// modules/webhooks/routes.ts).
//
// Write path (the connector's whole job):
//   1. RESOLVE-OR-CREATE the per-call doc: look it up by title (current, then
//      legacy; tools.ts resolveCallDocId), else ONE deterministic cross-app
//      `knowledge:create` — title `Appel : <callRef>` (exact-title upsert
//      guard: an existing doc is RETURNED, not duplicated), NO body (so the
//      redirect can never wipe accumulated segments), and a per-call
//      `idempotencyKey` (Redis-reserved — two concurrent FIRST segments
//      serialize instead of double-creating; the cross-app
//      idempotency contract).
//   2. Parse the body, apply the delivery (segment: dedup-by-marker +
//      insert-in-ts-order; summary: replace `## Résumé` wholesale).
//   3. `knowledge:update` under the just-read revision. On REVISION_CONFLICT
//      (knowledge service.ts throws, never retries server-side) → re-read via
//      `knowledge:get` and re-apply — bounded attempts. The revision compare
//      IS the compare-and-swap: a racing duplicate loses the revision race,
//      re-reads, finds its marker already present, and no-ops.
//
// Failure contract (shared route semantics, same as monitoring/ci-status):
// malformed envelope → 400 (sender bug, no retry); anything transient or
// attempts-exhausted → 503 so the kernel releases the replay claim and the
// sender's retry re-delivers.
import type { WebhookResult } from "@liaison/app-sdk"
import type { CallsCtx, CrossAppEnvelope } from "./ctx"
import {
  applySegment,
  applySummary,
  type CallDoc,
  callTitleFor,
  parseCallDoc,
  renderCallDoc,
} from "./doc-format"
import { type CallsEnvelope, parseCallsEnvelope } from "./envelope"
import { resolveCallDocId } from "./tools"

export type { WebhookResult }

const OK: WebhookResult = { status: 200, body: "ok" }

/** Bounded read-modify-write attempts. Concurrent segment delivery (15-30s
 *  cadence bursts) is the expected steady state, not an edge case — but the
 *  contention window is one document per call, so a handful of immediate
 *  retries absorbs it (no sleep: QuickJS has no timer primitive, and the
 *  kernel-level 503-retry is the backoff of last resort). */
const MAX_ATTEMPTS = 5

interface DocSnapshot {
  id: string
  revision: number
  body: string
}

function isRevisionConflict(env: CrossAppEnvelope): boolean {
  if (env.status !== "error") return false
  return /revision[_ ]?conflict/i.test(`${env.error.code} ${env.error.message}`)
}

/** Idempotency-reservation contention — another concurrent call holds the
 *  same key (`idempotency_in_flight`) or a stale reservation conflicted; both
 *  resolve by retrying, which replays the cached result or re-resolves. */
function isIdempotencyContention(env: CrossAppEnvelope): boolean {
  if (env.status !== "error") return false
  return /^idempotency_(in_flight|conflict)$/.test(env.error.code)
}

function snapshotFromDocResult(result: unknown): DocSnapshot | null {
  const r = result as { id?: unknown; revision?: unknown; body?: unknown } | null
  if (!r || typeof r.id !== "string" || typeof r.revision !== "number") return null
  return { id: r.id, revision: r.revision, body: typeof r.body === "string" ? r.body : "" }
}

/**
 * Resolve the per-call document, creating it when absent. Deterministic
 * params (derived from callRef ONLY — the idempotency reservation hashes the
 * params, so any variance would turn a replay into a conflict): no body, a
 * fixed tag filing the doc under the transcript "collection" surface.
 */
async function resolveOrCreateDoc(ctx: CallsCtx, callRef: string): Promise<DocSnapshot> {
  // An existing document wins, under the current OR the legacy title: the
  // create's exact-title upsert only knows the current title, so without this
  // lookup a call already stored under the legacy title would get a second doc.
  const existingId = await resolveCallDocId(ctx, callRef)
  if (existingId) {
    const existing = await readDoc(ctx, existingId)
    if (!existing) throw new RetryableResolveError(`knowledge:get failed for ${existingId}`, false)
    return existing
  }
  const env = await ctx.executeTool("knowledge:create", {
    documentScope: "organization",
    title: callTitleFor(callRef),
    summary: `Transcription d'appel : ${callRef}`,
    tagNames: ["appel"],
    idempotencyKey: `calls:doc:${callRef}`,
  })
  if (env.status !== "completed") {
    if (env.status === "error") {
      throw new RetryableResolveError(`knowledge:create failed: ${env.error.code} ${env.error.message}`, isIdempotencyContention(env))
    }
    throw new RetryableResolveError("knowledge:create was gated (pending_approval): unexpected for an ungated tool", false)
  }
  const snap = snapshotFromDocResult(env.result)
  if (!snap) {
    throw new RetryableResolveError("knowledge:create returned no id/revision", false)
  }
  return snap
}

class RetryableResolveError extends Error {
  readonly contention: boolean
  constructor(message: string, contention: boolean) {
    super(message)
    this.contention = contention
  }
}

async function readDoc(ctx: CallsCtx, id: string): Promise<DocSnapshot | null> {
  const env = await ctx.executeTool("knowledge:get", { id })
  if (env.status !== "completed") return null
  const r = env.result as { status?: string; document?: unknown }
  if (r?.status !== "available") return null
  return snapshotFromDocResult(r.document)
}

/** Apply the envelope to a parsed doc. `changed:false` ⇒ dedup no-op. */
function applyEnvelope(doc: CallDoc, envelope: CallsEnvelope): { doc: CallDoc; changed: boolean } {
  if (envelope.kind === "segment") {
    const { doc: next, inserted } = applySegment(doc, {
      segmentId: envelope.segmentId,
      ts: envelope.ts,
      speaker: envelope.speaker,
      text: envelope.text,
    })
    return { doc: next, changed: inserted }
  }
  return {
    doc: applySummary(doc, { ts: envelope.ts, text: envelope.text, isFinal: envelope.isFinal }),
    changed: true,
  }
}

/**
 * `segment` webhook topic handler — `(payload, ctx, headers?)` per the
 * manifest webhook contract.
 */
export async function segmentWebhookHandler(
  payload: unknown,
  ctx: CallsCtx,
  _headers?: Record<string, string | undefined>,
): Promise<WebhookResult> {
  const parsed = parseCallsEnvelope(payload)
  if (!parsed.ok) {
    // Malformed input is the SENDER's bug — 400 (do not ask for a retry).
    return { status: 400, body: `invalid calls envelope: ${parsed.reason}` }
  }
  const envelope = parsed.envelope

  try {
    let snap: DocSnapshot | null = null
    // Set once the doc has been resolved at least once (create-or-get or a
    // successful re-read). Distinguishes "never resolved yet" (needs
    // resolveOrCreateDoc) from "re-read after a conflict came back null"
    // (needs another re-read, NOT a fallback to create — see C1/U8.4: the
    // create call reuses the same deterministic idempotencyKey, so falling
    // back to it here would replay the idempotency-cached CREATE-time
    // response, a stale revision doomed to re-conflict and burn an attempt
    // for nothing).
    let knownDocId: string | null = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (!snap) {
        if (knownDocId) {
          // A transient knowledge:get hiccup on the post-conflict re-read —
          // retry the SAME re-read (bounded by the outer loop's own
          // MAX_ATTEMPTS), never resolveOrCreateDoc.
          snap = await readDoc(ctx, knownDocId)
          if (!snap && attempt < MAX_ATTEMPTS) continue
          if (!snap) {
            ctx.logger.error("calls: post-conflict re-read kept failing", {
              callRef: envelope.callRef,
              kind: envelope.kind,
              attempts: MAX_ATTEMPTS,
            })
            return { status: 503, body: "segment persistence failed" }
          }
        } else {
          // Never resolved yet. First attempt goes through create-or-get;
          // after a conflict we re-read by id (cheaper, and immune to
          // idempotency-cache staleness — the cached create result carries
          // the CREATE-time revision).
          try {
            snap = await resolveOrCreateDoc(ctx, envelope.callRef)
            knownDocId = snap.id
          } catch (err) {
            if (err instanceof RetryableResolveError && err.contention && attempt < MAX_ATTEMPTS) {
              continue // another delivery holds the create reservation — retry resolves it
            }
            throw err
          }
        }
      }

      const { doc, changed } = applyEnvelope(parseCallDoc(snap.body), envelope)
      if (!changed) return OK // segmentId marker already present — idempotent no-op

      const env = await ctx.executeTool("knowledge:update", {
        id: snap.id,
        revision: snap.revision,
        body: renderCallDoc(doc),
      })
      if (env.status === "completed") return OK
      if (isRevisionConflict(env)) {
        // Lost the optimistic-concurrency race — re-read and re-apply (the
        // dedup check reruns against the fresh body inside this same loop).
        knownDocId = snap.id
        snap = await readDoc(ctx, snap.id)
        continue
      }
      // Non-conflict failure: transient (DB blip etc.) — fall through to 503
      // so the kernel releases the replay claim and the sender re-delivers.
      ctx.logger.error("calls: knowledge:update failed", {
        callRef: envelope.callRef,
        kind: envelope.kind,
        error: env.status === "error" ? env.error : env.status,
      })
      return { status: 503, body: "segment persistence failed" }
    }
    // Attempts exhausted under sustained contention.
    ctx.logger.error("calls: revision-conflict retries exhausted", {
      callRef: envelope.callRef,
      kind: envelope.kind,
      attempts: MAX_ATTEMPTS,
    })
    return { status: 503, body: "segment persistence contended, retry" }
  } catch (err) {
    ctx.logger.error("calls segment webhook failed", {
      callRef: envelope.callRef,
      kind: envelope.kind,
      err: String(err),
    })
    return { status: 503, body: "segment processing failed" }
  }
}
