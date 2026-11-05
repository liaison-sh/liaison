// SPDX-License-Identifier: FSL-1.1-ALv2
// The Knowledge settings page's synced sources list (settings overhaul P2 T8)
// runs on the synced_sources.list / archive / run_now tools, which carry the
// checks of /api/knowledge/synced-sources: a caller without knowledge reads is
// refused (S17), a reader lists their own and the organization's sources, an
// organization source is archived only with knowledge:sources:manage, and a
// source the caller cannot see is not found.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import knowledgeManifest from "~/apps/knowledge/app.manifest.json"
import { knowledgeActorFromContext } from "~/apps/knowledge/service"
import type { KnowledgeSourceAdapter } from "~/apps/knowledge/source-protocol"
import { createSyncedSource } from "~/apps/knowledge/synced-sources"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const READ = "knowledge:documents:read"
const MANAGE = "knowledge:sources:manage"

const stubAdapter: KnowledgeSourceAdapter = {
  source: "google-drive",
  searchRemote: async () => ({
    hits: [],
    status: { source: "google-drive", state: "complete", retryable: false },
  }),
  listFolder: async () => ({ items: [] }),
}

async function tokenWith(userId: string, scopes: string[]): Promise<string> {
  const [row] = await withSystemDb("synced-tools-mint", (db) =>
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
  if (!row) throw new Error(`tokenWith: user ${userId} missing`)
  return signAccessToken(
    {
      userId,
      orgId: row.orgId,
      name: row.name,
      authVersion: row.authVersion,
      permissionVersion: row.permissionVersion,
      roles: [],
      scopes,
      dimensionGrants: {},
    },
    env.JWT_SECRET,
    60 * 60,
  )
}

async function tool(token: string, name: string, params: Record<string, unknown> = {}) {
  const res = await app.request("/api/apps/run-tool", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ toolName: `knowledge:${name}`, params }),
  })
  return { status: res.status, body: (await res.json()) as any }
}

describe("knowledge synced_sources tools", () => {
  let orgId: string
  let ownerId: string
  let otherId: string
  let orgSourceId: string
  let personalSourceId: string

  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    ownerId = (await minimal.person(orgId, { role: "member" })).id
    otherId = (await minimal.person(orgId, { role: "member" })).id
    const make = async (userId: string, scopes: string[], scope: "organization" | "personal") => {
      const actor = knowledgeActorFromContext({ orgId, userId, scopes, dimensionGrants: {} })
      const ctx = { actorType: "user" as const, orgId, userId, scopes, dimensionGrants: {} }
      return withRlsContext(ctx, (tx) =>
        createSyncedSource(
          tx,
          {
            appName: "google-drive",
            folderRef: `folder-${scope}`,
            displayName: scope === "organization" ? "Team manual" : "My notes",
            syncIntervalSeconds: 3600,
            scope,
            ...(scope === "organization" ? { defaultSensitivity: "internal" } : {}),
          },
          actor,
          { adapter: stubAdapter },
        ),
      )
    }
    orgSourceId = (await make(ownerId, [READ, MANAGE], "organization")).id
    personalSourceId = (await make(ownerId, [READ], "personal")).id
  }, 180_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  test("a caller without knowledge reads is refused by every tool", async () => {
    const token = await tokenWith(otherId, ["kernel:threads"])
    expect((await tool(token, "synced_sources.list")).status).toBe(403)
    expect((await tool(token, "synced_sources.archive", { id: orgSourceId })).status).toBe(403)
    expect((await tool(token, "synced_sources.run_now", { id: orgSourceId })).status).toBe(403)
  })

  test("a reader lists their own and the organization's sources, not another's personal one", async () => {
    const owner = await tool(await tokenWith(ownerId, [READ]), "synced_sources.list")
    expect(owner.status).toBe(200)
    const ownerRows = owner.body.data.rows as Array<{ id: string; scope: string }>
    expect(ownerRows.map((r) => r.id).sort()).toEqual([orgSourceId, personalSourceId].sort())
    expect(ownerRows.find((r) => r.id === orgSourceId)?.scope).toBe("organization")
    const other = await tool(await tokenWith(otherId, [READ]), "synced_sources.list")
    expect((other.body.data.rows as Array<{ id: string }>).map((r) => r.id)).toEqual([orgSourceId])
  })

  // M2: the settings list reads each row through its declared column formats, so
  // every value the tool returns has a label and the real error travels with the row.
  test("the settings list declares a label for every value the tool returns, and the error", async () => {
    const owner = await tool(await tokenWith(ownerId, [READ]), "synced_sources.list")
    const rows = owner.body.data.rows as Array<Record<string, unknown>>
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect("lastError" in r).toBe(true)
    const block = (
      knowledgeManifest.settings.sections as Array<{
        blocks: Array<{
          block: string
          ops?: { list?: string }
          columns?: Array<{
            key: string
            format?: string
            errorKey?: string
            options?: Array<{ value: string }>
          }>
        }>
      }>
    )
      .flatMap((s) => s.blocks)
      .find((b) => b.block === "list" && b.ops?.list === "synced_sources.list")
    const col = (key: string) => block?.columns?.find((c) => c.key === key)
    expect(col("lastSyncAt")?.format).toBe("datetime")
    expect(col("lastSyncStatus")?.format).toBe("status")
    expect(col("lastSyncStatus")?.errorKey).toBe("lastError")
    const values = (key: string) => col(key)?.options?.map((o) => o.value) ?? []
    expect(values("lastSyncStatus").sort()).toEqual(["error", "idle", "ok", "running"])
    expect(values("scope").sort()).toEqual(["organization", "personal"])
    for (const r of rows) {
      expect(values("appName")).toContain(r.appName as string)
      expect(values("scope")).toContain(r.scope as string)
    }
  })

  test("another reader cannot force or archive someone's personal source: not found / forbidden", async () => {
    const token = await tokenWith(otherId, [READ])
    expect((await tool(token, "synced_sources.run_now", { id: personalSourceId })).status).toBe(404)
    const archive = await tool(token, "synced_sources.archive", { id: orgSourceId })
    expect(archive.status).toBe(403)
  })

  test("the owner archives their personal source; a manager archives the organization's", async () => {
    const own = await tool(await tokenWith(ownerId, [READ]), "synced_sources.archive", {
      id: personalSourceId,
    })
    expect(own.status).toBe(200)
    const org = await tool(await tokenWith(otherId, [READ, MANAGE]), "synced_sources.archive", {
      id: orgSourceId,
    })
    expect(org.status).toBe(200)
    const after = await tool(await tokenWith(ownerId, [READ]), "synced_sources.list")
    expect(after.body.data.rows).toEqual([])
  })
})
