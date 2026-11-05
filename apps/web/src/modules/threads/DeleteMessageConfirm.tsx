// SPDX-License-Identifier: FSL-1.1-ALv2
import type { Component } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

/**
 * "Delete this message? This cannot be undone." Every delete of a message (the
 * desktop ⋯ menu, the agent message menu, the long-press sheet) goes through
 * it: a delete takes the message's files with it, so one stray tap must not.
 */
export const DeleteMessageConfirm: Component<{
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}> = (props) => {
  const i18n = useI18n()
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onCancel()}>
      <Dialog.Content class="max-w-sm" data-testid="delete-message-confirm">
        <Dialog.Title class="text-[15px]">
          {i18n.t("kernel.messageDeleteConfirmTitle")}
        </Dialog.Title>
        <Dialog.Description class="mt-1 text-[13px] text-text-secondary">
          {i18n.t("kernel.messageDeleteConfirmBody")}
        </Dialog.Description>
        <div class="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="delete-message-cancel"
            onClick={() => props.onCancel()}
          >
            {i18n.t("kernel.common.cancel")}
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            data-testid="delete-message-confirm-btn"
            onClick={() => props.onConfirm()}
          >
            {i18n.t("kernel.common.delete")}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
