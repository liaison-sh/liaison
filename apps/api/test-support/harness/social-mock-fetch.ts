// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Social "Ground Control" E2E harness — server-side platform-fetch mock (B10).
//
// The social app is loaded FROM SOURCE in tests, but its gated post-back tools
// (reply_to_finding / send_dm / like_item) still issue real outbound calls
// through the host fetch (the same rpc-bridge fetch the Boxtal sandbox uses).
// The Facebook Graph / Google hosts are unreachable in CI, so we install a
// `typeof fetch` that intercepts the social platform hosts and returns canned
// OK responses, and DELEGATES TO THE REAL `fetch` for every other host.
//
// This composes WITH the Boxtal mock: at boot the e2e server chains
// social-mock → boxtal-mock → globalThis.fetch (each mock handles its own hosts
// and defers the rest to the next delegate). The intercepts-host predicate the
// rpc-bridge consults is `boxtalMockHandlesHost(h) || socialMockHandlesHost(h)`
// so private/loopback validation is skipped only for mocked hosts.
//
// Records every social request `{ url, method, headers, body, actor }` so the
// E2E can assert "no graph POST before approval / exactly one after approve".

// — recorder —

export interface SocialMockRecord {
  url: string
  method: string
  /** Lowercased header map (Bun normalizes header names to lowercase). */
  headers: Record<string, string>
  /** Actor marker the bridge injects when LIAISON_TEST_INJECT_ACTOR=1. */
  actor: string | null
  body: string | null
  receivedAt: number
}

const records: SocialMockRecord[] = []

export function socialMockAllRequests(): SocialMockRecord[] {
  return [...records]
}

// — mutable per-scenario mode —

interface SocialMockState {
  /** Force the next post-back HTTP status (default 200 = ok). */
  postStatus: number
}

const state: SocialMockState = { postStatus: 200 }

export function setSocialMockMode(patch: { postStatus?: number }): void {
  if (patch.postStatus !== undefined) state.postStatus = patch.postStatus
}
export function resetSocialMockState(): void {
  state.postStatus = 200
  records.length = 0
}

// — host matching —

// graph.instagram.com: the Instagram API with Instagram Login (adapters/
// instagram.ts IG_BASE) serves the same Graph shapes. Without it an Instagram
// post-back left the mock and went out to the real Instagram API (answered
// 400, recorded nothing), which read as an approved send that never happened.
const FB_GRAPH_HOSTS = new Set(["graph.facebook.com", "www.facebook.com", "graph.instagram.com"])
const GOOGLE_HOSTS = new Set([
  "www.googleapis.com",
  "youtube.googleapis.com",
  "oauth2.googleapis.com",
])

/** Hosts the social mock serves canned bytes for. */
export function socialMockHandlesHost(hostname: string): boolean {
  return FB_GRAPH_HOSTS.has(hostname) || GOOGLE_HOSTS.has(hostname)
}

// — fetch impl —

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/**
 * Build the social platform-fetch mock. `realFetch` is the delegate for every
 * non-social host (in the e2e boot chain, the Boxtal mock). Mirrors the Boxtal
 * mock's shape: record → match → respond, defer otherwise.
 */
export function makeSocialMockFetch(realFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    let host: string
    let path: string
    try {
      const parsed = new URL(url)
      host = parsed.hostname
      path = parsed.pathname
    } catch {
      return realFetch(input, init)
    }

    if (!socialMockHandlesHost(host)) {
      return realFetch(input, init)
    }

    const method = (init?.method ?? "GET").toUpperCase()
    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = new Headers(init.headers)
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v
      })
    }
    const body = typeof init?.body === "string" ? init.body : null
    records.push({
      url,
      method,
      headers,
      actor: headers["x-liaison-actor"] ?? null,
      body,
      receivedAt: Date.now(),
    })

    // Mode override (e.g. force a 410/429/5xx to exercise the post-back failure
    // arms). POSTs only: the reads a post-back makes first (the Facebook Page
    // token via GET /me/accounts) must still answer, or the post-back fails
    // before its POST and the failure arm under test never runs.
    if (state.postStatus !== 200 && method === "POST") {
      return jsonResponse(
        { error: { message: "forced", code: state.postStatus } },
        state.postStatus,
      )
    }

    // — Facebook Graph post-back endpoints —
    //   POST /{object-id}/comments  — reply_to_finding
    //   POST /me/messages           — send_dm
    //   POST /{object-id}/likes     — like_item
    if (FB_GRAPH_HOSTS.has(host)) {
      if (method === "POST" && /\/comments$/.test(path)) {
        return jsonResponse({ id: `cmt-${records.length}` })
      }
      if (method === "POST" && /\/me\/messages$/.test(path)) {
        return jsonResponse({ message_id: `mid-${records.length}`, recipient_id: "psid" })
      }
      if (method === "POST" && /\/likes$/.test(path)) {
        return jsonResponse({ success: true })
      }
      // Discovery / read shapes the adapters might issue — empty page.
      return jsonResponse({ data: [], paging: {} })
    }

    // — Google / YouTube reads (no post-back in scope) — empty page —
    return jsonResponse({ items: [], pageInfo: { totalResults: 0 } })
  }) as typeof fetch
}
