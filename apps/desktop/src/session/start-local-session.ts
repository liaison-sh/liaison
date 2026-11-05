// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Starting a session that runs on this machine.
//
// Three things happen, in this order, and the order is the point:
//
//  1. the agent's definition is fetched (`agent-definition-client.ts`), so an
//     account that may not read it is refused HERE rather than getting a
//     session with no skills and no memory that looks like a working agent;
//  2. the start is AUDITED on the server (`local-session-routes.ts`), with a
//     digest of the folder and never its path, so a session that ran at all
//     leaves a row even though its prompts and files never leave the machine;
//  3. only then is the sidecar told to start (`sidecar-client.ts`).
//
// The definition the window fetched IS what the session runs with: it is
// composed here into one text and handed to `start_session`, which writes it
// into the session's MCP config for the sidecar to append to Claude Code's own
// system prompt (`sdk-runner.ts` composeSystemPrompt). There is no second
// source for it any more (the shell used to read one from the environment),
// because two sources for one prompt is how they drift, and the checksum every
// turn is audited with is the checksum of this exact text. The mode is passed in
// LIAISON terms (manual | edit | plan | bypass); the SDK's own values are the
// sidecar's business (`sdk-runner.ts` mapPermissionMode) and are pinned from
// the test here as well, because the pass through and the mapping are one
// contract in two files.

import type { LocalTurnRecord } from "@liaison/shared/threads/local-turn"
import {
  composeAgentDefinitionText,
  definitionChecksum,
  fetchAgentDefinition,
  fetchAgentKind,
} from "./agent-definition-client"
import { hashFolder } from "./folder-hash"
import type { AccessTokenSource, ClaimHolder, LocalClaimHandle } from "./local-claim"
import {
  CLAIM_REQUEST_TIMEOUT_MS,
  claimThreadForLocalTurns,
  currentAccessToken,
  LocalClaimError,
} from "./local-claim"
import { getSessionEntry, setSessionId } from "./SessionResumeStore"
import type { PermissionMode, SidecarEvent } from "./sidecar-client"
import {
  onTurnEvent,
  reportConversationLost,
  startSession,
  startTurn,
  stopSession,
} from "./sidecar-client"
import { SIDECAR_EXITED_TYPE } from "./sidecar-exit"

/**
 * How long a turn waits for the `ready` line before it is audited with no
 * checksum. The line is emitted on the first SDK message of the session
 * (`sidecar/index.ts:457-461`), so it arrives AFTER the first turn was sent,
 * never before: a turn that blocked on it would deadlock the first message of
 * every session. A session whose model is slow to answer is audited without a
 * checksum rather than not audited at all.
 */
export const READY_CHECKSUM_TIMEOUT_MS = 30_000

/**
 * WHICH OF THE THREE SERVER STEPS REFUSED (P6d-FX5, W8).
 *
 * A start touches the server three times before the sidecar exists, and every
 * one of them used to reject with a plain `Error` whose only distinguishing
 * mark was English in its message. The window swallowed all three identically
 * and said nothing, which is the defect: "the conversation is already running
 * on another machine" and "your session expired" are different things for a
 * person to do, and neither is "try again".
 */
export type LocalSessionStartReason =
  /** The account may not read this agent, so a session would have no skills. */
  | "AgentDefinitionRefused"
  /** The start could not be audited, and an unaudited session never runs. */
  | "AuditRefused"
  /** Another machine holds this conversation (409). No retry undoes it. */
  | "ConversationClaimed"
  /** The claim was refused for any other reason. */
  | "ClaimRefused"
  /**
   * The 409 came from THIS window's own lease (P6d-FX7, SK-5). A release the
   * server never applied leaves the claim live for the rest of its TTL, and
   * telling the user to go and stop the session on another machine names a
   * machine that does not exist. This one says to try again in a moment.
   */
  | "ClaimHeldHere"

/**
 * WHY A START RESUMED NOTHING when this (agent, folder) had a session to
 * resume, as the start's audit row records it:
 *  - `cold_resume`: the server's time rule (P4c-T23);
 *  - `definition_changed`: the agent's definition is not the one the stored
 *    session was created with (2026-09-23). A resumed session keeps its
 *    transcript, and an answer given under the old definition outvoted the
 *    fixed one about one run in three;
 *  - `definition_unknown`: the stored session predates the checksum, so which
 *    definition it ran with is unknown. Treated like a change, once: the
 *    sessions stored before this build are exactly the ones that may carry an
 *    answer given under a definition since fixed, and the cost is one fresh
 *    session per (agent, folder), fed the conversation's context.
 */
export type LocalSessionFreshReason = "cold_resume" | "definition_changed" | "definition_unknown"

/** One refused start, naming the step that refused it. */
export class LocalSessionStartError extends Error {
  readonly reason: LocalSessionStartReason
  /** Who holds the conversation, on a `ConversationClaimed` the server named. */
  readonly holder: ClaimHolder | null
  constructor(reason: LocalSessionStartReason, cause?: unknown) {
    super(`the local session could not be started (${reason})`, { cause })
    this.name = "LocalSessionStartError"
    this.reason = reason
    this.holder = cause instanceof LocalClaimError ? cause.holder : null
  }
}

