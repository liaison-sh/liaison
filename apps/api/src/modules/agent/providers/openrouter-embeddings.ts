// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Embeddings on OpenRouter (`POST /embeddings`), the managed edition's
// embedder (S31). Zero data retention per request; the reported USD cost is
// what the call is metered at. Verified against the provider: `google/gemini-embedding-001`
// answers 3072 dimensions under `zdr: true`, the same vectors the Google
// path stores. The request asks for the instance's width (`dimensions`, part
// of OpenRouter's embeddings API); the caller still cuts and normalises what
// comes back (modules/search/embedding-dimensions.ts), so a provider behind
// OpenRouter that ignores the field stores the right width all the same.
import { managedZdrRouting, openRouterFetch } from "~/modules/agent/providers/openrouter"

/** A text longer than this is embedded on its opening (the Google path's cut). */
export const EMBEDDING_INPUT_MAX_CHARS = 8000

const EMBEDDING_TIMEOUT_MS = 30_000

export interface OpenRouterEmbedResult {
  vectors: number[][]
  tokens: number
  /** What OpenRouter billed, USD, when it reported it. */
  costUsd: number | undefined
}

export class OpenRouterEmbeddingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OpenRouterEmbeddingError"
  }
}

/** The request body: model, inputs, output width when given, zero-retention routing. */
export function buildOpenRouterEmbeddingRequest(
  upstreamId: string,
  texts: string[],
  dimensions?: number,
) {
  return {
    model: upstreamId,
    input: texts.map((t) => t.slice(0, EMBEDDING_INPUT_MAX_CHARS)),
    ...(dimensions ? { dimensions } : {}),
    provider: managedZdrRouting(),
  }
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

/** One embed batch. Throws OpenRouterEmbeddingError on an upstream failure. */
export async function openRouterEmbed(params: {
  apiKey: string
  upstreamId: string
  texts: string[]
  orgId: string
  /** The output width to ask for. */
  dimensions?: number
}): Promise<OpenRouterEmbedResult> {
  const res = await openRouterFetch("/embeddings", {
    apiKey: params.apiKey,
    body: buildOpenRouterEmbeddingRequest(params.upstreamId, params.texts, params.dimensions),
    signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
    orgId: params.orgId,
  })
  const body = (await res.json().catch(() => null)) as {
    data?: Array<{ index?: number; embedding?: unknown }>
    usage?: { prompt_tokens?: unknown; total_tokens?: unknown; cost?: unknown }
    error?: { message?: unknown }
  } | null
  if (!res.ok || !body || !Array.isArray(body.data)) {
    const message = typeof body?.error?.message === "string" ? `: ${body.error.message}` : ""
    throw new OpenRouterEmbeddingError(
      `OpenRouter embeddings answered HTTP ${res.status}${message}`,
    )
  }
  const vectors: number[][] = new Array(params.texts.length)
  body.data.forEach((row, i) => {
    const at = typeof row.index === "number" ? row.index : i
    if (Array.isArray(row.embedding)) vectors[at] = row.embedding as number[]
  })
  const usage = body.usage ?? {}
  return {
    vectors,
    tokens: finiteNumber(usage.prompt_tokens) ?? finiteNumber(usage.total_tokens) ?? 0,
    costUsd: finiteNumber(usage.cost),
  }
}
