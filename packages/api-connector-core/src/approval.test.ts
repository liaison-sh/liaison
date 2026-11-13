// SPDX-License-Identifier: FSL-1.1-ALv2
// A write's `approval` block (what its approval card shows besides the
// request) and `linkHosts`: what a save accepts and refuses, each refusal on
// the path of the offending value, and how the link and the context read's
// params render from the write's params.
import { describe, expect, it } from "bun:test"
import {
  type Operation,
  renderApprovalContextParams,
  renderApprovalLink,
  validateAdapter,
} from "./index"

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

function forum(approval: Json, extra: { [k: string]: Json } = {}): { [k: string]: Json } {
  return {
    id: "forum",
    name: "Forum",
    version: "1.2.0",
    baseUrl: "https://api.example.com/api/community",
    auth: { type: "bearer" },
    ...extra,
    operations: [
      {
        name: "get_thread",
        description: "One thread and its posts.",
        kind: "read",
        method: "GET",
        path: "/threads/{threadId}",
        params: {
          type: "object",
          properties: { threadId: { type: "string", format: "uuid" } },
          required: ["threadId"],
        },
        items: "/data/posts",
        fields: ["id", "body", "authorName", "createdAt"],
      },
      {
        name: "reply",
        description: "Reply in a thread as the brand.",
        kind: "write",
        method: "POST",
        path: "/threads/{threadId}/posts",
        params: {
          type: "object",
          properties: {
            threadId: { type: "string", format: "uuid" },
            text: { type: "string", minLength: 1, maxLength: 8000 },
          },
          required: ["threadId", "text"],
        },
        body: { body: "{text}" },
        items: "/data",
        fields: ["id"],
        approval,
      },
    ],
  }
}

const GOOD = {
  link: "https://example.com/community?thread={threadId}",
  linkLabel: "Open the thread",
  context: {
    read: "get_thread",
    params: { threadId: "{threadId}" },
    label: "Thread so far",
    maxItems: 8,
  },
}

function issuePaths(input: unknown): string[] {
  const r = validateAdapter(input)
  return r.ok ? [] : r.issues.map((i) => i.path)
}

function issueAt(input: unknown, path: string): string {
  const r = validateAdapter(input)
  if (r.ok) throw new Error(`accepted; expected an issue at ${path}`)
  const hit = r.issues.find((i) => i.path === path)
  if (!hit) throw new Error(`no issue at ${path}: ${JSON.stringify(r.issues)}`)
  return hit.message
}

const AT = "operations.1.approval"

describe("adapter approval block: accepted", () => {
  it("accepts a link on a declared link host and a context read of the same adapter", () => {
    const r = validateAdapter(forum(GOOD, { linkHosts: ["example.com"] }))
    if (!r.ok) throw new Error(JSON.stringify(r.issues))
    expect(r.adapter.operations[1]?.approval?.context?.read).toBe("get_thread")
  })

  it("accepts a link on the baseUrl host without linkHosts", () => {
    const approval = { link: "https://api.example.com/threads/{threadId}" }
    expect(issuePaths(forum(approval))).toEqual([])
  })

  it("an adapter without approval or linkHosts is valid as before", () => {
    const a = forum(null)
    const reply = (a.operations as { [k: string]: Json }[])[1]
    if (reply) delete reply.approval
    expect(issuePaths(a)).toEqual([])
  })
})