export interface StartLocalSessionOptions {
  agentId: string
  /**
   * The conversation this session's turns come from and answer into (A32).
   * Claimed for this machine before the sidecar is started, and released when
   * the session ends: while the claim is live the SERVER does not run this
   * agent's turn in that thread.
   */
  threadId?: string | null
  /** The path the user picked. It never leaves this module. */
  folder: string
  mode: PermissionMode
  model: string
  serverAddress: string
  /**
   * Read at every request this session makes, not once at start: a session
   * outlives an access token (fifteen minutes), and one that kept the starting
   * token lost its claim, its turns and its replies on the sixteenth minute.
   */
  accessToken: AccessTokenSource
  resumeSessionId?: string | null
  /**
   * THE COLD RESUME DECISION (P4c-T23), as the server's rule computes it: more
   * than the warm window since this agent's last turn. A cold turn starts a
   * NEW SDK session, because the context it should run with is the one the
   * server just reassembled (a short cold tail plus the brief), not the raw
   * transcript the old session is still holding. A warm turn resumes the
   * session id this (agent, folder) pair was in the middle of.
   */
  coldResume?: boolean
  /**
   * WHAT THAT FRESH SESSION IS FED (P4c-T26b). The server's own cold assembly
   * for this turn, appended to the agent's definition as the session's system
   * prompt (`renderColdContext`). Absent on a warm turn, and absent on a cold
   * turn the server could not assemble: `coldResume` is then false and the
   * session resumes, because starting empty is worse than starting stale.
   */
  coldContext?: ColdTurnContext | null
  /**
   * WHO WROTE THE CONVERSATION'S LAST AGENT TURN, as the server answered
   * (`fetchTurnContext`), or undefined when it did not say (an older server).
   * A stored SDK session is resumed only when it is the session that wrote
   * that turn: a cloud turn, another computer or another conversation in the
   * same folder since then means the transcript it holds is missing turns the
   * thread has, and the session starts fresh on the server's history instead.
   */
  lastAgentTurn?: LastAgentTurn | null
  /**
   * THIS WINDOW's holder key (P6d-FX7, SK-5). Passed in rather than minted per
   * claim, because the holder is the user AND the window: a key per claim made
   * a window's second start a conflict with its own lease.
   */
  holderKey?: string
  /**
   * Take the conversation from the machine that holds it. Only after the
   * person asked to, on a refusal that said who holds it; never the default.
   */
  takeOver?: boolean
}

export interface LocalSessionHandle {
  readonly agentId: string
  /** The id the AUDIT trail gave this session, named by the server. */
  readonly auditSessionId: string
  readonly folderHash: string
  /** The Liaison mode, unchanged: the SDK's own value is the sidecar's. */
  readonly mode: PermissionMode
  readonly model: string
  readonly serverAddress: string
  /** Asked for the current token by every request (`currentAccessToken`). */
  readonly accessToken: AccessTokenSource
  /** The conversation this session answers in, or null. */
  readonly threadId: string | null
  /**
   * The claim this window holds on that conversation, or null. Presented with
   * every reply: the server posts as the agent only for the machine whose
   * claim stopped it answering.
   */
  readonly claimHolderKey: string | null
  /** Stops listening and audits the end, exactly once. */
  readonly finish: () => Promise<void>
  /**
   * RELEASES THE CONVERSATION, KEEPS THE SESSION (P6d-FX7, SK-2). Starting a
   * session for another conversation has to stop the server answering the new
   * one before it claims it, and must not tear down the session that is
   * running to do so: the new start may be refused, and the user never asked
   * to leave the conversation that was working.
   */
  readonly releaseClaim: () => Promise<void>
  /** Registers the released claim again, for a handover that was refused.
   *  Best effort: the answer says whether the conversation is ours again. */
  readonly reclaim: () => Promise<boolean>
  /**
   * The checksum the sidecar reported on `ready`, of the definition the
   * session is actually running with. The session's definition is fixed for
   * its whole life, so this one value is what every turn is audited with: a
   * harness that dropped or truncated the prompt shows up as a checksum that
   * is not the definition's, rather than as an agent behaving oddly.
   */
  systemPromptChecksum(): Promise<string | null>
  /**
   * Why this start resumed nothing although a session was stored, or null (a
   * resume, or a first start). The window says so on a definition change.
   */
  readonly freshReason: LocalSessionFreshReason | null
  /**
   * The Claude Code session this one runs, as the sidecar last announced it
   * (the resumed id until it does). Recorded on every reply, so the next start
   * can tell whether its stored session wrote the conversation's last turn.
   */
  sdkSessionId?(): string | null
}

function sessionsUrl(serverAddress: string, agentId: string): string {
  const base = serverAddress.replace(/\/+$/, "")
  return `${base}/api/agents/${encodeURIComponent(agentId)}/local-sessions`
}

/**
 * How long any ONE server round trip on the start path may take (P6d-FX7,
 * SK-4). None of them had a signal, and a start awaits all of them: a server
 * that accepts the connection and never answers held the window in `starting`
 * with no way out.
 */
export const START_REQUEST_TIMEOUT_MS = 10_000

