// SPDX-License-Identifier: FSL-1.1-ALv2
// [Task 9] tickets:accounts:admin role bundle alignment.
import { describe, expect, it } from "bun:test"
import ticketsManifest from "~/apps/tickets/app.manifest.json"

describe("tickets.role-bundles.scope-alignment", () => {
  it("support_lead and admin bundles include tickets:accounts:admin", () => {
    const roles = (ticketsManifest as any).roles
    expect(roles.support_lead.scopes).toContain("tickets:accounts:admin")
    expect(roles.admin.scopes).toContain("tickets:accounts:admin")
  })

  it("support bundle does NOT include tickets:accounts:admin", () => {
    const roles = (ticketsManifest as any).roles
    expect(roles.support.scopes).not.toContain("tickets:accounts:admin")
  })
})
