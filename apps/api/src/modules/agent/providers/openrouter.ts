// SPDX-License-Identifier: FSL-1.1-ALv2
import { DEMO_BOX_KEY_REASONING_LEVEL } from "@liaison/shared"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import type { LanguageModel } from "ai"
import { isManagedEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { fetchWithPinnedHost } from "~/lib/outbound-fetch"
import { blockedHostsSource } from "~/modules/agent/providers/openrouter-blocked-hosts"
import {
  applyHostDenyList,
  providerPinFetch,
  withRouting,
} from "~/modules/agent/providers/openrouter-provider-pin"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import {
  VISITOR_INPUT_USD_PER_M,
  VISITOR_OUTPUT_USD_PER_M,
} from "~/modules/demo/demo-spend-ceiling"

const log = rootLogger.child({ module: "openrouter" })

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

/**
 * OpenRouter's API root. `OPENROUTER_BASE_URL` points it at a stub in tests;
 * it is an operator setting, so it is not run through the outbound URL guard.
 */
export function openRouterBaseURL(): string {
  return (process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, "")
}

/**
 * The routing every OpenRouter call carries: no upstream provider that may
 * store or train on the data, and only providers that honour every parameter
 * the call sends (tools, reasoning). A model no provider serves under these
 * terms fails with OpenRouter's own message instead of quietly running
 * somewhere else.
 */
export const OPENROUTER_ROUTING = { data_collection: "deny", require_parameters: true } as const

/**
 * The routing of a managed cell's side calls (S31): embeddings, media
 * analysis and the web-search completion name zero data retention themselves.
 * `withManagedZdr` adds it to every managed request whatever its builder said.
 */
export function managedZdrRouting() {
  return { ...OPENROUTER_ROUTING, zdr: true } as const
}

/**
 * ZERO DATA RETENTION ON A MANAGED CELL. The privacy notice promises it on every
 * AI call, so each request says so itself and the promise does not rest on the
 * OpenRouter account's setting alone. Every way out passes here: `openRouterFetch`
 * (REST), `createOpenRouterModel` (the SDK) and `openRouterThreadFetch` (a thread's
 * own call); a new one is refused by the guard in openrouter-zdr.test.ts. A body
 * without a `model` is not a model call. A self-hosted request is unchanged: the
 * data policy of OPENROUTER_ROUTING is what that instance's owner gets.
 */
export function withManagedZdr(body: unknown): unknown {
  if (!isManagedEdition() || !body || typeof body !== "object" || !("model" in body)) return body
  const b = body as Record<string, unknown>
  const provider = b.provider && typeof b.provider === "object" ? b.provider : {}
  return { ...b, provider: { ...provider, zdr: true } }
}

/** `withManagedZdr` on each request a fetch sends. */
function managedZdrFetch(inner: typeof fetch): typeof fetch {
  const f = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (!isManagedEdition() || typeof init?.body !== "string") return inner(input, init)
    let parsed: unknown
    try {
      parsed = JSON.parse(init.body)
    } catch {
      return inner(input, init)
    }
    return inner(input, { ...init, body: JSON.stringify(withManagedZdr(parsed)) })
  }
  return Object.assign(f, { preconnect: fetch.preconnect })
}

/**
 * A chat request body (one with `messages`) with the org's blocked hosts kept
 * out of its routing (openrouter-blocked-hosts.ts; no org: the instance
 * default). Any other body is returned unchanged. A thread's requests get the
 * same treatment inside `providerPinFetch`; this covers every other path.
 */
export async function withBlockedHosts(body: unknown, orgId: string | null): Promise<unknown> {
  if (!body || typeof body !== "object" || !("messages" in body)) return body
  const b = body as Record<string, unknown>
  const provider = (b.provider && typeof b.provider === "object" ? b.provider : {}) as Record<
    string,
    unknown
  >
  return withRouting(b, applyHostDenyList(provider, await blockedHostsSource.get(orgId)))
}