/** POST the start row. A refusal rejects: an unaudited session never runs. */
async function auditStart(
  options: StartLocalSessionOptions,
  folderHash: string,
  resumeSessionId: string | null,
  freshReason: LocalSessionFreshReason | null,
): Promise<string> {
  const response = await fetch(sessionsUrl(options.serverAddress, options.agentId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${currentAccessToken(options.accessToken)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      permissionMode: options.mode,
      folderHash,
      model: options.model,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(freshReason ? { freshReason } : {}),
    }),
    signal: AbortSignal.timeout(START_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`the local session could not be audited (${response.status})`)
  }
  const body = (await response.json()) as { data?: { sessionId?: unknown } }
  const sessionId = body?.data?.sessionId
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("the audit start answered without a session id")
  }
  return sessionId
}

/**
 * One audit event on a session. `turn` and `end` are the only kinds.
 *
 * It takes the four fields it needs rather than a `LocalSessionHandle`,
 * because the END of a start that DIED has to be written and there is no
 * handle at that point (P6d-FX5, W8): the start row was posted, the claim was
 * then refused, and a trail with a start and no end reads as a session that is
 * still running on a machine where nothing ever ran.
 */
interface AuditTarget {
  readonly serverAddress: string
  readonly agentId: string
  readonly accessToken: AccessTokenSource
  readonly auditSessionId: string
}

async function auditEvent(target: AuditTarget, body: Record<string, unknown>): Promise<void> {
  const url = `${sessionsUrl(target.serverAddress, target.agentId)}/${encodeURIComponent(target.auditSessionId)}/events`
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${currentAccessToken(target.accessToken)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(START_REQUEST_TIMEOUT_MS),
  })
}

/**
 * The end row, written best effort (P6d-FX7, SK-6).
 *
 * Closing the trail is worth doing and it is NEVER worth the reason: both
 * refusal paths below wrote the end row before throwing their specific error,
 * with no catch, so the same network condition that had just refused the claim
 * replaced `ConversationClaimed` with its own rejection and the caller
 * answered "StartFailed. Try again." exactly when the specific sentence was
 * worth the most.
 */
async function auditEndQuietly(target: AuditTarget): Promise<void> {
  try {
    await auditEvent(target, { kind: "end" })
  } catch {
    // The row closing is best effort. The reason is not.
  }
}

/**
 * The shell would not take the prompt: no sidecar is running, or its pipe is
 * closed. Distinct from a turn audit the server refused, because here nothing
 * runs at all and the window has to say so (2026-09-23).
 */
export class TurnNotDeliveredError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause),
    )
    this.name = "TurnNotDeliveredError"
  }
}

/**
 * One turn, and the audit row that says it happened. The user's message is
 * NOT sent to the server: only the checksum of the system prompt the session
 * runs with, which is the same value every turn because the definition is
 * fixed for the session's lifetime.
 */
export async function sendTurn(
  handle: LocalSessionHandle,
  userMessage: string,
  turnCredential: string | null = null,
): Promise<void> {
  try {
    // S59: the credential of the message this turn answers rides the turn line,
    // so this turn's gateway calls, and only this turn's, present it.
    if (turnCredential) await startTurn(userMessage, turnCredential)
    else await startTurn(userMessage)
  } catch (error) {
    throw new TurnNotDeliveredError(error)
  }
  const promptChecksum = await handle.systemPromptChecksum()
  // BEST EFFORT, AND AFTER THE PROMPT (2026-09-23). The prompt is already
  // running, so a turn row the server did not take (a timeout, a blip) must
  // not become a rejection: the caller used to read it as the turn failing and
  // never posted the answer the turn went on to give. The thread rides along
  // so the server runs its between-turns upkeep (checkpoint, episode close)
  // for this conversation exactly as it does before a cloud turn.
  try {
    await auditEvent(handle, {
      kind: "turn",
      ...(promptChecksum ? { promptChecksum } : {}),
      permissionMode: handle.mode,
      ...(handle.threadId ? { threadId: handle.threadId } : {}),
    })
  } catch {
    // The trail misses one turn row; the answer is not lost for it.
  }
}

/** One message of the claimed conversation, as the SERVER has it. */
export interface FetchedThreadMessage {
  id: string
  threadId: string
  /** `user`, `agent` or `system`, from the row rather than from the page. */
  authorKind: string
  text: string
  /** The reply thread the message was asked in (A7), null in the channel. */
  replyRootId: string | null
  /**
   * S59 (D36): the server's credential for the local turn that answers this
   * message, minted only for the holder of the live claim and an unanswered
   * message of the caller. Null otherwise.
   */
  turnCredential: string | null
}

/**
 * READS THE MESSAGE RATHER THAN BELIEVING THE PAGE (A32).
 *
 * The announcement that a message arrived comes off the document, and anything
 * that can inject markup into apps/web can dispatch one: text taken from there
 * and run as a prompt is an in-page injection promoted to a turn on the user's
 * own Claude Code login. So the announcement carries an id and nothing this
 * shell acts on, and the text that runs is the text the server returns for that
 * id, in the conversation this session claimed.
 *
 * Answers null for anything the server will not give us: a message of another
 * conversation, a deleted one, an id that never existed.
 */
