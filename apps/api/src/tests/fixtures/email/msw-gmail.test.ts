// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { setupGmailMocks } from "./msw-gmail"

describe("msw gmail mock", () => {
  let mocks: ReturnType<typeof setupGmailMocks>

  beforeEach(() => {
    mocks = setupGmailMocks([])
    mocks.start()
  })

  afterEach(() => {
    mocks.stop()
  })

  it("intercepts users.messages.send with default + queued + 429 failure", async () => {
    mocks.queue("messages.send", { id: "g1", threadId: "t1" })
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: "Bearer x" },
      body: JSON.stringify({ raw: "x" }),
    })
    expect(await r.json()).toEqual({ id: "g1", threadId: "t1" })

    mocks.injectFailure("messages.send", { kind: "rate_limit", retryAfter: 5 })
    const r2 = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: "Bearer x" },
      body: JSON.stringify({ raw: "x" }),
    })
    expect(r2.status).toBe(429)
    expect(r2.headers.get("retry-after")).toBe("5")
  })

  it("captures requests and supports oauth token route", async () => {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: "grant_type=refresh_token",
    })
    expect(r.status).toBe(200)
    const json = (await r.json()) as { access_token: string }
    expect(json.access_token).toBe("test-access-token")
    const log = mocks.requests()
    expect(log[0].route).toBe("token")
  })

  it("history.list returns queued response", async () => {
    mocks.queue("history.list", {
      history: [{ id: "h1", messagesAdded: [{ message: { id: "m1" } }] }],
      historyId: "42",
    })
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=1")
    const body = (await r.json()) as { historyId: string }
    expect(body.historyId).toBe("42")
  })

  it("messages.get echoes id parameter", async () => {
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/abc")
    const body = (await r.json()) as { id: string }
    expect(body.id).toBe("abc")
  })

  it("watch returns historyId/expiration", async () => {
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/watch", {
      method: "POST",
    })
    const body = (await r.json()) as { historyId: string; expiration: string }
    expect(body.historyId).toBe("1")
    expect(Number(body.expiration)).toBeGreaterThan(Date.now())
  })
})
