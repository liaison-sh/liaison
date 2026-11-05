// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S19 / A6: an app turned Off (or removed) for the workspace has none of its
// tools in any agent tool set for that org, and a restricted app is not
// "lockable" for a person it is restricted away from (A12). One reader
// (`org-apps.ts`) answers; these tests pin the tool-bridge surfaces that read it.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { z } from "zod"
import type { ActorContext } from "~/db/rls"
import { toolRegistry } from "~/modules/apps/app-registries"
import { forgetOrgApps, rememberOrgAppStates } from "~/modules/apps/org-apps"
import {
  ALL_DEFERRED_TOOLS_UNLOCKED,
  buildToolSet,
  listDeferredTools,
  listGatewayTools,
  listLockedCapabilities,
} from "./tool-bridge"

const ORG_ID = "11111111-1111-1111-1111-aaaaaaaa0a28"

const ADMIN: ActorContext = {
  actorType: "user",
  userId: "22222222-2222-2222-2222-bbbbbbbb0a28",
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

const NO_INVOICING: ActorContext = { ...ADMIN, scopes: ["kernel:threads:read"] }

function plant(app: string, tool: string, deferLoading: boolean, scope: string) {
  toolRegistry.set([ORG_ID, app, tool], {
    appName: app,
    name: tool,
    description: `${app} ${tool}`,
    requiredScopes: [scope],
    deferLoading,
    params: z.object({}),
    handler: async () => ({ ok: true }),
  } as unknown as Parameters<typeof toolRegistry.set>[1])
}

describe("Off apps: tool-bridge surfaces", () => {
  beforeEach(() => {
    plant("invoicing", "documents_search", true, "invoicing:documents:read")
    plant("invoicing", "drafts_create", false, "invoicing:documents:write")
    plant("kernel", "threads_list", false, "kernel:threads:read")
    rememberOrgAppStates(ORG_ID, [])
  })
  afterEach(() => {
    toolRegistry.deleteByPrefix([ORG_ID])
    forgetOrgApps(ORG_ID)
  })

  it("discriminator: the invoicing tools are in the tool set while the app is On", () => {
    const names = Object.keys(buildToolSet(ORG_ID, ADMIN, undefined, ALL_DEFERRED_TOOLS_UNLOCKED))
    expect(names).toContain("invoicing__documents_search")
    expect(names).toContain("invoicing__drafts_create")
  })

  it("buildToolSet (agent) drops every tool of an Off app and keeps the rest", () => {
    rememberOrgAppStates(ORG_ID, [{ app: "invoicing", status: "disabled" }])
    const names = Object.keys(buildToolSet(ORG_ID, ADMIN, undefined, ALL_DEFERRED_TOOLS_UNLOCKED))
    expect(names.filter((n) => n.startsWith("invoicing__"))).toEqual([])
    expect(names).toContain("kernel__threads_list")
  })

  it("buildToolSet (gateway) drops every tool of an Off app", () => {
    rememberOrgAppStates(ORG_ID, [{ app: "invoicing", status: "disabled" }])
    const names = Object.keys(buildToolSet(ORG_ID, ADMIN, undefined, undefined, "gateway"))
    expect(names.filter((n) => n.startsWith("invoicing__"))).toEqual([])
    expect(names).toContain("kernel__threads_list")
  })

  it("listDeferredTools and listGatewayTools omit an Off app", () => {
    expect(listDeferredTools(ORG_ID, ADMIN).map((t) => t.appName)).toContain("invoicing")
    rememberOrgAppStates(ORG_ID, [{ app: "invoicing", status: "disabled" }])
    expect(listDeferredTools(ORG_ID, ADMIN).map((t) => t.appName)).not.toContain("invoicing")
    expect(
      listDeferredTools(ORG_ID, NO_INVOICING, "agent", true).map((t) => t.appName),
    ).not.toContain("invoicing")
    expect(listGatewayTools(ORG_ID, ADMIN).map((t) => t.appName)).not.toContain("invoicing")
  })

  it("list_locked_capabilities does not advertise an Off app's tools", () => {
    expect(listLockedCapabilities(NO_INVOICING.scopes ?? [], ORG_ID).map((t) => t.app)).toContain(
      "invoicing",
    )
    rememberOrgAppStates(ORG_ID, [{ app: "invoicing", status: "disabled" }])
    expect(
      listLockedCapabilities(NO_INVOICING.scopes ?? [], ORG_ID).map((t) => t.app),
    ).not.toContain("invoicing")
  })

  it("turning it back On restores the tools (nothing was deleted)", () => {
    rememberOrgAppStates(ORG_ID, [{ app: "invoicing", status: "disabled" }])
    rememberOrgAppStates(ORG_ID, [])
    const names = Object.keys(buildToolSet(ORG_ID, ADMIN, undefined, ALL_DEFERRED_TOOLS_UNLOCKED))
    expect(names).toContain("invoicing__documents_search")
  })

  it("kernel is never Off", () => {
    rememberOrgAppStates(ORG_ID, [{ app: "kernel", status: "disabled" }])
    const names = Object.keys(buildToolSet(ORG_ID, ADMIN, undefined, ALL_DEFERRED_TOOLS_UNLOCKED))
    expect(names).toContain("kernel__threads_list")
  })

  it("a removed app is gated exactly like an Off one", () => {
    rememberOrgAppStates(ORG_ID, [{ app: "invoicing", status: "removed" }])
    const names = Object.keys(buildToolSet(ORG_ID, ADMIN, undefined, ALL_DEFERRED_TOOLS_UNLOCKED))
    expect(names.filter((n) => n.startsWith("invoicing__"))).toEqual([])
  })

  it("list_locked_capabilities does not advertise a restricted app to a person it is restricted away from", () => {
    const listed = "33333333-3333-3333-3333-cccccccc0a28"
    rememberOrgAppStates(ORG_ID, [
      {
        app: "invoicing",
        status: "active",
        accessMode: "restricted",
        allowedUserIds: new Set([listed]),
      },
    ])
    expect(
      listLockedCapabilities(NO_INVOICING.scopes ?? [], ORG_ID, ADMIN.userId).map((t) => t.app),
    ).not.toContain("invoicing")
    expect(
      listLockedCapabilities(NO_INVOICING.scopes ?? [], ORG_ID, listed).map((t) => t.app),
    ).toContain("invoicing")
  })
})