export async function fetchThreadMessage(
  handle: LocalSessionHandle,
  threadId: string,
  messageId: string,
): Promise<FetchedThreadMessage | null> {
  const base = handle.serverAddress.replace(/\/+$/, "")
  const url =
    `${base}/api/agents/${encodeURIComponent(handle.agentId)}/local-claims/` +
    `${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}` +
    // S59: the claim's holder key is what lets the server mint this turn's
    // credential; without one the answer is the message alone.
    (handle.claimHolderKey ? `?holderKey=${encodeURIComponent(handle.claimHolderKey)}` : "")
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${currentAccessToken(handle.accessToken)}` },
  })
  if (!response.ok) return null
  const body = (await response.json()) as { data?: Partial<FetchedThreadMessage> }
  const data = body?.data
  if (!data || typeof data.id !== "string" || typeof data.text !== "string") return null
  if (typeof data.threadId !== "string" || typeof data.authorKind !== "string") return null
  return {
    id: data.id,
    threadId: data.threadId,
    authorKind: data.authorKind,
    text: data.text,
    replyRootId: typeof data.replyRootId === "string" ? data.replyRootId : null,
    turnCredential: typeof data.turnCredential === "string" ? data.turnCredential : null,
  }
}

/** One row of the cold tail, as the server assembled it. */
export interface ColdTailRow {
  id: string
  /** `user`, `agent` or `system`, from the stored row. */
  authorType: string
  /** Who spoke, or null when the row's author is gone. */
  authorName: string | null
  /** ISO 8601, so a rendered transcript can carry the clock. */
  createdAt: string
  content: string
  /** The tools that row called, by NAME. Never their results. */
  toolNames: string[]
}

/**
 * THE CONTEXT A COLD LOCAL TURN RUNS WITH (P4c-T26b), exactly what the cloud
 * path assembles for the same turn.
 */
export interface ColdTurnContext {
  /** The checkpoint this turn renders: the brief core plus its episode titles. */
  checkpoint: { summary: string }
  /** The raw messages after the cold boundary, oldest first. */
  tail: ColdTailRow[]
  /** The cold hybrid recall block, already framed by the server, or null. */
  recall: string | null
  /** "Resumed after 3 hours. ..." , or null when the gap is unknown. */
  resumeLine: string | null
}

/**
 * IS THIS TURN A COLD RESUME, AND WITH WHAT (P4c-E1, P4c-T26b)?
 *
 * The rule is time since this agent's last turn in this conversation, measured
 * over rows only the server can see, and it already decides what context the
 * server assembles. This window cannot recompute it (it holds no transcript)
 * and must not guess it: a guess that says "warm" resumes an SDK conversation
 * the server has stopped feeding, and a guess that says "cold" throws away a
 * session somebody is in the middle of.
 *
 * ONE ROUND TRIP, because the decision and the context it implies are one
 * answer: asking twice is two reads that can disagree about the same turn, and
 * the second of them would run after the first one's advance.
 *
 * NULL ON ANYTHING THAT IS NOT A CLEAR COLD YES. Warm is the behaviour this
 * shell has always had, so a server that is older (it answers the T26 boolean
 * and nothing else), unreachable or refusing leaves the session RESUMING
 * exactly as before: a stale context is worse than the right one and far
 * better than none.
 *
 * `fresh` ASKS FOR THE CONTEXT ON A WARM TURN TOO (2026-09-23): the session is
 * starting new whatever the clock says (the agent's definition changed), so
 * the server answers `fresh: true` with the context a warm cloud turn runs
 * with. An older server ignores the flag and answers the bare boolean, which
 * reads as null: the session then starts on its definition alone.
 */
export async function fetchColdContext(params: {
  serverAddress: string
  accessToken: string
  agentId: string
  threadId: string
  fresh?: boolean
}): Promise<ColdTurnContext | null> {
  return (await fetchTurnContext(params)).context
}

/** Where the conversation's last agent turn ran, as the server stored it. */
export interface LastAgentTurn {
  runLocation: "local" | "cloud"
  /** The Claude Code session that wrote it, for a local turn that recorded one. */
  sdkSessionId: string | null
}

/**
 * The cold decision and its context (`fetchColdContext`), plus, on a warm turn
 * and only when asked (`continuity`), who wrote the conversation's last agent
 * turn. `lastAgentTurn` is undefined when the server did not say (an older
 * server, a failed read), which leaves the resume decision as it always was.
 */
export async function fetchTurnContext(params: {
  serverAddress: string
  accessToken: string
  agentId: string
  threadId: string
  fresh?: boolean
  continuity?: boolean
}): Promise<{ context: ColdTurnContext | null; lastAgentTurn?: LastAgentTurn | null }> {
  const base = params.serverAddress.replace(/\/+$/, "")
  const query = [params.fresh ? "fresh=1" : null, params.continuity ? "continuity=1" : null]
    .filter(Boolean)
    .join("&")
  const url =
    `${base}/api/agents/${encodeURIComponent(params.agentId)}/local-claims/` +
    `${encodeURIComponent(params.threadId)}/turn-context${query ? `?${query}` : ""}`
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${params.accessToken}` },
      signal: AbortSignal.timeout(CLAIM_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      console.warn(`the cold context could not be read (${response.status}); resuming instead`)
      return { context: null }
    }
    const data = ((await response.json()) as { data?: Record<string, unknown> })?.data
    if (!data) return { context: null }
    const lastAgentTurn = lastAgentTurnFrom(data)
    return { context: coldContextFrom(data, params.fresh === true), lastAgentTurn }
  } catch (error) {
    console.warn("the cold context could not be read; resuming instead", error)
    return { context: null }
  }
}

