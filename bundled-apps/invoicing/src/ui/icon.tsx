// SPDX-License-Identifier: FSL-1.1-ALv2
//
// InvoicingAppIcon — activity bar icon. Drawn inline so the bundle doesn't
// pull `lucide-solid`. Stroke 1.5, currentColor — matches the kernel's
// lucide icons visually.
//
// The mark is a receipt with a pen-nib overlay: reads as "issued document"
// without being literal (no $ sign, no localized currency mark, no
// jurisdictional iconography). Matches the refined-minimalism direction
// across the rest of the bundled plugins.
import type { Component } from "solid-js"

export const InvoicingAppIcon: Component<{ size?: number }> = (props) => {
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
      {/* Receipt body — torn-edge bottom for the "receipt" silhouette */}
      <path d="M5 3v18l2-1.5 2 1.5 2-1.5 2 1.5 2-1.5 2 1.5 2-1.5V3z" />
      {/* Top two ledger rows */}
      <path d="M8 7h8M8 11h6" />
      {/* Pen-nib overlay — diagonal stroke + tip — anchors the icon */}
      <path d="M14.5 15.5l3.5-3.5 1.5 1.5-3.5 3.5-2 .5z" />
    </svg>
  )
}
