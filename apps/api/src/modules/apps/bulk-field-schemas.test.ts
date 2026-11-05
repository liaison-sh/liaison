// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { manifestRegistry } from "~/modules/apps/app-registries"
import { projectBulkToolSchemas } from "~/modules/apps/bulk-field-schemas"
import { signAccessToken } from "~/modules/auth/jwt"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import ticketsManifest from "../../apps/tickets/app.manifest.json"

describe("projectBulkToolSchemas", () => {
  test("the tickets bulk close carries the closedReason enum, so the form renders a select", () => {
    const tools = projectBulkToolSchemas(
      (ticketsManifest as any).bulk,
      (ticketsManifest as any).tools,
    )
    const closedReason = tools?.close?.params.properties.closedReason
    expect(closedReason?.type).toBe("string")
    expect(closedReason?.enum).toContain("resolved")
  })

  test("only the shared fields of bulk underlying tools are projected", () => {
    const tools = projectBulkToolSchemas(
      { close: { underlyingTool: "close", sharedFields: ["reason"] } },
      {
        close: {
          params: {
            properties: { ticketId: { type: "string" }, reason: { type: "string", enum: ["a"] } },
          },
          editableFields: [
            { field: "reason", label: "Reason", widget: "select" },
            { field: "other", label: "Other" },
          ],
        },
        unrelated: { params: { properties: { secret: { type: "string" } } } },
      },
    )
    expect(tools).toEqual({
      close: {
        params: { properties: { reason: { type: "string", enum: ["a"] } } },
        editableFields: [{ field: "reason", label: "Reason", widget: "select" }],
      },
    })
  })
})

async function adminToken(orgId: string): Promise<string> {
  const user = await minimal.person(orgId, { role: "admin" })
  const [row] = await withSystemDb("bulk-schemas-mint", (db) =>
    db
      .select({
        name: users.name,
        authVersion: users.authVersion,
        permissionVersion: users.permissionVersion,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1),
  )
  if (!row) throw new Error("adminToken: user missing")
  const perms = await withPrivilegedDb(orgId, "bulk-schemas-perms", (tx) =>
    loadEffectivePermissions(tx, user.id, orgId),
  )
  return signAccessToken(
    {
      userId: user.id,
      orgId,
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

describe("GET /api/apps/manifests forwards the bulk tool schemas", () => {
  let orgId: string
  let token: string
  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    token = await adminToken(orgId)
    manifestRegistry.set([orgId, "bulkish"], {
      name: "bulkish",
      bulk: { close: { underlyingTool: "close", sharedFields: ["reason"] } },
      tools: {
        close: { params: { properties: { reason: { enum: ["a", "b"] } } }, editableFields: [] },
      },
      uiBundleUrl: null,
    })
  })
  afterAll(async () => {
    manifestRegistry.delete([orgId, "bulkish"])
    await releaseTestLock()
  })

  test("the manifest payload includes tools for the bulk form", async () => {
    const res = await app.request("/api/apps/manifests", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      data: Array<{ name: string; manifest: { tools?: Record<string, any> } }>
    }
    const entry = json.data.find((a) => a.name === "bulkish")
    expect(entry?.manifest.tools?.close?.params?.properties?.reason?.enum).toEqual(["a", "b"])
  })
})
