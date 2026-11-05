// SPDX-License-Identifier: FSL-1.1-ALv2
// SetTaskLabelsForm — `BulkUiCustomForm` for projects:setLabels. One
// picker per live label group: "Unchanged" (default), the group's live values,
// "None" (clears each task's own value). Only the changed groups are sent, as
// the `labels` map the update tool takes.
import { type Component, createSignal, For, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { ensureLabelCatalog, labelCatalog } from "~/modules/projects/label-catalog-store"
import { LABEL_NONE } from "~/modules/projects/task-labels"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

interface Props {
  ids: string[]
  onSubmit: (params: Record<string, unknown>) => void
  onCancel: () => void
}

export const SetTaskLabelsForm: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  onMount(() => {
    if (api) void ensureLabelCatalog(api)
  })
  /** group id → value id or LABEL_NONE; an absent key is "Unchanged". */
  const [choices, setChoices] = createSignal<Record<string, string>>({})
  const groups = () => labelCatalog.liveGroups()

  const choose = (groupId: string, valueId: string) => {
    const next = { ...choices() }
    if (valueId === "") delete next[groupId]
    else next[groupId] = valueId
    setChoices(next)
  }

  function submit(): void {
    const picked = choices()
    if (props.ids.length === 0 || Object.keys(picked).length === 0) return
    const labels: Record<string, string | null> = {}
    for (const [groupId, valueId] of Object.entries(picked)) {
      labels[groupId] = valueId === LABEL_NONE ? null : valueId
    }
    props.onSubmit({ labels })
  }

  return (
    <div class="flex flex-wrap items-center gap-2" data-testid="projects-set-labels">
      <Show
        when={groups().length > 0}
        fallback={
          <span class="text-xs text-text-tertiary">{i18n.t("projects.labels.bulk.empty")}</span>
        }
      >
        <For each={groups()}>
          {(group) => (
            <label class="flex items-center gap-1 text-xs text-text-secondary">
              <span>{group.name}</span>
              <select
                class="rounded border border-border bg-surface-sunken px-2 py-1 text-xs"
                data-testid={`projects-set-labels.group-${group.id}`}
                value={choices()[group.id] ?? ""}
                onChange={(e) => choose(group.id, e.currentTarget.value)}
              >
                <option value="">{i18n.t("projects.labels.bulk.unchanged")}</option>
                <For each={group.values}>{(v) => <option value={v.id}>{v.name}</option>}</For>
                <option value={LABEL_NONE}>{i18n.t("projects.labels.bulk.none")}</option>
              </select>
            </label>
          )}
        </For>
        <Button
          type="button"
          size="sm"
          data-testid="projects-set-labels.submit"
          disabled={props.ids.length === 0 || Object.keys(choices()).length === 0}
          onClick={() => submit()}
        >
          {i18n.t("projects.labels.bulk.submit")}
        </Button>
      </Show>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="projects-set-labels.cancel"
        onClick={() => props.onCancel()}
      >
        {i18n.t("kernel.common.cancel")}
      </Button>
    </div>
  )
}
