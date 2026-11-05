// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { createDeepLinkQueue, parseDeepLink, SESSION_LINK_PREFIX } from "./deep-link"

describe("parseDeepLink", () => {
  it("parses a thread deep link into a route path", () => {
    expect(parseDeepLink("liaison://thread/abc123")).toBe("/threads/abc123")
  })

  it("refuses anything that is not a liaison thread link", () => {
    // Fail closed: a deep link is attacker reachable, any page can navigate to
    // one, and the value ends up in the app's own router.
    for (const link of [
      "https://example.com/threads/abc123",
      "javascript:alert(1)",
      "liaison://thread",
      "liaison://thread/",
      "liaison://thread/abc123/extra",
      "liaison://thread/../../settings",
      "liaison://thread/abc%2F123",
      "liaison://thread/abc123?tab=files",
      "liaison://thread/abc123#top",
      "liaison://threads/abc123",
      "liaison://connect?server=https://example.com",
      "not a url",
      "",
    ]) {
      expect(parseDeepLink(link)).toBeNull()
    }
  })

  it("refuses a thread id that is not an identifier", () => {
    expect(parseDeepLink(`liaison://thread/${"a".repeat(200)}`)).toBeNull()
    expect(parseDeepLink("liaison://thread/a b")).toBeNull()
  })
})

describe("parseDeepLink: sessions", () => {
  it("parses a session deep link into the session route", () => {
    expect(parseDeepLink("liaison://session/abc-123")).toBe("/sessions/abc-123")
  })

  it("refuses a session link that is not exactly session/<id>", () => {
    for (const link of [
      "liaison://session/../x",
      "liaison://session/a/b",
      "liaison://session/a?x=1",
      "liaison://session/a#f",
      "liaison://sessions/a",
      `liaison://session/${"a".repeat(65)}`,
      "liaison://session/",
      "liaison://session",
      "liaison://session/a%2Fb",
    ]) {
      expect(parseDeepLink(link)).toBeNull()
    }
  })

  it("exports the session link prefix", () => {
    expect(SESSION_LINK_PREFIX).toBe("liaison://session/")
  })
})

describe("parseDeepLink: attention items (LIF-18)", () => {
  it("routes a strict attention link through the app's notification route", () => {
    expect(
      parseDeepLink(
        "liaison://attention/kernel/approval_request/5f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
      ),
    ).toBe(
      `/?route=${encodeURIComponent("attention/kernel/approval_request/5f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b")}`,
    )
    expect(parseDeepLink("liaison://attention/projects/task/t-42")).toBe(
      `/?route=${encodeURIComponent("attention/projects/task/t-42")}`,
    )
  })

  it("routes an attention id with dots, colons or escapes, the web resolver's grammar", () => {
    for (const path of [
      "monitoring/incident/inc.42",
      "mail/conversation/gmail:18f3a@x",
      "mail/conversation/a%3Ab",
    ]) {
      expect(parseDeepLink(`liaison://attention/${path}`)).toBe(
        `/?route=${encodeURIComponent(`attention/${path}`)}`,
      )
    }
  })

  it("refuses an attention link that is not exactly app/type/id", () => {
    for (const link of [
      "liaison://attention",
      "liaison://attention/",
      "liaison://attention/kernel/approval_request",
      "liaison://attention/kernel/approval_request/",
      "liaison://attention/kernel/approval_request/abc/extra",
      "liaison://attention/x/y/../",
      "liaison://attention/x/y/..",
      "liaison://attention/../../settings/x",
      "liaison://attention/Kernel/approval_request/abc",
      "liaison://attention/kernel/approval_request/abc%2F123",
      "liaison://attention/kernel/approval_request/a%5Cb",
      "liaison://attention/kernel/approval_request/%2E%2E",
      "liaison://attention/kernel/approval_request/a..b",
      "liaison://attention/kernel/approval_request/.",
      "liaison://attention/kernel/approval_request/%252F",
      "liaison://attention/kernel/approval_request/%E0%A4%A",
      "liaison://attention/kernel/approval_request/abc?x=1",
      "liaison://attention/kernel/approval_request/abc#top",
      "liaison://attention/kernel/approval request/abc",
      `liaison://attention/kernel/approval_request/${"a".repeat(200)}`,
      "liaison://attention//approval_request/abc",
    ]) {
      expect(parseDeepLink(link)).toBeNull()
    }
  })
})

describe("parseDeepLink: a message in an entity's thread", () => {
  const T = "5f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"
  const M = "6a2d3b4c-5e6f-4a71-8b2c-3d4e5f6a7b8c"
  it("routes the entity with the thread and message to bring into view", () => {
    expect(parseDeepLink(`liaison://attention/projects/task/t-42?thread=${T}&message=${M}`)).toBe(
      `/?route=${encodeURIComponent(`attention/projects/task/t-42?thread=${T}&message=${M}`)}`,
    )
  })
  it("refuses any other query on an attention link", () => {
    for (const link of [
      `liaison://attention/projects/task/t-42?message=${M}`,
      `liaison://attention/projects/task/t-42?thread=${T}&message=${M}&x=1`,
      `liaison://attention/projects/task/t-42?thread=${T}&message=../x`,
      `liaison://attention/projects/task/t-42?message=${M}&thread=${T}`,
      `liaison://attention/projects/task/t-42?thread=${T}&message=${M}#top`,
    ]) {
      expect(parseDeepLink(link)).toBeNull()
    }
  })
})

describe("deep link queue", () => {
  it("queues a link received before app ready and flushes it once ready", () => {
    const seen: string[] = []
    const queue = createDeepLinkQueue()
    queue.onAppUrlOpen("liaison://thread/abc123")
    queue.registerNavigator((path) => seen.push(path))
    expect(seen).toEqual([])
    queue.markAppReady()
    expect(seen).toEqual(["/threads/abc123"])
  })

  it("delivers a link exactly once, never twice", () => {
    const seen: string[] = []
    const queue = createDeepLinkQueue()
    queue.registerNavigator((path) => seen.push(path))
    queue.onAppUrlOpen("liaison://thread/abc123")
    queue.markAppReady()
    queue.markAppReady()
    expect(seen).toEqual(["/threads/abc123"])
  })

  it("navigates straight away once the app is ready", () => {
    const seen: string[] = []
    const queue = createDeepLinkQueue()
    queue.registerNavigator((path) => seen.push(path))
    queue.markAppReady()
    queue.onAppUrlOpen("liaison://thread/one")
    queue.onAppUrlOpen("liaison://thread/two")
    expect(seen).toEqual(["/threads/one", "/threads/two"])
  })

  it("drops a link it cannot validate rather than handing it to the router", () => {
    const seen: string[] = []
    const queue = createDeepLinkQueue()
    queue.registerNavigator((path) => seen.push(path))
    queue.markAppReady()
    queue.onAppUrlOpen("liaison://thread/../settings")
    queue.onAppUrlOpen("https://example.com/threads/x")
    expect(seen).toEqual([])
  })
})
