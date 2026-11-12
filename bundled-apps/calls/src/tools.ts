// SPDX-License-Identifier: FSL-1.1-ALv2
//
// MCP tool handlers — the read surface over per-call knowledge documents.
// No tables (spec §2): reads resolve the per-call doc and parse its
// structured body (doc-format.ts). callRef→doc-id resolution (U5.8) tries
// knowledge:find_by_title FIRST — a DB-backed exact-title lookup that never
// rides the Meilisearch index, so it never lags behind a just-created doc
// under replay load (U5.7's root-caused (c) failure: 51x call_not_found
// while the doc provably existed in Postgres) — falling back to
// knowledge:search only if find_by_title's own lookup errors/is unavailable.
// The doc BODY is always read via knowledge:get (DB-fresh, so segment
// recency never depended on the search index either).
import type { CallsCtx } from "./ctx"
import {
  applyLinks,
  CALL_TITLE_PREFIX,
  type CallLinks,
  type CallSegment,
  callTitleCandidates,
  LEGACY_CALL_TITLE_PREFIX,
  parseCallDoc,
  renderCallDoc,
  segmentsSince,
} from "./doc-format"
import { DELIVERY_ID_HEADER, SIGNATURE_HEADER, WEBHOOK_SECRET_KEY } from "./lib/hmac"

const CALL_TITLE_PREFIXES = [CALL_TITLE_PREFIX, LEGACY_CALL_TITLE_PREFIX]
function callTitlePrefixOf(title: string): string | undefined {
  return CALL_TITLE_PREFIXES.find((p) => title.startsWith(p))
}

interface SearchHit {
  source?: string
  sourceEntityId?: string
  title?: string
  type?: string
}

function searchHits(result: unknown): SearchHit[] {
  const hits = (result as { hits?: unknown })?.hits
  return Array.isArray(hits) ? (hits as SearchHit[]) : []
}

/** Resolve callRef → local knowledge document id via the DB-backed exact-title lookup
 *  (U5.8). Returns undefined (not null) when the tool call itself errored/is unavailable
 *  — the CALLER falls back to search in that case only; a clean {found:false} answer is
 *  a real "no doc" and must NOT trigger the search fallback. */
async function resolveCallDocIdByFindByTitle(
  ctx: CallsCtx,
  title: string,
): Promise<string | null | undefined> {
  const env = await ctx.executeTool("knowledge:find_by_title", { title })
  if (env.status !== "completed") return undefined
  const r = env.result as { found?: boolean; document?: { id?: string } | null }
  if (!r?.found) return null
  return r.document?.id ?? null
}

/** Resolve callRef → local knowledge document id by exact-title match over
 *  knowledge's search. Returns null when no doc exists (or the search index
 *  has not caught up with a seconds-old call yet — the honest failure mode,
 *  reported as call_not_found rather than papered over). */
async function resolveCallDocIdBySearch(ctx: CallsCtx, title: string): Promise<string | null> {
  const env = await ctx.executeTool("knowledge:search", { query: title, limit: 20 })
  if (env.status !== "completed") return null
  const hit = searchHits(env.result).find(
    (h) => h.source === "knowledge" && h.type === "document" && h.title === title,
  )
  return hit?.sourceEntityId ?? null
}

/** Resolve callRef → local knowledge document id. Tries knowledge:find_by_title FIRST
 *  (U5.8) — DB-backed, never rides the Meilisearch index, so it never lags behind a
 *  just-created doc under replay load (U5.7's root-caused (c) failure: 51x call_not_found
 *  while the doc provably existed in Postgres). Falls back to knowledge:search only when
 *  find_by_title's own call errors/is unavailable — a genuine {found:false} is trusted as
 *  a real "no doc yet" and does not fall through to search. */
export async function resolveCallDocId(ctx: CallsCtx, callRef: string): Promise<string | null> {
  // Current title first, then the legacy one (callTitleCandidates): documents
  // stored before the title rename must still resolve.
  for (const title of callTitleCandidates(callRef)) {
    const byTitle = await resolveCallDocIdByFindByTitle(ctx, title)
    const id = byTitle !== undefined ? byTitle : await resolveCallDocIdBySearch(ctx, title)
    if (id) return id
  }
  return null
}

