// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE PINNED PLAN (P2-T09; charter). Shown only when the session has a
// TodoWrite or Task* list: "Plan", "n of m", a progress bar and the current
// item; collapsible to the one summary line.

import type { NodeSessionEvent } from "@liaison/shared"
import { Check, ListChecks } from "lucide-solid"
import { createMemo, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { PathContext } from "./display"
import { latestPlan } from "./transcript"

export default function SessionPlan(props: {
  events: readonly NodeSessionEvent[]
  pathContext: PathContext
}) {
  const t = useI18n().t
  const plan = createMemo(() => latestPlan(props.events, props.pathContext))
  const pct = () => {
    const p = plan()
    return p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0
  }
  return (
    <Show when={plan()}>
      {(p) => (
        <details
          data-testid="session-plan"
          class="rounded-lg border border-border bg-surface text-[12.5px]"
        >
          <summary class="flex cursor-pointer select-none items-center gap-2 px-3 py-2">
            <ListChecks class="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
            <span class="font-medium text-text">{t("kernel.nodeSessions.plan.title")}</span>
            <span class="tabular-nums text-text-secondary">
              {t("kernel.nodeSessions.plan.progress", { done: p().done, total: p().total })}
            </span>
            <span
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct()}
              class="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-surface-hover"
            >
              <span class="block h-full bg-accent" style={{ width: `${pct()}%` }} />
            </span>
            <Show when={p().current}>
              <span class="min-w-0 flex-1 truncate text-right text-text-secondary">
                {p().current}
              </span>
            </Show>
          </summary>
          <ul class="flex flex-col gap-1 border-t border-border-subtle px-3 py-2">
            <For each={p().items}>
              {(item) => (
                <li
                  class="flex items-start gap-2"
                  classList={{
                    "text-text-tertiary line-through": item.status === "completed",
                    "font-medium text-text": item.status === "in_progress",
                    "text-text-secondary": item.status === "pending",
                  }}
                >
                  <span class="mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    <Show when={item.status === "completed"}>
                      <Check class="h-3.5 w-3.5 text-success" />
                    </Show>
                  </span>
                  {item.content}
                </li>
              )}
            </For>
          </ul>
        </details>
      )}
    </Show>
  )
}
