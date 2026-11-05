// SPDX-License-Identifier: FSL-1.1-ALv2
// MergeTicketsForm — `BulkUiCustomForm` implementation for tickets:merge.
// The bulk toolbar wraps this with the actual dispatch; we only collect
// the target ticket + optional note and call onSubmit/onCancel.

import { type Component, createSignal, For } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { ticketListStore } from "~/modules/tickets/ticket-list-store"
import { Button } from "~/ui/Button"

interface Props {
  ids: string[]
  onSubmit: (params: Record<string, unknown>) => void
  onCancel: () => void
}

export const MergeTicketsForm: Component<Props> = (props) => {
  const i18n = useI18n()
  const [target, setTarget] = createSignal(props.ids[0] ?? "")
  const [note, setNote] = createSignal("")

  function submit(): void {
    const tgt = target()
    if (!tgt) return
    const sourceTicketIds = props.ids.filter((id) => id !== tgt)
    if (sourceTicketIds.length === 0) return
    props.onSubmit({
      targetTicketId: tgt,
      sourceTicketIds,
      note: note().trim() || undefined,
    })
  }

  return (
    <div class="flex items-center gap-2" data-testid="tickets-merge-form">
      <fieldset class="flex items-center gap-2">
        <For each={props.ids}>
          {(id) => {
            const t = ticketListStore.byId[id]
            return (
              <label class="flex items-center gap-1 text-xs">
                <input
                  type="radio"
                  name="merge-target"
                  value={id}
                  checked={target() === id}
                  onChange={() => setTarget(id)}
                  data-testid={`tickets-merge-target-${id}`}
                />
                <span class="truncate">{t?.handle ?? id}</span>
              </label>
            )
          }}
        </For>
      </fieldset>
      <input
        class="rounded border border-border bg-surface-sunken px-2 py-1 text-xs"
        placeholder={i18n.t("tickets.optionalNote")}
        data-testid="tickets-merge-note"
        value={note()}
        onInput={(e) => setNote(e.currentTarget.value)}
      />
      <Button
        type="button"
        size="sm"
        data-testid="tickets-merge-form-submit"
        disabled={props.ids.length < 2 || !target()}
        onClick={() => submit()}
      >
        {i18n.t("tickets.merge")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="tickets-merge-form-cancel"
        onClick={() => props.onCancel()}
      >
        {i18n.t("kernel.common.cancel")}
      </Button>
    </div>
  )
}
