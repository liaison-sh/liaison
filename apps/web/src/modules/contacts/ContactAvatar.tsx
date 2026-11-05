// SPDX-License-Identifier: FSL-1.1-ALv2
import type { Component } from "solid-js"
import { Show } from "solid-js"
import { avatarColors, contactInitials } from "./contact-visuals"

type AvatarSize = "sm" | "md" | "lg" | "xl"

interface ContactAvatarProps {
  id: string
  name?: string | null
  email?: string | null
  size?: AvatarSize
  // Renders a soft outer ring — used in the list to suggest "automated"
  // senders (different texture than humans without adding visual noise).
  muted?: boolean
}

const SIZE_MAP: Record<AvatarSize, { box: string; text: string; ringPad: string }> = {
  sm: { box: "h-6 w-6", text: "text-[10px]", ringPad: "p-[2px]" },
  md: { box: "h-8 w-8", text: "text-[11px]", ringPad: "p-[2px]" },
  lg: { box: "h-10 w-10", text: "text-[13px]", ringPad: "p-[2px]" },
  xl: { box: "h-16 w-16", text: "text-[20px]", ringPad: "p-[3px]" },
}

export const ContactAvatar: Component<ContactAvatarProps> = (props) => {
  const size = () => props.size ?? "md"
  const cfg = () => SIZE_MAP[size()]
  const colors = () => avatarColors(props.id)
  const label = () => contactInitials({ name: props.name, email: props.email })

  return (
    <Show
      when={props.muted}
      fallback={
        <div
          aria-hidden="true"
          class={`${cfg().box} flex shrink-0 items-center justify-center rounded-full font-semibold ${cfg().text}`}
          style={{
            "background-color": colors().bg,
            color: colors().text,
            "line-height": "1",
            // Subtle inner highlight so the avatar reads as a token rather than
            // a flat blob — important against bg colors that share luminance
            // with surface-hover.
            "box-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.06)",
          }}
        >
          {label()}
        </div>
      }
    >
      <div
        aria-hidden="true"
        class={`${cfg().box} flex shrink-0 items-center justify-center rounded-full font-medium ${cfg().text} bg-surface-hover text-text-tertiary`}
        style={{
          // Dashed border = "synthetic identity" without using accent color.
          border: "1px dashed var(--color-border-strong)",
          "line-height": "1",
        }}
      >
        {label()}
      </div>
    </Show>
  )
}
