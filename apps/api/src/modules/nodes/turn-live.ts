// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A NODE CHAT TURN, LIVE IN ITS CHAT (S24). A turn of a chat that runs on the
 * owner's computer (an `interactive` node job) is shown in the conversation the
 * way a cloud turn is: the agent is announced while the job waits (Queued),
 * a live turn block opens when a node claims it, its steps arrive as the node
 * runs them, and the block ends with the job. The frames are the cloud turn's
 * own (`kernel:typing`, `kernel:agent_stream`), recorded in the stream
 * registry so a chat opened mid-turn seeds the same state
 * (GET /api/agent/stream-state/:threadId). Nothing is persisted here.
 *
 * Audience, as a cloud turn's:
 *  - the typing frame (who is taking a turn, no content) reaches the
 *    conversation's members;
 *  - the stream frames carry what the node did, so they carry NO
 *    `accumulatedScopes`: the server cannot know what a step on the owner's
 *    computer read, and an untagged chunk fails closed to everyone but the
 *    requester (`hasStreamChunkAccess`, the registry's replay gate). The
 *    requester is the job's owner, the only person whose turns run there.
 *
 * Even a node that never reports its steps (a desktop older than the
 * progress route) shows a running turn: the block opens on the claim with one
 * running step, "Run on my computer", naming the computer.
 */
import { redactSecrets } from "@liaison/shared"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import {
  listLiveAgentStreams,
  type RecordedFrame,
  recordAgentStreamEvent,
  touchAgentStream,
} from "~/modules/agent/runtime/stream-registry"
import { settleJobPrompts } from "./permission-prompts"

const log = rootLogger.child({ module: "node-turn-live" })

/** The job facts a live frame needs. */
export interface NodeTurnJob {
  id: string
  orgId: string
  ownerUserId: string
  agentId: string
  threadId: string | null
  kind: string
}

/** The step a running turn shows before (or without) the node's own steps. */
export const NODE_TURN_STEP_TOOL = "kernel__run_on_my_computer"

/** The id of that step: one per job. */
export const nodeTurnStepId = (jobId: string) => `node-turn:${jobId}`

/** One step a node reports (POST /jobs/:id/turn-progress). */
export type NodeTurnProgressEvent =
  | { type: "tool_call"; id: string; toolName: string; summary?: string }
  | { type: "tool_result"; id: string; isError?: boolean }

/** Only an interactive job in a conversation is a chat turn. */
function liveThread(job: NodeTurnJob): string | null {
  return job.kind === "interactive" && job.threadId ? job.threadId : null
}

function typing(job: NodeTurnJob, threadId: string, action: "start" | "stop"): void {
  broadcastEphemeral({
    app: "kernel",
    entity: "typing",
    action,
    entityId: threadId,
    orgId: job.orgId,
    actorId: job.ownerUserId,
    actorType: "agent",
    data: { threadId, authorType: "agent", userId: job.ownerUserId, agentId: job.agentId },
  }).catch((err) => log.warn({ err, jobId: job.id, action }, "node turn typing frame failed"))
}

/**
 * Record one frame, then broadcast it with the `seq` and item the record
 * allocated (S28). Frames of one turn are recorded in call order, so they leave
 * in `seq` order. A record Redis fails is broadcast all the same, without `seq`
 * (open: only the replay loses it). Never rejects.
 */
function stream(
  job: NodeTurnJob,
  threadId: string,
  action: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  // No scope tag, on purpose (see the header): owner-only content.
  return recordAgentStreamEvent(threadId, job.orgId, action, data, {
    requesterId: job.ownerUserId,
    agentId: job.agentId,
  })
    .catch((err: unknown): RecordedFrame | null => {
      log.warn({ err, jobId: job.id, action }, "node turn stream frame not recorded")
      return null
    })
    .then((frame) =>
      broadcastEphemeral({
        app: "kernel",
        entity: "agent_stream",
        action,
        entityId: threadId,
        orgId: job.orgId,
        actorId: job.ownerUserId,
        actorType: "agent",
        data: { threadId, agentId: job.agentId, replyRootId: null, ...data, ...frame },
      }),
    )
    .catch((err) => log.warn({ err, jobId: job.id, action }, "node turn stream frame failed"))
}

/** The job waits for a computer: the agent reads Queued in the chat. */
export function nodeTurnQueued(job: NodeTurnJob): void {
  const threadId = liveThread(job)
  if (threadId) typing(job, threadId, "start")
}

/** A computer took the job: the live block opens with its running step. */
export async function nodeTurnRunning(job: NodeTurnJob, nodeName: string | null): Promise<void> {
  const threadId = liveThread(job)
  if (!threadId) return
  typing(job, threadId, "start")
  const started = stream(job, threadId, "start")
  await stream(job, threadId, "tool_call", {
    toolCallId: nodeTurnStepId(job.id),
    toolName: NODE_TURN_STEP_TOOL,
    args: {},
    summary: nodeName ? redactSecrets(nodeName) : "",
  })
  await started
}

/**
 * The node's own steps, as it runs them (redacted: they quote commands and
 * paths). Never rejects.
 */
export async function nodeTurnProgress(
  job: NodeTurnJob,
  events: readonly NodeTurnProgressEvent[],
): Promise<void> {
  const threadId = liveThread(job)
  if (!threadId) return
  // A step re-sent (a retried post) is shown once. A registry Redis does not
  // answer forwards every step (open): the registry keeps a re-sent call on its
  // first item, so the fold and the client still show it once.
  const known = new Set(
    await listLiveAgentStreams(threadId)
      .then((snaps) =>
        snaps
          .filter((snap) => snap.agentId === job.agentId)
          .flatMap((snap) => snap.toolCalls.map((t) => t.toolCallId)),
      )
      .catch((err: unknown): string[] => {
        log.warn({ err, jobId: job.id }, "node turn: could not read the live turn's steps")
        return []
      }),
  )
  const sent: Promise<void>[] = []
  for (const event of events) {
    const toolCallId = `node-step:${job.id}:${event.id}`
    if (event.type === "tool_call") {
      if (known.has(toolCallId)) continue
      known.add(toolCallId)
      sent.push(
        stream(job, threadId, "tool_call", {
          toolCallId,
          toolName: redactSecrets(event.toolName),
          args: {},
          summary: redactSecrets(event.summary ?? ""),
        }),
      )
    } else {
      sent.push(
        stream(job, threadId, "tool_result", {
          toolCallId,
          result: event.isError ? { error: "failed" } : { ok: true },
        }),
      )
    }
  }
  await Promise.all(sent)
}

/** The job's heartbeat: the turn still runs, even while it waits on its owner. */
export async function nodeTurnAlive(job: NodeTurnJob): Promise<void> {
  const threadId = liveThread(job)
  if (!threadId) return
  await touchAgentStream(threadId, job.agentId).catch((err: unknown) =>
    log.warn({ err, jobId: job.id }, "node turn: could not touch the live turn"),
  )
}

/** A run that never started went back to the queue: its block closes, the agent stays Queued. */
export async function nodeTurnRequeued(job: NodeTurnJob): Promise<void> {
  const threadId = liveThread(job)
  if (!threadId) return
  await stream(job, threadId, "clear")
  typing(job, threadId, "start")
}

/**
 * The job ended: the turn ends. `answered`: its reply is (being) posted, which
 * replaces the block as a cloud turn's reply does. Otherwise (failed, stopped,
 * discarded, lost) the block is cleared: the conversation says what happened.
 */
export async function nodeTurnEnded(
  job: NodeTurnJob,
  outcome: "answered" | "ended",
): Promise<void> {
  const threadId = liveThread(job)
  if (!threadId) return
  // Its open permission prompts can no longer be answered: they leave Home.
  void settleJobPrompts(job)
  const sent =
    outcome === "answered"
      ? [
          stream(job, threadId, "tool_result", {
            toolCallId: nodeTurnStepId(job.id),
            result: { ok: true },
          }),
          stream(job, threadId, "done"),
        ]
      : [stream(job, threadId, "clear")]
  await Promise.all(sent)
  typing(job, threadId, "stop")
}
