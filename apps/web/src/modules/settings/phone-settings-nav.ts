// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which settings screen the phone is on (M2-3 T18).
//
// At phone width the settings tab is a PUSH stack: the You screen is the root
// and a section is pushed over it. The URL cannot carry that on its own,
// because the Profile section's href IS the settings root (`/settings`), so
// "at the root" and "looking at Profile" are the same pathname. This signal is
// the missing bit, and it lives outside the component so the You screen, the
// back control and SettingsLayout all read the same one.
//
// Desktop never reads it: there the sidebar column is always present and every
// section is one click away.
import { createSignal } from "solid-js"

const [pushedSection, setPushedSection] = createSignal<string | null>(null)

export { pushedSection }

/** Push a registered section's href over the You screen. */
export function pushSettingsSection(href: string): void {
  setPushedSection(href)
}

/** Back to the You screen. */
export function popSettingsSection(): void {
  setPushedSection(null)
}

/** Test and session-teardown hook: the stack starts at the root. */
export function resetPhoneSettingsNav(): void {
  setPushedSection(null)
}