async function readDocBody(ctx: CallsCtx, id: string): Promise<string | null> {
  const env = await ctx.executeTool("knowledge:get", { id })
  if (env.status !== "completed") return null
  const r = env.result as { status?: string; document?: { body?: unknown } }
  if (r?.status !== "available") return null
  return typeof r.document?.body === "string" ? r.document.body : ""
}

interface DocSnapshot {
  revision: number
  body: string
}

async function readDocSnapshot(ctx: CallsCtx, id: string): Promise<DocSnapshot | null> {
  const env = await ctx.executeTool("knowledge:get", { id })
  if (env.status !== "completed") return null
  const r = env.result as { status?: string; document?: { revision?: unknown; body?: unknown } }
  if (r?.status !== "available") return null
  const revision = r.document?.revision
  if (typeof revision !== "number") return null
  return { revision, body: typeof r.document?.body === "string" ? r.document.body : "" }
}

function isRevisionConflict(env: {
  status: string
  error?: { code?: string; message?: string }
}): boolean {
  if (env.status !== "error") return false
  return /revision[_ ]?conflict/i.test(`${env.error?.code ?? ""} ${env.error?.message ?? ""}`)
}

/** Bounded read-modify-write attempts — same CAS discipline and attempt cap
 *  as the segment webhook's retry loop (webhooks.ts MAX_ATTEMPTS): a links
 *  write races the SAME per-call document a concurrent segment/summary
 *  delivery is appending to, so it must absorb the identical contention. */
const MAX_LINKS_ATTEMPTS = 5

export interface SegmentView {
  segmentId: string
  ts: string
  speaker: string
  text: string
}

function segView(s: CallSegment): SegmentView {
  return { segmentId: s.segmentId, ts: s.ts.toISOString(), speaker: s.speaker, text: s.text }
}

/**
 * Incremental since-read over one call's transcript (spec §3.7: "an
 * incremental `since`-style read exposed as a new tool of the calls connector
 * itself"). `lastSegmentTs` always reports the DOC's newest segment so a
 * caller measures staleness in one field even when the window filters
 * everything out ("MCP tool reports last-segment ts so Claude knows
 * staleness").
 */
export async function callsSegmentsSinceHandler(
  params: { callRef: string; since?: string; limit?: number },
  ctx: CallsCtx,
): Promise<{
  data: {
    callRef: string
    documentId: string
    segments: SegmentView[]
    lastSegmentTs: string | null
    summary: { ts: string; text: string; isFinal: boolean } | null
    truncated: boolean
    links: CallLinks | null
  }
}> {
  const docId = await resolveCallDocId(ctx, params.callRef)
  if (!docId) {
    throw new Error(
      `call_not_found: no transcript document for callRef ${JSON.stringify(params.callRef)}: either no segment was ever ingested for it, or the call started seconds ago and the search index has not caught up`,
    )
  }
  const body = await readDocBody(ctx, docId)
  if (body === null) throw new Error(`call_not_found: document ${docId} is not readable`)

  const doc = parseCallDoc(body)
  const since =
    params.since !== undefined && params.since !== null ? new Date(params.since) : undefined
  if (since && Number.isNaN(since.getTime())) {
    throw new Error(`invalid_params: since is not a parseable timestamp`)
  }
  const limit = Math.max(1, Math.min(500, Math.trunc(params.limit ?? 50)))
  const windowed = segmentsSince(doc, since)
  const page = windowed.slice(0, limit)
  const last = doc.segments[doc.segments.length - 1]
  return {
    data: {
      callRef: params.callRef,
      documentId: docId,
      segments: page.map(segView),
      lastSegmentTs: last ? last.ts.toISOString() : null,
      summary: doc.summary
        ? { ts: doc.summary.ts.toISOString(), text: doc.summary.text, isFinal: doc.summary.isFinal }
        : null,
      truncated: page.length < windowed.length,
      // Plainly null when no links write has ever
      // happened for this call — never a guessed/derived contact or deal.
      links: doc.links,
    },
  }
}

/**
 * calls_set_links: metadata linking the call document to a contact and a
 * deal task. Writes the `## Liens` block on the per-call
 * document (doc-format.ts applyLinks). This is an AGENT tool (unlike the
 * webhook, which only ever ingests transcript data) — the synthesis skill
 * calls it after resolving a contactId (kernel:contacts_search/read) and/or
 * creating the relance deal task (projects:create), passing whichever id(s)
 * it has. Omitted params PRESERVE the current value (read-modify-write);
 * an explicit `null` CLEARS that link (e.g. a deal task got reassigned).
 * Never creates the underlying call document — a links write against a
 * callRef with no transcript yet is a genuine call_not_found, not silently
 * papered over by creating an empty doc.
 */
