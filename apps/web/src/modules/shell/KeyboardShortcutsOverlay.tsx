// SPDX-License-Identifier: FSL-1.1-ALv2

import type { Component } from "solid-js"
import { For } from "solid-js"
import { getKeybindings } from "~/framework/app-registry"
import { useI18n } from "~/modules/i18n/i18n-context"
import { formatKeyLabel } from "~/modules/shell/key-label"
import { Dialog } from "~/ui/Dialog"

interface KeyboardShortcutsOverlayProps {
  isOpen: boolean
  onClose: () => void
}

const KeyboardShortcutsOverlay: Component<KeyboardShortcutsOverlayProps> = (props) => {
  const i18n = useI18n()
  const bindings = () => getKeybindings().filter((b) => b.key)

  return (
    <Dialog
      open={props.isOpen}
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <Dialog.Content class="w-full max-w-md">
        <div class="mb-4 flex items-center justify-between">
          <Dialog.Title>{i18n.t("kernel.keyboardShortcuts")}</Dialog.Title>
          <Dialog.Close class="text-text-tertiary hover:text-text">
            {i18n.t("kernel.esc")}
          </Dialog.Close>
        </div>
        <Dialog.Description class="sr-only">
          {i18n.t("kernel.shellUi.listOfAvailableKeyboardShortcuts")}
        </Dialog.Description>
        <div class="space-y-2">
          <For each={bindings()}>
            {(binding) => (
              <div class="flex items-center justify-between py-1">
                <span class="text-sm text-text-secondary">{binding.label ?? binding.id}</span>
                <kbd class="rounded bg-surface-hover px-2 py-0.5 text-xs font-mono text-text-tertiary">
                  {formatKeyLabel(binding.key)}
                </kbd>
              </div>
            )}
          </For>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}

export default KeyboardShortcutsOverlay
