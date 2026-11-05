// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B8 — registering the social app seeds its Component-A assets with correct
// defaults + provenance: 3 default-disabled playbook skills (guide stays
// enabled), the community-manager sub-agent with a valid ceiling, and 3 routine
// templates (none auto-instantiated). Enabling morning-digest creates exactly
// one routine targeting the digest playbook.

import { beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { disabledAppSkills, routines, subAgentDefinitions, users } from "~/db/schema/kernel"
import { handleEnableRoutineTemplate } from "~/modules/agent/tools/skills-routines-tools"
import { routineTemplateRegistry } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { createTestOrg } from "~/tests/helpers/org"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")

function socialDescriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "social", "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  const version = (manifest.version as string) ?? "0.1.0"
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    _bundlePath: join(REPO_ROOT, "bundled-apps", "social", version, "bundle.js"),
  }
}

let orgId: string
let userId: string

async function listDisabled(org: string) {
  return withPrivilegedDb(org, "test-list-disabled", (tx) =>
    tx
      .select()
      .from(disabledAppSkills)
      .where(and(eq(disabledAppSkills.orgId, org), eq(disabledAppSkills.appName, "social"))),
  )
}

async function listAgents(org: string, agentType: string) {
  return withPrivilegedDb(org, "test-list-agents", (tx) =>
    tx
      .select()
      .from(subAgentDefinitions)
      .where(and(eq(subAgentDefinitions.orgId, org), eq(subAgentDefinitions.agentType, agentType))),
  )
}

function listTemplates(org: string, app: string): Array<{ key: string }> {
  const out: Array<{ key: string }> = []
  for (const [[entryOrg, entryApp, key]] of routineTemplateRegistry.entries()) {
    if (entryOrg === org && entryApp === app) out.push({ key })
  }
  return out
}

async function countRoutines(org: string, app: string): Promise<number> {
  const rows = await withPrivilegedDb(org, "test-count-routines", (tx) =>
    tx
      .select()
      .from(routines)
      .where(
        and(eq(routines.orgId, org), eq(routines.appName, app), eq(routines.sourceKind, "app")),
      ),
  )
  return rows.length
}

async function routinesFor(org: string, app: string, key: string) {
  return withPrivilegedDb(org, "test-routines-for", (tx) =>
    tx
      .select()
      .from(routines)
      .where(
        and(eq(routines.orgId, org), eq(routines.appName, app), eq(routines.templateKey, key)),
      ),
  )
}

describe("social Component-A assets reconcile (B8)", () => {
  beforeAll(async () => {
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    const org = await createTestOrg()
    orgId = org.id
    userId = await withSystemDb("social-assets-user", async (db) => {
      const [u] = await db
        .insert(users)
        .values({
          orgId,
          email: `s-${crypto.randomUUID()}@t.co`,
          passwordHash: "x",
          name: "Social Operator",
          status: "active",
        })
        .returning({ id: users.id })
      return u.id
    })
    await registerApps([socialDescriptor()] as never, orgId)
  })

  test("seeds default-disabled playbook skills (guide stays enabled)", async () => {
    const disabled = await listDisabled(orgId)
    expect(disabled.map((d) => d.skillName).sort()).toEqual([
      "daily-social-digest",
      "draft-brand-reply",
      "triage-social-findings",
    ])
    // every seeded disable carries 'seed' provenance, org-wide (userId null)
    for (const d of disabled) {
      expect(d.disabledBy).toBe("seed")
      expect(d.userId).toBeNull()
    }
  })

  test("seeds community-manager with a social-prefixed scope ceiling", async () => {
    const [agent] = await listAgents(orgId, "community-manager")
    expect(agent).toBeDefined()
    expect(agent?.appName).toBe("social")
    expect((agent?.scopeCeiling ?? []).every((s) => s.startsWith("social:"))).toBe(true)
    expect(agent?.skills).toEqual(["draft-brand-reply", "daily-social-digest"])
  })

  test("registers three templates, none auto-instantiated", () => {
    expect(
      listTemplates(orgId, "social")
        .map((t) => t.key)
        .sort(),
    ).toEqual(["morning-digest", "triage-cron", "triage-event"])
  })

  test("no routines exist until a template is enabled", async () => {
    expect(await countRoutines(orgId, "social")).toBe(0)
  })

  test("enabling morning-digest creates exactly one routine wired to the digest playbook", async () => {
    const ctx = {
      orgId,
      userId,
      db: undefined as never,
      emit: async () => {},
      enqueueJob: async () => {},
      resolveContact: async () => null,
      logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never,
      actorType: "user" as const,
      approverUserId: userId,
      scopes: [
        "social:findings:read",
        "social:findings:write",
        "social:dm:read",
        "social:internal",
        "kernel:routines:write",
      ],
    }
    const res = (await handleEnableRoutineTemplate(
      { appName: "social", templateKey: "morning-digest", timezone: "UTC" },
      ctx,
    )) as { routine?: { appName: string; templateKey: string; sourceKind: string } }
    expect(res.routine).toMatchObject({
      appName: "social",
      templateKey: "morning-digest",
      sourceKind: "app",
    })
    const rows = await routinesFor(orgId, "social", "morning-digest")
    expect(rows.length).toBe(1)
    expect(rows[0]?.prompt).toMatch(/daily-social-digest/)
  })
})
