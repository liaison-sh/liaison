// SPDX-License-Identifier: FSL-1.1-ALv2
// Kanban card label chips: the card's effective labels resolved on
// the client from the loaded board (a parent's change shows on its children at
// once), value names only, the first two in catalog order then "+n".
import { type Component, createMemo, For, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { labelCatalog } from "~/modules/projects/label-catalog-store"
import {
  effectiveLabels,
  type LabelNode,
  labelValueText,
  type TaskLabel,
} from "~/modules/projects/task-labels"

const VISIBLE = 2

interface KanbanLabelChipsProps {
  task: LabelNode
  byId: ReadonlyMap<string, LabelNode>
}

export const KanbanLabelChips: Component<KanbanLabelChipsProps> = (props) => {
  const i18n = useI18n()
  // Several readers per render (the Show, the visible slice, "+n"): resolve once.
  const labels = createMemo(() =>
    effectiveLabels(props.task, props.byId, labelCatalog.groupOrder()),
  )
  const valueText = (entry: TaskLabel) => {
    const { valueName, archived } = labelCatalog.displayName(entry)
    return labelValueText(i18n.t, valueName, archived)
  }
  const fullText = (entry: TaskLabel) =>
    i18n.t("projects.labels.chip", {
      group: labelCatalog.displayName(entry).groupName,
      value: valueText(entry),
    })
  const rest = () => labels().slice(VISIBLE)
  return (
    <Show when={labels().length > 0}>
      <For each={labels().slice(0, VISIBLE)}>
        {(entry) => (
          <span
            data-testid="project-kanban-card.label"
            data-inherited={entry.inherited ? "true" : "false"}
            data-archived={labelCatalog.displayName(entry).archived ? "true" : "false"}
            title={fullText(entry)}
            class={cn(
              "ml-1.5 whitespace-nowrap rounded-sm border px-1 text-[10.5px]",
              entry.inherited
                ? "border-transparent italic text-text-tertiary"
                : "border-border-subtle text-text-secondary",
            )}
          >
            {valueText(entry)}
          </span>
        )}
      </For>
      <Show when={rest().length > 0}>
        <span
          data-testid="project-kanban-card.labels-more"
          title={i18n.t("projects.labels.card.moreTitle", {
            list: rest().map(fullText).join(", "),
          })}
          class="ml-1.5 whitespace-nowrap rounded-sm border border-border-subtle px-1 text-[10.5px] text-text-tertiary"
        >
          {i18n.t("projects.labels.card.more", { count: rest().length })}
        </span>
      </Show>
    </Show>
  )
}
