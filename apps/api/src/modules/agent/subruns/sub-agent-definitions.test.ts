// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled, users } from "~/db/schema/kernel"
import { createTestOrg } from "~/tests/helpers/org"
import { seededApps } from "~/tests/helpers/seeded-app-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  createSubAgentDefinition,
  deleteSubAgentDefinition,
  isScopeSubset,
  KERNEL_OWNER,
  listSubAgentDefinitions,
  loadSubAgentDefinition,
  ScopeOutsideAppError,
  ScopeOutsideCreatorError,
  UnknownAppError,
} from "./sub-agent-definitions"

const SEEDED = seededApps()

// `apps_installed` is instance-wide (no org_id). The PK is (name, version), so
// fresh names per call avoid collisions. The `installed_by` FK points at
// `users.id`; in this suite the active org's bootstrap admin is the only
// available user.
async function installTestApp(grantedScopes: string[]): Promise<{ appName: string }> {
  const appName = SEEDED.track(`test-app-${crypto.randomUUID().slice(0, 8)}`)
  const version = "1.0.0"
  await withSystemDb("test-install-app", async (db) => {
    const [admin] = await db.select({ id: users.id }).from(users).limit(1)
    if (!admin) throw new Error("installTestApp: no user found — call createTestOrg first")
    await db.insert(appsInstalled).values({
      name: appName,
      version,
      sourceUrl: `file:///tmp/${appName}.liaisonapp`,
      sha256: "0".repeat(64),
      grantedScopes,
      installedBy: admin.id,
    })
    await db
      .insert(appsActiveVersion)
      .values({ name: appName, version })
      .onConflictDoUpdate({ target: appsActiveVersion.name, set: { version } })
  })
  return { appName }
}

beforeAll(async () => {
  await acquireTestLock()
})

afterAll(async () => {
  await SEEDED.cleanup()
  await releaseTestLock()
})

describe("isScopeSubset", () => {
  it("returns true for exact-match scopes", () => {
    expect(isScopeSubset(["mcp:jira:read"], ["mcp:jira:read", "mcp:jira:write"])).toBe(true)
  })

  it("returns true when parent has a glob covering the child", () => {
    expect(isScopeSubset(["mcp:jira:read"], ["mcp:jira:*"])).toBe(true)
  })

  it("returns true when parent has root wildcard '*'", () => {
    expect(isScopeSubset(["anything:goes"], ["*"])).toBe(true)
  })

  it("returns false when child has a scope the parent does not cover", () => {
    expect(isScopeSubset(["mcp:slack:write"], ["mcp:jira:*"])).toBe(false)
  })

  it("returns true for empty child (vacuously)", () => {
    expect(isScopeSubset([], ["mcp:jira:*"])).toBe(true)
  })
})

// Each integration test below builds its own fresh org + app via createTestOrg
// (which truncates between calls). Pattern matches existing route tests in this
// codebase: beforeEach creates fresh org, then test asserts.

