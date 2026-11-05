// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S17, the pure half: what a payload may carry. The integration test next door
// proves the same rule against a real `messages` row.
import { describe, expect, it } from "bun:test"
import { buildDeepLink, buildPushPayload, PUSH_BODY_MAX } from "~/modules/push/redact"

const THREAD = "8e0b6d6e-0e0f-4f1e-9c2a-0a1b2c3d4e5f"

const base = {
  id: "6f1e2d3c-4b5a-4968-8877-665544332211",
  threadId: THREAD,
  content: "the payout run for Pennylane cleared, 41,200 EUR",
  authorName: "Alice",
  threadTitle: "finance",
}

describe("push payload redaction", () => {
  it("a scope-tagged message payload has no content, body or title field", () => {
    const payload = buildPushPayload(
      { ...base, requiredScopes: ["pennylane:payouts:read"] },
      "mention",
      4,
    )
    expect("content" in payload).toBe(false)
    expect("body" in payload).toBe(false)
    expect("title" in payload).toBe(false)
    expect(payload.badgeCount).toBe(4)
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain("payout")
    expect(serialized).not.toContain("Pennylane")
    expect(serialized).not.toContain("pennylane:payouts:read")
    expect(serialized).not.toContain("finance")
    expect(serialized).not.toContain("Alice")
  })

  it("an unscoped message payload includes the thread title and a truncated body", () => {
    const payload = buildPushPayload({ ...base, requiredScopes: [] }, "dm", 1)
    expect(payload.title).toBe("finance")
    expect(payload.body).toBe(base.content)
    const long = "x".repeat(400)
    const truncated = buildPushPayload({ ...base, requiredScopes: [], content: long }, "dm", 1)
    expect(truncated.body?.length).toBeLessThanOrEqual(PUSH_BODY_MAX)
  })

  it("falls back to the author name when the thread has no title", () => {
    const payload = buildPushPayload({ ...base, threadTitle: null, requiredScopes: [] }, "dm", 0)
    expect(payload.title).toBe("Alice")
  })

  it("redacts when requiredScopes cannot be read, rather than publishing", () => {
    const payload = buildPushPayload(
      { ...base, requiredScopes: null as unknown as string[] },
      "mention",
      0,
    )
    expect("body" in payload).toBe(false)
    expect("title" in payload).toBe(false)
  })

  it("every payload carries a deep link on the registered scheme", () => {
    for (const scopes of [[], ["finance:read"]]) {
      const payload = buildPushPayload({ ...base, requiredScopes: scopes }, "approval", 0)
      expect(payload.deepLink).toBe(`liaison://thread/${THREAD}`)
      expect(payload.deepLink.startsWith("liaison://thread/")).toBe(true)
    }
    expect(buildDeepLink(THREAD)).toBe(`liaison://thread/${THREAD}`)
  })
})

describe("push body is plain text", () => {
  const USER = "11111111-1111-4111-8111-111111111111"
  const AGENT = "6c7de388-0000-4000-8000-000000000001"
  it("renders mentions, links, bold and code spans as readable text", () => {
    const payload = buildPushPayload(
      {
        ...base,
        requiredScopes: [],
        content: `@[Recipient](user:${USER}) ask @[Data](agent:${AGENT}) about **this** [doc](https://x.test/d) and \`npm ci\``,
      },
      "mention",
      1,
    )
    expect(payload.body).toBe("@Recipient ask @Data about this doc and npm ci")
  })
})

// A message in an ENTITY's thread (a task's comments) is pushed as news of
// the entity: the title names it and the tap opens it, on that message.
describe("push payload of a message in an entity's thread", () => {
  const TASK = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
  const anchor = {
    app: "projects",
    entityType: "task",
    entityId: TASK,
    title: "Task: Fix the login page · Website",
  }

  it("names the entity, keeps the author in the body and opens the task on the message", () => {
    const payload = buildPushPayload(
      { ...base, threadTitle: null, requiredScopes: [], anchor },
      "dm",
      2,
    )
    expect(payload.title).toBe("Task: Fix the login page · Website")
    expect(payload.body).toBe(`Alice: ${base.content}`)
    expect(payload.deepLink).toBe(`liaison://attention/projects/task/${TASK}`)
    expect(payload.route).toBe(`attention/projects/task/${TASK}`)
    expect(payload.messageId).toBe(base.id)
    expect(payload.threadId).toBe(THREAD)
    // Rule 5: judged by the message, never by the thread it sits in.
    expect(payload.settle).toBe(`message/${base.id}`)
  })

  it("a scope-tagged message still opens the task but says nothing about it", () => {
    const payload = buildPushPayload({ ...base, requiredScopes: ["x:y:read"], anchor }, "dm", 0)
    expect("title" in payload).toBe(false)
    expect("body" in payload).toBe(false)
    expect(payload.deepLink).toBe(`liaison://attention/projects/task/${TASK}`)
    expect(JSON.stringify(payload)).not.toContain("login")
  })
})

describe("the key a push is settled by (rule 5)", () => {
  it("a message push names the message, a reply's included, never only its channel", () => {
    expect(buildPushPayload({ ...base, requiredScopes: [] }, "dm", 0).settle).toBe(
      `message/${base.id}`,
    )
    const ROOT = "0a0b0c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d"
    const reply = buildPushPayload(
      { ...base, replyRootId: ROOT, requiredScopes: ["x:y:read"] },
      "mention",
      0,
    )
    expect(reply.settle).toBe(`message/${base.id}`)
    expect(reply.threadId).toBe(THREAD)
  })

  it("a message without an id carries no key, so nothing can withdraw it", () => {
    expect("settle" in buildPushPayload({ ...base, id: "", requiredScopes: [] }, "dm", 0)).toBe(
      false,
    )
  })
})
