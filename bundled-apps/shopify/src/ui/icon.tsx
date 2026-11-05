// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ShopifyAppIcon — activity bar icon. Drawn inline so the bundle doesn't
// pull `lucide-solid`. Stroke 1.5, currentColor — matches the kernel's
// lucide icons visually.
//
// The mark is a simplified shopping bag with a single curved handle — reads
// as "commerce" without being literal (no Shopify wordmark, no dollar
// signs). Matches the refined-minimalism direction we've committed to
// across the rest of the plugin's surfaces.
import type { Component } from "solid-js"

export const ShopifyAppIcon: Component<{ size?: number }> = (props) => {
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
      {/* Bag body */}
      <path d="M5 7h14l-1.2 12.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8L5 7z" />
      {/* Handle */}
      <path d="M9 7a3 3 0 0 1 6 0" />
    </svg>
  )
}