describe("createSubAgentDefinition", () => {
  let orgId: string

  beforeEach(async () => {
    orgId = (await createTestOrg()).id
  })

  it("creates a definition when scopeCeiling is a subset of app granted_scopes", async () => {
    const { appName } = await installTestApp(["mcp:jira:*", "mcp:tailspin-db:*"])
    const def = await createSubAgentDefinition({
      orgId,
      appName,
      agentType: "ticket-investigator",
      whenToUse: "For each open ticket",
      scopeCeiling: ["mcp:jira:read", "mcp:tailspin-db:read"],
      systemPrompt: "You investigate tickets.",
      skills: [],
      mcpServers: ["jira"],
    })
    expect(def.id).toBeDefined()
    expect(def.agentType).toBe("ticket-investigator")
    expect(def.appName).toBe(appName)
    expect(def.scopeCeiling).toEqual(["mcp:jira:read", "mcp:tailspin-db:read"])
    expect(def.contextProfile).toBe("standard")
  })

  it("rejects when scopeCeiling exceeds app granted_scopes", async () => {
    const { appName } = await installTestApp(["mcp:jira:read"])
    await expect(
      createSubAgentDefinition({
        orgId,
        appName,
        agentType: "evil",
        whenToUse: "...",
        scopeCeiling: ["mcp:slack:write"],
        systemPrompt: "...",
      }),
    ).rejects.toBeInstanceOf(ScopeOutsideAppError)
  })

  it("rejects when the app is not installed / active", async () => {
    await expect(
      createSubAgentDefinition({
        orgId,
        appName: "no-such-app",
        agentType: "x",
        whenToUse: "...",
        scopeCeiling: [],
        systemPrompt: "...",
      }),
    ).rejects.toBeInstanceOf(UnknownAppError)
  })

  it("is idempotent on (orgId, agentType) — re-registering updates fields in place", async () => {
    const { appName } = await installTestApp(["mcp:jira:*"])
    const first = await createSubAgentDefinition({
      orgId,
      appName,
      agentType: "investigator",
      whenToUse: "first",
      scopeCeiling: ["mcp:jira:read"],
      systemPrompt: "v1",
    })
    const second = await createSubAgentDefinition({
      orgId,
      appName,
      agentType: "investigator",
      whenToUse: "second",
      scopeCeiling: ["mcp:jira:read", "mcp:jira:write"],
      systemPrompt: "v2",
    })
    // Same row (no duplicate), fields updated.
    expect(second.id).toBe(first.id)
    expect(second.whenToUse).toBe("second")
    expect(second.systemPrompt).toBe("v2")
    expect(second.scopeCeiling).toEqual(["mcp:jira:read", "mcp:jira:write"])
    const list = await listSubAgentDefinitions(orgId)
    expect(list.filter((d) => d.agentType === "investigator").length).toBe(1)
  })

  // --- Kernel/org-owned roles (BL-229): no plugin owner, ceiling capped by the
  // creator's own grantable scopes (the self-contained cap). ---

  it("registers a kernel/org-owned role when appName is omitted and the ceiling ⊆ creatorScopes", async () => {
    const def = await createSubAgentDefinition({
      orgId,
      // appName omitted → kernel-owned
      creatorScopes: ["kernel:agent:web", "kernel:contacts:read", "kernel:threads:read"],
      agentType: "dealer-researcher",
      whenToUse: "Research a single dealer's web presence and contact details.",
      scopeCeiling: ["kernel:agent:web", "kernel:contacts:read"],
      systemPrompt: "You research dealers.",
    })
    expect(def.id).toBeDefined()
    expect(def.appName).toBe(KERNEL_OWNER)
    expect(def.agentType).toBe("dealer-researcher")
    expect(def.scopeCeiling).toEqual(["kernel:agent:web", "kernel:contacts:read"])
    // Discoverable via list — no plugin owner required.
    const list = await listSubAgentDefinitions(orgId)
    expect(list.some((d) => d.agentType === "dealer-researcher")).toBe(true)
  })

  it("treats explicit appName='kernel' the same as omitted (kernel-owned)", async () => {
    const def = await createSubAgentDefinition({
      orgId,
      appName: "kernel",
      creatorScopes: ["kernel:agent:web"],
      agentType: "kernel-explicit",
      whenToUse: "x",
      scopeCeiling: ["kernel:agent:web"],
      systemPrompt: "x",
    })
    expect(def.appName).toBe(KERNEL_OWNER)
  })

  it("rejects a kernel-owned ceiling that exceeds the creator's scopes", async () => {
    await expect(
      createSubAgentDefinition({
        orgId,
        creatorScopes: ["kernel:contacts:read"],
        agentType: "over-broad",
        whenToUse: "x",
        // creator does not hold a write scope → cannot grant it
        scopeCeiling: ["kernel:contacts:write"],
        systemPrompt: "x",
      }),
    ).rejects.toBeInstanceOf(ScopeOutsideCreatorError)
  })

  it("rejects a kernel-owned role authored without creatorScopes (fails loud, never silently uncapped)", async () => {
    await expect(
      createSubAgentDefinition({
        orgId,
        agentType: "no-cap",
        whenToUse: "x",
        scopeCeiling: ["kernel:agent:web"],
        systemPrompt: "x",
      }),
    ).rejects.toBeInstanceOf(ScopeOutsideCreatorError)
  })

  it("a kernel-owned role with a glob creator scope covers concrete ceiling entries", async () => {
    const def = await createSubAgentDefinition({
      orgId,
      creatorScopes: ["kernel:contacts:*", "kernel:agent:web"],
      agentType: "glob-creator",
      whenToUse: "x",
      scopeCeiling: ["kernel:contacts:read", "kernel:agent:web"],
      systemPrompt: "x",
    })
    expect(def.scopeCeiling).toEqual(["kernel:contacts:read", "kernel:agent:web"])
  })
})