function lastAgentTurnFrom(data: Record<string, unknown>): LastAgentTurn | null | undefined {
  if (!("lastAgentTurn" in data)) return undefined
  const raw = data.lastAgentTurn as { runLocation?: unknown; sdkSessionId?: unknown } | null
  if (raw === null) return null
  if (raw?.runLocation !== "local" && raw?.runLocation !== "cloud") return undefined
  return {
    runLocation: raw.runLocation,
    sdkSessionId: typeof raw.sdkSessionId === "string" ? raw.sdkSessionId : null,
  }
}

function coldContextFrom(data: Record<string, unknown>, fresh: boolean): ColdTurnContext | null {
  if (data.coldResume !== true && !(fresh && data.fresh === true)) return null
  // A SERVER THAT SAYS COLD AND CARRIES NOTHING is the T26 server. Resuming
  // its session is the only answer that does not start the agent from
  // nothing, which is what this whole task exists to stop.
  const tail = Array.isArray(data.tail) ? (data.tail as ColdTailRow[]) : null
  const checkpoint = data.checkpoint as { summary?: unknown } | undefined
  if (tail === null || typeof checkpoint?.summary !== "string") {
    console.warn("the server reported a cold turn without its context; resuming instead")
    return null
  }
  return {
    checkpoint: { summary: checkpoint.summary },
    tail: tail.map((row) => ({
      id: String(row?.id ?? ""),
      authorType: String(row?.authorType ?? ""),
      authorName: typeof row?.authorName === "string" ? row.authorName : null,
      createdAt: String(row?.createdAt ?? ""),
      content: String(row?.content ?? ""),
      toolNames: Array.isArray(row?.toolNames) ? row.toolNames.map(String) : [],
    })),
    recall: typeof data.recall === "string" ? data.recall : null,
    resumeLine: typeof data.resumeLine === "string" ? data.resumeLine : null,
  }
}

/**
 * THE COLD CONTEXT AS ONE TEXT, for the session's system prompt append.
 *
 * WHY THE APPEND AND NOT A MESSAGE LIST. The Claude Agent SDK gives a NEW
 * session exactly one channel for prior turns, `resume`, and a cold resume is
 * the decision not to use it. Its `prompt` iterable carries `SDKUserMessage`
 * only, so there is no way to hand it an assistant turn: an initial message
 * list is not a channel that exists. What is left is the system prompt, which
 * this shell already composes and hands over whole (`sdk-runner.ts`
 * composeSystemPrompt appends it to the Claude Code preset), and the first user
 * message. The append wins: the transcript is not the person speaking now, and
 * putting it inside their turn is what makes a model answer the transcript.
 *
 * The two halves stay SEPARATE by delimiter. The agent's definition ends, and
 * everything this function adds is inside one `<cold-resume>` element that says
 * what it is: a summary of what came before, the memory recalled for this turn,
 * and the verbatim recent transcript with its authors and clock. None of it is
 * an instruction and the frame says so.
 *
 * It is covered by the audited `systemPromptChecksum` like the rest of the
 * prompt, so what a cold turn actually ran with is provable after the fact.
 */
/**
 * Why a session is fed the conversation's record: the audited reasons, plus a
 * session that is new to this conversation (`new_session`) and a stored one
 * that is no longer the conversation's (`history_moved`: the last agent turn
 * was written elsewhere).
 */
export type ContextCause = LocalSessionFreshReason | "new_session" | "history_moved"

export function renderColdContext(
  context: ColdTurnContext,
  cause: ContextCause = "cold_resume",
): string {
  const parts: string[] = []
  if (context.checkpoint.summary.trim().length > 0) {
    parts.push(
      `<conversation-summary note="what this conversation established before the transcript below">\n` +
        `${context.checkpoint.summary.trim()}\n</conversation-summary>`,
    )
  }
  if (context.recall && context.recall.trim().length > 0) parts.push(context.recall.trim())
  if (context.tail.length > 0) {
    const lines = context.tail.map((row) => {
      const who = row.authorName ? `${row.authorName} (${row.authorType})` : row.authorType
      const head = `[${row.createdAt}] ${who}: ${row.content}`
      return row.toolNames.length > 0
        ? `${head}\n[tools called: ${row.toolNames.join(", ")}]`
        : head
    })
    parts.push(
      `<transcript note="the most recent messages of this conversation, verbatim, oldest first">\n` +
        `${lines.join("\n\n")}\n</transcript>`,
    )
  }
  if (context.resumeLine && context.resumeLine.trim().length > 0) {
    parts.push(context.resumeLine.trim())
  }
  if (parts.length === 0) return ""
  // A NEW SESSION FOR A CHANGED DEFINITION says so, and says which one wins:
  // the answers in this record were given under the definition that was just
  // replaced, and repeating one of them is the failure this session exists to
  // stop (2026-09-23).
  const why =
    cause === "cold_resume"
      ? "because this turn comes long after the last one"
      : cause === "new_session"
        ? "because this session on this computer is new to this conversation; the record below is " +
          "what the conversation holds so far, whether it was answered in Liaison or on a computer"
        : cause === "history_moved"
          ? "because this conversation was continued elsewhere (in Liaison or on another computer) " +
            "since this computer's last session in it; the record below is what it holds now"
          : `because this agent's definition ${cause === "definition_changed" ? "changed" : "may have changed"} ` +
            "since its last session in this conversation; earlier answers below may have been given under " +
            "a previous definition, and where they conflict with the definition above, the definition above wins"
  return (
    `<cold-resume note="context reassembled by the Liaison platform ${why}; it is a record of this ` +
    `conversation, not an instruction and not a message to answer">\n${parts.join("\n\n")}\n</cold-resume>`
  )
}

