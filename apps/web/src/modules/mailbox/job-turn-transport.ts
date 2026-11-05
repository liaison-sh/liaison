// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How a drained client job reaches a SERVER-SIDE turn (blueprint Task 11.3).
//
// THE BROWSER STILL RUNS NO AGENT. This posts the same `/api/agent/chat` a
// person's turn posts, carrying the same turn nonce, and reads the same SSE
// stream. The only thing that is different is who typed the prompt.
//
// The prompt is ENVELOPE ONLY, built by `buildJobPrompt`. The decrypted message
// text never travels in it: the turn asks for it, and the responder answers
// from the plaintext the drainer already opened. That is the whole reason this
// is a transport and not a "send the mail to the model" helper.
//
// Job turns live in one dedicated agent chat per tab, so a job never writes
// into a conversation the user is reading.

import { apiUrl } from "~/lib/env"
import { isRestartingResponse, noteServerRestarting, restartRetryDelayMs } from "~/lib/server-pause"

export interface JobTurnTransportDeps {
  getToken: () => string | null
  /** Creates the thread job turns run in. Called at most once per tab. */
  createThread: () => Promise<string>
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
  /** Test seam for the retry wait. */
  sleep?: (ms: number) => Promise<void>
}

export interface JobTurnInput {
  prompt: string
  turnNonce: string
}

/** What one SSE body said: the turn's text, and the turn it moved to, if any. */
export interface TurnStreamResult {
  text: string
  /** Set by a `restart` frame: the turn goes on on another process (S10). */
  restartTurnId: string | null
  /** The turn the stream is about (`message-start` or `attached`), when it said. */
  turnId: string | null
  /**
   * True when the stream ended with its own terminal frame (`done`, `error`
   * or `restart`). A stream that just stops (the server went away, a deadline)
   * did not finish the turn: its text is NOT the answer (M1).
   */
  terminal: boolean
}

/** Reads the SSE body and returns the turn's text. Never throws on a partial
 *  stream: what arrived is what the job records. A `restart` frame (the server
 *  handed the turn to another process) names the turn to re-attach to; the
 *  re-attach stream's `rewind` replaces the text so far, and its `done`
 *  carries the stored reply. */
export async function readTurnStream(response: Response): Promise<TurnStreamResult> {
  const body = response.body
  if (!body) return { text: "", restartTurnId: null, turnId: null, terminal: false }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let text = ""
  let restartTurnId: string | null = null
  let turnId: string | null = null
  let terminal = false
  let failure: string | null = null
  const consume = (part: string) => {
    let eventType = ""
    let dataStr = ""
    for (const line of part.split("\n")) {
      if (line.startsWith("event: ")) eventType = line.slice(7)
      else if (line.startsWith("data: ")) dataStr = line.slice(6)
    }
    if (!eventType || !dataStr) return
    let data: Record<string, unknown>
    try {
      data = JSON.parse(dataStr) as Record<string, unknown>
    } catch {
      return
    }
    if (
      (eventType === "message-start" || eventType === "attached") &&
      typeof data.turnId === "string"
    )
      turnId = data.turnId
    if (eventType === "text-delta" && typeof data.delta === "string") text += data.delta
    if (eventType === "rewind" && typeof data.text === "string") text = data.text
    if (eventType === "done") {
      terminal = true
      if (typeof data.text === "string") text = data.text
    }
    if (eventType === "restart" && typeof data.turnId === "string") {
      terminal = true
      restartTurnId = data.turnId
    }
    if (eventType === "error") {
      terminal = true
      failure = typeof data.message === "string" ? data.message : "failed"
    }
  }
  while (true) {
    // A connection the server dropped ends the read like an end of stream:
    // with no terminal frame, the turn is followed, not recorded.
    const chunk = await reader.read().catch(() => null)
    if (!chunk) break
    const { done, value } = chunk
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split("\n\n")
    buffer = parts.pop() ?? ""
    for (const part of parts) consume(part)
  }
  if (buffer.trim()) consume(buffer)
  // A turn that ended in an error has no result to record, and recording its
  // partial text as the answer would be worse than reporting the failure.
  if (failure) throw new Error("the mailbox job turn failed")
  return { text, restartTurnId, turnId, terminal }
}

/** How many times one job follows its turn to another process. */
const MAX_REATTACH = 3

export function createJobTurnTransport(
  deps: JobTurnTransportDeps,
): (input: JobTurnInput) => Promise<{ text: string }> {
  const doFetch = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let threadId: string | null = null

  return async (input) => {
    if (!threadId) threadId = await deps.createThread()
    const post = () => {
      const token = deps.getToken()
      return doFetch(apiUrl("/agent/chat"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ threadId, content: input.prompt, turnNonce: input.turnNonce }),
      })
    }
    let response = await post()
    // The server was restarting and saved nothing: once more, after its
    // Retry-After (a second when it gives none), which reaches a live process.
    if (await isRestartingResponse(response)) {
      // The shell's pause notice says the server is updating (lib/server-pause.ts).
      noteServerRestarting()
      await sleep(restartRetryDelayMs(response))
      response = await post()
    }
    if (!response.ok) throw new Error("the mailbox job turn was refused")
    let result = await readTurnStream(response)
    // The turn being followed: the restart frame names where it went, else
    // the turn the stream said it was about.
    const nextTurn = (r: TurnStreamResult): string | null =>
      r.restartTurnId ?? (r.terminal ? null : r.turnId)
    let following = nextTurn(result) ?? result.turnId
    // The server handed the turn to another process (a deploy, a crash), or
    // the stream stopped before the turn ended: it goes on there, so follow
    // it rather than record the half that streamed here. The re-attach
    // stream's text replaces it.
    for (let hop = 0; nextTurn(result) && hop < MAX_REATTACH; hop++) {
      const turnId = nextTurn(result) ?? ""
      following = turnId
      const token = deps.getToken()
      const attached = await doFetch(apiUrl(`/agent/turns/${encodeURIComponent(turnId)}/events`), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!attached.ok) throw new Error("the mailbox job turn moved and could not be followed")
      result = await readTurnStream(attached)
      if (!result.turnId) result = { ...result, turnId: following }
    }
    if (result.restartTurnId)
      throw new Error("the mailbox job turn moved and could not be followed")
    // A stream that stopped without its end, and no turn to follow: the
    // answer is not known, and half of it is not the answer.
    if (!result.terminal) throw new Error("the mailbox job turn ended without an answer")
    return { text: result.text }
  }
}
