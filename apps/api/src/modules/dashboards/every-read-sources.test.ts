// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The reads made dashboard sources by the every-read rule (every-read-is-a-source.guard.test.ts):
// the kernel reads added to KERNEL_DASHBOARD_SOURCES and the app reads hidden from the agent's
// catalog (a settings page's own read), which the source rule no longer refuses. For each, a
// dashboard block that reads it saves, and runs for the viewer. A read that needs a record id
// runs against an id that does not exist: the block reaches the tool and gets the tool's own
// answer, never a source refusal.
//
// In-tree and kernel reads run their real handlers. A bundled app's read is registered from its
// manifest declaration (the flags the source rule reads), with a handler returning the shape
// its real one does, since a bundled app is not installed in a fresh test org.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { UserContext } from "~/db/rls"
import { defineAppBuilderTools } from "~/modules/app-builder/tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createDashboard, getBlockData } from "~/modules/dashboards/service"
import { checkToolSource, SECRET_READS } from "~/modules/dashboards/sources"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const NO_SUCH_ID = "00000000-0000-4000-8000-000000000000"
const REFUSALS = ["not_allowed", "no_access", "unknown_tool"]

interface Case {
  tool: string
  params?: Record<string, unknown>
  /** The list a block charts, when the result holds several. */
  rowsPath?: string
  /** The result's rows chart (a count): the default. "reaches" = the call reaches the tool. */
  expect?: "rows" | "object" | "reaches"
}

/** The kernel reads this rule added to the source list. */
const KERNEL_CASES: Case[] = [
  { tool: "kernel:users_search", params: { query: "a" } },
  { tool: "kernel:describe_user_access", params: { userId: "{owner}" }, expect: "object" },
  { tool: "kernel:contacts_read", params: { contactId: NO_SUCH_ID }, expect: "reaches" },
  { tool: "kernel:contacts_addresses_list", params: { contactId: NO_SUCH_ID }, expect: "reaches" },
  { tool: "kernel:contacts_find_duplicates", expect: "reaches" },
  { tool: "kernel:contacts_groups_list" },
  { tool: "kernel:contacts_group_members", params: { groupId: NO_SUCH_ID }, expect: "reaches" },
  { tool: "kernel:threads_search", params: { query: "dashboard" }, expect: "reaches" },
  { tool: "kernel:list_routine_events", expect: "reaches" },
  {
    tool: "kernel:routine_tool_scopes",
    params: { tools: ["kernel__users_list"] },
    rowsPath: "tools",
  },
  { tool: "kernel:approval_policy_get", expect: "reaches" },
  { tool: "kernel:policy_get", expect: "reaches" },
  { tool: "kernel:roles_list" },
  { tool: "kernel:get_role", params: { roleId: NO_SUCH_ID }, expect: "reaches" },
  { tool: "kernel:list_scopes", expect: "reaches" },
  { tool: "kernel:list_dimensions", expect: "reaches" },
  { tool: "kernel:list_locked_capabilities", expect: "reaches" },
  { tool: "kernel:list_skills", expect: "reaches" },
  { tool: "kernel:skill_search", params: { query: "invoice" }, expect: "reaches" },
  { tool: "kernel:skill_read", params: { name: "no-such-skill" }, expect: "reaches" },
  { tool: "kernel:subagent_list", expect: "reaches" },
  { tool: "kernel:subagent_get", params: { id: NO_SUCH_ID }, expect: "reaches" },
  { tool: "kernel:ai_models_get", expect: "reaches" },
  { tool: "kernel:files_list", expect: "reaches" },
  { tool: "kernel:files_read", params: { fileId: NO_SUCH_ID }, expect: "reaches" },
  { tool: "kernel:document_templates_list", expect: "reaches" },
  { tool: "kernel:document_template_get", params: { id: NO_SUCH_ID }, expect: "reaches" },
  { tool: "kernel:document_rules_list", expect: "reaches" },
  {
    tool: "kernel:document_rules_match",
    params: { recordType: "boxtal:shipment", records: [] },
    expect: "reaches",
  },
  { tool: "kernel:document_record_types_list", expect: "reaches" },
  { tool: "kernel:product_attributes_list", expect: "reaches" },
  { tool: "kernel:data_collections_list", expect: "reaches" },
  { tool: "kernel:dashboards_list", expect: "reaches" },
  { tool: "kernel:dashboards_get", params: { id: NO_SUCH_ID }, expect: "reaches" },
  { tool: "kernel:dashboards_history", params: { id: NO_SUCH_ID }, expect: "reaches" },
  { tool: "kernel:import_kinds", expect: "reaches" },
  { tool: "kernel:import_reference", expect: "reaches" },
  { tool: "kernel:import_sample", params: { uploadId: NO_SUCH_ID }, expect: "reaches" },
  { tool: "kernel:import_status", params: { runId: NO_SUCH_ID }, expect: "reaches" },
  {
    tool: "kernel:merge_imported_user_preview",
    params: { importedUserId: NO_SUCH_ID, targetUserId: NO_SUCH_ID },
    expect: "reaches",
  },
  { tool: "kernel:apps_build_list", expect: "reaches" },
  { tool: "kernel:apps_build_get", params: { draftId: NO_SUCH_ID }, expect: "reaches" },
  { tool: "kernel:apps_build_versions", params: { name: "no-such-app" }, expect: "reaches" },
  { tool: "kernel:apps_build_logs", params: { draftId: NO_SUCH_ID }, expect: "reaches" },
  { tool: "kernel:apps_build_preview", params: { draftId: NO_SUCH_ID }, expect: "reaches" },
  { tool: "kernel:config_export", expect: "reaches" },
  { tool: "kernel:config_plan", params: { config: {} }, expect: "reaches" },
  { tool: "kernel:notifications_get", expect: "reaches" },
  { tool: "kernel:sidebar_apps_get", expect: "reaches" },
  { tool: "kernel:setup_state", expect: "reaches" },
]