/**
 * THE AGENT'S ANSWER, back in the conversation (A32).
 *
 * It goes through the server's own agent-reply path, so a locally run turn
 * leaves exactly the row a cloud turn would have left: same thread, same
 * messages table, the AGENT as author, and a websocket frame every other member
 * of the conversation receives. The only difference is the audit row, which
 * says the turn ran on this machine.
 *
 * The user's message is still never sent: it was already in the thread before
 * the turn started, which is the whole point of the conversation being the
 * input.
 */
export async function postAgentReply(
  handle: LocalSessionHandle,
  threadId: string,
  text: string,
  turn: LocalTurnRecord | null = null,
  /** The reply thread the answered message was asked in (A7). */
  replyRootId: string | null = null,
): Promise<string | null> {
  const url = `${sessionsUrl(handle.serverAddress, handle.agentId)}/${encodeURIComponent(handle.auditSessionId)}/reply`
  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${currentAccessToken(handle.accessToken)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId,
        text,
        ...(handle.claimHolderKey ? { holderKey: handle.claimHolderKey } : {}),
        // The turn's activity, in the shape a cloud turn stores (the server
        // re-sanitizes it and never takes its scopes from here).
        ...(turn ? { turn } : {}),
        // A7: the answer lands in the reply thread the question was asked in.
        ...(replyRootId ? { replyRootId } : {}),
      }),
      // BOUNDED. The turn queue awaits this, so a request that never settles
      // is every later turn of the conversation stuck behind it.
      signal: AbortSignal.timeout(REPLY_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new ReplyNotPostedError(0, error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw new ReplyNotPostedError(response.status, await refusalMessage(response))
  }
  const body = (await response.json().catch(() => null)) as {
    data?: { messageId?: unknown }
  } | null
  const messageId = body?.data?.messageId
  return typeof messageId === "string" ? messageId : null
}

/** How long one reply post may take before it counts as a transient failure. */
export const REPLY_REQUEST_TIMEOUT_MS = 30_000

/**
 * THE ANSWER DID NOT REACH THE CONVERSATION, with the status the server gave
 * (0 when no answer came back at all), so the caller can tell a failure a
 * retry fixes from one it does not.
 */
export class ReplyNotPostedError extends Error {
  readonly status: number
  constructor(status: number, detail: string) {
    super(
      status === 0
        ? `the server could not be reached (${detail})`
        : `the server refused it (${status}${detail ? `: ${detail}` : ""})`,
    )
    this.name = "ReplyNotPostedError"
    this.status = status
  }

  /** A server error, a rate limit, a lapsed token or no answer at all. */
  get transient(): boolean {
    return (
      this.status === 0 ||
      this.status === 401 ||
      this.status === 408 ||
      this.status === 429 ||
      this.status >= 500
    )
  }
}

async function refusalMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } }
    const message = body?.error?.message
    return typeof message === "string" ? message.slice(0, 200) : ""
  } catch {
    return ""
  }
}

/**
 * The session is over: the shell is told to stop it, and the trail is closed.
 *
 * The end row is written whichever way the session ended (the user stopping
 * it, the sidecar finishing, an error), and exactly once: a trail with two
 * ends for one session reads as two sessions.
 */
export async function endLocalSession(handle: LocalSessionHandle): Promise<void> {
  // THE CLAIM FIRST, AND WHATEVER THE SHELL DOES (2026-09-23). This awaited
  // `stopSession` first, so on an app quit (the shell already tearing the
  // sidecar down, the invoke rejecting or never answering) the release was
  // never sent, and the relaunched app found the conversation held by its own
  // previous life. The release is a keepalive request and bounded, so it goes
  // before the one step that can hang on a dying shell.
  try {
    await handle.releaseClaim()
  } finally {
    try {
      await stopSession()
    } finally {
      await handle.finish()
    }
  }
}

/**
 * WHICH refusal a claim rejection is. A 409 is two different things to say:
 * another machine is running the conversation, or this window's own lease is
 * still live because a release never reached the server (P6d-FX7, SK-5).
 */
export function claimRefusalFor(error: unknown): LocalSessionStartReason {
  if (!(error instanceof LocalClaimError) || error.status !== 409) return "ClaimRefused"
  return error.heldByThisWindow ? "ClaimHeldHere" : "ConversationClaimed"
}

