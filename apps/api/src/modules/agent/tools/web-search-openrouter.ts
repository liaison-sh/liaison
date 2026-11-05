// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `web_search` ON AN OPENROUTER KEY (D13, S13).
//
// An org that holds an OpenRouter key and no Exa key still gets web search: one
// small completion with OpenRouter's `web` plugin (engine pinned to Exa), whose
// answer is ignored and whose `url_citation` annotations ARE the results. Each
// citation carries the page excerpt the plugin fed the model, which is what the
// Exa path returns as its snippet (live probe 2026-10-22: five citations with
// 162 to 3785 characters of content for USD 0.0077, `scripts/probe-openrouter-search.ts`).
//
// The model is the cheapest one that reliably carries the plugin, and
// `max_tokens` is tiny: the text it writes is thrown away, so every output
// token past the first few is money for nothing.
import { isManagedEdition } from "~/lib/edition"
import {
  managedZdrRouting,
  OPENROUTER_ROUTING,
  openRouterFetch,
  registerBoxKeyModel,
} from "~/modules/agent/providers/openrouter"
import {
  WEB_SEARCH_MODEL_INPUT_USD_PER_M,
  WEB_SEARCH_MODEL_OUTPUT_USD_PER_M,
} from "~/modules/demo/demo-spend-ceiling"

/** The OpenRouter model the search completion runs on. */
export const OPENROUTER_WEB_SEARCH_MODEL = "google/gemini-3.1-flash-lite"

// On a demo box the search may run on the box's key (a verified visitor's,
// metered per search): the request guard admits this model at its own prices.
registerBoxKeyModel(OPENROUTER_WEB_SEARCH_MODEL, {
  prompt: WEB_SEARCH_MODEL_INPUT_USD_PER_M,
  completion: WEB_SEARCH_MODEL_OUTPUT_USD_PER_M,
})

/** The completion's own answer is discarded, so it is kept to a handful of tokens. */
const SEARCH_MAX_TOKENS = 30

/** A citation's excerpt is cut here (the Exa path's results run about this long). */
export const MAX_CITATION_CONTENT_CHARS = 4000

const SEARCH_TIMEOUT_MS = 30_000

/** Test seam: the search's own timeout, in ms (null restores the default). */
export const OpenRouterWebSearchTestAccess = {
  timeoutMs: null as number | null,
}

export interface OpenRouterSearchHit {
  title: string
  url: string
  /** The page excerpt, NOT yet wrapped as external content (the caller wraps it). */
  content: string
  score: number
}

export interface OpenRouterSearchResult {
  hits: OpenRouterSearchHit[]
  /** What OpenRouter billed for the call, USD, when it reported it. */
  costUsd: number | undefined
  inputTokens: number
  outputTokens: number
}

export class OpenRouterSearchError extends Error {
  constructor(
    message: string,
    /**
     * The search provably cost nothing: the connection ended before OpenRouter
     * answered anything (and our own timeout did not cut it), or OpenRouter
     * answered 4xx (it rejected the request). A box key hold for it is released;
     * any other failure may have been billed and settles at the hold's max.
     */
    readonly notBilled = false,
  ) {
    super(message)
    this.name = "OpenRouterSearchError"
  }
}

/**
 * The request body, pinned: model, plugin, engine, routing, usage accounting.
 * A managed cell's search completion also asks for zero data retention (S31);
 * the search itself runs at the pinned engine, which ZDR does not cover, so
 * its retention is stated in the privacy notes.
 */
export function buildOpenRouterWebSearchRequest(query: string, maxResults: number) {
  return {
    model: OPENROUTER_WEB_SEARCH_MODEL,
    messages: [{ role: "user", content: query }],
    plugins: [{ id: "web", engine: "exa", max_results: maxResults }],
    max_tokens: SEARCH_MAX_TOKENS,
    provider: isManagedEdition() ? managedZdrRouting() : { ...OPENROUTER_ROUTING },
    usage: { include: true },
  }
}

interface RawCitation {
  url?: unknown
  title?: unknown
  content?: unknown
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/** A citation title is cut here (a page title, not a paragraph). */
export const MAX_CITATION_TITLE_CHARS = 200
/** A citation URL longer than this is not a result. */
const MAX_CITATION_URL_CHARS = 2048

// Control characters (C0, DEL, C1), zero-width marks and the bidi overrides
// that reorder what a reader sees: never meaningful in a title or a URL, a
// classic hiding place.
function isInvisible(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  )
}

