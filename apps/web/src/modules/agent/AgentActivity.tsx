// SPDX-License-Identifier: FSL-1.1-ALv2

import { Index, type JSX, Match, Show, Switch } from "solid-js"
import type { ToolCallState, TurnTimelineEntry } from "~/modules/threads/message-store"
import ThinkingBlock from "./ThinkingBlock"
import { groupToolCalls, SingleToolCallRow, StackedToolCallGroup } from "./ToolCallRow"

interface AgentActivityProps {
  /** Every tool call in the turn — the timeline references these by id. */
  toolCalls: ToolCallState[]
  /** Full accumulated reasoning text (used only for the no-timeline fallback). */
  reasoning?: string
  /** True while reasoning is still streaming — drives the last segment's live state. */
  reasoningStreaming?: boolean
  /** Reasoning token count for the "thought" affordance (persisted turns). */
  reasoningTokens?: number
  /** Ordered reasoning/tool interleave. Absent → flat reasoning-then-tools fallback. */
  timeline?: TurnTimelineEntry[]
  /**
   * Draws the turn's answer text where it was written, between the tools. Only
   * a caller that then leaves the message's own content out passes it; without
   * it text entries are skipped and the answer is drawn below, as before.
   */
  renderText?: (text: string) => JSX.Element
  /** Drawn after the turn's last text run (the live block's streaming caret). */
  textTail?: JSX.Element
  /** The turn shown (the message that started it). */
  turnId?: string | null
  /** The person's message the turn answers; its tool rows carry `data-turn-id` = `askId ?? turnId`. */
  askId?: string | null
}

/** One rendered slice of a turn: a reasoning segment, an answer segment or a run of tool calls. */
type ActivityBlock =
  | { kind: "reasoning"; text: string; streaming: boolean; tokenCount?: number }
  | { kind: "text"; text: string; last?: boolean }
  | { kind: "tools"; calls: ToolCallState[] }

/**
 * Walk the timeline into render blocks, joining tool ids back to their full call
 * state and coalescing consecutive tool calls into one run (so the ×N stacking
 * still applies). The trailing reasoning segment carries the live streaming flag
 * and the token count — earlier segments are already complete.
 */
function buildBlocks(props: AgentActivityProps): ActivityBlock[] {
  const timeline = props.timeline ?? []
  const byId = new Map(props.toolCalls.map((tc) => [tc.toolCallId, tc]))
  const blocks: ActivityBlock[] = []
  let lastReasoningIdx = -1

  for (const entry of timeline) {
    if (entry.kind === "reasoning") {
      blocks.push({ kind: "reasoning", text: entry.text, streaming: false })
      lastReasoningIdx = blocks.length - 1
    } else if (entry.kind === "text") {
      if (props.renderText) blocks.push({ kind: "text", text: entry.text })
    } else {
      const call = byId.get(entry.toolCallId)
      if (!call) continue
      const last = blocks[blocks.length - 1]
      if (last?.kind === "tools") last.calls.push(call)
      else blocks.push({ kind: "tools", calls: [call] })
    }
  }

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block?.kind !== "text") continue
    block.last = true
    break
  }
  if (lastReasoningIdx >= 0) {
    const block = blocks[lastReasoningIdx] as Extract<ActivityBlock, { kind: "reasoning" }>
    block.streaming = !!props.reasoningStreaming
    block.tokenCount = props.reasoningTokens
  }
  return blocks
}

/** Render one run of tool calls, stacking consecutive same-name calls into ×N. */
function ToolRun(props: { calls: ToolCallState[]; turnId?: string | null; askId?: string | null }) {
  const groups = () => groupToolCalls(props.calls)
  return (
    // `<Index>`, not `<For>`: `groupToolCalls` builds FRESH group objects on
    // every recompute, and `<For>` keys by reference, so any update to the turn
    // remounted every row and a stacked group the person had opened snapped shut.
    <Index each={groups()}>
      {(group) => (
        <Show
          when={group().calls.length > 1}
          fallback={
            <SingleToolCallRow
              toolCall={group().calls[0]}
              turnId={props.turnId}
              askId={props.askId}
            />
          }
        >
          <StackedToolCallGroup
            toolCalls={group().calls}
            turnId={props.turnId}
            askId={props.askId}
          />
        </Show>
      )}
    </Index>
  )
}

/**
 * Renders an agent turn's thinking + tool activity in the exact order the model
 * produced it, so a tool call invoked mid-thinking appears between the reasoning
 * segments that surround it instead of after the whole thinking block. Falls back
 * to the flat "reasoning then tools" layout for turns persisted before the
 * timeline shipped (no `timeline`, or reasoning-off turns with no interleave).
 */
export default function AgentActivity(props: AgentActivityProps) {
  const hasTimeline = () => (props.timeline?.length ?? 0) > 0

  return (
    <Show
      when={hasTimeline()}
      fallback={
        <>
          <ThinkingBlock
            reasoning={props.reasoning}
            streaming={props.reasoningStreaming}
            tokenCount={props.reasoningTokens}
          />
          <ToolRun calls={props.toolCalls} turnId={props.turnId} askId={props.askId} />
        </>
      }
    >
      {/* `<Index>`, not `<For>`: `buildBlocks` returns FRESH block objects on
          every recompute (any store write to the turn's timeline, tool calls or
          token count), and `<For>` keys by reference, so it disposed and
          remounted every row, and a ThinkingBlock the person had just opened
          snapped shut. Keyed by position, a block's row stays mounted and only
          its props update. */}
      <Index each={buildBlocks(props)}>
        {(block) => (
          <Switch
            fallback={
              <ToolRun
                calls={(block() as { calls: ToolCallState[] }).calls}
                turnId={props.turnId}
                askId={props.askId}
              />
            }
          >
            <Match when={block().kind === "reasoning"}>
              <ThinkingBlock
                reasoning={(block() as { text: string }).text}
                streaming={(block() as { streaming: boolean }).streaming}
                tokenCount={(block() as { tokenCount?: number }).tokenCount}
              />
            </Match>
            <Match when={block().kind === "text"}>
              <div
                data-testid="agent-activity-text"
                class="text-[13.5px] leading-relaxed text-text"
              >
                {props.renderText?.((block() as { text: string }).text)}
                <Show when={(block() as { last?: boolean }).last}>{props.textTail}</Show>
              </div>
            </Match>
          </Switch>
        )}
      </Index>
    </Show>
  )
}