export async function startLocalSession(
  options: StartLocalSessionOptions,
): Promise<LocalSessionHandle> {
  const folderHash = await hashFolder(options.folder)
  // Identical whichever group the model picker was on, and carrying no
  // runtime location: where the turn executes is not part of who the agent is.
  const connection = {
    serverAddress: options.serverAddress,
    // One-shot reads at start; the token of the moment is enough for them.
    accessToken: currentAccessToken(options.accessToken),
  }
  // EVERY SERVER STEP NAMES ITSELF (P6d-FX5, W8). Three round trips happen
  // before a sidecar exists and all three used to reject alike, so the window
  // could only say "it did not start" for a refusal the user can act on.
  let agentDefinition: string
  let agentKind: Awaited<ReturnType<typeof fetchAgentKind>>
  try {
    // The conversation, when there is one: the server composes the definition
    // under that room's floor, as a cloud turn there would read it.
    const definition = await fetchAgentDefinition(options.agentId, {
      ...connection,
      ...(options.threadId ? { threadId: options.threadId } : {}),
    })
    agentDefinition = composeAgentDefinitionText(definition)
    // A second round trip, because the definition route carries no kind (see
    // `fetchAgentKind`). It decides whether this session keeps the operator's
    // own connectors, so it is fetched before anything is started rather than
    // guessed.
    agentKind = await fetchAgentKind(options.agentId, connection)
  } catch (error) {
    throw new LocalSessionStartError("AgentDefinitionRefused", error)
  }
  // WHO THE AGENT IS, as one checksum (2026-09-23), taken before any cold
  // context is appended, and stored beside the session id the sidecar names.
  const currentDefinition = await definitionChecksum(agentDefinition)
  // A stored id for THIS agent in THIS folder resumes the conversation it was
  // in the middle of; an explicit one from the caller wins over it. A COLD
  // resume resumes nothing: the same decision the server's turn start made
  // (P4c-T23) starts a new SDK session, fed by the context that turn assembled.
  // NOR DOES A CHANGED DEFINITION: the stored session's transcript holds what
  // the agent said under the definition that was just replaced, and resuming
  // it let that transcript outvote the new one.
  const stored = getSessionEntry(options.agentId, folderHash)
  const candidate = options.resumeSessionId ?? stored?.sessionId ?? null
  let resumeSessionId: string | null = null
  let freshReason: LocalSessionFreshReason | null = null
  // Why the session is fed the server's record without an audited reason.
  let continuityCause: ContextCause | null = null
  if (options.coldResume) {
    freshReason = candidate ? "cold_resume" : null
  } else if (candidate && stored?.sessionId === candidate) {
    if (stored.definitionChecksum === null) freshReason = "definition_unknown"
    else if (stored.definitionChecksum !== currentDefinition) freshReason = "definition_changed"
    else if (
      options.lastAgentTurn !== undefined &&
      options.lastAgentTurn?.sdkSessionId !== candidate
    ) {
      // THE STORED SESSION IS NOT THIS CONVERSATION'S ANY MORE (2026-09-23):
      // its last agent turn was written in Liaison, on another computer, or by
      // a session of another conversation in this folder. Resuming it would
      // hide those turns from the agent; the server's record has them.
      continuityCause = "history_moved"
    } else resumeSessionId = candidate
  } else if (candidate) {
    // An explicit id this window never stored is the caller's own decision.
    resumeSessionId = candidate
  } else if (options.lastAgentTurn !== undefined) {
    // A FIRST SESSION ON THIS COMPUTER is fed what the conversation already
    // holds, as a cloud turn would be, rather than starting from nothing.
    continuityCause = "new_session"
  }
  // THE CONTEXT RIDES WITH THE DEFINITION (P4c-T26b). One text, one checksum,
  // one channel: the SDK gives a fresh session no other way to be told what
  // came before (see `renderColdContext`). Delimited, so the agent's
  // definition and the conversation's record never read as one thing. A
  // session new because the DEFINITION changed asks the server for the same
  // context on a warm turn (`fresh`); one it cannot get starts on the
  // definition alone, which is still better than the transcript it replaced.
  let context: ColdTurnContext | null = null
  let contextCause: ContextCause = "cold_resume"
  if (options.coldResume && options.coldContext) {
    context = options.coldContext
  } else if (
    (freshReason === "definition_changed" ||
      freshReason === "definition_unknown" ||
      continuityCause !== null) &&
    options.threadId
  ) {
    context = await fetchColdContext({
      serverAddress: options.serverAddress,
      accessToken: connection.accessToken,
      agentId: options.agentId,
      threadId: options.threadId,
      fresh: true,
    })
    contextCause = continuityCause ?? (freshReason as LocalSessionFreshReason)
  }
  if (context) {
    const rendered = renderColdContext(context, contextCause)
    if (rendered.length > 0) agentDefinition = `${agentDefinition}\n\n${rendered}`
  }
  let auditSessionId: string
  try {
    auditSessionId = await auditStart(options, folderHash, resumeSessionId, freshReason)
  } catch (error) {
    throw new LocalSessionStartError("AuditRefused", error)
  }
  /**
   * The start row exists from here on, so every failure below CLOSES it.
   * Without this a refused claim left a row saying a session started on this
   * machine and never ended, which is the one thing the trail is for.
   */
  const auditTarget: AuditTarget = {
    serverAddress: options.serverAddress,
    agentId: options.agentId,
    accessToken: options.accessToken,
    auditSessionId,
  }

  // THE CLAIM, before the sidecar exists (A32). A session that runs without one
  // means the server answers the same message from the cloud: two turns, two
  // replies, and only one of them able to see the folder. A refusal therefore
  // stops the session rather than starting a second answerer.
  let claim: LocalClaimHandle | null = null
  const claimHolderKey = options.holderKey ?? null
  if (options.threadId) {
    try {
      claim = await claimThreadForLocalTurns({
        serverAddress: options.serverAddress,
        accessToken: options.accessToken,
        agentId: options.agentId,
        threadId: options.threadId,
        // The window says so rather than going quiet: a machine that has
        // stopped holding the conversation has stopped being the thing that
        // answers it, and the reconnect banner is where that already gets said.
        onLost: reportConversationLost,
        ...(options.holderKey ? { holderKey: options.holderKey } : {}),
        ...(options.takeOver ? { takeOver: true } : {}),
      })
    } catch (error) {
      await auditEndQuietly(auditTarget)
      throw new LocalSessionStartError(claimRefusalFor(error), error)
    }
  }

  // Subscribed BEFORE the session starts: `ready` is emitted once and is not
  // replayed, so a listener attached afterwards can miss it entirely.
  let settleChecksum: ((value: string | null) => void) | null = null
  const checksum = new Promise<string | null>((resolve) => {
    settleChecksum = resolve
  })
  const timer = setTimeout(() => settleChecksum?.(null), READY_CHECKSUM_TIMEOUT_MS)

  let ended = false
  let unsubscribe: () => void = () => undefined
  let announcedSession: string | null = resumeSessionId

  const handle: LocalSessionHandle = {
    agentId: options.agentId,
    auditSessionId,
    threadId: options.threadId ?? null,
    claimHolderKey: claim?.holderKey ?? claimHolderKey,
    folderHash,
    mode: options.mode,
    model: options.model,
    serverAddress: options.serverAddress,
    accessToken: options.accessToken,
    systemPromptChecksum: () => checksum,
    sdkSessionId: () => announcedSession,
    freshReason,
    finish: async () => {
      if (ended) return
      ended = true
      unsubscribe()
      clearTimeout(timer)
      // A turn still waiting on `ready` must not hang on a session that ended.
      settleChecksum?.(null)
      // The claim goes FIRST: the server may answer this conversation again the
      // moment it lapses, and the audit round trip is the slower of the two.
      await claim?.release()
      await auditEndQuietly(handle)
    },
    releaseClaim: async () => {
      const held = claim
      claim = null
      await held?.release()
    },
    reclaim: async () => {
      if (claim) return true
      if (!options.threadId) return false
      try {
        claim = await claimThreadForLocalTurns({
          serverAddress: options.serverAddress,
          accessToken: options.accessToken,
          agentId: options.agentId,
          threadId: options.threadId,
          onLost: reportConversationLost,
          // The SAME key, so the server reads this as the renewal it is.
          ...(claimHolderKey ? { holderKey: claimHolderKey } : {}),
        })
        return true
      } catch {
        // The conversation could not be taken back. The TTL and the reconnect
        // banner are what is left, and neither is this function's to raise.
        return false
      }
    },
  }

  unsubscribe = onTurnEvent((event: SidecarEvent) => {
    if (event.type === "ready") {
      clearTimeout(timer)
      settleChecksum?.((event.systemPromptChecksum as string | null) ?? null)
    }
    // The sidecar names the resumable session (`sidecar/index.ts:467`), so the
    // id is recorded when it arrives rather than guessed at start time, with
    // the definition it was created with (a resume keeps the one it had,
    // which is the one it was checked against above).
    if (event.type === "session" && typeof event.sessionId === "string") {
      announcedSession = event.sessionId
      setSessionId(options.agentId, folderHash, event.sessionId, currentDefinition)
    }
    // ONLY THE SHELL'S EXIT REPORT ENDS THE SESSION (2026-09-23, production).
    // `done` and `error` used to, and neither line says WHICH process wrote
    // it: the shell forwards the stdout of every child it ever spawned, and a
    // session started for another conversation replaces the running child by
    // sending it the shutdown line, which that child answers with `done`. That
    // `done` reached the NEW session's listener, which "finished": it released
    // the claim it had just taken, the turn then ran for real, and its answer
    // was refused by the server (no live claim) and dropped. The exit report
    // is attributed: the shell sends it only for the child that is still the
    // running session (`sidecar.rs` `retire_exited`), and a child of ours that
    // writes `done` exits right after, so its report always follows. An
    // `error` line is not an ending at all: a fatal one is followed by `done`
    // and the exit.
    if (event.type === SIDECAR_EXITED_TYPE) {
      void handle.finish()
    }
  })

  try {
    await startSession({
      agentId: options.agentId,
      cwd: options.folder,
      permissionMode: options.mode,
      model: options.model,
      resumeSessionId,
      agentDefinition,
      agentKind,
      accessToken: currentAccessToken(options.accessToken),
    })
  } catch (error) {
    // The claim outlives a session that never started, and for its whole TTL
    // the conversation has nobody answering it: not the server, which sees a
    // claim, and not this machine, which has no sidecar.
    unsubscribe()
    clearTimeout(timer)
    await claim?.release()
    // And the trail closes with it, for the same reason the refused claim
    // above closes it: a start row with no end is a session still running.
    await auditEndQuietly(auditTarget)
    ended = true
    throw error
  }
  return handle
}
