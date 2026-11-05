// SPDX-License-Identifier: FSL-1.1-ALv2
// Bring one section of an app settings page into view: `?section=<id>` on the
// page's URL on arrival, or a link on the page itself (Mail's "Open Mail
// Setup" pointing at the Gmail switch a few sections below). The section
// scrolls to the top and its first control takes focus, so the click visibly
// lands somewhere even when the page was already open.

/** The DOM id of a section of an app settings page. */
export function settingsSectionElementId(app: string, sectionId: string): string {
  return `settings-section-${app}-${sectionId}`
}

/** The URL of an app settings page opened on one of its sections. */
export function settingsSectionHref(app: string, sectionId: string): string {
  return `/settings/apps/${app}?section=${encodeURIComponent(sectionId)}`
}

/** Scroll the section into view and focus its first control; false when it is not on screen. */
export function revealSettingsSection(app: string, sectionId: string): boolean {
  const el = document.getElementById(settingsSectionElementId(app, sectionId))
  if (!el) return false
  el.scrollIntoView?.({ block: "start", behavior: "smooth" })
  const control = el.querySelector<HTMLElement>(
    "[data-testid^='settings-input-']:not([disabled]), button:not([disabled]), input:not([disabled])",
  )
  ;(control ?? el).focus({ preventScroll: true })
  return true
}
