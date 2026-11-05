// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What is set up in this workspace, as a snapshot: the state the setup card
 * carried when it was posted, or the one a `kernel__setup_state` call returned.
 * It never fetches and never updates itself: "as of" says when it was read, and
 * the agent reads it again after each step, which draws a fresh card. A step
 * not done is an empty circle, nothing louder.
 */
import { Check, Circle } from "lucide-solid"
import { type Component, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { ToolCallState } from "~/modules/threads/message-store"

export interface SetupItemView {
  key: string
  done: boolean
  optional: boolean
  detail?: string
}

export interface SetupStateView {
  items: SetupItemView[]
  next?: string | null
  asOf?: string
}

const ITEM_KEYS = new Set([
  "aiKey",
  "apps",
  "mail",
  "team",
  "knowledge",
  "import",
  "roles",
  "connector",
])

/** The checklist out of any value (a row's metadata, a tool result), or null. */
export function readSetupState(value: unknown): SetupStateView | null {
  if (!value || typeof value !== "object") return null
  const raw = (value as { items?: unknown }).items
  if (!Array.isArray(raw)) return null
  const items: SetupItemView[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const { key, done, optional, detail } = entry as Record<string, unknown>
    if (typeof key !== "string" || !ITEM_KEYS.has(key)) continue
    items.push({
      key,
      done: done === true,
      optional: optional === true,
      ...(typeof detail === "string" ? { detail } : {}),
    })
  }
  if (items.length === 0) return null
  const { next, asOf } = value as { next?: unknown; asOf?: unknown }
  return {
    items,
    next: typeof next === "string" ? next : null,
    ...(typeof asOf === "string" ? { asOf } : {}),
  }
}

/** The checklist a finished `kernel__setup_state` call returned, or null. */
export function setupStateResult(toolCall: ToolCallState): SetupStateView | null {
  const name = toolCall.toolName
  if (name !== "kernel__setup_state" && name !== "kernel:setup_state") return null
  if (toolCall.status === "error") return null
  return readSetupState(toolCall.result)
}

export const SetupChecklistCard: Component<{ state: SetupStateView }> = (props) => {
  const i18n = useI18n()
  const asOf = () => {
    const at = props.state.asOf ? new Date(props.state.asOf) : null
    return at && !Number.isNaN(at.getTime())
      ? i18n.fmtDate(at, { dateStyle: "medium", timeStyle: "short" })
      : null
  }
  return (
    <div
      data-testid="setup-checklist"
      class="my-2 max-w-md rounded-lg border border-border bg-elevated px-3 py-2 text-[13px]"
    >
      <div class="flex items-baseline justify-between gap-2">
        <span class="font-medium text-text-primary">{i18n.t("first-run.checklist.title")}</span>
        <Show when={asOf()}>
          {(at) => (
            <span class="text-[11.5px] text-text-tertiary">
              {i18n.t("first-run.checklist.asOf", { time: at() })}
            </span>
          )}
        </Show>
      </div>
      <ul class="mt-1.5 flex flex-col gap-1">
        <For each={props.state.items}>
          {(item) => (
            <li
              data-testid={`setup-item-${item.key}`}
              data-done={item.done ? "true" : "false"}
              class="flex items-center gap-2"
            >
              <Show
                when={item.done}
                fallback={
                  <Circle
                    size={14}
                    class="shrink-0 text-text-tertiary"
                    role="img"
                    aria-label={i18n.t("first-run.checklist.notDone")}
                  />
                }
              >
                <Check
                  size={14}
                  class="shrink-0 text-text-secondary"
                  role="img"
                  aria-label={i18n.t("first-run.checklist.done")}
                />
              </Show>
              <span class={item.done ? "text-text-secondary" : "text-text-primary"}>
                {i18n.t(`first-run.checklist.item.${item.key}`)}
              </span>
              <Show when={item.optional}>
                <span class="text-[11.5px] text-text-tertiary">
                  {i18n.t("first-run.checklist.optional")}
                </span>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}

export default SetupChecklistCard
