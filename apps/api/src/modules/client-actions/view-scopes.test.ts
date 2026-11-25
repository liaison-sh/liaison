// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The scopes one read of a target runs with: the sender's own and, for a view tool that asks for
// its app's internal scope, that one scope. A view tool that asks for anything else a role can
// carry gets nothing from the kernel.
import { afterAll, describe, expect, it } from "bun:test"
import { toolRegistry } from "~/modules/apps/app-registries"
import { viewScopes } from "./targets"

const ORG = "00000000-0000-4000-8000-00000000d0f3"
const APP = "viewscopes"
const target = { app: APP, viewTool: "view_get" }
const withTool = (requiredScopes: string[]) =>
  toolRegistry.set([ORG, APP, "view_get"], {
    appName: APP,
    name: "view_get",
    requiredScopes,
  } as never)

afterAll(() => {
  toolRegistry.delete([ORG, APP, "view_get"])
})

describe("the scopes a target's read runs with", () => {
  const own = [`${APP}:docs:write`]

  it("adds the app's internal scope only when its view tool asks for it", () => {
    withTool([`${APP}:internal`])
    expect(viewScopes(target, ORG, own)).toEqual([...own, `${APP}:internal`])
    expect(viewScopes(target, ORG, [`${APP}:internal`])).toEqual([`${APP}:internal`])
  })

  it("adds nothing a role can carry, nothing of another app, and nothing for a tool not there", () => {
    withTool([`${APP}:docs:read`])
    expect(viewScopes(target, ORG, own)).toEqual(own)
    withTool(["otherapp:internal", `${APP}:docs:admin`])
    expect(viewScopes(target, ORG, own)).toEqual(own)
    toolRegistry.delete([ORG, APP, "view_get"])
    expect(viewScopes(target, ORG, own)).toEqual(own)
  })
})
