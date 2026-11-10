// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GUARD: a person decides their own request. A gated kernel tool a member may call (no admin
// scope among its required scopes) but only `kernel:approve` may decide used to send a person's
// own request (their own routine, their own connection, a skill hidden for themselves) to the
// org's admins. Every such tool must either route the requester's own requests to the requester
// (an `approvalResourceOwnerRegistry` entry: personal resources are decided by their owner) or be
// listed below as admin-decided on purpose, with the reason.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { decidingScopeForToolDef } from "~/modules/approvals/authority"
import {
  approvalResourceOwnerRegistry,
  initializedOrgRuntimes,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createTestOrg } from "~/tests/helpers/org"

/** Member-callable kernel tools that stay decided by `kernel:approve`, and why. */
const ADMIN_DECIDED: Record<string, string> = {
  config_knowledge: "org-wide configuration: the organization's knowledge collections",
  config_invoicing: "org-wide configuration: the organization's issuers, tax regimes, e-invoicing",
}

/** An admin-grade required scope: the caller already needs admin authority to ask. */
const isAdminScope = (scope: string): boolean =>
  scope === "*" || scope === "kernel" || scope.endsWith(":admin")

describe("member-callable kernel tools decided by kernel:approve", () => {
  let orgId: string

  beforeAll(async () => {
    orgId = (await createTestOrg()).id
    await ensureAppsForOrg(orgId)
  })

  afterAll(() => {
    initializedOrgRuntimes.delete(orgId)
  })

  it("route the requester's own request to the requester, or are listed as admin-decided", () => {
    const offenders: string[] = []
    let checked = 0
    for (const [[, app, name], tool] of toolRegistry.entriesOf(orgId)) {
      if (app !== "kernel" || tool.gated !== true) continue
      if (decidingScopeForToolDef(tool, "kernel") !== "kernel:approve") continue
      const required = tool.requiredScopes ?? []
      if (required.some(isAdminScope)) continue
      checked++
      if (approvalResourceOwnerRegistry.get([orgId, "kernel", name])) continue
      if (ADMIN_DECIDED[name]) continue
      offenders.push(`${name} (requires ${required.join(", ") || "nothing"})`)
    }
    expect(checked).toBeGreaterThan(0)
    expect(offenders).toEqual([])
  })
})
