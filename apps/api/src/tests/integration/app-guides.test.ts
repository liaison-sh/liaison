// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { handleSkillRead } from "~/modules/agent/tools/skills-routines-tools"
import { registerApps } from "~/modules/apps/runtime"
import { createTestOrg } from "~/tests/helpers/org"

// createTestOrg → bootstrapRegister → ensureAppsForOrg registers the in-tree
// apps (mail, knowledge). The three bundled apps (boxtal/shopify/invoicing)
// install via test routes per-test, so here we register them from source (the
// load-from-source side channel) so their guide skills land in skillRegistry.
// We read each guide via skill_read with admin scopes so requiredScopes never
// filter.

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")

function bundledDescriptor(name: string): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", name, "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  const version = (manifest.version as string) ?? "0.1.0"
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    // Synthetic installed path → the bundle-loader maps it back to
    // bundled-apps/<name>/handlers.ts (LIAISON_BUNDLED_APPS_FROM_SOURCE).
    _bundlePath: join(REPO_ROOT, "bundled-apps", name, version, "bundle.js"),
  }
}

let orgId: string
let userId: string

const guideNames: Array<[string, string]> = [
  ["boxtal", "boxtal-overview"],
  ["shopify", "shopify-overview"],
  ["invoicing", "invoicing-overview"],
  ["mail", "mail-overview"],
  ["knowledge", "knowledge-overview"],
]

describe("app guides (A11)", () => {
  beforeAll(async () => {
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    const org = await createTestOrg()
    orgId = org.id
    userId = await withSystemDb("app-guides-user", async (db) => {
      const [u] = await db
        .insert(users)
        .values({
          orgId,
          email: `g-${crypto.randomUUID()}@t.co`,
          passwordHash: "x",
          name: "Guide Reader",
          status: "active",
        })
        .returning({ id: users.id })
      return u.id
    })
    // Register the three bundled apps from source so their guides are seeded.
    await registerApps(
      [
        bundledDescriptor("boxtal"),
        bundledDescriptor("shopify"),
        bundledDescriptor("invoicing"),
      ] as never,
      orgId,
    )
  })

  for (const [app, skill] of guideNames) {
    test(`${app} ships a non-placeholder guide readable via skill_read`, async () => {
      const res = await handleSkillRead({ name: skill }, { orgId, userId, scopes: ["*"] })
      expect("body" in res).toBe(true)
      const body = (res as { body: string }).body
      expect(body.length).toBeGreaterThan(120)
      expect(body.toLowerCase()).toMatch(/routine|knowledge|liaison|agent/)
    })
  }
})