function stripInvisible(raw: string): string {
  let out = ""
  for (const ch of raw) if (!isInvisible(ch.codePointAt(0) ?? 0)) out += ch
  return out
}

/**
 * A citation title, written by the cited page: invisible characters and any
 * markup removed, whitespace collapsed, length capped (web_fetch's title rule).
 */
export function cleanCitationTitle(raw: string): string {
  return stripInvisible(raw)
    .replace(/<[^>]*>?/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CITATION_TITLE_CHARS)
}

/** A citation URL: invisible characters removed, http(s) only, a sane length; else null. */
export function cleanCitationUrl(raw: string): string | null {
  const candidate = stripInvisible(raw).trim()
  if (!candidate || candidate.length > MAX_CITATION_URL_CHARS) return null
  try {
    const url = new URL(candidate)
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null
  } catch {
    return null
  }
}

/**
 * The hits of an OpenRouter chat completion: its `url_citation` annotations, in
 * order, one per URL, at most `limit`, each excerpt cut to
 * MAX_CITATION_CONTENT_CHARS. A citation without an http(s) URL is not a
 * result; titles and URLs are cleaned (cleanCitationTitle, cleanCitationUrl).
 * The score is the rank (1 for the first, falling evenly), since OpenRouter
 * reports no relevance number.
 */
export function mapOpenRouterCitations(body: unknown, limit: number): OpenRouterSearchHit[] {
  const choices = (body as { choices?: unknown } | null)?.choices
  if (!Array.isArray(choices)) return []
  const annotations = (choices[0] as { message?: { annotations?: unknown } } | undefined)?.message
    ?.annotations
  if (!Array.isArray(annotations)) return []
  const seen = new Set<string>()
  const hits: OpenRouterSearchHit[] = []
  for (const a of annotations) {
    const entry = a as { type?: unknown; url_citation?: RawCitation } | null
    if (entry?.type !== "url_citation" || !entry.url_citation) continue
    const url = cleanCitationUrl(asString(entry.url_citation.url))
    if (!url || seen.has(url)) continue
    seen.add(url)
    hits.push({
      title: cleanCitationTitle(asString(entry.url_citation.title)),
      url,
      content: asString(entry.url_citation.content).slice(0, MAX_CITATION_CONTENT_CHARS),
      score: 0,
    })
    if (hits.length >= limit) break
  }
  return hits.map((h, i) => ({ ...h, score: 1 - i / hits.length }))
}

function usageOf(body: unknown): {
  cost?: unknown
  prompt_tokens?: unknown
  completion_tokens?: unknown
} {
  const usage = (body as { usage?: unknown } | null)?.usage
  return usage && typeof usage === "object" ? usage : {}
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

/** One web search on OpenRouter. Throws OpenRouterSearchError on an upstream failure. */
export async function openRouterWebSearch(params: {
  query: string
  numResults: number
  apiKey: string
  /** The org searching: its blocked OpenRouter hosts apply. */
  orgId?: string | null
}): Promise<OpenRouterSearchResult> {
  let res: Response
  const signal = AbortSignal.timeout(OpenRouterWebSearchTestAccess.timeoutMs ?? SEARCH_TIMEOUT_MS)
  try {
    res = await openRouterFetch("/chat/completions", {
      apiKey: params.apiKey,
      body: buildOpenRouterWebSearchRequest(params.query, params.numResults),
      signal,
      orgId: params.orgId ?? null,
    })
  } catch (err) {
    // Cut by our timeout: OpenRouter had the request and may still run it.
    // Otherwise nothing answered at all (closed, reset, refused).
    throw new OpenRouterSearchError(
      err instanceof Error ? `OpenRouter unreachable: ${err.message}` : "OpenRouter unreachable",
      !signal.aborted,
    )
  }
  const body = (await res.json().catch(() => null)) as unknown
  if (!res.ok) {
    const message = asString((body as { error?: { message?: unknown } } | null)?.error?.message)
    throw new OpenRouterSearchError(
      `OpenRouter answered HTTP ${res.status}${message ? `: ${message}` : ""}`,
      res.status >= 400 && res.status < 500,
    )
  }
  const usage = usageOf(body)
  return {
    hits: mapOpenRouterCitations(body, params.numResults),
    costUsd: finiteNumber(usage.cost),
    inputTokens: finiteNumber(usage.prompt_tokens) ?? 0,
    outputTokens: finiteNumber(usage.completion_tokens) ?? 0,
  }
}
