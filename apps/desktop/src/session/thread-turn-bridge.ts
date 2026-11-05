// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE CONVERSATION IS THE INPUT (A32).
//
// The driven walk found a local session that started, badged itself Local, and
// could not be sent anything: `sendTurn` had no caller, and the blueprint never
// said where a local turn's prompt comes from. It comes from the DM the session
// was started in. This module is the whole loop, and it is deliberately small:
//
//   apps/web names the message the turn answers, through the bridge
//     (`bridge.ts`'s `sendTurn`, which this module's `submitLocalTurn` is)
//     -> the message is re-read from the server, because an id is a claim
//     -> the mention token is stripped, because it names WHO, not WHAT
//     -> `sendTurn` runs it through the sidecar's SDK session
//     -> the permission card and the activity rows are already rendered from
//        the same stream, so neither is wired here
//     -> the turn is posted back as the AGENT's reply, with its activity in
//        the shape a cloud turn stores, retried and kept until it lands
//
// There is no second composer and no second message store: the reply lands in
// the same thread, through the same messages table, and a user reading the
// conversation in a browser sees exactly what a cloud turn would have left.
//
// One turn at a time. The SDK session is a single conversation, and a second
// message arriving mid turn is queued rather than interleaved: two prompts on
// one session come back as one answer with no way to say which question it
// answered.

import type { LocalTurnRecord } from "@liaison/shared/threads/local-turn"
import { claudeAuthFailureOf } from "./claude-auth-failure"
import { createLocalTurnRecorder, type LocalTurnTranscript } from "./local-turn-recorder"
import { onTurnEvent } from "./sidecar-client"
import { SIDECAR_EXITED_TYPE } from "./sidecar-exit"
import type { LocalSessionHandle } from "./start-local-session"
import {
  fetchThreadMessage,
  postAgentReply,
  ReplyNotPostedError,
  sendTurn,
} from "./start-local-session"
import {
  forgetUndeliveredReply,
  keepUndeliveredReply,
  undeliveredRepliesIn,
  undeliveredReplyFor,
} from "./undelivered-replies"

/**
 * The mention token a message opens with, in apps/web's own format
 * (`lib/mention-format.ts`): `@[Name](agent:<id>)`. It addresses the agent, it
 * is not part of the question, and leaving it in makes every local prompt start
 * by telling the agent its own name.
 */
const LEADING_MENTION_TOKEN = /^\s*@\[[^\]]*\]\(agent:[^)]*\)\s*/

/** What the agent is actually being asked. */
export function promptFromMessage(text: string): string {
  return text.replace(LEADING_MENTION_TOKEN, "").trim()
}

/**
 * THE LIVE SESSION, registered by whoever attached the loop.
 *
 * The conversation's composer lives in apps/web and reaches the shell through
 * `window.__LIAISON_DESKTOP__` (bridge.ts). That is the ONLY way in since
 * P6d-T16a: the document event this module also listened on is gone, along
 * with the overlay that needed it.
 */
let liveSession: { handle: LocalSessionHandle; threadId: string } | null = null

/** Serializes every turn, whichever path asked for it. One SDK conversation. */
let liveQueue: Promise<void> = Promise.resolve()

/** The message whose turn is running now, or null between turns. */
let runningMessageId: string | null = null

/**
 * Who is told when a turn could not run, or ran and could not be posted.
 * Registered by whoever attached the loop. `undelivered` says the answer
 * exists and is kept on this machine, so a Retry posts it rather than running
 * the turn again.
 */
export type LocalTurnFailureReporter = (
  messageId: string,
  reason: string,
  kind?: "stopped" | "undelivered",
) => void
let reportFailure: LocalTurnFailureReporter | null = null

/** Who is told that an answer reached the conversation (a failure line retires). */
export type LocalTurnDeliveredReporter = (messageId: string) => void
let reportDelivered: LocalTurnDeliveredReporter | null = null

/**
 * The message whose turn is running, for the shell that has to say which turn
 * a dead sidecar took with it.
 */
export function currentLocalTurnMessageId(): string | null {
  return runningMessageId
}

/**
 * How long to wait before each further attempt at posting an answer. A post
 * that failed on a network blip, a restarting server or a token that was
 * turning over is tried again; four more attempts span about forty seconds.
 * Settable for tests.
 */
export const replyRetry: { delaysMs: readonly number[] } = {
  delaysMs: [1_000, 3_000, 9_000, 27_000],
}

/** A finished turn, and whether it failed for want of a Claude sign-in. */
interface RecordedTurn {
  transcript: LocalTurnTranscript
  /** The CLI's own sentence when the turn could not authenticate, else null. */
  authFailure: string | null
}

/**
 * Resolves with the turn's record when the SDK says the turn is done, or with
 * null when the sidecar DIED instead: there is no answer to post, and the
 * shell names the failure on the conversation (`bridge.ts`).
 *
 * Subscribed BEFORE the turn is sent, and it records the turn from the very
 * lines the activity rows are drawn from.
 */
