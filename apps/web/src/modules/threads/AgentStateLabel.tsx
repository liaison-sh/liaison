// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, createEffect, createSignal, on, onCleanup, Show } from "solid-js"
import { formatToolName } from "~/modules/agent/format-tool-name"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import {
  getChannelAgentStream,
  reconcileAgentStreamsWithServer,
} from "~/modules/threads/message-store"
import { agentTypingInThread } from "~/modules/threads/thread-store"
import { refusalShownInThread } from "~/modules/threads/turn-refusal"

/** A running turn that has been IDLE for this long reads as Stuck rather than
 *  Working. Not a server timeout: the turn may still finish. Waiting on a tool
 *  is not idling: the runtime sends nothing between a tool call and its result,
 *  so a slow tool (a quote batch, a fetch, a sandboxed job, a subagent) would
 *  otherwise read as Stuck on a perfectly healthy turn. */
export const AGENT_STUCK_THRESHOLD_MS = 20_000

/** How often the label re-evaluates the stuck threshold. */
const TICK_MS = 1_000

export type AgentTurnState = "idle" | "queued" | "working" | "stuck" | "failed"

/** The four labels, one kernel dictionary key each. */
const LABEL_KEYS: Record<Exclude<AgentTurnState, "idle">, string> = {
  queued: "kernel.agentStateQueued",
  working: "kernel.agentStateWorking",
  stuck: "kernel.agentStateStuck",
  failed: "kernel.agentStateFailed",
}

/**
 * Map what the client observes of a turn onto its state. A turn is announced
 * over the typing channel before the model streams (Queued), then streams
 * (Working), and goes quiet (Stuck) or breaks (Failed). A finished turn has no
 * state of its own to show.
 */
export function agentTurnState(input: {
  streamState: "idle" | "streaming" | "complete" | "error"
  lastActivityAt: number
  announced: boolean
  now: number
  /** True while at least one tool call of this turn has not returned. */
  awaitingTool?: boolean
}): AgentTurnState {
  if (input.streamState === "error") return "failed"
  if (input.streamState === "complete") return "idle"
  if (input.streamState === "streaming") {
    if (input.awaitingTool) return "working"
    const quietFor = input.now - input.lastActivityAt
    return quietFor > AGENT_STUCK_THRESHOLD_MS ? "stuck" : "working"
  }
  return input.announced ? "queued" : "idle"
}

/** The tool the turn is waiting on, when the stream state already names one. */
export function pendingToolName(
  toolCalls: Array<{ toolName: string; status: string }>,
): string | null {
  const pending = toolCalls.find((call) => call.status === "pending" || call.status === "running")
  return pending?.toolName ?? null
}

interface AgentStateLabelProps {
  threadId: string
}

const AgentStateLabel: Component<AgentStateLabelProps> = (props) => {
  const i18n = useI18n()
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), TICK_MS)
  onCleanup(() => clearInterval(timer))

  const pendingTool = () => pendingToolName(getChannelAgentStream(props.threadId).toolCalls)

  const state = () => {
    const stream = getChannelAgentStream(props.threadId)
    return agentTurnState({
      streamState: stream.state,
      lastActivityAt: stream.lastActivityAt,
      announced: agentTypingInThread(props.threadId),
      now: now(),
      awaitingTool: pendingTool() !== null,
    })
  }

  // Stuck is a question, not an answer: the turn may have ended with its end
  // never reaching this client. Ask the server when the turn goes quiet; a
  // block it no longer runs ends, and the label with it.
  const client = useOptionalApi()
  createEffect(
    on(state, (s) => {
      if (s === "stuck" && client) void reconcileAgentStreamsWithServer(client, props.threadId)
    }),
  )

  const label = () => {
    const s = state()
    if (s === "idle") return null
    // A turn refused before it ran: the conversation already says why, once,
    // as its system line (turn-refusal.ts).
    if (
      s === "failed" &&
      refusalShownInThread(props.threadId, getChannelAgentStream(props.threadId).error?.message)
    ) {
      return null
    }
    const tool = s === "working" ? pendingTool() : null
    const text = i18n.t(LABEL_KEYS[s])
    return tool ? `${text}: ${formatToolName(tool)}` : text
  }

  /** Why the turn failed, when the stream said. A turn that broke BEFORE it
   *  emitted anything (no key for the provider, a model that is gone) is the
   *  only trace the room gets, so "Failed" on its own leaves the reader with
   *  nothing to act on. */
  const reason = () => {
    if (state() !== "failed") return null
    const message = getChannelAgentStream(props.threadId).error?.message?.trim()
    return message && message.length > 0 ? message : null
  }

  return (
    <Show when={label()}>
      {(text) => (
        <div
          class="flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-tertiary"
          data-testid="agent-state"
          data-state={state()}
        >
          <Show when={state() === "working" || state() === "queued"}>
            <span class="flex gap-0.5">
              <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:0ms]" />
              <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:150ms]" />
              <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:300ms]" />
            </span>
          </Show>
          <span>{text()}</span>
          <Show when={reason()}>
            {(why) => <span data-testid="agent-state-reason">{why()}</span>}
          </Show>
        </div>
      )}
    </Show>
  )
}

export default AgentStateLabel
