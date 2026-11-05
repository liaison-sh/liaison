// SPDX-License-Identifier: FSL-1.1-ALv2
import { Hono } from "hono"

export type GmailHistoryEntry = {
  id?: string
  messagesAdded?: Array<{ message: { id: string } }>
}

export type GmailHistoryResponse = {
  history?: GmailHistoryEntry[]
  historyId?: string
}

export type GmailMessageHeader = { name: string; value: string }

export type GmailMessageResponse = {
  id: string
  threadId?: string
  labelIds?: string[]
  internalDate?: string
  payload?: {
    mimeType?: string
    headers?: GmailMessageHeader[]
    body?: { data?: string; size?: number }
    parts?: Array<{
      mimeType?: string
      headers?: GmailMessageHeader[]
      body?: { data?: string; size?: number }
    }>
  }
}

export type GmailSendResponse = { id: string; threadId?: string }
export type GmailWatchResponse = { historyId: string; expiration: string }

export type CapturedGmailRequest = {
  route: "token" | "history.list" | "messages.get" | "messages.send" | "watch"
  url: string
  method: string
  body?: unknown
  account?: string
}

type FixtureFailure = "network" | "429" | "5xx"

export type GmailHttpFixture = {
  baseUrl: string
  tokenUrl: string
  apiBaseUrl: string
  queueHistory(accountEmail: string, history: GmailHistoryResponse): void
  queueMessage(accountEmail: string, messageId: string, payload: GmailMessageResponse): void
  queueSendResponse(accountEmail: string, response: GmailSendResponse): void
  queueWatchResponse(accountEmail: string, response: GmailWatchResponse): void
  injectFailure(
    route: "token" | "history" | "message" | "send" | "watch",
    kind: FixtureFailure,
  ): void
  requests(): CapturedGmailRequest[]
  reset(): void
  close(): Promise<void>
}

export async function startGmailHttpFixture(): Promise<GmailHttpFixture> {
  const requestLog: CapturedGmailRequest[] = []
  const historyByAccount = new Map<string, GmailHistoryResponse[]>()
  const messagesByAccount = new Map<string, Map<string, GmailMessageResponse[]>>()
  const sendByAccount = new Map<string, GmailSendResponse[]>()
  const watchByAccount = new Map<string, GmailWatchResponse[]>()
  const failures = new Map<string, FixtureFailure>()

  function failureOnce(route: string): FixtureFailure | undefined {
    const f = failures.get(route)
    if (f !== undefined) failures.delete(route)
    return f
  }

  function applyFailure(route: string): Response | null {
    const f = failureOnce(route)
    if (!f) return null
    if (f === "429") {
      return new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "1" },
      })
    }
    if (f === "5xx") {
      return new Response(JSON.stringify({ error: "server_error" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("network error", { status: 500 })
  }

  const app = new Hono()

  // Account email is supplied via X-Test-Account header (set by the worker).
  function accountFromReq(c: { req: { header: (n: string) => string | undefined } }): string {
    const h = c.req.header("x-test-account") ?? c.req.header("X-Test-Account")
    return (h ?? "").toLowerCase()
  }

  app.post("/oauth2/token", async (c) => {
    requestLog.push({ route: "token", url: c.req.url, method: "POST" })
    const failure = applyFailure("token")
    if (failure) return failure
    return c.json({ access_token: "test-access-token", token_type: "Bearer", expires_in: 3600 })
  })

  app.get("/gmail/v1/users/me/history", async (c) => {
    const account = accountFromReq(c)
    requestLog.push({ route: "history.list", url: c.req.url, method: "GET", account })
    const failure = applyFailure("history")
    if (failure) return failure
    const queue = historyByAccount.get(account) ?? []
    const next = queue.shift() ?? { history: [], historyId: "1" }
    return c.json(next)
  })

  app.get("/gmail/v1/users/me/messages/:id", async (c) => {
    const account = accountFromReq(c)
    const id = c.req.param("id")
    requestLog.push({ route: "messages.get", url: c.req.url, method: "GET", account })
    const failure = applyFailure("message")
    if (failure) return failure
    const queue = messagesByAccount.get(account)?.get(id) ?? []
    const next = queue.shift() ?? {
      id,
      threadId: "T-default",
      labelIds: ["INBOX"],
      payload: { headers: [{ name: "Message-Id", value: `<${id}@gmail.test>` }] },
    }
    return c.json(next)
  })

  app.post("/gmail/v1/users/me/messages/send", async (c) => {
    const account = accountFromReq(c)
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      body = undefined
    }
    requestLog.push({ route: "messages.send", url: c.req.url, method: "POST", account, body })
    const failure = applyFailure("send")
    if (failure) return failure
    const queue = sendByAccount.get(account) ?? []
    const next = queue.shift() ?? { id: `g-${Date.now()}`, threadId: `T-${Date.now()}` }
    return c.json(next)
  })

  app.post("/gmail/v1/users/me/watch", async (c) => {
    const account = accountFromReq(c)
    requestLog.push({ route: "watch", url: c.req.url, method: "POST", account })
    const failure = applyFailure("watch")
    if (failure) return failure
    const queue = watchByAccount.get(account) ?? []
    const next = queue.shift() ?? {
      historyId: "1",
      expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }
    return c.json(next)
  })

  const server = Bun.serve({ fetch: app.fetch, port: 0 })
  const baseUrl = `http://127.0.0.1:${server.port}`

  return {
    baseUrl,
    tokenUrl: `${baseUrl}/oauth2/token`,
    apiBaseUrl: `${baseUrl}/gmail/v1`,
    queueHistory(accountEmail, history) {
      const key = accountEmail.toLowerCase()
      const list = historyByAccount.get(key) ?? []
      list.push(history)
      historyByAccount.set(key, list)
    },
    queueMessage(accountEmail, messageId, payload) {
      const key = accountEmail.toLowerCase()
      const map = messagesByAccount.get(key) ?? new Map<string, GmailMessageResponse[]>()
      const list = map.get(messageId) ?? []
      list.push(payload)
      map.set(messageId, list)
      messagesByAccount.set(key, map)
    },
    queueSendResponse(accountEmail, response) {
      const key = accountEmail.toLowerCase()
      const list = sendByAccount.get(key) ?? []
      list.push(response)
      sendByAccount.set(key, list)
    },
    queueWatchResponse(accountEmail, response) {
      const key = accountEmail.toLowerCase()
      const list = watchByAccount.get(key) ?? []
      list.push(response)
      watchByAccount.set(key, list)
    },
    injectFailure(route, kind) {
      failures.set(route, kind)
    },
    requests() {
      return requestLog.slice()
    },
    reset() {
      requestLog.length = 0
      historyByAccount.clear()
      messagesByAccount.clear()
      sendByAccount.clear()
      watchByAccount.clear()
      failures.clear()
    },
    async close() {
      server.stop(true)
    },
  }
}
