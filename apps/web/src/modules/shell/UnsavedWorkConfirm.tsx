// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one question asked before the page or some tabs are thrown away while
// they hold unsaved work (lib/unsaved-work.ts): what would be lost, then Keep
// or Discard. A trivial confirm, so a small dialog.
import { type Component, For, Show } from "solid-js"
import { pendingDiscard, resolveDiscard } from "~/lib/unsaved-work"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

export const UnsavedWorkConfirm: Component = () => {
  const i18n = useI18n()
  const reload = () => pendingDiscard()?.action === "reload"
  return (
    <Dialog
      open={pendingDiscard() !== null}
      onOpenChange={(open) => !open && resolveDiscard(false)}
    >
      <Dialog.Content>
        <div data-testid="unsaved-work-confirm">
          <Dialog.Title>
            {reload()
              ? i18n.t("kernel.unsavedWork.reloadTitle")
              : i18n.t("kernel.unsavedWork.closeTitle")}
          </Dialog.Title>
          <p class="mt-3 text-sm text-text-secondary">{i18n.t("kernel.unsavedWork.body")}</p>
          <Show when={pendingDiscard()}>
            {(open) => (
              <ul class="mt-2 list-disc pl-5 text-sm text-text" data-testid="unsaved-work-items">
                <For each={open().items}>{(item) => <li>{item}</li>}</For>
              </ul>
            )}
          </Show>
          <div class="mt-5 flex justify-end gap-2">
            <Button
              variant="ghost"
              data-testid="unsaved-work-keep"
              onClick={() => resolveDiscard(false)}
            >
              {i18n.t("kernel.unsavedWork.keep")}
            </Button>
            <Button
              variant="danger"
              data-testid="unsaved-work-discard"
              onClick={() => resolveDiscard(true)}
            >
              {reload()
                ? i18n.t("kernel.unsavedWork.discardAndReload")
                : i18n.t("kernel.unsavedWork.discardAndClose")}
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
