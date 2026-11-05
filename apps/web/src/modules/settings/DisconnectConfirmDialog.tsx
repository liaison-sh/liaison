// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

/**
 * Asks before a connection is disconnected, and says what goes with it: the
 * app's imported data (`body`, the app's own sentence) and the provider access
 * (revoked, tokens deleted). Disconnecting deletes data, so it is never one click.
 */
export const DisconnectConfirmDialog: Component<{
  open: boolean
  /** What is being disconnected: an address, an inbox name, "Google Drive". */
  name: string
  /** What the disconnect deletes and what it keeps, in the app's words. */
  body: string
  busy?: boolean
  /** The connection is an OAuth grant Liaison revokes (default). False for a disconnect that
   *  releases no provider access, such as an API inbox. */
  revokes?: boolean
  testId: string
  onConfirm: () => void
  onCancel: () => void
}> = (props) => {
  const i18n = useI18n()
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onCancel()}>
      <Dialog.Content>
        <div data-testid={props.testId}>
          <Dialog.Title>
            {i18n.t("kernel.disconnectConfirm.title", { name: props.name })}
          </Dialog.Title>
          <p class="mt-3 text-sm text-text-secondary">{props.body}</p>
          <Show when={props.revokes !== false}>
            <p class="mt-2 text-sm text-text-secondary">
              {i18n.t("kernel.disconnectConfirm.revokeNote")}
            </p>
          </Show>
          <div class="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => props.onCancel()}>
              {i18n.t("kernel.common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={props.busy}
              data-testid={`${props.testId}-confirm`}
              onClick={() => props.onConfirm()}
            >
              {i18n.t("kernel.disconnectConfirm.confirm")}
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