/** A fetch that keeps the org's blocked hosts out of every chat request it sends. */
function blockedHostsFetch(inner: typeof fetch, orgId: string | null): typeof fetch {
  const f = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (typeof init?.body !== "string") return inner(input, init)
    let parsed: unknown
    try {
      parsed = JSON.parse(init.body)
    } catch {
      return inner(input, init)
    }
    const next = await withBlockedHosts(parsed, orgId)
    return next === parsed
      ? inner(input, init)
      : inner(input, { ...init, body: JSON.stringify(next) })
  }
  return Object.assign(f, { preconnect: fetch.preconnect })
}

// ── THE BOX KEY REQUEST GUARD (demo mode) ──────────────────────────────────
// On a demo box this deployment's OpenRouter key is spent by strangers, under
// budgets that are priced for a handful of models. Whatever path reaches the
// wire, a request made WITH THE BOX KEY passes `assertBoxKeyRequest` first:
// its `model` must be one of the models the budgets are priced for (the
// visitor pin, the reserved org's pin, the web-search plugin model, the
// transcription models), and every chat request carries OpenRouter's
// `provider.max_price` at the derivation block's prices, so no upstream
// provider dearer than that may serve it. Anything else is refused before it
// leaves the box (`alert: demo_box_key_model`). Process-wide and independent
// of call sites; a no-op off demo mode and for every other key.

/** OpenRouter's per-request price ceiling, USD per 1M tokens. */
export interface OpenRouterMaxPrice {
  prompt: number
  completion: number
}

const registeredBoxKeyModels = new Map<string, OpenRouterMaxPrice | null>()

/**
 * Register a non-chat-pin model the box key may be used for (its module's
 * own call path meters it), with its max price (null: not a chat request).
 */
export function registerBoxKeyModel(upstreamId: string, maxPrice: OpenRouterMaxPrice | null): void {
  registeredBoxKeyModels.set(upstreamId, maxPrice)
}

function stripOpenRouterPrefix(key: string): string {
  return key.startsWith("openrouter/") ? key.slice("openrouter/".length) : key
}

/** The visitor pin's OpenRouter id (env). */
export function visitorPinUpstreamId(): string {
  return stripOpenRouterPrefix(env.LIAISON_DEMO_VISITOR_MODEL)
}

/** Every model the box key may name, with the max price its requests carry. */
export function boxKeyModels(): Map<string, OpenRouterMaxPrice | null> {
  const out = new Map(registeredBoxKeyModels)
  const reserved = env.LIAISON_DEMO_RESERVED_MODEL
  if (reserved.startsWith("openrouter/")) out.set(stripOpenRouterPrefix(reserved), null)
  out.set(visitorPinUpstreamId(), {
    prompt: VISITOR_INPUT_USD_PER_M,
    completion: VISITOR_OUTPUT_USD_PER_M,
  })
  return out
}

/** Is `apiKey` this box's own OpenRouter key, on a demo box? */
export function isDemoBoxKey(apiKey: string | undefined): boolean {
  if (!isDemoModeEnabled()) return false
  const boxKey = process.env.OPENROUTER_API_KEY
  return Boolean(boxKey && apiKey && apiKey === boxKey)
}

/** A box key request refused before it was sent. */
export class BoxKeyRequestRefusedError extends Error {
  readonly code = "demo_box_key_model"
  constructor(readonly model: string) {
    super("This demo box's key may not be used for that model.")
    this.name = "BoxKeyRequestRefusedError"
  }
}

/**
 * The guard (see above): refuse a box key request for any other model, and
 * return the body with `provider.max_price` injected (chat requests), the
 * visitor pin's reasoning at the demo's effort (`DEMO_BOX_KEY_REASONING_LEVEL`,
 * low) and its output (reasoning tokens included) capped at the step cap.
 */
