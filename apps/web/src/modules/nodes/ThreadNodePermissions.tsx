// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A NODE CHAT'S OPEN PERMISSION PROMPTS, IN THE CHAT. A chat that runs on one
// of the person's computers relays each prompt as an attention row
// (permission-prompts.ts), whose notification opens this conversation. The
// decision is chat business: the Allow / Deny card is drawn here, above the
// composer, for every undecided prompt of this conversation that has not
// expired. Home only says the agent needs you, and opens this chat. A card
// answered here leaves a short muted line in its place until the turn ends.

import type { AttentionItem } from "@liaison/shared"
import { type Component, createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import NodePermissionCard, {
  type NodePermissionPrompt,
  nodePermissionPromptOf,
} from "~/modules/nodes/NodePermissionCard"
import { attentionStore } from "~/modules/shell/attention-store"
import { getLiveAgentStreams } from "~/modules/threads/message-store"
import { agentTypingInThread } from "~/modules/threads/thread-store"
import { createNow } from "~/primitives/createNow"

/** The conversation an attention row's link opens, if it names one. */
function linkedThreadId(item: AttentionItem): string | null {
  const link = item.metadata?.link as { tabType?: unknown; entityId?: unknown } | undefined
  if (link?.tabType === "thread" && typeof link.entityId === "string") return link.entityId
  const action = item.action
  return action.type === "open_entity" && action.tabType === "thread" ? action.entityId : null
}

/** This conversation's undecided prompts, oldest first, at `now`. */
export function threadNodePrompts(
  items: readonly AttentionItem[],
  threadId: string,
  now: number,
): { item: AttentionItem; prompt: NodePermissionPrompt }[] {
  const out: { item: AttentionItem; prompt: NodePermissionPrompt }[] = []
  for (const item of items) {
    const prompt = nodePermissionPromptOf(item)
    if (!prompt || linkedThreadId(item) !== threadId) continue
    const expires = prompt.expiresAt ? Date.parse(prompt.expiresAt) : Number.NaN
    if (Number.isFinite(expires) && expires <= now) continue
    out.push({ item, prompt })
  }
  return out.sort((a, b) => a.item.occurredAt.localeCompare(b.item.occurredAt))
}

/** A prompt the owner answered from this chat: what stays in its place. */
interface DecidedPrompt {
  promptId: string
  toolName: string
  summary: string
  allow: boolean
}

export const ThreadNodePermissions: Component<{ threadId: string }> = (props) => {
  const i18n = useI18n()
  const now = createNow(15_000)
  // Answered here, for the rest of the turn: the card gives way to a short
  // line saying what was allowed or denied, instead of vanishing.
  const [decided, setDecided] = createSignal<DecidedPrompt[]>([])
  const decidedIds = createMemo(() => new Set(decided().map((d) => d.promptId)))
  const prompts = createMemo(() =>
    threadNodePrompts(attentionStore.items, props.threadId, now()).filter(
      (entry) => !decidedIds().has(entry.prompt.promptId),
    ),
  )
  // The turn is over (no agent announced or streaming here): its lines go.
  const turnLive = createMemo(
    () => agentTypingInThread(props.threadId) || getLiveAgentStreams(props.threadId).length > 0,
  )
  createEffect(
    on(turnLive, (live, wasLive) => {
      if (wasLive && !live) setDecided([])
    }),
  )
  const record = (prompt: NodePermissionPrompt, allow: boolean) =>
    setDecided((list) => [
      ...list,
      { promptId: prompt.promptId, toolName: prompt.toolName, summary: prompt.summary, allow },
    ])
  return (
    <Show when={prompts().length > 0 || decided().length > 0}>
      <ul
        data-testid="thread-node-permissions"
        class="mx-3 mb-2 divide-y divide-border-subtle rounded-lg border border-border bg-surface"
      >
        <For each={decided()}>
          {(entry) => (
            <li
              data-testid="node-permission-decided"
              data-decision={entry.allow ? "allowed" : "denied"}
              class="truncate px-4 py-1.5 text-[12px] text-text-tertiary"
            >
              {i18n.t(
                entry.allow
                  ? "kernel.nodes.permissionCard.youAllowed"
                  : "kernel.nodes.permissionCard.youDenied",
                { tool: entry.summary ? `${entry.toolName} ${entry.summary}` : entry.toolName },
              )}
            </li>
          )}
        </For>
        <For each={prompts()}>
          {(entry) => (
            <NodePermissionCard
              item={entry.item}
              prompt={entry.prompt}
              onDecided={(allow) => record(entry.prompt, allow)}
            />
          )}
        </For>
      </ul>
    </Show>
  )
}