function recordTurn(modelId: string | null): Promise<RecordedTurn | null> {
  const recorder = createLocalTurnRecorder(modelId)
  let authFailure: string | null = null
  return new Promise<RecordedTurn | null>((resolve) => {
    const stop = onTurnEvent((event) => {
      recorder.apply(event)
      authFailure ??= claudeAuthFailureOf(event)
      // ONLY `turn_done` ENDS A TURN (P6d-FX2, SK-3; 2026-09-23). `error` was
      // read as one and posted half a turn; `done` was too, and a `done` can be
      // written by a sidecar that is not this session's at all (a previous
      // child answering its shutdown line). Our own sidecar writing `done`
      // mid turn is the SDK stream ending, and the shell's exit report follows.
      if (event.type === "turn_done") {
        stop()
        resolve({ transcript: recorder.snapshot(), authFailure })
      }
      // A SIDECAR THAT DIED sends no `turn_done` (2026-09-23): this waited for
      // ever, and the queue behind it with it.
      if (event.type === SIDECAR_EXITED_TYPE) {
        stop()
        resolve(null)
      }
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * POSTS THE ANSWER, OR SAYS WHY IT COULD NOT (2026-09-23, production).
 *
 * This used to be one bare post whose rejection the turn queue swallowed: a
 * turn whose claim had gone ran to the end, the server refused the answer
 * (409, no live claim), and nothing on screen or in the conversation said so.
 * Now a transient failure is tried again; a lapsed claim is taken back once
 * (same holder key, so a machine that still holds it refuses) and the post
 * tried again; and a failure that outlasts both is kept on this machine and
 * reported, never dropped.
 */
async function deliverReply(
  handle: LocalSessionHandle,
  threadId: string,
  messageId: string,
  text: string,
  turn: LocalTurnRecord | null,
  replyRootId: string | null = null,
): Promise<boolean> {
  let reclaimed = false
  let attempt = 0
  let lastError: unknown = null
  // The record is bounded (`LOCAL_TURN_MAX_BYTES`), but a server that still
  // finds the body too large gets the answer without the calls: the activity is
  // worth less than the answer.
  let record = turn
  let trimmed = false
  while (true) {
    try {
      await postAgentReply(handle, threadId, text, record, replyRootId)
      forgetUndeliveredReply(messageId)
      reportDelivered?.(messageId)
      return true
    } catch (error) {
      lastError = error
      const status = error instanceof ReplyNotPostedError ? error.status : 0
      // THE CLAIM LAPSED OR WAS RELEASED UNDER THE TURN: take it back, once.
      if (status === 409 && !reclaimed) {
        reclaimed = true
        if (await handle.reclaim().catch(() => false)) continue
      }
      if (status === 413 && record && !trimmed) {
        trimmed = true
        record = { ...record, toolCalls: [], timeline: [], reasoning: undefined }
        continue
      }
      const transient = !(error instanceof ReplyNotPostedError) || error.transient
      if (!transient || attempt >= replyRetry.delaysMs.length) break
      await sleep(replyRetry.delaysMs[attempt] ?? 0)
      attempt += 1
    }
  }
  keepUndeliveredReply({
    threadId,
    agentId: handle.agentId,
    messageId,
    text,
    turn,
    ...(replyRootId ? { replyRootId } : {}),
    keptAt: Date.now(),
  })
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  reportFailure?.(messageId, reason, "undelivered")
  return false
}

/** Runs one prompt and posts the answer back, on the session that is live. */
async function runLocalTurn(
  handle: LocalSessionHandle,
  threadId: string,
  messageId: string,
  prompt: string,
  replyRootId: string | null = null,
  turnCredential: string | null = null,
) {
  if (!prompt) return
  runningMessageId = messageId
  try {
    // Subscribed BEFORE the turn is sent. `sendTurn` awaits the audit round
    // trip after handing the prompt over, so a fast turn can be done before it
    // resolves, and a waiter attached afterwards would wait for the next turn's
    // end instead of this one's.
    const done = recordTurn(handle.model ?? null)
    try {
      await sendTurn(handle, prompt, turnCredential)
    } catch (error) {
      // THE PROMPT NEVER REACHED A SIDECAR (2026-09-23). This used to be
      // swallowed by the queue's catch: the message sat in the conversation
      // with no reply and nothing on screen said why.
      reportFailure?.(messageId, error instanceof Error ? error.message : String(error), "stopped")
      return
    }
    const recorded = await done
    if (!recorded) return
    // CLAUDE ON THIS COMPUTER IS NOT SIGNED IN (2026-09-24). The CLI's "Not
    // logged in, run /login" is not the agent's answer and never reaches the
    // conversation: the turn failed, and the window offers a sign-in and the
    // same Retry any failed turn has (`bridge.ts`).
    if (recorded.authFailure) {
      reportFailure?.(messageId, recorded.authFailure, "stopped")
      return
    }
    const transcript = recorded.transcript
    // A turn that produced no text at all still did something (its tool
    // calls), and a cloud turn in that state stores an explicit line rather
    // than a blank bubble; the server writes it (`local-session-routes.ts`).
    if (!transcript.text && transcript.record.toolCalls.length === 0) return
    const sdkSessionId = handle.sdkSessionId?.() ?? null
    const record = sdkSessionId ? { ...transcript.record, sdkSessionId } : transcript.record
    await deliverReply(handle, threadId, messageId, transcript.text, record, replyRootId)
  } finally {
    runningMessageId = null
  }
}

/** Posts every answer this conversation kept from an earlier failure, oldest first. */
async function deliverKeptReplies(handle: LocalSessionHandle, threadId: string): Promise<void> {
  for (const kept of undeliveredRepliesIn(threadId, handle.agentId)) {
    const posted = await deliverReply(
      handle,
      threadId,
      kept.messageId,
      kept.text,
      kept.turn,
      kept.replyRootId ?? null,
    )
    if (!posted) return
  }
}

/**
 * ONE TURN, NAMED BY THE MESSAGE THE CONVERSATION HOLDS (P6d-FX1, SK-2).
 *
 * It took the composer's raw TEXT until this fix, which put a window level
 * `sendTurn(text)` on the page: anything that can run a script in apps/web
 * could then run an arbitrary prompt on the user's own Claude Code login. That
 * is the same door FX11 closed on the document event, and it is closed the
 * same way. The caller names a message ID, the shell re-reads that message
 * from the server in the conversation this session claimed, and what runs is
 * what the conversation holds: a forged id names somebody else's message, or
 * nothing at all, and either way this is where it stops.
 *
 * Answers false when no local session is attached, when the server will not
 * give us the message, when it belongs to another conversation, when its
 * author is not a human, and when what is left after the mention token is
 * empty, so a caller never has to ask first.
 */
export async function submitLocalTurn(messageId: string): Promise<boolean> {
  const session = liveSession
  if (!session) return false
  if (typeof messageId !== "string" || messageId.length === 0) return false
  let ran = false
  liveQueue = liveQueue
    .then(async () => {
      const message = await fetchThreadMessage(session.handle, session.threadId, messageId)
      if (!message) return
      if (message.threadId !== session.threadId) return
      // A HUMAN's message. The agent's own reply is the output of a local turn
      // and feeding it back in is a loop with no exit.
      if (message.authorKind !== "user") return
      // AN ANSWER THIS MACHINE ALREADY HAS is posted, not asked for again: the
      // turn ran, did its work in the folder, and only the post failed. This
      // is what the Retry on an undelivered answer does.
      const kept = undeliveredReplyFor(messageId)
      if (kept && kept.threadId === session.threadId && kept.agentId === session.handle.agentId) {
        await deliverReply(
          session.handle,
          session.threadId,
          messageId,
          kept.text,
          kept.turn,
          kept.replyRootId ?? message.replyRootId,
        )
        ran = true
        return
      }
      const prompt = promptFromMessage(message.text)
      if (!prompt) return
      await runLocalTurn(
        session.handle,
        session.threadId,
        messageId,
        prompt,
        message.replyRootId,
        message.turnCredential,
      )
      ran = true
    })
    // Nothing that reaches here is an answer: `runLocalTurn` reports its own
    // failures and keeps what it could not post. What is left is the re-read
    // of the message failing, which leaves nothing to answer.
    .catch(() => undefined)
  await liveQueue
  return ran
}

/**
 * Makes this thread's session the one a turn runs on, for as long as it lives,
 * and follows the SDK stream so a turn's answer can be posted back. Returns
 * the detach.
 *
 * It listens to NOTHING on the page. apps/web names the message a turn
 * answers through the bridge, and the shell re-reads it from the server: a
 * document event anything in the page could dispatch was the door FX11 closed
 * and P6d-T16a removed.
 */
export function attachLocalTurns(
  handle: LocalSessionHandle,
  threadId: string,
  onFailure: LocalTurnFailureReporter | null = null,
  onDelivered: LocalTurnDeliveredReporter | null = null,
): () => void {
  if (!threadId) return () => undefined

  liveSession = { handle, threadId }
  reportFailure = onFailure
  reportDelivered = onDelivered
  // An answer an earlier session of this conversation could not post goes
  // first, before any new turn: the conversation reads in order.
  liveQueue = Promise.resolve()
    .then(() => deliverKeptReplies(handle, threadId))
    .catch(() => undefined)

  return () => {
    if (liveSession?.handle === handle) {
      liveSession = null
      reportFailure = null
      reportDelivered = null
    }
  }
}
