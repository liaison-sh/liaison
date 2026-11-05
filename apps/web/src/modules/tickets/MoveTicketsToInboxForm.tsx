// SPDX-License-Identifier: FSL-1.1-ALv2
// MoveTicketsToInboxForm — `BulkUiCustomForm` implementation for
// tickets:ticketsMove. The bulk toolbar wraps this with the actual dispatch;
// we only collect the destination inbox and call onSubmit/onCancel.

import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { ticketInboxStore } from "~/modules/tickets/ticket-inbox-store"
import { Button } from "~/ui/Button"

interface Props {
  ids: string[]
  onSubmit: (params: Record<string, unknown>) => void
  onCancel: () => void
}

export const MoveTicketsToInboxForm: Component<Props> = (props) => {
  const i18n = useI18n()
  const [toInboxId, setToInboxId] = createSignal("")

  const targetInboxes = createMemo(() => ticketInboxStore.inboxes.filter((i) => !i.archivedAt))

  function submit(): void {
    const to = toInboxId()
    if (!to || props.ids.length === 0) return
    props.onSubmit({ toInboxId: to, ticketIds: props.ids })
  }

  return (
    <div class="flex items-center gap-2" data-testid="tickets-move-form">
      <select
        class="rounded border border-border bg-surface-sunken px-2 py-1 text-xs"
        data-testid="tickets-move-target-inbox"
        value={toInboxId()}
        onChange={(e) => setToInboxId(e.currentTarget.value)}
      >
        <option value="">{i18n.t("tickets.chooseInbox")}</option>
        <For each={targetInboxes()}>
          {(inbox) => (
            <option value={inbox.id} data-testid={`tickets-move-target-inbox-option-${inbox.id}`}>
              {inbox.name}
            </option>
          )}
        </For>
      </select>
      <Show when={targetInboxes().length === 0}>
        <span class="text-xs text-text-tertiary">{i18n.t("tickets.noInboxesAvailable")}</span>
      </Show>
      <Button
        type="button"
        size="sm"
        data-testid="tickets-move-form-submit"
        disabled={props.ids.length === 0 || !toInboxId()}
        onClick={() => submit()}
      >
        {i18n.t("tickets.move")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="tickets-move-form-cancel"
        onClick={() => props.onCancel()}
      >
        {i18n.t("kernel.common.cancel")}
      </Button>
    </div>
  )
}
