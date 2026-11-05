// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Sessions app on the phone (P4, charter "Phone"): two screens, Stop in
// the top bar, and every touch target at least 44 px. The tier is the shell's
// (shell-tier.ts), never a CSS breakpoint of this module's own, so the list
// and the session screen switch exactly where the shell drops its sidebar.

import { shellTier } from "~/modules/shell/shell-tier"

/** The 44 px minimum touch target (Tailwind's 11 = 2.75rem = 44 px). */
export const TAP_TARGET = "min-h-11 min-w-11"

export const isPhone = (): boolean => shellTier() === "phone"

/** `TAP_TARGET` on the phone, nothing on wider tiers (their density stays). */
export const phoneTap = (): string => (isPhone() ? TAP_TARGET : "")
