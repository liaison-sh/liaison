// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The light confirm a table asks before something it cannot take back from the grid alone:
// deleting a row (its history keeps it, and Undo brings it back) or dropping a column.
import type { Component } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

export const TableConfirmDialog: Component<{
  open: boolean
  title: string
  body: string
  confirmLabel: string
  testid: string
  onConfirm: () => void
  onCancel: () => void
}> = (props) => {
  const i18n = useI18n()
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onCancel()}>
      <Dialog.Content>
        <Dialog.Title>{props.title}</Dialog.Title>
        <p data-testid={`${props.testid}-text`} class="mt-3 text-[13px] text-text-secondary">
          {props.body}
        </p>
        <div class="mt-4 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            data-testid={`${props.testid}-cancel`}
            onClick={() => props.onCancel()}
          >
            {i18n.t("kernel.common.cancel")}
          </Button>
          <Button
            variant="danger"
            size="sm"
            data-testid={`${props.testid}-confirm`}
            onClick={() => props.onConfirm()}
          >
            {props.confirmLabel}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
