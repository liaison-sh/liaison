// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, createEffect, onCleanup, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useTabIsActive } from "~/modules/shell/TabVisibilityContext"

interface ContextualSaveBarProps {
  dirty: boolean
  saving?: boolean
  onSave: () => void
  onDiscard: () => void
  label?: string
}

export const ContextualSaveBar: Component<ContextualSaveBarProps> = (props) => {
  const i18n = useI18n()
  const isTabActive = useTabIsActive()
  createEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isTabActive()) return
      if (!props.dirty) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault()
        if (!props.saving) props.onSave()
        return
      }
      if (e.key === "Escape") {
        props.onDiscard()
      }
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  return (
    <Show when={props.dirty}>
      <div
        class="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-border bg-elevated px-4 py-2 text-sm shadow-sm transition-transform duration-150"
        role="region"
        aria-label={i18n.t("kernel.saveChanges")}
        data-testid="save-bar"
      >
        <span class="text-text-secondary">
          {props.label ?? i18n.t("kernel.shellUi.unsavedChanges")}
        </span>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="rounded border border-border px-3 py-1 text-xs text-text-secondary hover:bg-surface-hover disabled:opacity-50"
            data-testid="save-bar-discard"
            disabled={props.saving}
            onClick={() => props.onDiscard()}
          >
            {i18n.t("kernel.shellUi.discard")}
          </button>
          <button
            type="button"
            class="rounded bg-accent px-3 py-1 text-xs font-medium text-bg disabled:opacity-50"
            data-testid="save-bar-save"
            disabled={props.saving}
            onClick={() => props.onSave()}
          >
            {i18n.t("kernel.common.save")}
          </button>
        </div>
      </div>
    </Show>
  )
}
