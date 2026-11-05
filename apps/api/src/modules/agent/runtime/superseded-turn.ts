// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A DEMO VISITOR'S TURN THAT A NEWER MESSAGE REPLACED.
//
// A turn started from a posted message runs in the background: nothing ends it
// when the person moves on. On the demo a visitor who re-asked, or whose guided
// tour moved to its next step, left the earlier turn running to its step or
// time limit, and one such turn billed 200,000 input tokens on the visitor's
// budget after the tour that asked for it had stopped. A visitor's turn is
// therefore superseded by a newer request from the same person to the same
// agent in the same conversation: it stops between steps, before the next
// model call. Other orgs keep their turns: a person there may queue requests on
// purpose, and their spend is their own.
//
// A superseded turn is CLOSED, whatever it already wrote. Its saved reply keeps
// its text and tool calls (the work is real) and ends with SUPERSEDED_TURN_TEXT;
// its metadata carries finishReason "superseded", and the history replay
// (context.ts) puts that closing line AFTER the turn's tool results, where the
// turn stopped. Without it the next turn read the stopped turn's tool results
// as unfinished work (live demo: it wrote the stopped turn's summary and never
// answered the newer question). The turn that follows also gets a short note
// (supersededEarlierWorkNote): answer the latest message, not the stopped work.
// The newer message usually arrives while the earlier turn is inside a model
// step, and that turn stops only at the step's end: the newer turn therefore
// waits for it (waitForEarlierLiveTurn) before it reads the history, so it
// sees the stopped turn closed and carries the note.
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { listLiveAgentTurns, onLiveAgentTurnChange } from "~/modules/agent/runtime/stream-registry"

const K = () => sql.raw(schemaRef("kernel"))

/** The finish reason (and abort reason) of a superseded turn. */
export const SUPERSEDED_FINISH_REASON = "superseded"

/**
 * The line that closes a superseded turn: its whole reply when it wrote
 * nothing, its last line otherwise (supersededTurnContent).
 */
export const SUPERSEDED_TURN_TEXT =
  "I stopped working on this message because a newer message in this conversation replaced it."

/**
 * Whether the same person has since asked the same agent something newer in
 * this conversation (and in the same reply thread): a later message of theirs
 * in a direct conversation with the agent, or one that mentions the agent. A
 * re-invocation message (bundle-reinvoke) is the platform's, not a request.
 */
export async function turnSupersededByNewerMessage(params: {
  orgId: string
  threadId: string
  messageId: string
  senderId: string
  agentId: string | null
}): Promise<boolean> {
  const { orgId, threadId, messageId, senderId, agentId } = params
  try {
    const rows = await withPrivilegedDb(orgId, "agent-turn-superseded", async (tx) => {
      const result = await tx.execute(sql`
        SELECT 1 FROM ${K()}.messages newer
        JOIN ${K()}.messages asked ON asked.id = ${messageId}::uuid AND asked.org_id = ${orgId}::uuid
        JOIN ${K()}.threads t ON t.id = newer.thread_id AND t.org_id = newer.org_id
        WHERE newer.org_id = ${orgId}::uuid
          AND newer.thread_id = ${threadId}::uuid
          AND newer.id <> asked.id
          AND newer.author_type = 'user'
          AND newer.author_id = ${senderId}::uuid
          AND newer.deleted_at IS NULL
          AND newer.created_at > asked.created_at
          AND newer.reply_root_id IS NOT DISTINCT FROM asked.reply_root_id
          AND coalesce(newer.metadata->>'type', '') <> 'bundle-reinvoke'
          AND (
            t.type = 'agent_chat'
            OR (${agentId}::uuid IS NOT NULL AND coalesce(newer.mentions, '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('type', 'agent', 'id', ${agentId}::text)))
          )
        LIMIT 1
      `)
      return Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    })
    return rows.length > 0
  } catch {
    // A failed check keeps the turn: stopping it is a saving, not a guard.
    return false
  }
}

/** A superseded turn's saved reply: what it wrote, then the closing line. */
export function supersededTurnContent(text: string | null | undefined): string {
  const written = text?.trimEnd() ?? ""
  return written ? `${written}\n\n${SUPERSEDED_TURN_TEXT}` : SUPERSEDED_TURN_TEXT
}

/**
 * A superseded reply's text as the history replays it before its tool calls:
 * the closing line is taken off, to be replayed after the tool results.
 */
export function withoutSupersededClosure(content: string): string {
  return content.endsWith(SUPERSEDED_TURN_TEXT)
    ? content.slice(0, -SUPERSEDED_TURN_TEXT.length).trimEnd()
    : content
}

/**
 * The history with each superseded reply moved back to its own turn: right
 * before the newer message of the same person that replaced it. The reply is
 * saved when the turn stops, after that newer message, so in row order the
 * stopped turn's tool results came after the question the next turn must
 * answer, and read as the latest thing to respond to.
 */
export function placeSupersededRepliesAtTheirTurn<
  T extends {
    id?: string | null
    authorType: string
    authorId?: string | null
    metadata: unknown
  },
>(rows: readonly T[]): T[] {
  const out = [...rows]
  for (let i = 0; i < out.length; i++) {
    const row = out[i]
    const meta = row.metadata as { finishReason?: unknown; turnId?: unknown } | null
    if (row.authorType !== "agent" || meta?.finishReason !== SUPERSEDED_FINISH_REASON) continue
    const asked = out.findIndex((r) => r.id === meta.turnId)
    if (asked < 0 || asked > i) continue
    const askerId = out[asked].authorId
    let newer = -1
    for (let j = asked + 1; j < i; j++) {
      if (out[j].authorType === "user" && out[j].authorId === askerId) {
        newer = j
        break
      }
    }
    if (newer < 0) continue
    out.splice(i, 1)
    out.splice(newer, 0, row)
  }
  return out
}

