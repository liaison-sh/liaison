// SPDX-License-Identifier: FSL-1.1-ALv2
// Board toolbar "Labels" chip: one section per label group (live
// groups, plus archived groups a loaded task still carries), each listing its
// values (archived ones marked) and "No label". One selection per group;
// groups combine with AND. Hidden when the org has no groups, disabled while
// the catalog loads or after it failed.
import { Check, X } from "lucide-solid"
import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { type LabelGroup, labelCatalog } from "~/modules/projects/label-catalog-store"
import { projectsFilterStore } from "~/modules/projects/projects-filter-store"
import {
  effectiveLabels,
  LABEL_NONE,
  type LabelNode,
  labelValueText,
} from "~/modules/projects/task-labels"
import { PopupMenu } from "~/ui/PopupMenu"

interface LabelFilterChipProps {
  tasks: readonly LabelNode[]
  /** Controlled open state, for the project menu's "Filter by label" at phone width. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Phone row: a narrower chip. */
  compact?: boolean
}

/**
 * The filter's sections: live groups, plus archived groups a loaded task still
 * carries (as an effective entry) or the filter still selects.
 */
function labelFilterSections(
  tasks: readonly LabelNode[],
  selected: Readonly<Record<string, string>>,
): LabelGroup[] {
  const archived = labelCatalog.groups.filter((g) => g.archivedAt !== null)
  const used = new Set<string>()
  if (archived.length > 0) {
    const byId = new Map(tasks.map((t) => [t.id, t]))
    for (const task of tasks) {
      for (const entry of effectiveLabels(task, byId)) used.add(entry.groupId)
    }
  }
  return labelCatalog.groups.filter(
    (g) => g.archivedAt === null || used.has(g.id) || selected[g.id] !== undefined,
  )
}

/**
 * One visibility rule for the desktop chip and the phone menu entry: hidden
 * once the catalog has loaded and offers no section (no group, or only
 * archived groups nothing uses).
 */
export function labelFilterHidden(tasks: readonly LabelNode[]): boolean {
  return (
    labelCatalog.loaded && labelFilterSections(tasks, projectsFilterStore.taskLabels).length === 0
  )
}

export const LabelFilterChip: Component<LabelFilterChipProps> = (props) => {
  const i18n = useI18n()
  const [localOpen, setLocalOpen] = createSignal(false)
  const open = () => props.open ?? localOpen()
  const setOpen = (next: boolean) => {
    setLocalOpen(next)
    props.onOpenChange?.(next)
  }
  const selected = () => projectsFilterStore.taskLabels
  const sections = createMemo(() => labelFilterSections(props.tasks, selected()))
  const hidden = () => labelCatalog.loaded && sections().length === 0
  const unavailable = () => !labelCatalog.loaded || labelCatalog.failed
  const activeCount = () => Object.keys(selected()).length

  const pick = (groupId: string, valueId: string) => {
    projectsFilterStore.setTaskLabel(groupId, selected()[groupId] === valueId ? null : valueId)
  }

  return (
    <Show when={!hidden()}>
      <span class="inline-flex items-center">
        <PopupMenu open={open()} onOpenChange={setOpen}>
          <PopupMenu.Trigger
            data-testid="project-workspace.label-filter"
            aria-label={i18n.t("projects.labels.filter.menuLabel")}
            disabled={unavailable()}
            class={cn(
              "flex h-7 items-center rounded-sm border px-2 text-[12px] disabled:opacity-50",
              props.compact && "max-w-[96px] truncate",
              activeCount() > 0
                ? "border-accent-border bg-accent-glow text-accent"
                : "border-transparent text-text-tertiary hover:bg-surface-hover hover:text-text-secondary",
            )}
          >
            {activeCount() > 0
              ? i18n.t("projects.labels.filter.active", { count: activeCount() })
              : i18n.t("projects.labels.label")}
          </PopupMenu.Trigger>
          <PopupMenu.Content
            aria-label={i18n.t("projects.labels.filter.menuLabel")}
            class="max-h-80 min-w-44 overflow-auto"
          >
            <For each={sections()}>
              {(group) => (
                <div data-testid="label-filter.section" data-group={group.id}>
                  <PopupMenu.Group>
                    <PopupMenu.Label>{group.name}</PopupMenu.Label>
                    <For each={[...group.values.map((v) => v.id), LABEL_NONE]}>
                      {(valueId) => {
                        const text = () => {
                          if (valueId === LABEL_NONE) return i18n.t("projects.labels.noLabel")
                          const value = group.values.find((v) => v.id === valueId)
                          return labelValueText(i18n.t, value?.name ?? "", value?.archived === true)
                        }
                        return (
                          <PopupMenu.Item
                            data-testid="label-filter.option"
                            textValue={text()}
                            onSelect={() => pick(group.id, valueId)}
                          >
                            <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                              <Show when={selected()[group.id] === valueId}>
                                <Check class="h-3.5 w-3.5" />
                              </Show>
                            </span>
                            <span class="flex-1 truncate">{text()}</span>
                          </PopupMenu.Item>
                        )
                      }}
                    </For>
                  </PopupMenu.Group>
                </div>
              )}
            </For>
          </PopupMenu.Content>
        </PopupMenu>
        <Show when={activeCount() > 0}>
          <button
            type="button"
            data-testid="project-workspace.label-filter-clear"
            aria-label={i18n.t("projects.labels.filter.clear")}
            onClick={() => projectsFilterStore.clearTaskLabels()}
            class="flex h-7 w-6 items-center justify-center rounded-sm text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
          >
            <X class="h-3 w-3" />
          </button>
        </Show>
      </span>
    </Show>
  )
}
