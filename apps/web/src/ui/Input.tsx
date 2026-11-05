// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, createUniqueId, Show, splitProps } from "solid-js"
import { cn } from "~/lib/cn"

interface InputProps {
  class?: string
  type?: string
  placeholder?: string
  value?: string
  label?: string
  error?: string
  disabled?: boolean
  onInput?: (e: InputEvent & { currentTarget: HTMLInputElement; target: HTMLInputElement }) => void
  onChange?: (e: Event & { currentTarget: HTMLInputElement; target: HTMLInputElement }) => void
  onBlur?: (e: FocusEvent & { currentTarget: HTMLInputElement; target: HTMLInputElement }) => void
  ref?: (el: HTMLInputElement) => void
  autofocus?: boolean
  maxLength?: number
  name?: string
  autocomplete?: string
  inputmode?: "none" | "text" | "tel" | "url" | "email" | "numeric" | "decimal" | "search"
  autocapitalize?: "off" | "none" | "on" | "sentences" | "words" | "characters"
  autocorrect?: "on" | "off"
  spellcheck?: boolean
  "data-testid"?: string
  /** Password-manager opt-outs (see lib/no-autofill.ts). */
  "data-1p-ignore"?: boolean
  "data-lpignore"?: "true"
}

export const Input: Component<InputProps> = (props) => {
  const [local, others] = splitProps(props, ["class", "label", "error", "ref"])
  const id = createUniqueId()
  const errorId = `${id}-error`

  return (
    <div class="flex flex-col gap-1.5">
      <Show when={local.label}>
        <label for={id} class="text-[12.5px] font-medium text-text-secondary">
          {local.label}
        </label>
      </Show>
      <input
        id={id}
        ref={local.ref}
        aria-invalid={!!local.error}
        aria-describedby={local.error ? errorId : undefined}
        class={cn(
          "w-full rounded-sm border bg-bg px-3 py-[9px] text-[13.5px] text-text outline-none transition-colors duration-150",
          "placeholder:text-text-tertiary",
          "focus:border-accent-muted",
          local.error ? "border-error" : "border-border",
          local.class,
        )}
        {...others}
      />
      <Show when={local.error}>
        <span id={errorId} class="text-xs text-error">
          {local.error}
        </span>
      </Show>
    </div>
  )
}
