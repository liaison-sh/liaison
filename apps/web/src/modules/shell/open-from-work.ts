// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A screen opened from the phone's Work list comes back to it: "< Work" in the
// phone bar, and the edge swipe, as You > Agents comes back to You. Without it
// a module root (Help, Projects, ...) had no back control at all, and only a
// second tap on the Work tab returned.
import { openDetailFrom } from "~/primitives/createPushNav"

/** Open a screen (`open` opens its tab) so Back returns to the Work list. */
export function openFromWork(t: (key: string) => string, open: () => void): void {
  openDetailFrom({ label: t("kernel.phoneTabWork"), returnTo: "/work" }, open)
}
