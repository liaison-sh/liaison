// SPDX-License-Identifier: FSL-1.1-ALv2
// Task page label chips: one chip per live label group, after the
// release chip, plus archived groups the task still holds a value in. The
// entries are the server's (own and inherited); the catalog gives the groups,
// the live names and the picker's values.
import { Tag } from "lucide-solid"
import { type Component, createSignal, For, type JSX, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { type LabelGroup, labelCatalog } from "~/modules/projects/label-catalog-store"
import { labelValueText, type TaskLabel } from "~/modules/projects/task-labels"
import { PopupMenu } from "~/ui/PopupMenu"
import { Tooltip } from "~/ui/Tooltip"

interface TaskLabelChipsProps {
  /** The task's labels as the server returned them. */
  labels: TaskLabel[] | undefined
  disabled: boolean
  onChange: (groupId: string, valueId: string | null) => void
}

const CHIP_CLASS =
  "inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[12.5px] transition-colors"

const catalogReady = () => labelCatalog.loaded && !labelCatalog.failed

function entriesOf(labels: TaskLabel[] | undefined): TaskLabel[] {
  return Array.isArray(labels) ? labels : []
}

/**
 * The groups the task page shows a chip for: every live catalog group plus the
 * archived ones the task still holds a value in; without a usable catalog,
 * the task's own entries. Empty when the org has no group and the task no
 * label, so the meta row can drop the chips' separator too.
 */
export function taskLabelGroupIds(labels: TaskLabel[] | undefined): string[] {
  const list = entriesOf(labels)
  if (!catalogReady()) return list.map((e) => e.groupId)
  const out: string[] = []
  for (const group of labelCatalog.groups) {
    if (group.archivedAt === null || list.some((e) => e.groupId === group.id)) out.push(group.id)
  }
  // A group the catalog does not know yet (created since it loaded): read-only.
  for (const entry of list) {
    if (!out.includes(entry.groupId)) out.push(entry.groupId)
  }
  return out
}

export const TaskLabelChips: Component<TaskLabelChipsProps> = (props) => {
  const entries = (): TaskLabel[] => entriesOf(props.labels)
  // Group ids, not row objects: `For` keys by identity, so a fresh row object
  // per evaluation would remount the chip (and close its open menu) whenever
  // the task row is replaced by a store echo.
  const groupIds = (): string[] => taskLabelGroupIds(props.labels)
  return (
    <For each={groupIds()}>
      {(groupId, i) => (
        <>
          <Show when={i() > 0}>
            <span aria-hidden="true" class="text-text-tertiary/40">
              ·
            </span>
          </Show>
          <LabelChip
            group={catalogReady() ? (labelCatalog.group(groupId) ?? null) : null}
            groupId={groupId}
            entry={entries().find((e) => e.groupId === groupId) ?? null}
            disabled={props.disabled}
            onChange={(valueId) => props.onChange(groupId, valueId)}
          />
        </>
      )}
    </For>
  )
}

interface LabelChipProps {
  /** The catalog group; null when the catalog is not usable (read-only chip). */
  group: LabelGroup | null
  groupId: string
  entry: TaskLabel | null
  disabled: boolean
  onChange: (valueId: string | null) => void
}

export const LabelChip: Component<LabelChipProps> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  /** Names and archive mark from the catalog when usable, else from the payload. */
  const names = () => {
    const entry = props.entry
    if (!entry) return { groupName: props.group?.name ?? "", valueName: "", archived: false }
    return props.group ? labelCatalog.displayName(entry) : entry
  }
  const text = () => {
    const { groupName, valueName, archived } = names()
    if (!props.entry) return i18n.t("projects.labels.chipNotSet", { group: groupName })
    const value = labelValueText(i18n.t, valueName, archived)
    return i18n.t("projects.labels.chip", { group: groupName, value })
  }
  const inherited = () => props.entry?.inherited === true
  const archived = () => props.entry !== null && names().archived
  const groupArchived = () => props.group?.archivedAt != null
  /** Live values of the group; an archived group offers none. */
  const options = () =>
    props.group && !groupArchived() ? props.group.values.filter((v) => !v.archived) : []
  /** Read-only: no catalog, or an archived group whose value is inherited. */
  const interactive = () =>
    props.group !== null && (!groupArchived() || (props.entry !== null && !inherited()))

  const chip = (): JSX.Element => (
    <span
      data-testid={`task-detail.label-${props.groupId}`}
      data-inherited={inherited() ? "true" : "false"}
      data-archived={archived() ? "true" : "false"}
      title={groupArchived() ? i18n.t("projects.labels.readOnly") : undefined}
      class={cn(
        CHIP_CLASS,
        props.entry && !inherited()
          ? "border-border text-text-secondary"
          : "border-transparent text-text-tertiary",
        inherited() && "italic",
        interactive() && "hover:bg-surface-hover/50 hover:text-text",
      )}
    >
      <Tag class="h-3.5 w-3.5" />
      {text()}
    </span>
  )

  const body = (): JSX.Element => (
    <Show when={interactive()} fallback={chip()}>
      <PopupMenu open={open()} onOpenChange={setOpen}>
        <PopupMenu.Trigger
          class="rounded-sm disabled:opacity-50"
          disabled={props.disabled}
          aria-label={i18n.t("projects.labels.pickerLabel", { group: names().groupName })}
        >
          {chip()}
        </PopupMenu.Trigger>
        <PopupMenu.Content
          aria-label={i18n.t("projects.labels.pickerLabel", { group: names().groupName })}
        >
          <For each={options()}>
            {(v) => (
              <PopupMenu.Item
                data-testid="task-detail.label-option"
                textValue={v.name}
                onSelect={() => {
                  props.onChange(v.id)
                  setOpen(false)
                }}
              >
                {v.name}
              </PopupMenu.Item>
            )}
          </For>
          <PopupMenu.Item
            data-testid="task-detail.label-none"
            onSelect={() => {
              props.onChange(null)
              setOpen(false)
            }}
          >
            {i18n.t("projects.labels.none")}
          </PopupMenu.Item>
        </PopupMenu.Content>
      </PopupMenu>
    </Show>
  )

  return (
    <Show when={inherited() && props.entry?.inheritedFromKey} fallback={body()}>
      {(key) => (
        <Tooltip content={i18n.t("projects.labels.inheritedFrom", { key: key() })}>
          {body()}
        </Tooltip>
      )}
    </Show>
  )
}
