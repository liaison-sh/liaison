// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"

const SYSTEM_USER = "00000000-0000-0000-0000-000000000000"

describe("apps_installed table", () => {
  it("inserts an installed app row with required fields", async () => {
    await withSystemDb("apps-installed-insert", (db) =>
      db.insert(appsInstalled).values({
        name: "test-shopify-stub",
        version: "0.1.0",
        sourceUrl: "https://example.com/test-shopify-stub-0.1.0.liaisonapp",
        sha256: "a".repeat(64),
        grantedScopes: ["test-shopify-stub:orders:read"],
        installedBy: SYSTEM_USER,
      }),
    )
    const rows = await withSystemDb("apps-installed-select", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, "test-shopify-stub")),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].version).toBe("0.1.0")
    expect(rows[0].grantedScopes).toEqual(["test-shopify-stub:orders:read"])
    // Column defaults: an install-only app (no updateUrl) and no connections.
    expect(rows[0].grantedConnections).toEqual([])
    expect(rows[0].updateUrl).toBeNull()
    await withSystemDb("apps-installed-cleanup", (db) =>
      db.delete(appsInstalled).where(eq(appsInstalled.name, "test-shopify-stub")),
    )
  })

  it("allows multiple versions of the same app to coexist (composite PK = name,version)", async () => {
    await withSystemDb("apps-installed-v1", (db) =>
      db.insert(appsInstalled).values({
        name: "test-multi",
        version: "1.0.0",
        sourceUrl: "x",
        sha256: "a".repeat(64),
        grantedScopes: [],
        installedBy: SYSTEM_USER,
      }),
    )
    // Second version of the same app — accepted (enables atomic upgrade swap).
    await withSystemDb("apps-installed-v2", (db) =>
      db.insert(appsInstalled).values({
        name: "test-multi",
        version: "2.0.0",
        sourceUrl: "y",
        sha256: "b".repeat(64),
        grantedScopes: [],
        installedBy: SYSTEM_USER,
      }),
    )
    const rows = await withSystemDb("apps-installed-multi-select", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, "test-multi")),
    )
    expect(rows).toHaveLength(2)

    // Duplicate (name, version) is rejected by the composite primary key.
    // Run in its own transaction — a constraint violation poisons the txn.
    await expect(
      withSystemDb("apps-installed-dup", (db) =>
        db.insert(appsInstalled).values({
          name: "test-multi",
          version: "1.0.0",
          sourceUrl: "z",
          sha256: "c".repeat(64),
          grantedScopes: [],
          installedBy: SYSTEM_USER,
        }),
      ),
    ).rejects.toThrow()

    await withSystemDb("apps-installed-multi-cleanup", (db) =>
      db.delete(appsInstalled).where(eq(appsInstalled.name, "test-multi")),
    )
  })

  it("tracks the active version per app in apps_active_version", async () => {
    await withSystemDb("apps-active-insert", (db) =>
      db.insert(appsActiveVersion).values({ name: "test-active", version: "1.0.0" }),
    )
    const rows = await withSystemDb("apps-active-select", (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, "test-active")),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].version).toBe("1.0.0")
    await withSystemDb("apps-active-cleanup", (db) =>
      db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, "test-active")),
    )
  })
})