describe("adapter approval block: refused", () => {
  it("a link off the baseUrl host and every linkHosts host", () => {
    expect(issueAt(forum(GOOD), `${AT}.link`)).toContain("linkHosts")
    expect(issuePaths(forum(GOOD, { linkHosts: ["other.example"] }))).toContain(`${AT}.link`)
  })

  it("a link that is not https, or has a placeholder in its host", () => {
    const http = { link: "http://example.com/t/{threadId}" }
    expect(issuePaths(forum(http, { linkHosts: ["example.com"] }))).toContain(`${AT}.link`)
    const inHost = { link: "https://{threadId}.example.com/t" }
    expect(issueAt(forum(inHost, { linkHosts: ["example.com"] }), `${AT}.link`)).toContain(
      "after the host",
    )
  })

  it("a link with userinfo, a port or a fragment", () => {
    for (const link of [
      "https://user@example.com/t/{threadId}",
      "https://example.com:8443/t/{threadId}",
      "https://example.com/t/{threadId}#top",
    ]) {
      expect(issuePaths(forum({ link }, { linkHosts: ["example.com"] }))).toContain(`${AT}.link`)
    }
  })

  it("a link placeholder that names no param of the write", () => {
    const approval = { link: "https://example.com/t/{postId}" }
    expect(issueAt(forum(approval, { linkHosts: ["example.com"] }), `${AT}.link`)).toContain(
      "{postId}",
    )
  })

  it("a linkLabel without a link", () => {
    expect(issuePaths(forum({ linkLabel: "Open" }))).toContain(`${AT}.linkLabel`)
  })

  it("a context read that does not exist, or is a write", () => {
    const missing = { context: { read: "no_such_read", params: {} } }
    expect(issuePaths(forum(missing))).toContain(`${AT}.context.read`)
    const write = { context: { read: "reply", params: { threadId: "{threadId}" } } }
    expect(issueAt(forum(write), `${AT}.context.read`)).toContain("runs a read")
  })

  it("context params: an unknown param of the read, a placeholder naming no write param, a required one missing", () => {
    const unknown = {
      context: { read: "get_thread", params: { threadId: "{threadId}", page: "1" } },
    }
    expect(issuePaths(forum(unknown))).toContain(`${AT}.context.params.page`)
    const badRef = { context: { read: "get_thread", params: { threadId: "{postId}" } } }
    expect(issueAt(forum(badRef), `${AT}.context.params.threadId`)).toContain("{postId}")
    const noRequired = { context: { read: "get_thread", params: {} } }
    expect(issueAt(forum(noRequired), `${AT}.context.params`)).toContain("threadId")
  })

  it("maxItems above the ceiling", () => {
    const approval = { context: { ...GOOD.context, maxItems: 50 } }
    expect(issuePaths(forum(approval))).toContain(`${AT}.context.maxItems`)
  })

  it("approval on a read operation", () => {
    const a = forum(null)
    const [read, reply] = a.operations as { [k: string]: Json }[]
    if (reply) delete reply.approval
    if (read) read.approval = { link: "https://api.example.com/t/{threadId}" }
    expect(issueAt(a, "operations.0.approval")).toContain("write operation")
  })

  it("linkHosts: an IP address, a public suffix, a duplicate", () => {
    expect(issuePaths(forum(GOOD, { linkHosts: ["93.184.216.34"] }))).toContain("linkHosts.0")
    expect(issuePaths(forum(GOOD, { linkHosts: ["com"] }))).toContain("linkHosts.0")
    expect(issuePaths(forum(GOOD, { linkHosts: ["example.com", "example.com"] }))).toContain(
      "linkHosts.1",
    )
  })
})

describe("adapter approval block: rendering", () => {
  function replyOp(approval: Json = GOOD): Operation {
    const r = validateAdapter(forum(approval, { linkHosts: ["example.com"] }))
    if (!r.ok) throw new Error(JSON.stringify(r.issues))
    const op = r.adapter.operations[1]
    if (!op) throw new Error("no reply operation")
    return op
  }

  it("the link takes each param URL-encoded, and is null when one is unset", () => {
    const op = replyOp({ link: "https://example.com/community?thread={threadId}&q={text}" })
    expect(renderApprovalLink(op, { threadId: "t-1", text: "a b&c" })).toBe(
      "https://example.com/community?thread=t-1&q=a%20b%26c",
    )
    expect(renderApprovalLink(op, { text: "x" })).toBeNull()
  })

  it("the context params take the write's typed values, interpolate templates, drop unset ones", () => {
    const op = replyOp({
      context: { read: "get_thread", params: { threadId: "{threadId}" } },
    })
    expect(renderApprovalContextParams(op, { threadId: "t-1", text: "hi" })).toEqual({
      threadId: "t-1",
    })
    expect(renderApprovalContextParams(op, { text: "hi" })).toEqual({})
  })
})
