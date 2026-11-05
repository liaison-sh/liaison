// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { createJobTurnTransport } from "./job-turn-transport"

// A whole /chat stream: its text, then its own `done` frame (the server always ends with one).
const sse = (text: string) =>
  new Response(
    `event: text-delta\ndata: ${JSON.stringify({ delta: text })}\n\nevent: done\ndata: {}\n\n`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )

const restarting = (retryAfter: string | null = "1") =>
  new Response(JSON.stringify({ error: { message: "restarting", code: "RESTARTING" } }), {
    status: 503,
    headers: {
      "content-type": "application/json",
      ...(retryAfter === null ? {} : { "retry-after": retryAfter }),
    },
  })

/** The waits one turn makes when its first answer is `first`. */
async function retryWaits(first: Response): Promise<number[]> {
  const answers = [first, sse("done")]
  const sleeps: number[] = []
  const send = createJobTurnTransport({
    getToken: () => "t",
    createThread: async () => "thread-1",
    fetchImpl: async () => {
      const next = answers.shift()
      if (!next) throw new Error("no more answers")
      return next
    },
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  expect(await send({ prompt: "p", turnNonce: "n" })).toEqual({ text: "done" })
  return sleeps
}

describe("createJobTurnTransport", () => {
  it("retries once, after 1 s, when the server answers 503 RESTARTING", async () => {
    const answers = [restarting(), sse("done")]
    const calls: string[] = []
    const sleeps: number[] = []
    const send = createJobTurnTransport({
      getToken: () => "t",
      createThread: async () => "thread-1",
      fetchImpl: async (url) => {
        calls.push(url)
        const next = answers.shift()
        if (!next) throw new Error("no more answers")
        return next
      },
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    expect(await send({ prompt: "p", turnNonce: "n" })).toEqual({ text: "done" })
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([1_000])
  })

  it("waits what the server's Retry-After says, bounded, before the one retry", async () => {
    expect(await retryWaits(restarting("2"))).toEqual([2_000])
    // No hint, or one that cannot be read: a second.
    expect(await retryWaits(restarting(null))).toEqual([1_000])
    expect(await retryWaits(restarting("soon"))).toEqual([1_000])
    // A hint past the bound waits the bound: the next process is up by then.
    expect(await retryWaits(restarting("3600"))).toEqual([5_000])
  })

  it("a second RESTARTING is a refusal, not a loop", async () => {
    const answers = [restarting(), restarting(), sse("never")]
    const send = createJobTurnTransport({
      getToken: () => "t",
      createThread: async () => "thread-1",
      fetchImpl: async () => {
        const next = answers.shift()
        if (!next) throw new Error("no more answers")
        return next
      },
      sleep: async () => {},
    })
    await expect(send({ prompt: "p", turnNonce: "n" })).rejects.toThrow("refused")
    expect(answers).toHaveLength(1)
  })
})

const frames = (...events: Array<[string, Record<string, unknown>]>) =>
  new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

describe("a job turn the server hands to another process (S10)", () => {
  it("follows a `restart` frame to the re-attach stream and records its reply, not the cut text", async () => {
    const calls: Array<{ url: string; method: string; auth: string | null }> = []
    const answers = [
      frames(
        ["message-start", { threadId: "thread-1" }],
        ["text-delta", { delta: "Half an ans" }],
        ["restart", { turnId: "turn-9", threadId: "thread-1" }],
      ),
      frames(
        ["attached", { turnId: "turn-9" }],
        ["rewind", { text: "" }],
        ["text-delta", { delta: "The whole " }],
        ["text-delta", { delta: "answer." }],
        ["done", { messageId: "m-1", text: "The whole answer." }],
      ),
    ]
    const send = createJobTurnTransport({
      getToken: () => "t",
      createThread: async () => "thread-1",
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers)
        calls.push({ url, method: init?.method ?? "GET", auth: headers.get("Authorization") })
        const next = answers.shift()
        if (!next) throw new Error("no more answers")
        return next
      },
      sleep: async () => {},
    })
    expect(await send({ prompt: "p", turnNonce: "n" })).toEqual({ text: "The whole answer." })
    expect(calls.map((c) => [c.method, c.url.replace(/^.*\/api/, "")])).toEqual([
      ["POST", "/agent/chat"],
      ["GET", "/agent/turns/turn-9/events"],
    ])
    expect(calls[1]?.auth).toBe("Bearer t")
  })

  it("a re-attach stream that ends in an error fails the job", async () => {
    const answers = [
      frames(["restart", { turnId: "turn-9" }]),
      frames(["attached", { turnId: "turn-9" }], ["error", { message: "x", code: "failed" }]),
    ]
    const send = createJobTurnTransport({
      getToken: () => "t",
      createThread: async () => "thread-1",
      fetchImpl: async () => {
        const next = answers.shift()
        if (!next) throw new Error("no more answers")
        return next
      },
      sleep: async () => {},
    })
    await expect(send({ prompt: "p", turnNonce: "n" })).rejects.toThrow("failed")
  })

  it("M1: a stream that stops without its end follows the turn it named, and records that reply", async () => {
    const calls: string[] = []
    const answers = [
      // The server went away mid-turn: no done, no error, no restart.
      frames(
        ["message-start", { threadId: "thread-1", turnId: "turn-7" }],
        ["text-delta", { delta: "Half an ans" }],
      ),
      frames(
        ["attached", { turnId: "turn-7" }],
        ["done", { messageId: "m-7", text: "All of it." }],
      ),
    ]
    const send = createJobTurnTransport({
      getToken: () => "t",
      createThread: async () => "thread-1",
      fetchImpl: async (url) => {
        calls.push(url.replace(/^.*\/api/, ""))
        const next = answers.shift()
        if (!next) throw new Error("no more answers")
        return next
      },
      sleep: async () => {},
    })
    expect(await send({ prompt: "p", turnNonce: "n" })).toEqual({ text: "All of it." })
    expect(calls).toEqual(["/agent/chat", "/agent/turns/turn-7/events"])
  })

  it("M1: a stream that stops without its end and names no turn fails, never records the half", async () => {
    const answers = [
      frames(["message-start", { threadId: "thread-1" }], ["text-delta", { delta: "Half" }]),
    ]
    const send = createJobTurnTransport({
      getToken: () => "t",
      createThread: async () => "thread-1",
      fetchImpl: async () => {
        const next = answers.shift()
        if (!next) throw new Error("no more answers")
        return next
      },
      sleep: async () => {},
    })
    await expect(send({ prompt: "p", turnNonce: "n" })).rejects.toThrow("without an answer")
  })

  it("M1: a re-attach stream that stops without its end is followed again, not recorded", async () => {
    const answers = [
      frames(["restart", { turnId: "turn-9" }]),
      frames(["attached", { turnId: "turn-9" }], ["text-delta", { delta: "Part" }]),
      frames(["attached", { turnId: "turn-9" }], ["done", { messageId: "m-9", text: "Whole." }]),
    ]
    const send = createJobTurnTransport({
      getToken: () => "t",
      createThread: async () => "thread-1",
      fetchImpl: async () => {
        const next = answers.shift()
        if (!next) throw new Error("no more answers")
        return next
      },
      sleep: async () => {},
    })
    expect(await send({ prompt: "p", turnNonce: "n" })).toEqual({ text: "Whole." })
  })
})