/** The in-tree apps' reads hidden from agents. */
const IN_TREE_CASES: Case[] = [
  { tool: "tickets:categories.tree" },
  { tool: "projects:labels.tree", expect: "reaches" },
  { tool: "knowledge:synced_sources.list", expect: "reaches" },
  { tool: "mail:providers.get", expect: "object" },
  { tool: "mail:getSyncStatus", params: { accountId: NO_SUCH_ID }, expect: "reaches" },
]

/** The bundled apps' reads hidden from agents, each with the shape its handler returns. */
const BUNDLED: Array<{ app: string; tool: string; result: unknown; expect: "rows" | "object" }> = [
  { app: "ads", tool: "counts", result: { active: 2, paused: 1, total: 3 }, expect: "object" },
  {
    app: "boxtal",
    tool: "settings_form_get",
    result: { pickup_policy: "allow", label_format: "A4" },
    expect: "object",
  },
  {
    app: "boxtal",
    tool: "settings_sender_form_get",
    result: { name: "Warehouse", city: "Lyon", country: "FR" },
    expect: "object",
  },
  {
    app: "database",
    tool: "report_access_get",
    result: { domains: [{ domain: "sales", tier: "members" }], default: "members" },
    expect: "rows",
  },
  {
    app: "database",
    tool: "report_access_find_people",
    result: { people: [{ id: "u1", email: "a@example.test" }] },
    expect: "rows",
  },
  {
    app: "invoicing",
    tool: "einvoicing_settings_values",
    result: { platform: "", cutover: null, send: false, booking: false },
    expect: "object",
  },
  {
    app: "invoicing",
    tool: "einvoicing_provider_options",
    result: { options: [{ value: "pa", label: "Platform" }] },
    expect: "rows",
  },
  {
    app: "invoicing",
    tool: "draft_issue_preview",
    result: { document: { id: "d1", total: "12.00" }, total: "12.00" },
    expect: "object",
  },
  {
    app: "invoicing",
    tool: "viewer_access",
    result: { canCreate: true, canEdit: true, canDecide: false },
    expect: "object",
  },
  {
    app: "invoicing",
    tool: "documents_preview_pdf",
    result: { file_id: "f1", url: "/files/f1/inline" },
    expect: "object",
  },
]

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")

function manifestTool(app: string, tool: string): Record<string, unknown> {
  const m = JSON.parse(
    readFileSync(join(REPO, "bundled-apps", app, "app.manifest.json"), "utf8"),
  ) as { tools: Record<string, Record<string, unknown>> }
  const t = m.tools[tool]
  if (!t) throw new Error(`${app}:${tool} is not in its manifest`)
  return t
}

