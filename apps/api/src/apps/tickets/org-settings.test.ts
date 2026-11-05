// SPDX-License-Identifier: FSL-1.1-ALv2
// PATCH /api/org takes only the organization's own settings. Tickets settings
// are written one field at a time through /api/apps/tickets/settings/org,
// under each section's scope (org routes.test.ts covers the route).
import { describe, expect, it } from "bun:test"
import { updateOrgSchema } from "@liaison/shared"

describe("tickets.org-settings: the org PATCH schema", () => {
  it("rejects unknown top-level fields under settings (strict)", () => {
    const result = updateOrgSchema.safeParse({
      settings: { madeUpField: 1 },
    } as any)
    expect(result.success).toBe(false)
  })

  it("rejects settings.tickets: the Tickets settings page writes through the app settings route", () => {
    const result = updateOrgSchema.safeParse({
      settings: { tickets: { emailTemplate: { headerName: "Acme Support" } } },
    } as any)
    expect(result.success).toBe(false)
  })
})