export function assertBoxKeyRequest(body: unknown): Record<string, unknown> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  const model = typeof b.model === "string" ? b.model : ""
  const allowed = boxKeyModels()
  if (!allowed.has(model)) {
    log.error(
      { alert: "demo_box_key_model", model },
      "refused a request on the demo box key for a model its budgets do not price",
    )
    throw new BoxKeyRequestRefusedError(model)
  }
  const maxPrice = allowed.get(model) ?? null
  if (!maxPrice) return b
  const provider = (b.provider && typeof b.provider === "object" ? b.provider : {}) as Record<
    string,
    unknown
  >
  const out: Record<string, unknown> = { ...b, provider: { ...provider, max_price: maxPrice } }
  if (model === visitorPinUpstreamId()) {
    // Fixed here, not left to the caller: the demo runs the pin at one level
    // (the level the turn resolved and the menu shows, the same constant), and
    // the step's output cap holds its reasoning tokens (demo-spend-ceiling.ts,
    // ONE STEP).
    out.reasoning = { effort: DEMO_BOX_KEY_REASONING_LEVEL }
    const cap = env.LIAISON_DEMO_STEP_OUTPUT_TOKENS
    const asked = typeof b.max_tokens === "number" ? b.max_tokens : cap
    out.max_tokens = Math.min(asked, cap)
    if ("max_completion_tokens" in b) delete out.max_completion_tokens
  }
  return out
}

/** A fetch for the AI SDK provider that runs every box key request through the guard. */
function boxKeyGuardedFetch(): typeof fetch {
  const guarded = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (typeof init?.body !== "string") {
      throw new BoxKeyRequestRefusedError("(no JSON body)")
    }
    const body = assertBoxKeyRequest(JSON.parse(init.body))
    return fetch(input, { ...init, body: JSON.stringify(body) })
  }
  return Object.assign(guarded, { preconnect: fetch.preconnect })
}

// ── A STREAM THAT ENDS BEFORE ITS USAGE ────────────────────────────────────
// OpenRouter reports what a streamed call cost in its last chunk. A stream the
// caller stops first (a turn's time limit, a visitor's newer request, a client
// that went away) is still billed: the upstream processed the prompt and may have
// run the completion on. Its usage never reaches the caller, so no usage row was
// written for it and the org's ledger fell short of the key's bill (live demo,
// 2026-10-24). `onUnreportedGeneration` hears the generation id of such a stream,
// so the caller can read what it cost from OpenRouter's own record
// (`recordUnreportedGenerations`, credits/unreported-generations.ts).

/** A fetch that reports the id of every streamed generation that ended without its usage. */
export function unreportedGenerationFetch(
  inner: typeof fetch,
  onUnreported: (generationId: string) => void,
): typeof fetch {
  const watched = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await inner(input, init)
    if (!res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      return res
    }
    let id: string | null = null
    let reported = false
    let closed = false
    let tail = ""
    const decoder = new TextDecoder()
    const close = () => {
      if (closed) return
      closed = true
      if (id && !reported) onUnreported(id)
    }
    init?.signal?.addEventListener("abort", close, { once: true })
    const body = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk)
          if (reported) return
          tail += decoder.decode(chunk, { stream: true })
          if (!id) id = /"id"\s*:\s*"(gen-[^"]+)"/.exec(tail)?.[1] ?? null
          if (/"usage"\s*:\s*\{[^}]*"cost"\s*:/.test(tail)) reported = true
          // Only the end of the stream can still hold the usage object.
          if (tail.length > 8192) tail = tail.slice(-4096)
        },
        flush() {
          close()
        },
      }),
    )
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
  return Object.assign(watched, { preconnect: fetch.preconnect })
}

// ── ONE UPSTREAM PER CONVERSATION ──────────────────────────────────────────
// OpenRouter spreads a model's requests over many upstream providers, and each
// upstream holds its own prompt cache: a step served by another upstream than
// the step before reads nothing from cache and pays the whole prompt again.
// OpenRouter keeps a conversation on one upstream ("sticky routing"), but
// without a `session_id` it only starts doing so after a cache hit, and it
// recognises the conversation by its opening messages, which move when the
// history window slides. Every request of a thread therefore names the thread
// as its `session_id`: the turn's steps, and the thread's later turns, go to the
// upstream that holds their cache from the first request on. The id is the
// thread's opaque UUID, nothing a person wrote. `session_id` is only a
// preference, so the thread also PINS its first upstream host and names it in
// `provider.order` (openrouter-provider-pin.ts, which holds the fallback rule).

/**
 * An OpenRouter chat model. The routing options are MODEL SETTINGS, so the
 * reasoning fragment a turn sends through `providerOptions.openrouter`
 * (`{ reasoning: { effort } }`) merges beside them and never replaces them.
 * `onUnreportedGeneration` hears each streamed generation that ended without its
 * usage (see above); `sessionId` names the conversation and pins its upstream host
 * (see above).
 */
