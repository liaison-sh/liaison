// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What is set up in this workspace, as a snapshot: the state the setup card
 * carried when it was posted, or the one a `kernel__setup_state` call returned.
 * It never fetches and never updates itself: "as of" says when it was read, and
 * the agent reads it again after each step, which draws a fresh card.
 *
 * It reads as a to-do list, never as a form: a heading naming the workspace
 * and how many steps are done, each open step a numbered action ("Invite your
 * team") with a Start arrow when the conversation can take it, each done step
 * muted and struck through behind a tick. No empty box or circle anybody would
 * try to tick, and no alarm colour.
 *
 * The company brief comes before the team: while the brief is still open, the
 * team step says why it waits (colleagues arrive in a workspace whose agent
 * already knows the company) and its button reads "Invite now anyway", so
 * inviting first is always one press away, never blocked.
 */
import { ArrowRight, Check } from "lucide-solid"
import { type Component, createMemo, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { orgName } from "~/modules/shell/branding-store"
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

export const SetupChecklistCard: Component<{
  state: SetupStateView
  /** Start one open step: posts it in the conversation. Absent, rows carry no button. */
  onStart?: (step: string) => void
  /** A start is on its way: the buttons wait. */
  starting?: boolean
}> = (props) => {
  const i18n = useI18n()
  const asOf = () => {
    const at = props.state.asOf ? new Date(props.state.asOf) : null
    return at && !Number.isNaN(at.getTime())
      ? i18n.fmtDate(at, { dateStyle: "medium", timeStyle: "short" })
      : null
  }
  const heading = () => {
    const name = orgName()?.trim()
    return name
      ? i18n.t("first-run.checklist.heading", { workspace: name })
      : i18n.t("first-run.checklist.headingNoName")
  }
  const doneCount = () => props.state.items.filter((i) => i.done).length
  // Open steps are numbered 1, 2, 3 in their order; done ones carry a tick instead.
  const stepNumber = createMemo(() => {
    const numbers = new Map<string, number>()
    let n = 0
    for (const item of props.state.items) if (!item.done) numbers.set(item.key, ++n)
    return numbers
  })
  const label = (key: string) => i18n.t(`first-run.checklist.action.${key}`)
  // The team step while the company brief is still open: it says why it waits.
  const teamBeforeBrief = (key: string) =>
    key === "team" && props.state.items.some((i) => i.key === "knowledge" && !i.done)
  return (
    <div
      data-testid="setup-checklist"
      class="my-2 max-w-md rounded-lg border border-border bg-elevated px-3 py-2 text-[13px]"
    >
      <div class="flex items-baseline justify-between gap-2">
        <span data-testid="setup-checklist-heading" class="font-medium text-text-primary">
          {heading()}
        </span>
        <span
          data-testid="setup-checklist-progress"
          class="shrink-0 text-[11.5px] text-text-tertiary"
        >
          {i18n.t("first-run.checklist.progress", {
            done: doneCount(),
            total: props.state.items.length,
          })}
        </span>
      </div>
      <ol class="mt-1.5 flex flex-col gap-0.5">
        <For each={props.state.items}>
          {(item) => (
            <li
              data-testid={`setup-item-${item.key}`}
              data-done={item.done ? "true" : "false"}
              class="flex min-h-7 items-center gap-2"
            >
              <Show
                when={item.done}
                fallback={
                  <span
                    data-testid={`setup-item-number-${item.key}`}
                    class="w-4 shrink-0 text-right text-[12px] font-medium tabular-nums text-text-tertiary"
                  >
                    {stepNumber().get(item.key)}.
                  </span>
                }
              >
                <Check
                  size={14}
                  class="w-4 shrink-0 text-text-tertiary"
                  role="img"
                  aria-label={i18n.t("first-run.checklist.done")}
                />
              </Show>
              <span
                class={
                  item.done
                    ? "min-w-0 flex-1 text-text-tertiary line-through"
                    : "min-w-0 flex-1 text-text-primary"
                }
              >
                {label(item.key)}
                <Show when={item.optional && !item.done}>
                  <span class="ml-1.5 text-[11.5px] text-text-tertiary">
                    {i18n.t("first-run.checklist.optional")}
                  </span>
                </Show>
                <Show when={!item.done && teamBeforeBrief(item.key)}>
                  <span
                    data-testid="setup-item-team-after-brief"
                    class="block text-[11.5px] text-text-tertiary"
                  >
                    {i18n.t("first-run.checklist.teamAfterBrief")}
                  </span>
                </Show>
              </span>
              <Show when={!item.done && props.onStart}>
                <button
                  type="button"
                  data-testid={`setup-item-start-${item.key}`}
                  disabled={props.starting}
                  aria-label={
                    teamBeforeBrief(item.key)
                      ? i18n.t("first-run.checklist.inviteNowLabel")
                      : i18n.t("first-run.checklist.startLabel", { step: label(item.key) })
                  }
                  onClick={() => props.onStart?.(label(item.key))}
                  class="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-accent hover:bg-surface-hover disabled:opacity-50"
                >
                  {teamBeforeBrief(item.key)
                    ? i18n.t("first-run.checklist.inviteNow")
                    : i18n.t("first-run.checklist.start")}
                  <ArrowRight size={12} />
                </button>
              </Show>
            </li>
          )}
        </For>
      </ol>
      <Show when={asOf()}>
        {(at) => (
          <div class="mt-1 text-[11.5px] text-text-tertiary">
            {i18n.t("first-run.checklist.asOf", { time: at() })}
          </div>
        )}
      </Show>
    </div>
  )
}

export default SetupChecklistCard
