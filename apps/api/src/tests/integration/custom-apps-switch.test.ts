// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The instance switch for organisations' own apps (LIAISON_CUSTOM_APPS,
// lib/edition.ts customAppsEnabled): default on in the managed edition, off on
// a self-hosted server. Off, an org admin's URL install and namespace answer
// 404, the app builder's routes answer 404, its tools are not in the catalog,
// a builder install is refused, and the branding flags carry no `customApps`
// (so the web hides the builder). Instance installs by the operator are not
// gated here.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { _setEdition, customAppsEnabled } from "~/lib/edition"
import { env } from "~/lib/env"
import { APP_BUILDER_TOOL_NAMES, registerAppBuilderTools } from "~/modules/app-builder/tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { installAppFromBytes } from "~/modules/apps/install-service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const saved = env.LIAISON_CUSTOM_APPS
let orgId = ""
let adminId = ""
let bearer = ""

const get = (path: string) => app.request(path, { headers: { authorization: `Bearer ${bearer}` } })
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })

async function flags(): Promise<Record<string, boolean>> {
  const res = await app.request("/api/settings/branding")
  return ((await res.json()) as { data: { flags: Record<string, boolean> } }).data.flags
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  adminId = (await minimal.orgAdmin(orgId)).id
  bearer = await minimal.token(adminId)
}, 60_000)

afterAll(async () => {
  env.LIAISON_CUSTOM_APPS = saved
  _setEdition(null)
  await releaseTestLock()
})

describe("LIAISON_CUSTOM_APPS", () => {
  it("defaults on in the managed edition and off on a self-hosted server; on/off win", () => {
    env.LIAISON_CUSTOM_APPS = undefined
    _setEdition("self_hosted")
    expect(customAppsEnabled()).toBe(false)
    _setEdition("managed")
    expect(customAppsEnabled()).toBe(true)
    env.LIAISON_CUSTOM_APPS = "off"
    expect(customAppsEnabled()).toBe(false)
    _setEdition("self_hosted")
    env.LIAISON_CUSTOM_APPS = "on"
    expect(customAppsEnabled()).toBe(true)
    _setEdition(null)
  })

  it("off: custom install, namespace and the builder answer 404; no builder tool; no flag", async () => {
    env.LIAISON_CUSTOM_APPS = "off"
    expect((await get("/api/apps/custom/namespace")).status).toBe(404)
    expect(
      (await post("/api/apps/custom/install", { url: "https://example.com/x.liaisonapp" })).status,
    ).toBe(404)
    expect((await get("/api/apps/builder/drafts")).status).toBe(404)
    expect(
      (await post("/api/apps/builder/drafts/00000000-0000-4000-8000-000000000000/check", {}))
        .status,
    ).toBe(404)
    registerAppBuilderTools(orgId)
    for (const name of APP_BUILDER_TOOL_NAMES) {
      expect(toolRegistry.get([orgId, "kernel", name])).toBeUndefined()
    }
    expect(
      await installAppFromBytes({
        bytes: new Uint8Array([1]),
        ownerOrgId: orgId,
        installedBy: adminId,
        grantedScopes: [],
        grantedConnections: [],
        grantedCapabilities: [],
        grantedCrossAppCalls: [],
        sourceUrl: "builder:draft/x/1",
      }).then(
        () => "installed",
        (err: { status?: number }) => err.status,
      ),
    ).toBe(404)
    expect((await flags()).customApps).toBeUndefined()
  })

  it("on: the routes answer, the tools are registered and the flag is set", async () => {
    env.LIAISON_CUSTOM_APPS = "on"
    expect((await get("/api/apps/custom/namespace")).status).toBe(200)
    expect((await get("/api/apps/builder/drafts")).status).toBe(200)
    registerAppBuilderTools(orgId)
    for (const name of APP_BUILDER_TOOL_NAMES) {
      expect(toolRegistry.get([orgId, "kernel", name])).toBeDefined()
    }
    expect((await flags()).customApps).toBe(true)
  })
})