/**
 * The person's request that this agent's last turn for them, in this
 * conversation (and reply thread), stopped on because a newer message replaced
 * it; null when that turn was not superseded.
 */
export async function earlierSupersededRequest(params: {
  orgId: string
  threadId: string
  messageId: string
  senderId: string
  agentId: string | null
}): Promise<string | null> {
  const { orgId, threadId, messageId, senderId, agentId } = params
  try {
    const rows = await withPrivilegedDb(orgId, "agent-turn-earlier-superseded", async (tx) => {
      const result = await tx.execute(sql`
        SELECT prev.content, reply.metadata->>'finishReason' AS finish_reason
        FROM ${K()}.messages reply
        JOIN ${K()}.messages prev ON prev.id::text = reply.metadata->>'turnId' AND prev.org_id = reply.org_id
        JOIN ${K()}.messages asked ON asked.id = ${messageId}::uuid AND asked.org_id = ${orgId}::uuid
        WHERE reply.org_id = ${orgId}::uuid
          AND reply.thread_id = ${threadId}::uuid
          AND reply.author_type = 'agent'
          AND reply.deleted_at IS NULL
          AND (${agentId}::uuid IS NULL OR reply.author_agent_id = ${agentId}::uuid)
          AND prev.thread_id = reply.thread_id
          AND prev.id <> asked.id
          AND prev.author_type = 'user'
          AND prev.author_id = ${senderId}::uuid
          AND prev.created_at < asked.created_at
          AND prev.reply_root_id IS NOT DISTINCT FROM asked.reply_root_id
        ORDER BY prev.created_at DESC, reply.created_at DESC
        LIMIT 1
      `)
      return (
        Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      ) as Array<{ content: string; finish_reason: string | null }>
    })
    const last = rows[0]
    return last && last.finish_reason === SUPERSEDED_FINISH_REASON ? last.content : null
  } catch {
    // A failed read leaves the note out: the closed turn in the history still says it stopped.
    return null
  }
}

/** The start of the stopped request, on one line, as the note quotes it. */
function requestExcerpt(request: string): string {
  const line = request.replace(/\s+/g, " ").replace(/'/g, "’").trim()
  return line.length > 60 ? `${line.slice(0, 60).trimEnd()}…` : line
}

/** The runtime note of a turn whose person's earlier request was stopped by this one. */
export function supersededEarlierWorkNote(request: string): string {
  return (
    '<runtime-context note="injected by the Liaison platform, not written by the user">\n' +
    `Your earlier work on '${requestExcerpt(request)}' was stopped when this message arrived; what it did is in the history. ` +
    "Answer this latest message now; mention the stopped work only if this message asks about it.\n" +
    "</runtime-context>"
  )
}

/** How long a newer turn waits for the person's earlier live turn to stop. */
export const EARLIER_TURN_WAIT_MS = 20_000

/**
 * Wait until no earlier live turn of the same person and agent runs in this
 * conversation (stream-registry.ts), at most `timeoutMs`. Resolves "none" when
 * there was nothing to wait for, "ended" when it stopped, "timeout" past the bound.
 *
 * The registry is cell-wide, so the earlier turn may run in another process:
 * its end reaches the change listener from there, and the poll reads the
 * thread's live turns without their content (P2-13). A first read Redis does
 * not answer waits for nothing ("none": the turn goes ahead, as with no earlier
 * turn); a later one counts as still running, so the bound still ends the wait.
 */
export async function waitForEarlierLiveTurn(params: {
  threadId: string
  messageId: string
  senderId: string
  agentId: string | null
  timeoutMs?: number
}): Promise<"none" | "ended" | "timeout"> {
  const { threadId, messageId, senderId, agentId } = params
  const running = async (): Promise<boolean> =>
    (await listLiveAgentTurns(threadId)).some(
      (turn) =>
        turn.requesterId === senderId &&
        turn.agentId === agentId &&
        turn.turnId !== null &&
        turn.turnId !== messageId,
    )
  if (!(await running().catch(() => false))) return "none"
  const deadline = Date.now() + (params.timeoutMs ?? EARLIER_TURN_WAIT_MS)
  return new Promise((resolve) => {
    let poll: ReturnType<typeof setInterval> | undefined
    let stop: () => void = () => {}
    let settled = false
    let reading = false
    const settle = (outcome: "ended" | "timeout") => {
      if (settled) return
      settled = true
      clearInterval(poll)
      stop()
      resolve(outcome)
    }
    const check = () => {
      if (settled) return
      if (Date.now() >= deadline) {
        settle("timeout")
        return
      }
      if (reading) return
      reading = true
      void running()
        .catch(() => true)
        .then((still) => {
          reading = false
          if (!still) settle("ended")
          else if (Date.now() >= deadline) settle("timeout")
        })
    }
    // A turn's end wakes the wait at once; the poll covers the bound and an
    // entry the stale sweep removes without telling anyone.
    stop = onLiveAgentTurnChange((change) => {
      if (change.threadId === threadId && !change.running) check()
    })
    poll = setInterval(check, 250)
  })
}
