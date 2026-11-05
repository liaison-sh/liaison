// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { isManifestHandler, resetAppRegistries, toolRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg, installedAppDescriptor } from "~/modules/apps/init"

const TEST_ORG = "00000000-0000-0000-0000-00000015b001"

// Seeding lives inside the `it` (not beforeAll) so the test self-bootstraps
// when run via `bun test -t "<test-name>"` — Bun's `-t` filter does NOT
// invoke the enclosing describe's beforeAll for a matched inner test, which
// would otherwise leave the org/user fixture absent and ensureAppsForOrg
// silently failing its registrations (tool registry stays empty).
describe("ensureAppsForOrg — manifest startup path", () => {
  afterAll(async () => {
    resetAppRegistries()
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_test" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE org_id = ${TEST_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${TEST_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
  })

  it("loads the test app via manifest format through ensureAppsForOrg", async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG}, 'Startup Test Org', 'startup-test')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES ('00000000-0000-0000-0000-00000015b002', ${TEST_ORG}, 'startup@test.com', 'hash', 'Startup', 'active')
      ON CONFLICT (id) DO NOTHING`

    await ensureAppsForOrg(TEST_ORG)

    const tool = toolRegistry.get([TEST_ORG, "test", "listItems"])
    expect(tool).toBeDefined()
    expect(isManifestHandler(tool!.handler)).toBe(true)
  })
})

describe("installedAppDescriptor — uiBundlePath plumbing", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "installed-desc-test-"))
  })

  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  function manifestPathOf(payload: Record<string, unknown>): string {
    const p = join(tmp, `${payload.name as string}.manifest.json`)
    writeFileSync(p, JSON.stringify(payload))
    return p
  }

  it("attaches _uiBundlePath when the discovered app has one", () => {
    const desc = installedAppDescriptor({
      name: "x",
      version: "1.0.0",
      manifestPath: manifestPathOf({
        name: "x",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: [],
      }),
      bundlePath: "/fake/bundle.js",
      uiBundlePath: "/fake/ui.js",
      source: "installed",
    })
    // biome-ignore lint/suspicious/noExplicitAny: descriptor metadata fields are intentionally untyped
    expect((desc as any)._uiBundlePath).toBe("/fake/ui.js")
  })

  it("omits _uiBundlePath when the discovered app does not have one", () => {
    const desc = installedAppDescriptor({
      name: "y",
      version: "1.0.0",
      manifestPath: manifestPathOf({
        name: "y",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: [],
      }),
      bundlePath: "/fake/bundle.js",
      source: "installed",
    })
    // biome-ignore lint/suspicious/noExplicitAny: descriptor metadata fields are intentionally untyped
    expect((desc as any)._uiBundlePath).toBeUndefined()
  })
})
