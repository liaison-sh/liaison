// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ONE WAY AN AGENT TURN BECOMES A ROW, wherever the turn ran.
//
// A cloud turn (`agent-service.ts` finalize) and a turn that ran on a user's
// own machine (`local-session-routes.ts` reply) write the same thing: the agent
// message through `sendMessage` (which queues the outbox event every
// downstream consumer reads: search indexing, attention and notifications, the
// audit and timeline rows), then the turn's metadata on that row (the tool
// calls the thread view draws and the history replays, the timeline, the
// usage the compaction trigger reads), then the low-latency websocket copy.
// Two copies of that sequence drifted once already (the local path wrote the
// text and nothing else), so there is one.
//
// What differs is only who is allowed to write: a cloud turn writes as the
// runtime, a local reply writes under the RLS of the person whose machine ran
// it. The caller passes the transaction runner for that.

import { and, eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { messages } from "~/db/schema/kernel"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import { sendMessage } from "~/modules/threads/message"
import { messageVisibilityFacts } from "~/services/security/visibility"

const log = rootLogger.child({ module: "persist-agent-turn" })

type SentMessage = NonNullable<Awaited<ReturnType<typeof sendMessage>>>

export interface PersistAgentTurnParams {
  /** Runs the `sendMessage` write under the caller's authority. */
  write: <T>(fn: (tx: RlsClient) => Promise<T>) => Promise<T>
  orgId: string
  /** The human whose turn this answers (the row's `authorId`). */
  userId: string
  threadId: string
  /** Undefined lets the write path resolve the thread's agent (cloud only). */
  agentId: string | undefined
  /** The label a reply is attributed under, when the caller names one. */
  agentAuthorLabel?: string
  content: string
  requiredScopes: string[]
  parentMessageId?: string | null
  /**
   * The reply thread the answer lands in (A7). Undefined inherits the
   * parent's (sendMessage), null is the channel.
   */
  replyRootId?: string | null
  /** A post nobody in the conversation asked for (a routine's run): see `SendMessageParams.unprompted`. */
  unprompted?: boolean
  /**
   * The row ends the turn or run for the person it works for: its final
   * answer, a routine's summary, a local or node turn's reply
   * (`SendMessageParams.endsTurn`). Required, so every caller says it: a card
   * posted in the middle of a turn ("Started on <computer>") and an answer to
   * another agent are `false`.
   */
  endsTurn: boolean
  /** Stored on the row, exactly as given (plus the label, when there is one). */
  metadata: Record<string, unknown>
  /** What the websocket copy carries. Defaults to the stored metadata. */
  broadcastMetadata?: Record<string, unknown>
  /** Stored content may be scrubbed; the live copy can carry another text. */
  broadcastContent?: string
}

/** Null when the write path refused the row (the caller may not post there). */
export async function persistAgentTurn(
  params: PersistAgentTurnParams,
): Promise<SentMessage | null> {
  // The label `sendMessage` stored rides on the metadata, and the update below
  // replaces the column: it is carried over rather than lost.
  const metadata = params.agentAuthorLabel
    ? { ...params.metadata, agentAuthorLabel: params.agentAuthorLabel }
    : params.metadata
  // One write, under the caller's own authority: the row and its metadata
  // commit together, and the metadata update needs no bypass because the
  // writer IS the row's author (messages_update admits the author).
  const sent = await params.write(async (tx) => {
    const row = await sendMessage(tx, {
      orgId: params.orgId,
      userId: params.userId,
      threadId: params.threadId,
      content: params.content,
      authorType: "agent",
      agentId: params.agentId,
      ...(params.agentAuthorLabel ? { agentAuthorLabel: params.agentAuthorLabel } : {}),
      requiredScopes: params.requiredScopes,
      parentMessageId: params.parentMessageId ?? null,
      ...(params.replyRootId !== undefined ? { replyRootId: params.replyRootId } : {}),
      ...(params.unprompted ? { unprompted: true } : {}),
      endsTurn: params.endsTurn,
    })
    if (!row) return null
    await tx
      .update(messages)
      .set({ metadata })
      .where(and(eq(messages.id, row.id), eq(messages.orgId, params.orgId)))
    return row
  })
  if (!sent) return null

  // Broadcast message:create for low-latency WS delivery
  broadcastEphemeral({
    app: "kernel",
    entity: "message",
    action: "create",
    entityId: sent.id,
    orgId: params.orgId,
    actorId: params.userId,
    actorType: "agent",
    data: {
      id: sent.id,
      threadId: params.threadId,
      authorId: params.userId,
      // Straight off what sendMessage just persisted and published, never a
      // second guess at it: this copy races the outbox event for the SAME row
      // and whichever wins is what the row is labelled with until a refetch.
      authorName: sent.authorName,
      authorAgentId: sent.authorAgentId ?? null,
      parentMessageId: sent.parentMessageId ?? null,
      replyRootId: sent.replyRootId ?? null,
      alsoInChannel: sent.alsoInChannel,
      authorType: "agent",
      content: params.broadcastContent ?? params.content,
      metadata: params.broadcastMetadata ?? metadata,
      // The low-latency copy is tagged with the same turn scopes the row was
      // given, so the fan-out delivers it to exactly the readers RLS will.
      ...messageVisibilityFacts({ requiredScopes: params.requiredScopes, disclosureList: null }),
      createdAt: sent.createdAt,
      // The same flag the outbox event carries: this copy may win the race.
      ...(params.unprompted ? { unprompted: true } : {}),
    },
  }).catch((err) => log.error({ err }, "Failed to broadcast agent message:create"))

  return sent
}