export function createOpenRouterModel(
  apiKey: string,
  upstreamId: string,
  opts: {
    onUnreportedGeneration?: (generationId: string) => void
    sessionId?: string
    /** Hears each request of a thread's TURN as sent (providerPinFetch `onSent`). */
    onTurnRequest?: (sent: Record<string, unknown>, pinnedHost: string | null) => void
    /** The org the call runs for: its blocked OpenRouter hosts apply (else the instance default). */
    orgId?: string | null
  } = {},
): LanguageModel {
  // On a demo box, every request on the box's own key passes the guard.
  const guarded: typeof fetch = isDemoBoxKey(apiKey) ? boxKeyGuardedFetch() : fetch
  // A thread's requests stay on the upstream host it first landed on.
  // No thread: the org's blocked hosts still stay out of the routing.
  const orgId = opts.orgId ?? null
  const base = managedZdrFetch(
    opts.sessionId
      ? providerPinFetch(guarded, opts.sessionId, undefined, undefined, {
          orgId,
          ...(opts.onTurnRequest ? { onSent: opts.onTurnRequest } : {}),
        })
      : blockedHostsFetch(guarded, orgId),
  )
  const watched = opts.onUnreportedGeneration
    ? unreportedGenerationFetch(base, opts.onUnreportedGeneration)
    : base
  const provider = createOpenRouter({
    apiKey,
    baseURL: openRouterBaseURL(),
    // Strict sends `stream_options.include_usage`, so streamed turns report tokens.
    compatibility: "strict",
    ...(watched !== fetch ? { fetch: watched } : {}),
  })
  return provider.chat(upstreamId, {
    provider: { ...OPENROUTER_ROUTING },
    usage: { include: true },
    ...(opts.sessionId ? { extraBody: { session_id: opts.sessionId } } : {}),
  })
}

/**
 * The fetch a thread's own OpenRouter chat request goes through, for a call
 * made outside the AI SDK (the idle compaction's brief, context/warm-compaction.ts):
 * the demo box key guard, then the thread's upstream host pin. Nothing is
 * recorded as the thread's turn request.
 */
export function openRouterThreadFetch(
  apiKey: string,
  threadId: string,
  orgId: string | null = null,
): typeof fetch {
  const guarded: typeof fetch = isDemoBoxKey(apiKey) ? boxKeyGuardedFetch() : fetch
  return managedZdrFetch(providerPinFetch(guarded, threadId, undefined, undefined, { orgId }))
}

/**
 * A direct call to OpenRouter's REST API (what the AI SDK provider does not
 * cover: the model catalogue, speech to text, a web-plugin completion read for
 * its citations). Goes through the pinned outbound path with no redirects. The
 * base URL is an operator setting, so a private address is allowed (an
 * operator's own gateway); the link-local and metadata ranges never are.
 * A `body` makes it a JSON POST; without one it is a GET.
 */
export async function openRouterFetch(
  path: string,
  init: {
    apiKey?: string
    body?: unknown
    signal?: AbortSignal
    /** The org a chat request runs for: its blocked OpenRouter hosts apply. */
    orgId?: string | null
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (init.apiKey) headers.Authorization = `Bearer ${init.apiKey}`
  // A box key request names a priced model or never leaves (see the guard).
  // A GET on the box key (the catalogue) carries no model and spends nothing.
  // A chat request never goes to a blocked host, whichever caller built it.
  let body = withManagedZdr(await withBlockedHosts(init.body, init.orgId ?? null))
  if (init.apiKey && isDemoBoxKey(init.apiKey) && body !== undefined) {
    body = assertBoxKeyRequest(body)
  }
  if (init.body !== undefined) headers["Content-Type"] = "application/json"
  return fetchWithPinnedHost(
    `${openRouterBaseURL()}${path}`,
    {
      method: init.body !== undefined ? "POST" : "GET",
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    },
    { allowPrivate: true, allowPrivateHostsInTest: true, maxRedirects: 0 },
  )
}
