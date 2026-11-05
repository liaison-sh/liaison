// SPDX-License-Identifier: FSL-1.1-ALv2
import { ToggleButton } from "@kobalte/core/toggle-button"
import { type ParentComponent, splitProps } from "solid-js"
import { cn } from "~/lib/cn"

interface ToggleProps {
  pressed: boolean
  onChange: (pressed: boolean) => void
  class?: string
  disabled?: boolean
  "aria-label"?: string
  "data-testid"?: string
  "data-touch-dense"?: boolean
}

export const Toggle: ParentComponent<ToggleProps> = (props) => {
  const [local, others] = splitProps(props, ["class", "children", "pressed", "onChange"])

  return (
    <ToggleButton
      pressed={local.pressed}
      onChange={local.onChange}
      class={cn(
        "inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm transition-colors duration-150",
        "text-text-secondary hover:bg-surface-hover hover:text-text",
        "data-[pressed]:bg-accent-glow data-[pressed]:text-accent",
        local.class,
      )}
      {...others}
    >
      {local.children}
    </ToggleButton>
  )
}
