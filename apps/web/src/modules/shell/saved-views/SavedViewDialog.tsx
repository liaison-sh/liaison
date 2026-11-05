// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, createSignal, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { Input } from "~/ui/Input"

interface SavedViewDialogProps {
  mode: "create" | "rename"
  open: boolean
  initialName?: string
  canShare: boolean
  onSubmit: (input: { name: string; sharedWithOrg: boolean }) => void | Promise<void>
  onClose: () => void
}

export const SavedViewDialog: Component<SavedViewDialogProps> = (props) => {
  const i18n = useI18n()
  const [name, setName] = createSignal(props.initialName ?? "")
  const [shared, setShared] = createSignal(false)
  const [submitting, setSubmitting] = createSignal(false)

  async function submit() {
    const trimmed = name().trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      await props.onSubmit({ name: trimmed, sharedWithOrg: shared() })
      setName("")
      setShared(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Content class="w-80" data-testid="saved-view-dialog">
        <Dialog.Title>
          {props.mode === "create"
            ? i18n.t("kernel.shellUi.saveCurrentView")
            : i18n.t("kernel.shellUi.renameSavedView")}
        </Dialog.Title>
        <div class="mt-3 flex flex-col gap-3">
          <Input
            label={i18n.t("kernel.common.name")}
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            data-testid="saved-view-dialog-name"
          />
          <Show when={props.mode === "create" && props.canShare}>
            <label class="flex items-center gap-2 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={shared()}
                onChange={(e) => setShared(e.currentTarget.checked)}
                data-testid="saved-view-dialog-share"
              />
              {i18n.t("kernel.shellUi.shareWithOrg")}
            </label>
          </Show>
          <div class="mt-2 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={props.onClose}
              data-testid="saved-view-dialog-cancel"
            >
              {i18n.t("kernel.common.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={() => void submit()}
              disabled={submitting() || !name().trim()}
              data-testid="saved-view-dialog-submit"
            >
              {props.mode === "create"
                ? i18n.t("kernel.common.save")
                : i18n.t("kernel.common.rename")}
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
