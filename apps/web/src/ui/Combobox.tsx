// SPDX-License-Identifier: FSL-1.1-ALv2
import { Combobox as KobalteCombobox } from "@kobalte/core/combobox"
import { type Component, createSignal, splitProps } from "solid-js"
import { cn } from "~/lib/cn"

interface ComboboxProps {
  /** The committed value; shown in the field when it opens. */
  value: string
  /** Values offered while typing, filtered by what is typed. */
  suggestions: string[]
  /**
   * Called once per commit with the chosen text: a picked suggestion, or the
   * typed text on Enter or blur (free text is always accepted).
   */
  onCommit(value: string): void
  /** Escape with the list closed: leave without committing. */
  onCancel?(): void
  placeholder?: string
  maxLength?: number
  disabled?: boolean
  autofocus?: boolean
  class?: string
  "aria-label"?: string
  "data-testid"?: string
}

/**
 * A text field with suggestions that also takes any free text. Kobalte's
 * combobox only knows its options, so the typed text is tracked here and
 * committed on Enter (when no suggestion is highlighted) or on blur; picking a
 * suggestion commits that suggestion. One commit per interaction.
 */
export const Combobox: Component<ComboboxProps> = (props) => {
  const [local] = splitProps(props, [
    "value",
    "suggestions",
    "onCommit",
    "onCancel",
    "placeholder",
    "maxLength",
    "disabled",
    "autofocus",
    "class",
    "aria-label",
    "data-testid",
  ])
  const [draft, setDraft] = createSignal(local.value)
  let committed = false

  // The current value must be an option for Kobalte to show it in the field.
  const options = () => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const v of [local.value, ...local.suggestions]) {
      const t = v?.trim()
      if (!t || seen.has(t)) continue
      seen.add(t)
      out.push(t)
    }
    return out
  }

  const commit = (value: string) => {
    if (committed) return
    committed = true
    local.onCommit(value.trim())
  }

  return (
    <KobalteCombobox<string>
      options={options()}
      value={local.value.trim() ? local.value.trim() : null}
      onChange={(v) => {
        if (v != null) commit(v)
      }}
      onInputChange={setDraft}
      disabled={local.disabled}
      triggerMode="focus"
      noResetInputOnBlur
      placeholder={local.placeholder}
      itemComponent={(itemProps) => (
        <KobalteCombobox.Item
          item={itemProps.item}
          class="flex cursor-pointer items-center rounded-md px-2 py-1 font-mono text-[12px] text-text-secondary outline-none data-[highlighted]:bg-surface-hover data-[highlighted]:text-text"
        >
          <KobalteCombobox.ItemLabel>{itemProps.item.rawValue}</KobalteCombobox.ItemLabel>
        </KobalteCombobox.Item>
      )}
    >
      <KobalteCombobox.Control class="inline-flex" aria-label={local["aria-label"]}>
        <KobalteCombobox.Input
          data-testid={local["data-testid"]}
          aria-label={local["aria-label"]}
          maxLength={local.maxLength}
          autofocus={local.autofocus}
          ref={(el: HTMLInputElement) => {
            if (local.autofocus) queueMicrotask(() => el.focus())
          }}
          class={cn(
            "w-40 rounded-sm border border-border bg-bg px-2 py-0.5 font-mono text-[12px] text-text outline-none placeholder:text-text-tertiary focus:border-accent-muted",
            local.class,
          )}
          onKeyDown={(e: KeyboardEvent) => {
            const input = e.currentTarget as HTMLInputElement
            if (e.key === "Enter") {
              // A highlighted suggestion is Kobalte's to select; otherwise the
              // typed text is the answer.
              if (!input.getAttribute("aria-activedescendant")) {
                e.preventDefault()
                commit(input.value)
              }
            } else if (e.key === "Escape" && input.getAttribute("aria-expanded") !== "true") {
              committed = true
              local.onCancel?.()
            }
          }}
          onBlur={(e: FocusEvent) => {
            const next = e.relatedTarget as HTMLElement | null
            if (next?.closest?.("[role='listbox']")) return
            commit(draft())
          }}
        />
      </KobalteCombobox.Control>
      <KobalteCombobox.Portal>
        <KobalteCombobox.Content
          class="popup-menu z-50 rounded-lg border border-border bg-elevated p-1 shadow-popover outline-none"
          // Options take no focus (virtual focus) and Kobalte selects on
          // press up, so a mousedown here would blur the input first and the
          // blur would commit the typed prefix. Keep focus in the input: the
          // pick then commits the picked suggestion, once.
          onMouseDown={(e: MouseEvent) => e.preventDefault()}
        >
          <KobalteCombobox.Listbox class="max-h-60 overflow-y-auto outline-none" />
        </KobalteCombobox.Content>
      </KobalteCombobox.Portal>
    </KobalteCombobox>
  )
}
