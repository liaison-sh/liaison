// SPDX-License-Identifier: FSL-1.1-ALv2
// T3.4 — MCP exposure smoke test for the 12 kernel skills/routines tools.
//
// The plan's failing-test sketch mentioned `kernel:${tool}` names; in this
// codebase tool-bridge sanitizes the separator (`:` is not in the SDK's
// `^[a-zA-Z0-9_-]+$` allow-list), so the wire name is `kernel__${tool}`.
// The MCP projection (`listMcpTools`) emits the sanitized names directly.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { registerSkillRoutineTools } from "~/modules/agent/tools/skills-routines-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { userContextFor } from "~/modules/mcp/test-helpers"
import { listMcpTools } from "~/modules/mcp/tool-projection"
import { createTestOrg } from "~/tests/helpers/org"

async function setupOrgAndUser(): Promise<{ orgId: string; userId: string }> {
  const org = await createTestOrg()
  const userId = await withSystemDb("mcp-srt-user", async (db) => {
    const [u] = await db
      .insert(users)
      .values({
        orgId: org.id,
        email: `mcp-srt-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name: "MCP Skill Tester",
        status: "active",
      })
      .returning({ id: users.id })
    return u.id
  })
  return { orgId: org.id, userId }
}

describe("MCP exposure — kernel skills + routines tools", () => {
  let orgId: string
  let userId: string

  beforeEach(async () => {
    const setup = await setupOrgAndUser()
    orgId = setup.orgId
    userId = setup.userId
  })

  afterEach(() => {
    toolRegistry.deleteByPrefix([orgId])
  })

  it("MCP listing includes all twelve new kernel skills/routines tools", async () => {
    await registerSkillRoutineTools(orgId)
    const actor = userContextFor(orgId, userId, ["*"])
    const sdkTools = await listMcpTools({ orgId, actor })
    const names = new Set(sdkTools.map((t) => t.name))

    const expected = [
      // read-only (Task 3.1)
      "skill_search",
      "skill_read",
      "list_skills",
      "list_routines",
      // skill authoring (Task 3.2)
      "create_skill",
      "update_skill",
      "delete_skill",
      "toggle_app_skill",
      // routine authoring (Task 3.3)
      "create_routine",
      "update_routine",
      "delete_routine",
      "run_routine_now",
    ]
    for (const tool of expected) {
      expect(names).toContain(`kernel__${tool}`)
    }
  }, 30_000)

  it("MCP listing filters by scope — read-only scopes hide gated authoring tools", async () => {
    await registerSkillRoutineTools(orgId)
    const readerActor = userContextFor(orgId, userId, [
      "kernel:skills:read",
      "kernel:routines:read",
    ])
    const sdkTools = await listMcpTools({ orgId, actor: readerActor })
    const names = new Set(sdkTools.map((t) => t.name))

    // Read-only tools visible
    expect(names).toContain("kernel__skill_search")
    expect(names).toContain("kernel__skill_read")
    expect(names).toContain("kernel__list_skills")
    expect(names).toContain("kernel__list_routines")

    // Gated authoring tools hidden without write scopes
    expect(names).not.toContain("kernel__create_skill")
    expect(names).not.toContain("kernel__update_skill")
    expect(names).not.toContain("kernel__delete_skill")
    expect(names).not.toContain("kernel__toggle_app_skill")
    expect(names).not.toContain("kernel__create_routine")
    expect(names).not.toContain("kernel__update_routine")
    expect(names).not.toContain("kernel__delete_routine")
    expect(names).not.toContain("kernel__run_routine_now")
  }, 30_000)

  it("MCP exposure for kernel tools requires no app-name filter", async () => {
    // Sanity guard against future regressions: the listing must include kernel
    // tools side-by-side with manifest-app tools — the projection iterates the
    // registry without filtering by appName.
    await registerSkillRoutineTools(orgId)
    const actor = userContextFor(orgId, userId, ["*"])
    const sdkTools = await listMcpTools({ orgId, actor })

    const kernelTools = sdkTools.filter((t) => t.name.startsWith("kernel__"))
    expect(kernelTools.length).toBeGreaterThanOrEqual(12)
    // Every kernel tool must expose a JSON-Schema inputSchema (Zod→JSON conversion didn't drop it).
    for (const t of kernelTools) {
      expect(t.inputSchema).toBeDefined()
      expect((t.inputSchema as { type?: string }).type).toBe("object")
    }
  }, 30_000)
})
