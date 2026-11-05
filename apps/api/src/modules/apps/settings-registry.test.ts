// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Declarative settings at runtime (settings-overhaul P2 T2, A19, A22): a
 * registered app's `kind`, `settings` and listing fields reach the web through
 * GET /api/apps/manifests, the registry holds a validator per field built from
 * the manifest JSON (so installed and bundled apps qualify, not only TS
 * descriptors), and a section's adminScope joins the scope universe.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { settingsFixtureApp } from "~/modules/apps/__fixtures__/settings-app/descriptor"
import { appSettingsRegistry, manifestRegistry } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { signAccessToken } from "~/modules/auth/jwt"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { getScopeCatalog, invalidateScopeCatalog } from "~/modules/permissions/scope-catalog"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

async function mintToken(userId: string): Promise<string> {
  const [row] = await withSystemDb("settings-registry-mint", (db) =>
    db
      .select({
        orgId: users.orgId,
        name: users.name,
        authVersion: users.authVersion,
        permissionVersion: users.permissionVersion,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  )
  if (!row) throw new Error(`mintToken: user ${userId} missing`)
  const perms = await withPrivilegedDb(row.orgId, "settings-registry-perms", (tx) =>
    loadEffectivePermissions(tx, userId, row.orgId),
  )
  return signAccessToken(
    {
      userId,
      orgId: row.orgId,
      name: row.name,
      authVersion: row.authVersion,
      permissionVersion: row.permissionVersion,
      roles: perms.roles,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    env.JWT_SECRET,
    60 * 60,
  )
}

interface ManifestEntry {
  name: string
  manifest: {
    kind?: string
    settings?: { sections: Array<{ id: string; scope: string; adminScope?: string }> }
    description?: string
    displayName?: string
    version?: string
    license?: string
    author?: string
  }
}

describe("declarative settings registration", () => {
  let orgId: string
  let adminToken: string

  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    await registerApps([settingsFixtureApp], orgId)
    invalidateScopeCatalog(orgId)
    adminToken = await mintToken((await minimal.person(orgId, { role: "admin" })).id)
  }, 180_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  test("GET /api/apps/manifests carries kind, settings and the listing fields", async () => {
    const res = await app.request("/api/apps/manifests", {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: ManifestEntry[] }
    const fx = data.find((a) => a.name === "settingsfx")
    expect(fx).toBeDefined()
    expect(fx?.manifest.kind).toBe("app")
    expect(fx?.manifest.description).toBe("Declarative settings fixture")
    expect(fx?.manifest.displayName).toBe("Settings fixture")
    expect(fx?.manifest.version).toBe("1.0.0")
    expect(fx?.manifest.license).toBe("MIT")
    // The page header's publisher line reads the store listing.
    expect(fx?.manifest.author).toBe("Fixture Works")
    const sections = fx?.manifest.settings?.sections ?? []
    expect(sections.map((s) => s.id)).toEqual(["prefs", "limits", "general", "remote", "address"])
    // An org section without its own adminScope carries the default, so the
    // web shows it to exactly the people the API lets write it.
    expect(sections.find((s) => s.id === "general")?.adminScope).toBe("kernel:apps:admin")
    expect(sections.find((s) => s.id === "limits")?.adminScope).toBe("settingsfx:limits:admin")
    expect(sections.find((s) => s.id === "prefs")?.adminScope).toBeUndefined()

    // An app without a settings page reports kind "app" and no settings.
    const contacts = data.find((a) => a.name === "contacts")
    expect(contacts?.manifest.kind).toBe("app")
    expect(contacts?.manifest.settings).toBeUndefined()
  })

  test("the registry validates each field with the type the manifest declares", () => {
    const reg = appSettingsRegistry.get([orgId, "settingsfx"])
    const fields = reg?.manifestSettings?.fields
    expect(fields).toBeDefined()
    const max = fields?.org.get("limits.max")
    expect(max?.adminScope).toBe("settingsfx:limits:admin")
    expect(max?.validator.safeParse(5).success).toBe(true)
    expect(max?.validator.safeParse("five").success).toBe(false)
    expect(max?.validator.safeParse(500).success).toBe(false)
    expect(fields?.org.get("greeting")?.adminScope).toBe("kernel:apps:admin")
    expect(fields?.user.get("signature.text")?.adminScope).toBeNull()
    // The namespace schemas the sandbox bridge reads are derived from the same fields.
    expect(reg?.orgSchema?.safeParse({ limits: { max: "five" } }).success).toBe(false)
    expect(reg?.orgSchema?.safeParse({ limits: { max: 5 }, other: "kept" }).success).toBe(true)
    expect(reg?.userDefaults).toEqual({ digest: { enabled: true } })
  })

  test("a section adminScope joins the org's scope catalog", () => {
    // A scope named ONLY by a settings section (no tool or role declares it).
    manifestRegistry.set([orgId, "probesettings"], {
      name: "probesettings",
      uiBundleUrl: null,
      settings: {
        sections: [
          {
            id: "only",
            title: "Only",
            scope: "org",
            adminScope: "probesettings:only:admin",
            blocks: [{ block: "field", key: "x", type: "text", label: "X" }],
          },
        ],
      },
    })
    invalidateScopeCatalog(orgId)
    try {
      const scopes = getScopeCatalog(orgId).map((e) => e.scope)
      expect(scopes).toContain("probesettings:only:admin")
    } finally {
      manifestRegistry.delete([orgId, "probesettings"])
      invalidateScopeCatalog(orgId)
    }
  })
})