describe("loadSubAgentDefinition", () => {
  let orgId: string

  beforeEach(async () => {
    orgId = (await createTestOrg()).id
  })

  it("returns the definition by (orgId, agentType)", async () => {
    const { appName } = await installTestApp(["mcp:jira:*"])
    await createSubAgentDefinition({
      orgId,
      appName,
      agentType: "investigator",
      whenToUse: "x",
      scopeCeiling: ["mcp:jira:read"],
      systemPrompt: "x",
    })
    const def = await loadSubAgentDefinition(orgId, "investigator")
    expect(def).not.toBeNull()
    expect(def?.agentType).toBe("investigator")
  })

  it("returns null when no definition exists for that type", async () => {
    const def = await loadSubAgentDefinition(orgId, "nonexistent")
    expect(def).toBeNull()
  })
})

describe("listSubAgentDefinitions", () => {
  let orgId: string

  beforeEach(async () => {
    orgId = (await createTestOrg()).id
  })

  it("lists all definitions in the org", async () => {
    const { appName } = await installTestApp(["mcp:jira:*", "mcp:slack:*"])
    await createSubAgentDefinition({
      orgId,
      appName,
      agentType: "investigator-a",
      whenToUse: "x",
      scopeCeiling: ["mcp:jira:read"],
      systemPrompt: "x",
    })
    await createSubAgentDefinition({
      orgId,
      appName,
      agentType: "investigator-b",
      whenToUse: "x",
      scopeCeiling: ["mcp:slack:read"],
      systemPrompt: "x",
    })
    const list = await listSubAgentDefinitions(orgId)
    expect(list.length).toBe(2)
    const types = list.map((d) => d.agentType).sort()
    expect(types).toEqual(["investigator-a", "investigator-b"])
  })

  it("filters by appName", async () => {
    const { appName: appA } = await installTestApp(["mcp:jira:*"])
    const { appName: appB } = await installTestApp(["mcp:slack:*"])
    await createSubAgentDefinition({
      orgId,
      appName: appA,
      agentType: "investigator-a",
      whenToUse: "x",
      scopeCeiling: ["mcp:jira:read"],
      systemPrompt: "x",
    })
    await createSubAgentDefinition({
      orgId,
      appName: appB,
      agentType: "investigator-b",
      whenToUse: "x",
      scopeCeiling: ["mcp:slack:read"],
      systemPrompt: "x",
    })
    const list = await listSubAgentDefinitions(orgId, { appName: appA })
    expect(list.length).toBe(1)
    expect(list[0].agentType).toBe("investigator-a")
  })
})

describe("deleteSubAgentDefinition", () => {
  let orgId: string

  beforeEach(async () => {
    orgId = (await createTestOrg()).id
  })

  it("removes a definition and returns true", async () => {
    const { appName } = await installTestApp(["mcp:jira:*"])
    await createSubAgentDefinition({
      orgId,
      appName,
      agentType: "to-delete",
      whenToUse: "x",
      scopeCeiling: ["mcp:jira:read"],
      systemPrompt: "x",
    })
    const ok = await deleteSubAgentDefinition(orgId, "to-delete")
    expect(ok).toBe(true)
    expect(await loadSubAgentDefinition(orgId, "to-delete")).toBeNull()
  })

  it("returns false when nothing was deleted", async () => {
    expect(await deleteSubAgentDefinition(orgId, "nope")).toBe(false)
  })
})

describe("apps_active_version smoke", () => {
  beforeEach(async () => {
    await createTestOrg()
  })

  it("apps_active_version row is readable after install", async () => {
    const { appName } = await installTestApp(["mcp:noop:*"])
    const rows = await withSystemDb("test-read-active-version", async (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, appName)),
    )
    expect(rows.length).toBe(1)
  })
})
