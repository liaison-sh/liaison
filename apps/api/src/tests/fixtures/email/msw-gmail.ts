// SPDX-License-Identifier: FSL-1.1-ALv2
import { type DefaultBodyType, HttpResponse, http, type StrictResponse } from "msw"
import { setupServer } from "msw/node"

type MswServer = ReturnType<typeof setupServer>

export type GmailMockRoute = "token" | "messages.send" | "messages.get" | "history.list" | "watch"

export type GmailMockHandler = {
  route: GmailMockRoute
  response?: unknown
  matcher?: (req: Request) => boolean
}

export type GmailFailureKind =
  | { kind: "rate_limit"; retryAfter?: number }
  | { kind: "5xx"; status?: number }
  | { kind: "network" }
  | { kind: "401" }

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
const TOKEN_URL = "https://oauth2.googleapis.com/token"

type RouteState = {
  responses: unknown[]
  failure: GmailFailureKind | null
}

type JsonResponse = Record<string, unknown> | unknown[]

export type GmailMocks = {
  start(): void
  stop(): void
  reset(): void
  injectFailure(route: GmailMockRoute, failure: GmailFailureKind): void
  queue(route: GmailMockRoute, response: unknown): void
  requests(): Array<{ route: GmailMockRoute; url: string; body?: unknown }>
}

export function setupGmailMocks(initial: GmailMockHandler[] = []): GmailMocks {
  const state: Record<GmailMockRoute, RouteState> = {
    token: { responses: [], failure: null },
    "messages.send": { responses: [], failure: null },
    "messages.get": { responses: [], failure: null },
    "history.list": { responses: [], failure: null },
    watch: { responses: [], failure: null },
  }
  const requestLog: Array<{ route: GmailMockRoute; url: string; body?: unknown }> = []

  for (const h of initial) {
    if (h.response !== undefined) state[h.route].responses.push(h.response)
  }

  function applyFailure(route: GmailMockRoute): StrictResponse<DefaultBodyType> | null {
    const f = state[route].failure
    if (!f) return null
    if (f.kind === "rate_limit") {
      return HttpResponse.json(
        { error: { code: 429, message: "rate limited" } },
        {
          status: 429,
          headers: { "Retry-After": String(f.retryAfter ?? 1) },
        },
      ) as StrictResponse<DefaultBodyType>
    }
    if (f.kind === "5xx") {
      return HttpResponse.json(
        { error: { code: f.status ?? 500, message: "server error" } },
        { status: f.status ?? 500 },
      ) as StrictResponse<DefaultBodyType>
    }
    if (f.kind === "401") {
      return HttpResponse.json(
        { error: { code: 401, message: "unauthorized" } },
        { status: 401 },
      ) as StrictResponse<DefaultBodyType>
    }
    if (f.kind === "network") {
      return HttpResponse.error() as StrictResponse<DefaultBodyType>
    }
    return null
  }

  function nextResponse(route: GmailMockRoute, fallback: JsonResponse): JsonResponse {
    const queue = state[route].responses
    if (queue.length > 0) return queue.shift() as JsonResponse
    return fallback
  }

  const handlers = [
    http.post(TOKEN_URL, async ({ request }) => {
      requestLog.push({ route: "token", url: request.url })
      const failure = applyFailure("token")
      if (failure) return failure
      return HttpResponse.json(
        nextResponse("token", {
          access_token: "test-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      )
    }),
    http.post(`${GMAIL_BASE}/messages/send`, async ({ request }) => {
      let body: unknown
      try {
        body = await request.clone().json()
      } catch {
        body = undefined
      }
      requestLog.push({ route: "messages.send", url: request.url, body })
      const failure = applyFailure("messages.send")
      if (failure) return failure
      return HttpResponse.json(
        nextResponse("messages.send", { id: "gmail-msg-1", threadId: "T-1" }),
      )
    }),
    http.get(`${GMAIL_BASE}/messages/:id`, async ({ request, params }) => {
      requestLog.push({ route: "messages.get", url: request.url, body: params })
      const failure = applyFailure("messages.get")
      if (failure) return failure
      return HttpResponse.json(
        nextResponse("messages.get", {
          id: String(params.id ?? ""),
          threadId: "T-default",
          labelIds: ["INBOX"],
          payload: { headers: [], body: { data: "" } },
        }),
      )
    }),
    http.get(`${GMAIL_BASE}/history`, async ({ request }) => {
      requestLog.push({ route: "history.list", url: request.url })
      const failure = applyFailure("history.list")
      if (failure) return failure
      return HttpResponse.json(nextResponse("history.list", { history: [], historyId: "1" }))
    }),
    http.post(`${GMAIL_BASE}/watch`, async ({ request }) => {
      requestLog.push({ route: "watch", url: request.url })
      const failure = applyFailure("watch")
      if (failure) return failure
      return HttpResponse.json(
        nextResponse("watch", {
          historyId: "1",
          expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
        }),
      )
    }),
  ]

  let server: MswServer | null = null

  return {
    start() {
      if (!server) server = setupServer(...handlers)
      server.listen({ onUnhandledRequest: "bypass" })
    },
    stop() {
      if (server) {
        server.close()
        server = null
      }
    },
    reset() {
      for (const r of Object.keys(state) as GmailMockRoute[]) {
        state[r].responses.length = 0
        state[r].failure = null
      }
      requestLog.length = 0
    },
    injectFailure(route, failure) {
      state[route].failure = failure
    },
    queue(route, response) {
      state[route].responses.push(response)
    },
    requests() {
      return requestLog.slice()
    },
  }
}
