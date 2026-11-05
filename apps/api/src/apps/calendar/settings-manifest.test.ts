// SPDX-License-Identifier: FSL-1.1-ALv2
// Calendar's settings page (settings overhaul P2 T8): ONE declarative page with
// a connections block (connect, share, disconnect) and the CalendarChoices
// block (which calendars are imported, retry of a failed import), no
// views.settings, and a dimension manageHref that lands on that page (the old
// /settings/calendar/accounts matched no page at all).
import { describe, expect, it } from "bun:test"
import calendarManifest from "~/apps/calendar/app.manifest.json"
import { validateAppManifest } from "~/modules/apps/contract"

describe("calendar settings manifest", () => {
  const m = calendarManifest as unknown as {
    kind?: string
    settings: { sections: Array<{ id: string; scope: string; blocks: any[] }> }
    views: Record<string, unknown>
    schema: Record<string, { dimensions?: Record<string, { manageHref?: string }> }>
  }

  it("declares one page: a connections block and the CalendarChoices block", () => {
    expect(validateAppManifest(calendarManifest).success).toBe(true)
    expect(m.kind).toBe("app")
    expect(m.views.settings).toBeUndefined()
    expect(m.settings.sections).toHaveLength(1)
    expect(m.settings.sections[0].scope).toBe("user")
    expect(m.settings.sections[0].blocks.map((b) => b.block)).toEqual(["connections", "custom"])
    expect(m.settings.sections[0].blocks[1].component).toBe("CalendarChoices")
  })

  it("every manageHref points at the calendar settings page", () => {
    const hrefs = Object.values(m.schema).flatMap((t) =>
      Object.values(t.dimensions ?? {}).flatMap((d) => (d.manageHref ? [d.manageHref] : [])),
    )
    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs) expect(href).toBe("/settings/apps/calendar")
  })
})
