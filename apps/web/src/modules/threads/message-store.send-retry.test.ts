// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A SEND WHOSE ANSWER WAS LOST IS SENT ONCE MORE, AND IS ONE MESSAGE (S26).
//
// A network blip can take the answer of a post the server already stored.
// The send is retried once with the same body, the same correlationId, which
// the server deduplicates: the thread ends with one message, never two and
// never a vanished bubble. A refusal (a 4xx) is an answer and is never retried.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import {
  handleWsMessageEvent,
  messageStore,
  resetMessageStore,
  sendMessage,
} from "~/modules/threads/message-store"
import { resetThreadStore } from "~/modules/threads/thread-store"

const THREAD = "t-blip"
const USER = { id: "u-me", name: "Me" }

/** The posted body, as the fake server reads it. */
function bodyOf(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? Object.fromEntries(Object.entries(raw)) : {}
}

function stored(body: Record<string, unknown>) {
  return {
    id: "m-1",
    threadId: THREAD,
    authorId: USER.id,
    authorName: USER.name,
    authorType: "user",
    content: body.content,
    createdAt: "2026-10-30T09:00:00Z",
  }
}

describe("a send across a network blip", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetMessageStore()
    resetThreadStore()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("a send whose response was lost is retried once with the same correlationId and ends as one message", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const post = vi.fn(async (_path: string, raw: unknown) => {
      const body = bodyOf(raw)
      bodies.push(body)
      if (bodies.length === 1) {
        // The server stored it and the socket echoed it; the answer was lost.
        handleWsMessageEvent("create", { ...stored(body), correlationId: body.correlationId })
        throw new ApiError("Network error", 0)
      }
      // The server's dedup replays the stored message for the same correlationId.
      return { data: stored(body) }
    })
    const sent = sendMessage({ post }, THREAD, "hello", USER)
    await vi.advanceTimersByTimeAsync(1_000)
    await sent
    expect(post).toHaveBeenCalledTimes(2)
    expect(bodies[1]).toEqual(bodies[0])
    expect(typeof bodies[0].correlationId).toBe("string")
    const t = messageStore.threads[THREAD]
    expect(t?.ids).toEqual(["m-1"])
    expect(t?.byId["m-1"]?.pending).toBeFalsy()
  })

  it("a retry the server answers 'still in flight' asks again: the send ends stored, once", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const post = vi.fn(async (_path: string, raw: unknown) => {
      const body = bodyOf(raw)
      bodies.push(body)
      if (bodies.length === 1) throw new ApiError("Request timed out", 0, "timeout")
      // The first POST is still committing when the retry reaches the server.
      if (bodies.length === 2) {
        throw new ApiError(
          "The same request is still being processed.",
          409,
          "IDEMPOTENT_IN_FLIGHT",
        )
      }
      return { data: stored(body) }
    })
    const sent = sendMessage({ post }, THREAD, "hello", USER)
    await vi.advanceTimersByTimeAsync(10_000)
    await sent
    expect(post).toHaveBeenCalledTimes(3)
    expect(bodies[2]).toEqual(bodies[0])
    const t = messageStore.threads[THREAD]
    expect(t?.ids).toEqual(["m-1"])
    expect(t?.byId["m-1"]?.pending).toBeFalsy()
  })

  it("another 409 is an answer, never retried", async () => {
    const post = vi.fn(async () => {
      throw new ApiError("Conflict", 409, "CONFLICT")
    })
    const sent = sendMessage({ post }, THREAD, "hello", USER).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await sent).toMatchObject({ status: 409 })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it("a timed-out send is retried the same way", async () => {
    const post = vi.fn(async (_path: string, raw: unknown) => {
      if (post.mock.calls.length === 1) throw new ApiError("Request timed out", 0, "timeout")
      return { data: stored(bodyOf(raw)) }
    })
    const sent = sendMessage({ post }, THREAD, "hello", USER)
    await vi.advanceTimersByTimeAsync(1_000)
    await sent
    expect(post).toHaveBeenCalledTimes(2)
    expect(messageStore.threads[THREAD]?.ids).toEqual(["m-1"])
  })

  it("a refusal is never retried", async () => {
    const post = vi.fn(async () => {
      throw new ApiError("Forbidden", 403)
    })
    const sent = sendMessage({ post }, THREAD, "hello", USER).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await sent).toMatchObject({ status: 403 })
    expect(post).toHaveBeenCalledTimes(1)
    expect(messageStore.threads[THREAD]?.ids).toEqual([])
  })

  it("a send still failing after its retry fails as before: the bubble is taken down", async () => {
    const post = vi.fn(async () => {
      throw new ApiError("Network error", 0)
    })
    const sent = sendMessage({ post }, THREAD, "hello", USER).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await sent).toMatchObject({ status: 0 })
    expect(post).toHaveBeenCalledTimes(2)
    expect(messageStore.threads[THREAD]?.ids).toEqual([])
  })
})