export async function callsSetLinksHandler(
  params: { callRef: string; contactId?: string | null; dealTaskId?: string | null },
  ctx: CallsCtx,
): Promise<{ data: { callRef: string; documentId: string; links: CallLinks } }> {
  const docId = await resolveCallDocId(ctx, params.callRef)
  if (!docId) {
    throw new Error(
      `call_not_found: no transcript document for callRef ${JSON.stringify(params.callRef)}. A call with no transcript yet cannot be linked.`,
    )
  }

  let snap = await readDocSnapshot(ctx, docId)
  if (!snap) throw new Error(`call_not_found: document ${docId} is not readable`)

  for (let attempt = 1; attempt <= MAX_LINKS_ATTEMPTS; attempt++) {
    const current = parseCallDoc(snap.body)
    const next: CallLinks = {
      contactId:
        params.contactId !== undefined ? params.contactId : (current.links?.contactId ?? null),
      dealTaskId:
        params.dealTaskId !== undefined ? params.dealTaskId : (current.links?.dealTaskId ?? null),
    }
    const updated = applyLinks(current, next)
    const env = await ctx.executeTool("knowledge:update", {
      id: docId,
      revision: snap.revision,
      body: renderCallDoc(updated),
    })
    if (env.status === "completed") {
      return { data: { callRef: params.callRef, documentId: docId, links: next } }
    }
    if (isRevisionConflict(env)) {
      snap = await readDocSnapshot(ctx, docId)
      if (!snap) throw new Error(`call_not_found: document ${docId} is not readable`)
      continue
    }
    const detail = env.status === "error" ? `${env.error.code}: ${env.error.message}` : env.status
    throw new Error(`links_write_failed: ${detail}`)
  }
  throw new Error(
    `links_write_contended: revision-conflict retries exhausted after ${MAX_LINKS_ATTEMPTS} attempts`,
  )
}

/**
 * Recent call documents — search-backed recall over the title convention
 * (bounded, NOT an authoritative total; the honest limit of a table-less
 * connector).
 */
export async function callsListHandler(
  params: { limit?: number },
  ctx: CallsCtx,
): Promise<{ data: { calls: Array<{ callRef: string; documentId: string; title: string }> } }> {
  const limit = Math.max(1, Math.min(50, Math.trunc(params.limit ?? 20)))
  const env = await ctx.executeTool("knowledge:search", { query: "Appel", limit })
  if (env.status !== "completed") {
    const detail = env.status === "error" ? `${env.error.code}: ${env.error.message}` : env.status
    throw new Error(`search_failed: ${detail}`)
  }
  const calls = searchHits(env.result)
    .filter(
      (h) =>
        h.source === "knowledge" &&
        h.type === "document" &&
        typeof h.title === "string" &&
        callTitlePrefixOf(h.title) !== undefined &&
        typeof h.sourceEntityId === "string",
    )
    .map((h) => ({
      callRef: (h.title as string).slice((callTitlePrefixOf(h.title as string) as string).length),
      documentId: h.sourceEntityId as string,
      title: h.title as string,
    }))
  return { data: { calls } }
}

/**
 * Operator setup read (admin scope, not agent-visible): whether the webhook
 * signing secret has been minted (a `transcript-source` connection was
 * established) and its value — the operator pastes it into the transcript
 * adapter's outgoing-webhook config. Mirrors monitoring's webhook_info /
 * projects' ci-status setup read (handlers.ts:440-451).
 */
export async function webhookInfoHandler(
  _params: Record<string, never>,
  ctx: CallsCtx,
): Promise<{
  data: {
    configured: boolean
    secret: string | null
    signatureHeader: string
    deliveryIdHeader: string
    algorithm: string
  }
}> {
  const secret = (await ctx.config.get(WEBHOOK_SECRET_KEY)) as string | null
  return {
    data: {
      configured: Boolean(secret),
      secret: secret ?? null,
      signatureHeader: SIGNATURE_HEADER,
      deliveryIdHeader: DELIVERY_ID_HEADER,
      algorithm: "HMAC-SHA256, base64-encoded digest of the raw request body",
    },
  }
}
