// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSignal } from "solid-js"

// Backs the tablet tier's icon-rail-vs-overlay-drawer toggle. Deliberately not
// persisted: the drawer is a transient overlay, so a reload starts from the
// rail, matching the panel store's own non-persisted open state.
const [tabletSidebarOpen, setTabletSidebarOpen] = createSignal(false)

export { tabletSidebarOpen }

export function toggleTabletSidebar(): void {
  setTabletSidebarOpen((open) => !open)
}

// Called when a sidebar entry is activated, so picking a thread on a tablet
// drops the drawer back to the rail instead of leaving it over the content.
export function closeTabletSidebar(): void {
  setTabletSidebarOpen(false)
}
