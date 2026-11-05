// SPDX-License-Identifier: FSL-1.1-ALv2
// PUT /api/apps/:appName/config/:key — the allowlisted admin write into
// `kernel.apps.config` (the store bundled apps read with `ctx.config.get`).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { connectionConfigRegistry, manifestRegistry } from "~/modules/apps/app-registries"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "cfgdemo"

describe("PUT /api/apps/:appName/config/:key", () => {
  let orgId: string
  let adminBearer: string
  let memberBearer: string

  beforeAll(async () => {
    await acquireTestLock()
    const admin = await minimal.adminSession((await createTestOrg()).id)
    orgId = admin.orgId
    adminBearer = admin.bearer
    memberBearer = (await minimal.session(orgId, { role: "member" })).bearer
    // createTestOrg already ran ensureAppsForOrg, so these synthetic registry
    // entries survive the route's own ensureAppsForOrg.
    manifestRegistry.set([orgId, APP], {
      name: APP,
      uiBundleUrl: null,
      configKeys: [
        { key: "sources", type: "json" },
        { key: "dashboardUrl", type: "url" },
      ],
    })
    connectionConfigRegistry.set([orgId, APP, "hook"], {
      type: "credentials",
      allowedDomains: ["demo.test"],
      webhookSecretConfigKey: "hookSecret",
    })
    await sql`
      INSERT INTO kernel.apps (org_id, name, version, status, config)
      VALUES (${orgId}, ${APP}, '1.0.0', 'active', ${JSON.stringify({ hookSecret: "cipher" })}::jsonb)
    `
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.apps WHERE org_id = ${orgId} AND name = ${APP}`
    connectionConfigRegistry.deleteByPrefix([orgId, APP])
    manifestRegistry.delete([orgId, APP])
    await releaseTestLock()
  })

  const put = (key: string, body: unknown, bearer = adminBearer) =>
    app.request(`/api/apps/${APP}/config/${key}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  /** The read `ctx.config.get` performs (sandbox/bridge/identity.ts config_get). */
  async function storedConfig(): Promise<Record<string, unknown>> {
    const [row] = await sql<{ config: Record<string, unknown> | null }[]>`
      SELECT config FROM kernel.apps WHERE org_id = ${orgId} AND name = ${APP} LIMIT 1
    `
    return row?.config ?? {}
  }

  it("refuses an undeclared key with 400", async () => {
    const res = await put("other", { value: "x" })
    expect(res.status).toBe(400)
    expect((await storedConfig()).other).toBeUndefined()
  })

  it("refuses a connection secret key with 400 and leaves it untouched", async () => {
    const res = await put("hookSecret", { value: "attacker" })
    expect(res.status).toBe(400)
    expect((await storedConfig()).hookSecret).toBe("cipher")
  })

  it("refuses a non-http(s) url with 400", async () => {
    expect((await put("dashboardUrl", { value: "javascript:alert(1)" })).status).toBe(400)
    expect((await put("dashboardUrl", { value: "ftp://files.example" })).status).toBe(400)
    expect((await storedConfig()).dashboardUrl).toBeUndefined()
  })

  it("refuses a caller without kernel:apps:admin with 403", async () => {
    const res = await put("dashboardUrl", { value: "https://status.example" }, memberBearer)
    expect(res.status).toBe(403)
    expect((await storedConfig()).dashboardUrl).toBeUndefined()
  })

  it("writes a declared key for an admin; the config read returns it, other keys kept", async () => {
    const sources = [{ id: "uptime", label: "Uptime", hue: 200 }]
    const res = await put("sources", { value: sources })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { changed: boolean } }).data.changed).toBe(true)
    const urlRes = await put("dashboardUrl", { value: "https://status.example/board" })
    expect(urlRes.status).toBe(200)

    const config = await storedConfig()
    expect(config.sources).toEqual(sources)
    expect(config.dashboardUrl).toBe("https://status.example/board")
    expect(config.hookSecret).toBe("cipher")

    // Same value again: no change reported.
    const again = await put("sources", { value: sources })
    expect(((await again.json()) as { data: { changed: boolean } }).data.changed).toBe(false)

    // GET lists the declared keys with their values, never the secret.
    const list = await app.request(`/api/apps/${APP}/config`, {
      headers: { Authorization: `Bearer ${adminBearer}` },
    })
    expect(list.status).toBe(200)
    const body = (await list.json()) as { data: Array<{ key: string; value: unknown }> }
    expect(body.data.map((d) => d.key)).toEqual(["sources", "dashboardUrl"])
    expect(JSON.stringify(body)).not.toContain("cipher")

    // null clears the key.
    expect((await put("dashboardUrl", { value: null })).status).toBe(200)
    expect((await storedConfig()).dashboardUrl).toBeUndefined()
  })

  it("audit-logs the write", async () => {
    const rows = await sql<{ action: string; metadata: { key: string } }[]>`
      SELECT action, metadata FROM kernel.audit_log
      WHERE org_id = ${orgId} AND entity_type = 'app_config'
    `
    expect(
      rows.some((r) => r.action === "app_config_updated" && r.metadata.key === "sources"),
    ).toBe(true)
  })
})
