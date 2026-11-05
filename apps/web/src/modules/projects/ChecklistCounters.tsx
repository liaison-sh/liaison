// SPDX-License-Identifier: FSL-1.1-ALv2
// Checklist progress on a Kanban card (spec S17, variant C): one counter per
// validation level, `AI 4/4 · Dev 2/4`, whose denominator is the level's
// applicable items. A level with any Fail reads the error token, a level fully
// in Success reads the success token, a level with nothing applicable is
// hidden. Plain mode (no levels) shows one `complete/total` counter. A task
// without checklist items shows nothing.

import { type Component, For, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { ChecklistStatus } from "~/modules/projects/checklist-types"

interface Counter {
  key: string
  label: string
  done: number
  of: number
  failing: boolean
}

function countersFor(status: ChecklistStatus): Counter[] {
  if (status.perLevel.length === 0) {
    return [{ key: "plain", label: "", done: status.complete, of: status.total, failing: false }]
  }
  return status.perLevel
    .filter((l) => l.applicable > 0)
    .map((l) => ({
      key: l.levelId,
      label: l.name,
      done: l.success,
      of: l.applicable,
      failing: l.fail > 0,
    }))
}

function toneClass(c: Counter): string {
  if (c.failing) return "text-error"
  if (c.done === c.of) return "text-success"
  return "text-text-tertiary"
}

export const ChecklistCounters: Component<{ status: ChecklistStatus | null | undefined }> = (
  props,
) => {
  const i18n = useI18n()
  const counters = () => (props.status && props.status.total > 0 ? countersFor(props.status) : [])
  return (
    <Show when={counters().length > 0}>
      <span
        data-testid="checklist-counters"
        title={i18n.t("projects.checklist.card.countersLabel")}
        class="inline-flex flex-wrap items-center gap-x-1 font-mono text-[11px] tabular-nums"
      >
        <For each={counters()}>
          {(c, i) => (
            <>
              <Show when={i() > 0}>
                <span aria-hidden="true" class="text-text-tertiary">
                  {" · "}
                </span>
              </Show>
              <span
                data-testid="checklist-counter"
                data-level={c.label || undefined}
                class={cn("whitespace-nowrap", toneClass(c))}
              >
                {c.label ? `${c.label} ${c.done}/${c.of}` : `${c.done}/${c.of}`}
              </span>
            </>
          )}
        </For>
      </span>
    </Show>
  )
}
