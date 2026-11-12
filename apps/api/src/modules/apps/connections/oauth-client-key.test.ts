// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * OAuth client resolution for an app that carries no resolver code: the
 * manifest names the key (`connections.<name>.oauthClient.key`), and the kernel
 * resolves the client under it, the org's stored client first, then the
 * instance's from the `LIAISON_OAUTH_<KEY>_CLIENT_ID/_SECRET` convention.
 *
 * Fixture: `pagefx`, two oauth2 connections naming one key `pagefx:shared`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { PAGE_FX_APP, pageFixtureApp } from "~/modules/apps/__fixtures__/page-app/descriptor"
import {
  instanceClientEnvNames,
  instanceOAuthClient,
  oauthClientKey,
} from "~/modules/apps/connections/oauth-client"
import { resolveOAuthClientConfig } from "~/modules/apps/connections/oauth-client-config"
import { upsertConnectionOAuthClient } from "~/modules/apps/connections/oauth-client-provisioning"
import { validateAppManifest } from "~/modules/apps/contract"
import { registerApps } from "~/modules/apps/runtime"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const NAMES = instanceClientEnvNames("pagefx:shared")!

describe("manifest-declared OAuth client key", () => {
  let orgId: string

  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    await registerApps([pageFixtureApp], orgId)
  }, 120_000)

  afterAll(async () => {
    delete process.env[NAMES.id]
    delete process.env[NAMES.secret]
    await releaseTestLock()
  })

  test("the convention names, and the key of both connections", () => {
    expect(NAMES).toEqual({
      id: "LIAISON_OAUTH_PAGEFX__SHARED_CLIENT_ID",
      secret: "LIAISON_OAUTH_PAGEFX__SHARED_CLIENT_SECRET",
    })
    expect(oauthClientKey(orgId, PAGE_FX_APP, "primary")).toBe("pagefx:shared")
    expect(oauthClientKey(orgId, PAGE_FX_APP, "secondary")).toBe("pagefx:shared")
    // Undeclared: the default key.
    expect(oauthClientKey(orgId, PAGE_FX_APP, "other")).toBe("pagefx:other")
  })

  test("two apps whose keys differ only in where the `:` sits read different pairs", () => {
    const short = instanceClientEnvNames("api:connector-crm")
    const long = instanceClientEnvNames("api-connector:crm")
    expect(short?.id).toBe("LIAISON_OAUTH_API__CONNECTOR_CRM_CLIENT_ID")
    expect(long?.id).toBe("LIAISON_OAUTH_API_CONNECTOR__CRM_CLIENT_ID")
    expect(short?.id).not.toBe(long?.id)
    // A key the one-to-one mapping cannot carry has no convention pair at all.
    for (const key of ["api-:crm", "api:-crm", "api--x:crm", "api:crm__x", "Api:crm", "a:b:c"]) {
      expect({ key, names: instanceClientEnvNames(key) }).toEqual({ key, names: null })
    }
    process.env.LIAISON_OAUTH_API__CONNECTOR_CRM_CLIENT_ID = "id-short"
    process.env.LIAISON_OAUTH_API__CONNECTOR_CRM_CLIENT_SECRET = "secret-short"
    try {
      expect(instanceOAuthClient("api-connector:crm")).toBeNull()
      expect(instanceOAuthClient("api:connector-crm")?.clientId).toBe("id-short")
    } finally {
      delete process.env.LIAISON_OAUTH_API__CONNECTOR_CRM_CLIENT_ID
      delete process.env.LIAISON_OAUTH_API__CONNECTOR_CRM_CLIENT_SECRET
    }
  })

  test("a key outside the app's own namespace is refused by the manifest validator", () => {
    const { _format, _bundlePath, ...manifest } = pageFixtureApp
    const bad = {
      ...manifest,
      connections: {
        primary: { ...manifest.connections.primary, oauthClient: { key: "google-drive:drive" } },
      },
    }
    const r = validateAppManifest(bad)
    expect(r.success).toBe(false)
    expect(String((r as { error?: string }).error)).toContain("app's own namespace")
    expect(validateAppManifest(manifest).success).toBe(true)
  })

  test("the instance's client from the convention pair, for every connection naming the key", async () => {
    expect(instanceOAuthClient("pagefx:shared", {})).toBeNull()
    process.env[NAMES.id] = "instance-id"
    process.env[NAMES.secret] = "instance-secret"
    for (const connectionName of ["primary", "secondary"]) {
      expect(
        await resolveOAuthClientConfig({ orgId, appName: PAGE_FX_APP, connectionName }),
      ).toEqual({ clientId: "instance-id", clientSecret: "instance-secret", source: "deployment" })
    }
  })

  test("the org's own client, stored once under the key, wins for both connections", async () => {
    await upsertConnectionOAuthClient({
      orgId,
      appName: PAGE_FX_APP,
      connectionName: "primary",
      clientId: "org-id",
      clientSecret: "org-secret",
    })
    expect(
      await resolveOAuthClientConfig({ orgId, appName: PAGE_FX_APP, connectionName: "secondary" }),
    ).toEqual({ clientId: "org-id", clientSecret: "org-secret", source: "org" })
  })
})