let orgId = ""
let owner = ""
let viewer: UserContext

function blockFor(c: Case, id: string) {
  const params = Object.fromEntries(
    Object.entries(c.params ?? {}).map(([k, v]) => [k, v === "{owner}" ? owner : v]),
  )
  const kind = c.expect ?? "rows"
  return {
    id,
    type: "metric",
    title: c.tool,
    source: { kind: "tool", tool: c.tool, params, ...(c.rowsPath ? { rowsPath: c.rowsPath } : {}) },
    // A list is counted; one record or a set of figures is read by a field.
    map: kind === "object" ? { value: "total" } : { agg: "count" },
  }
}

/** Saves a personal dashboard with one block on `c.tool`, then runs that block as the viewer. */
async function saveAndRun(c: Case) {
  const d = await createDashboard(viewer, {
    title: `Source ${c.tool}`,
    visibility: "personal",
    spec: { v: 1, blocks: [blockFor(c, "b")] },
  })
  return getBlockData(viewer, d.id, "b")
}

beforeAll(async () => {
  await acquireTestLock()
  const org = await minimal.secondOrg({ name: "Every Read Sources Org" })
  orgId = org.orgId
  owner = org.adminUserId
  await ensureAppsForOrg(orgId)
  defineAppBuilderTools(orgId)
  for (const b of BUNDLED) {
    const t = manifestTool(b.app, b.tool)
    toolRegistry.set([orgId, b.app, b.tool], {
      appName: b.app,
      name: b.tool,
      description: String(t.description),
      requiredScopes: t.requiredScopes as string[],
      readOnly: t.readOnly === true,
      ...(t.agentVisible === false ? { agentVisible: false } : {}),
      params: z.object({}),
      handler: async () => b.result,
    })
  }
  // The viewer holds every scope the reads under test need, and the dashboard scopes.
  const scopes = new Set(["kernel:dashboards:read", "kernel:dashboards:write"])
  for (const c of [
    ...KERNEL_CASES,
    ...IN_TREE_CASES,
    ...BUNDLED.map((b) => ({ tool: `${b.app}:${b.tool}` })),
  ]) {
    const [app, name] = c.tool.split(":") as [string, string]
    for (const s of toolRegistry.get([orgId, app, name])?.requiredScopes ?? []) scopes.add(s)
  }
  viewer = { actorType: "user", userId: owner, orgId, scopes: [...scopes], dimensionGrants: {} }
})

afterAll(async () => {
  await releaseTestLock()
})

describe("reads made dashboard sources", () => {
  for (const c of [...KERNEL_CASES, ...IN_TREE_CASES]) {
    it(`${c.tool}: a block saves and runs on it`, async () => {
      const out = await saveAndRun(c)
      if (c.expect === "reaches") {
        // The tool answered (records or its own error), not a source refusal or a write refusal.
        if (!out.ok) {
          expect(REFUSALS).not.toContain(out.error)
          expect(out.message).not.toContain("READ_ONLY_RUN")
        }
      } else {
        expect(out).toMatchObject({ ok: true })
      }
    })
  }

  for (const b of BUNDLED) {
    it(`${b.app}:${b.tool} (hidden from agents): a block saves and runs on it`, async () => {
      const c: Case = { tool: `${b.app}:${b.tool}`, expect: b.expect }
      const out = await saveAndRun(c)
      expect(out).toMatchObject({ ok: true, data: { kind: "metric" } })
    })
  }

  it("a read that returns a secret is refused, though hidden reads are sources", async () => {
    for (const tool of SECRET_READS) {
      const app = tool.slice(0, tool.indexOf(":"))
      const check = await checkToolSource(orgId, tool, { userId: owner, scopes: [`${app}:admin`] })
      if (toolRegistry.get([orgId, app, "webhook_info"])) {
        expect(check).toMatchObject({ ok: false, code: "not_allowed" })
      }
    }
    expect(
      (
        await checkToolSource(orgId, "projects:webhook_info", {
          userId: owner,
          scopes: ["projects:settings:admin"],
        })
      ).ok,
    ).toBe(false)
  })
})
