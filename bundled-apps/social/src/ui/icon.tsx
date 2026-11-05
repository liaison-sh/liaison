// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SocialAppIcon — activity-bar icon. Inline SVG (no lucide-solid dep), stroke
// 1.5 currentColor to match the kernel icon set. A speech/megaphone mark reads
// as "community / social" without platform-specific iconography.
import type { Component } from "solid-js"

export const SocialAppIcon: Component<{ size?: number }> = (props) => {
  const s = props.size ?? 16
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z" />
      <path d="M8 12h.01" />
      <path d="M12 12h.01" />
      <path d="M16 12h.01" />
    </svg>
  )
}
