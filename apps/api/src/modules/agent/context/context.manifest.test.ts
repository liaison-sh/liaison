// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { rootLogger } from "~/lib/logger"
import { assembleContext, systemPartsToText } from "~/modules/agent/context/context"
import { skillRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { resetOrgRuntimeForTest } from "~/tests/helpers/org-runtime"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-000000cd0001"
const USER_ID = "00000000-0000-0000-0000-000000cd0002"
const THREAD_ID = "00000000-0000-0000-0000-000000cd0003"

const actor: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

function systemText(result: Awaited<ReturnType<typeof assembleContext>>): string {
  return systemPartsToText(result.system)
}

// The skills MANIFEST section opens with this exact preamble (context.ts §3). It
// is distinct from system.md's inline mention of "## Skills available" in the
// skill-consult directive, so matching the preamble avoids that false positive.
const SKILLS_MANIFEST_PREAMBLE =
  "## Skills available\n\nSkills are reusable, user- or app-authored playbooks for specific tasks."

// The speaking agent: an agent-authored row names it (0080).
const AGENT_ID = "00000000-0000-0000-0000-00000000cd90"

describe("context-assembler — skills manifest", () => {
  beforeAll(async () => {
    await acquireTestLock()
    // The registries are process-global: start from an org with no apps and no
    // app-shipped skills, whatever earlier files in this process registered.
    resetOrgRuntimeForTest(ORG_ID)
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'ManifestOrg', 'manifest-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'manifest@test.com', 'Manifest User') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'personal', '@manifest', 'Test agent', ${USER_ID}, '["*"]'::jsonb) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'manifest-chat-1', 'agent_chat', ${USER_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
  })

  afterAll(releaseTestLock)

  afterEach(async () => {
    skillRegistry.deleteByPrefix([ORG_ID])
    toolRegistry.deleteByPrefix([ORG_ID])
    await sql`DELETE FROM kernel.disabled_app_skills WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG_ID}`
  })

  it("manifest section omitted when no apps and no DB skills", async () => {
    const result = await assembleContext({ threadId: THREAD_ID, orgId: ORG_ID, actor })
    const text = systemText(result)
    // Match the manifest section by its distinctive preamble, NOT the bare
    // "## Skills available" substring — system.md's skill-consult directive
    // (item 6) legitimately mentions the phrase "## Skills available" inline,
    // so a substring check would false-positive even with zero skills.
    expect(text).not.toContain(SKILLS_MANIFEST_PREAMBLE)
  })

  it("emits one '- name — description' line per visible row", async () => {
    skillRegistry.set([ORG_ID, "demo", "alpha"], {
      name: "alpha",
      description: "Alpha desc",
      body: "alpha body",
      requiredScopes: [],
    })
    skillRegistry.set([ORG_ID, "demo", "bravo"], {
      name: "bravo",
      description: "Bravo desc",
      body: "bravo body",
      requiredScopes: [],
    })
    const result = await assembleContext({ threadId: THREAD_ID, orgId: ORG_ID, actor })
    const text = systemText(result)
    expect(text).toContain("## Skills available")
    expect(text).toContain("- alpha — Alpha desc")
    expect(text).toContain("- bravo — Bravo desc")
    // Bodies must NOT appear in manifest
    expect(text).not.toContain("alpha body")
  })

  it("a turn that does not hold kernel__skill_read is never told to call it", async () => {
    // A routine tick whose scope carries no kernel:skills:read: the skills it can
    // see are not listed, and no kernel sentence names a tool it lacks.
    skillRegistry.set([ORG_ID, "demo", "alpha"], {
      name: "alpha",
      description: "Alpha desc",
      body: "alpha body",
      requiredScopes: [],
    })
    const held = new Set(["kernel__tool_search", "tickets__get", "tickets__reply"])
    const result = await assembleContext({
      threadId: THREAD_ID,
      orgId: ORG_ID,
      actor,
      heldTools: held,
    })
    const text = systemText(result)
    expect(text).not.toContain(SKILLS_MANIFEST_PREAMBLE)
    expect(text).not.toContain("kernel__skill_read")
    // The same assembly with the tool held lists the skill and says how to load it.
    const withRead = systemText(
      await assembleContext({
        threadId: THREAD_ID,
        orgId: ORG_ID,
        actor,
        heldTools: new Set([...held, "kernel__skill_read"]),
      }),
    )
    expect(withRead).toContain("- alpha — Alpha desc")
    expect(withRead).toContain("kernel__skill_read")
  })

  it("shadowing priority: personal > org > app for same name", async () => {
    skillRegistry.set([ORG_ID, "demo", "draft-reply"], {
      name: "draft-reply",
      description: "App-shipped draft-reply",
      body: "app body",
      requiredScopes: [],
    })
    await sql`INSERT INTO kernel.skills (org_id, author_user_id, name, description, body, created_by_actor_type) VALUES (${ORG_ID}, NULL, 'draft-reply', 'Org draft-reply', 'org body', 'user')`
    await sql`INSERT INTO kernel.skills (org_id, author_user_id, name, description, body, created_by_actor_type) VALUES (${ORG_ID}, ${USER_ID}, 'draft-reply', 'Personal draft-reply', 'personal body', 'user')`

    const result = await assembleContext({ threadId: THREAD_ID, orgId: ORG_ID, actor })
    const text = systemText(result)
    expect(text).toContain("- draft-reply — Personal draft-reply")
    expect(text).not.toContain("Org draft-reply")
    expect(text).not.toContain("App-shipped draft-reply")
  })

  it("scope filter excludes app skills whose requiredScopes are not subset of actor scopes", async () => {
    skillRegistry.set([ORG_ID, "demo", "needs-admin"], {
      name: "needs-admin",
      description: "Needs admin scope",
      body: "body",
      requiredScopes: ["kernel:admin"],
    })
    skillRegistry.set([ORG_ID, "demo", "open"], {
      name: "open",
      description: "Open to all",
      body: "body",
      requiredScopes: [],
    })
    const limitedActor: UserContext = { ...actor, scopes: ["kernel:basic"] }
    const result = await assembleContext({
      threadId: THREAD_ID,
      orgId: ORG_ID,
      actor: limitedActor,
    })
    const text = systemText(result)
    expect(text).toContain("- open — Open to all")
    expect(text).not.toContain("needs-admin")
  })

  it("scope filter excludes user/org skills whose requiredScopes are not subset of actor scopes", async () => {
    await sql`INSERT INTO kernel.skills (org_id, author_user_id, name, description, body, required_scopes, created_by_actor_type) VALUES (${ORG_ID}, NULL, 'priv-skill', 'Needs admin', 'b', ARRAY['kernel:admin']::text[], 'user')`
    const limitedActor: UserContext = { ...actor, scopes: ["kernel:basic"] }
    const result = await assembleContext({
      threadId: THREAD_ID,
      orgId: ORG_ID,
      actor: limitedActor,
    })
    const text = systemText(result)
    expect(text).not.toContain("priv-skill")
  })

  it("alpha ordering: same-source rows are sorted (apps by '<app>:<name>', user/org by 'name')", async () => {
    skillRegistry.set([ORG_ID, "zeta", "x"], {
      name: "x",
      description: "X from zeta",
      body: "b",
      requiredScopes: [],
    })
    skillRegistry.set([ORG_ID, "alpha", "y"], {
      name: "y",
      description: "Y from alpha",
      body: "b",
      requiredScopes: [],
    })
    await sql`INSERT INTO kernel.skills (org_id, author_user_id, name, description, body, created_by_actor_type) VALUES (${ORG_ID}, NULL, 'beta-skill', 'org beta', 'b', 'user')`
    await sql`INSERT INTO kernel.skills (org_id, author_user_id, name, description, body, created_by_actor_type) VALUES (${ORG_ID}, NULL, 'alpha-skill', 'org alpha', 'b', 'user')`

    const result = await assembleContext({ threadId: THREAD_ID, orgId: ORG_ID, actor })
    const text = systemText(result)
    // org first, then apps. Org names alpha-skill < beta-skill. App: alpha:y < zeta:x.
    const idxOrgA = text.indexOf("alpha-skill")
    const idxOrgB = text.indexOf("beta-skill")
    const idxAppY = text.indexOf("- y —")
    const idxAppX = text.indexOf("- x —")
    expect(idxOrgA).toBeGreaterThan(0)
    expect(idxOrgA).toBeLessThan(idxOrgB)
    expect(idxOrgB).toBeLessThan(idxAppY)
    expect(idxAppY).toBeLessThan(idxAppX)
  })

  it("namespace warn fires when a skill name collides with a tool name in the same org", async () => {
    toolRegistry.set([ORG_ID, "demo", "collide-name"], {
      appName: "demo",
      name: "collide-name",
      description: "tool",
      requiredScopes: ["demo:do"],
      handler: async () => null,
    })
    skillRegistry.set([ORG_ID, "demo", "collide-name"], {
      name: "collide-name",
      description: "skill clashing with tool",
      body: "b",
      requiredScopes: [],
    })
    const warnSpy = spyOn(rootLogger, "warn")
    try {
      await assembleContext({ threadId: THREAD_ID, orgId: ORG_ID, actor })
      const fired = warnSpy.mock.calls.some((args) => {
        const second = args[1]
        return typeof second === "string" && second.includes("shadows a tool name")
      })
      expect(fired).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("disabled-app-skill exclusion: row in disabled_app_skills omits the matching app-shipped row", async () => {
    skillRegistry.set([ORG_ID, "demo", "muted"], {
      name: "muted",
      description: "Muted skill",
      body: "b",
      requiredScopes: [],
    })
    skillRegistry.set([ORG_ID, "demo", "alive"], {
      name: "alive",
      description: "Alive skill",
      body: "b",
      requiredScopes: [],
    })
    await sql`INSERT INTO kernel.disabled_app_skills (org_id, user_id, app_name, skill_name) VALUES (${ORG_ID}, NULL, 'demo', 'muted')`

    const result = await assembleContext({ threadId: THREAD_ID, orgId: ORG_ID, actor })
    const text = systemText(result)
    expect(text).toContain("- alive — Alive skill")
    expect(text).not.toContain("Muted skill")
  })
})

describe("context-assembler — loaded skill bodies", () => {
  const T_ID = "00000000-0000-0000-0000-000000cd0004"
  beforeAll(async () => {
    await acquireTestLock()
    // The registries are process-global: start from an org with no apps and no
    // app-shipped skills, whatever earlier files in this process registered.
    resetOrgRuntimeForTest(ORG_ID)
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'ManifestOrg', 'manifest-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'manifest@test.com', 'Manifest User') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'personal', '@manifest', 'Test agent', ${USER_ID}, '["*"]'::jsonb) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${T_ID}, ${ORG_ID}, 'manifest-chat-2', 'agent_chat', ${USER_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${T_ID}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
  })

  afterAll(releaseTestLock)

  afterEach(async () => {
    skillRegistry.deleteByPrefix([ORG_ID])
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${T_ID}`
    await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG_ID}`
  })

  it("prior skill_read tool call → current body is injected as '## Skill: <name>'", async () => {
    skillRegistry.set([ORG_ID, "demo", "alpha"], {
      name: "alpha",
      description: "Alpha desc",
      body: "ALPHA BODY CONTENT",
      requiredScopes: [],
    })
    const metadata = {
      toolCalls: [
        { toolCallId: "tc1", toolName: "skill_read", args: { name: "alpha" }, result: "ok" },
      ],
    }
    await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, author_agent_id, content, metadata, required_scopes) VALUES ('00000000-0000-0000-0000-000000cd0100', ${T_ID}, ${ORG_ID}, ${USER_ID}, 'agent', ${AGENT_ID}, '', ${JSON.stringify(metadata)}::jsonb, '{}')`

    const result = await assembleContext({ threadId: T_ID, orgId: ORG_ID, actor })
    const text = systemText(result)
    expect(text).toContain("## Skill: alpha")
    expect(text).toContain("ALPHA BODY CONTENT")
  })

  it("self-heal: deleted skill → body block silently omitted", async () => {
    const metadata = {
      toolCalls: [
        { toolCallId: "tc1", toolName: "skill_read", args: { name: "ghost" }, result: "ok" },
      ],
    }
    await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, author_agent_id, content, metadata, required_scopes) VALUES ('00000000-0000-0000-0000-000000cd0101', ${T_ID}, ${ORG_ID}, ${USER_ID}, 'agent', ${AGENT_ID}, '', ${JSON.stringify(metadata)}::jsonb, '{}')`

    const result = await assembleContext({ threadId: T_ID, orgId: ORG_ID, actor })
    const text = systemText(result)
    expect(text).not.toContain("## Skill: ghost")
  })

  it("loaded body is the CURRENT body, not the historical tool-call payload", async () => {
    skillRegistry.set([ORG_ID, "demo", "fresh"], {
      name: "fresh",
      description: "Fresh desc",
      body: "UPDATED BODY",
      requiredScopes: [],
    })
    const metadata = {
      toolCalls: [
        {
          toolCallId: "tc1",
          toolName: "skill_read",
          args: { name: "fresh" },
          result: "STALE BODY",
        },
      ],
    }
    await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, author_agent_id, content, metadata, required_scopes) VALUES ('00000000-0000-0000-0000-000000cd0102', ${T_ID}, ${ORG_ID}, ${USER_ID}, 'agent', ${AGENT_ID}, '', ${JSON.stringify(metadata)}::jsonb, '{}')`

    const result = await assembleContext({ threadId: T_ID, orgId: ORG_ID, actor })
    const text = systemText(result)
    expect(text).toContain("UPDATED BODY")
    // STALE BODY may legitimately appear inside the assistant message in volatile; we only
    // verify the loaded-body block uses the registry's CURRENT body, not the historical result.
    const skillBlockStart = text.indexOf("## Skill: fresh")
    expect(skillBlockStart).toBeGreaterThan(-1)
    const skillBlockSlice = text.slice(skillBlockStart, skillBlockStart + 200)
    expect(skillBlockSlice).toContain("UPDATED BODY")
    expect(skillBlockSlice).not.toContain("STALE BODY")
  })

  it("shadowing: prior skill_read of 'draft-reply' resolves to the personal body when both personal and app exist", async () => {
    skillRegistry.set([ORG_ID, "demo", "draft-reply"], {
      name: "draft-reply",
      description: "App draft",
      body: "APP_BODY",
      requiredScopes: [],
    })
    await sql`INSERT INTO kernel.skills (org_id, author_user_id, name, description, body, created_by_actor_type) VALUES (${ORG_ID}, ${USER_ID}, 'draft-reply', 'Personal', 'PERSONAL_BODY', 'user')`
    const metadata = {
      toolCalls: [
        { toolCallId: "tc1", toolName: "skill_read", args: { name: "draft-reply" }, result: "ok" },
      ],
    }
    await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, author_agent_id, content, metadata, required_scopes) VALUES ('00000000-0000-0000-0000-000000cd0103', ${T_ID}, ${ORG_ID}, ${USER_ID}, 'agent', ${AGENT_ID}, '', ${JSON.stringify(metadata)}::jsonb, '{}')`

    const result = await assembleContext({ threadId: T_ID, orgId: ORG_ID, actor })
    const text = systemText(result)
    expect(text).toContain("## Skill: draft-reply")
    expect(text).toContain("PERSONAL_BODY")
    // App body must not be the resolved body
    const skillBlock = text.split("## Skill: draft-reply")[1] ?? ""
    expect(skillBlock).not.toContain("APP_BODY")
  })
})

// BL-265: a clearly-matching skill's BODY must reach the agent WITHOUT relying on
// the weak model to call skill_read. These exercise the full DB → resolved-skills
// → matcher → injected-body path through assembleContext.
describe("context-assembler — skill auto-surfacing (BL-265)", () => {
  const T_ID = "00000000-0000-0000-0000-000000cd0005"
  beforeAll(async () => {
    await acquireTestLock()
    // The registries are process-global: start from an org with no apps and no
    // app-shipped skills, whatever earlier files in this process registered.
    resetOrgRuntimeForTest(ORG_ID)
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'ManifestOrg', 'manifest-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'manifest@test.com', 'Manifest User') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'personal', '@manifest', 'Test agent', ${USER_ID}, '["*"]'::jsonb) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${T_ID}, ${ORG_ID}, 'manifest-chat-3', 'agent_chat', ${USER_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${T_ID}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
  })

  afterAll(releaseTestLock)

  afterEach(async () => {
    skillRegistry.deleteByPrefix([ORG_ID])
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${T_ID}`
    await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG_ID}`
  })

  // Seed the real RMA org-shared skill + a couple of distractor skills.
  async function seedSkills(): Promise<void> {
    await sql`INSERT INTO kernel.skills (org_id, author_user_id, name, description, body, created_by_actor_type) VALUES (${ORG_ID}, NULL, 'rma-full-setup', 'Set up the whole warranty RMA: approved reply + return label + queued restock, all gated.', 'RMA PLAYBOOK BODY — three gated legs', 'user')`
    await sql`INSERT INTO kernel.skills (org_id, author_user_id, name, description, body, created_by_actor_type) VALUES (${ORG_ID}, NULL, 'mass-processing', 'Process EVERY item in a set: page by totalCount, fan out, drive to zero — not a sample.', 'MASS BODY', 'user')`
    await sql`INSERT INTO kernel.skills (org_id, author_user_id, name, description, body, created_by_actor_type) VALUES (${ORG_ID}, NULL, 'gated-action-discipline', 'How to handle a gated action: it is pending approval, not done — never fake a result.', 'GATED BODY', 'user')`
  }

  async function insertUserMessage(id: string, content: string): Promise<void> {
    await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes) VALUES (${id}, ${T_ID}, ${ORG_ID}, ${USER_ID}, 'user', ${content}, '{}')`
  }

  it("auto-surfaces the matching skill BODY when the user task clearly matches — NO prior skill_read", async () => {
    await seedSkills()
    await insertUserMessage(
      "00000000-0000-0000-0000-000000cd0200",
      "Mason Reed's Kestrel 6 has two dead touch zones — set up the whole RMA: tell him it's approved, generate a prepaid return label, and queue the unit to be restocked once it's back.",
    )

    const result = await assembleContext({ threadId: T_ID, orgId: ORG_ID, actor })
    const text = systemText(result)
    // The body is in-context up front, without any skill_read tool call.
    expect(text).toContain("## Skill: rma-full-setup")
    expect(text).toContain("RMA PLAYBOOK BODY — three gated legs")
    // The wrong playbooks are NOT pulled in.
    expect(text).not.toContain("MASS BODY")
    expect(text).not.toContain("GATED BODY")
  })

  it("does NOT auto-surface any body for an unrelated user task (precision)", async () => {
    await seedSkills()
    await insertUserMessage(
      "00000000-0000-0000-0000-000000cd0201",
      "What were last month's total sales by product category?",
    )

    const result = await assembleContext({ threadId: T_ID, orgId: ORG_ID, actor })
    const text = systemText(result)
    // Manifest line still present (the skill is listed), but no body injected.
    expect(text).toContain("## Skills available")
    expect(text).not.toContain("RMA PLAYBOOK BODY")
    expect(text).not.toContain("## Skill: rma-full-setup")
  })

  it("does not double-inject: a prior skill_read of the match injects the body exactly once", async () => {
    await seedSkills()
    await insertUserMessage(
      "00000000-0000-0000-0000-000000cd0202",
      "Set up the whole warranty RMA for Mason: approved reply, prepaid return label, and queue the restock.",
    )
    const metadata = {
      toolCalls: [
        {
          toolCallId: "tc1",
          toolName: "skill_read",
          args: { name: "rma-full-setup" },
          result: "ok",
        },
      ],
    }
    await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, author_agent_id, content, metadata, required_scopes) VALUES ('00000000-0000-0000-0000-000000cd0203', ${T_ID}, ${ORG_ID}, ${USER_ID}, 'agent', ${AGENT_ID}, '', ${JSON.stringify(metadata)}::jsonb, '{}')`

    const result = await assembleContext({ threadId: T_ID, orgId: ORG_ID, actor })
    const text = systemText(result)
    const occurrences = text.split("## Skill: rma-full-setup").length - 1
    expect(occurrences).toBe(1)
  })
})
