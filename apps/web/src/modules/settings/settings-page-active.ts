// SPDX-License-Identifier: FSL-1.1-ALv2
// Each settings page is mounted on first visit and then kept (hidden) while
// another page shows, so a page cannot tell from mounting when it is looked
// at again. `useSettingsPageActive` says whether the page that reads it is the
// one on screen, in a settings tab that is itself the active tab: a page
// refetches when it turns true (settings overhaul A9). The settings layout
// provides the per-page half; outside it only the tab counts.
//
// Its own module so a page can read it without pulling the layout in.
import { type Accessor, createContext, useContext } from "solid-js"
import { useTabIsActive } from "~/modules/shell/TabVisibilityContext"

export const SettingsPageActiveContext = createContext<Accessor<boolean>>()

/** True while the calling settings page is the one shown (see above). */
export function useSettingsPageActive(): Accessor<boolean> {
  const page = useContext(SettingsPageActiveContext)
  const tab = useTabIsActive()
  return () => tab() && (page ? page() : true)
}
