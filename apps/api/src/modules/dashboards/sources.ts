// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHICH TOOLS MAY FEED A DASHBOARD BLOCK, asked when a dashboard is saved and
// again on every run (a tool's manifest can change after the save, an app can
// be upgraded or turned off, the viewer's scopes can change).
//
// A source is a read the viewer may make: a known tool, enabled for the org,
// whose declaration says it reads (`readOnly`, no write target) and asks for
// nothing a view cannot give: not gated (statically or for some params), no
// outward effect, not a contract-only op, not hidden from the agent, no human
// turn, no trust boundary, not a web read. Kernel tools are not judged by their
// marker alone: only the ones listed here qualify. An org's own custom app is
// a source under the same rules (its secrets are placed per request);
// another org's never is.
//
// The `readOnly` marker is still the app's own claim. What makes a view safe
// against a manifest that lies is the run itself, which is read-only
// (execute.ts): its bridge refuses every write, whatever the tool declared.

import { APP_DISABLED_CODE } from "@liaison/shared"
import { checkToolScopes } from "~/modules/agent/scopes/required-scopes"
import { appVisibleToOrg } from "~/modules/apps/app-org-scope"
import { toolRegistry } from "~/modules/apps/app-registries"
import { dashboardSourceRefusal } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { isAppActiveForOrgAsync } from "~/modules/apps/org-apps"
import { type DeclaredCollection, getDeclaredCollection } from "~/modules/data-store/declared"
import { AGENT_STORE_APP } from "~/modules/data-store/service"
import { hasScope } from "~/modules/permissions/permissions"

/** The kernel reads a dashboard may show: lists of the org's own records. */
export const KERNEL_DASHBOARD_SOURCES: ReadonlySet<string> = new Set([
  "users_list",
  "contacts_search",
  "threads_list",
  "list_routines",
  "approvals_list",
  "audit_search",
])

export type SourceRefusalCode = "unknown_tool" | "not_allowed" | "no_access"

export type SourceCheck =
  | { ok: true; tool: RegisteredTool }
  | { ok: false; code: SourceRefusalCode; message: string }

type RegisteredTool = NonNullable<ReturnType<typeof toolRegistry.get>>

/** Why the declaration of `tool` keeps it off dashboards, or null when it is a plain read. */
export const declarationRefusal = dashboardSourceRefusal

/** The tool registered for this org, filling the org's registries on a miss. */
async function lookupTool(
  orgId: string,
  app: string,
  name: string,
): Promise<RegisteredTool | null> {
  let tool = toolRegistry.get([orgId, app, name])
  if (!tool) {
    await ensureAppsForOrg(orgId)
    tool = toolRegistry.get([orgId, app, name])
  }
  return tool ?? null
}

/**
 * May `toolName` feed a block that `viewer` sees? `unknown_tool` and
 * `not_allowed` are the tool's own answer (the same for everyone); `no_access`
 * is this viewer's: they lack a scope the tool needs.
 */
export async function checkToolSource(
  orgId: string,
  toolName: string,
  viewer: { userId: string; scopes: string[] },
): Promise<SourceCheck> {
  const i = toolName.indexOf(":")
  const app = i === -1 ? "" : toolName.slice(0, i)
  const name = i === -1 ? "" : toolName.slice(i + 1)
  if (!app || !name) {
    return { ok: false, code: "unknown_tool", message: `'${toolName}' is not <app>:<tool>` }
  }
  if (app === "kernel" && !KERNEL_DASHBOARD_SOURCES.has(name)) {
    return {
      ok: false,
      code: "not_allowed",
      message: `${toolName} is not a dashboard source; kernel sources are ${[...KERNEL_DASHBOARD_SOURCES].map((n) => `kernel:${n}`).join(", ")}`,
    }
  }
  if (app !== "kernel" && !(await appVisibleToOrg(app, orgId))) {
    return {
      ok: false,
      code: "unknown_tool",
      message: `${toolName} is not a tool of this workspace`,
    }
  }
  const tool = await lookupTool(orgId, app, name)
  // Another person's own tool (a personal MCP server's) does not exist for this viewer.
  if (!tool || (tool.ownerUserId && tool.ownerUserId !== viewer.userId)) {
    return {
      ok: false,
      code: "unknown_tool",
      message: `${toolName} is not a tool of this workspace`,
    }
  }
  if (app !== "kernel" && !(await isAppActiveForOrgAsync(orgId, app))) {
    return {
      ok: false,
      code: "not_allowed",
      message: `${toolName}: ${APP_DISABLED_CODE}, the app is turned off`,
    }
  }
  const refusal = declarationRefusal(tool)
  if (refusal)
    return {
      ok: false,
      code: "not_allowed",
      message: `${toolName} cannot feed a dashboard: ${refusal}`,
    }
  const scopes = checkToolScopes(tool, viewer.scopes)
  if (!scopes.authorized) {
    return {
      ok: false,
      code: "no_access",
      message: `${toolName} needs ${scopes.missing.join(", ") || "a scope"}`,
    }
  }
  return { ok: true, tool }
}

export interface EligibleSource {
  tool: string
  description: string
  /** The tool's parameters, as JSON-schema property names, when it declares them. */
  params: string[]
  /** The fields of its result, when its manifest declares them (`returns.schema`). */
  outputFields: string[]
}

function paramNames(tool: RegisteredTool): string[] {
  const p = tool.params as
    | { shape?: Record<string, unknown>; properties?: Record<string, unknown> }
    | undefined
  if (!p) return []
  if (p.shape && typeof p.shape === "object") return Object.keys(p.shape)
  if (p.properties && typeof p.properties === "object") return Object.keys(p.properties)
  return []
}

/** Every tool this viewer could put on a dashboard, matching `query` (words of its name or description). */
export async function listEligibleSources(
  orgId: string,
  viewer: { userId: string; scopes: string[] },
  query?: string,
  limit = 30,
): Promise<EligibleSource[]> {
  await ensureAppsForOrg(orgId)
  const words = (query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 1)
  const out: EligibleSource[] = []
  const names: string[] = []
  for (const [[, app, name], tool] of toolRegistry.entriesOf(orgId)) {
    const full = `${app}:${name}`
    if (words.length) {
      const hay =
        `${full} ${tool.description} ${(tool.searchKeywords ?? []).join(" ")}`.toLowerCase()
      if (!words.some((w) => hay.includes(w))) continue
    }
    if (app === "kernel" ? !KERNEL_DASHBOARD_SOURCES.has(name) : declarationRefusal(tool) !== null)
      continue
    names.push(full)
  }
  for (const full of names.sort()) {
    if (out.length >= limit) break
    const check = await checkToolSource(orgId, full, viewer)
    if (!check.ok) continue
    out.push({
      tool: full,
      description: check.tool.description.slice(0, 300),
      params: paramNames(check.tool),
      outputFields: Object.keys(check.tool.returns?.schema ?? {}),
    })
  }
  return out
}

export type StoreSourceCheck =
  | { ok: true; declared: DeclaredCollection }
  | { ok: false; code: SourceRefusalCode; message: string }

/**
 * May `app`'s `collection` feed a block `viewer` sees? Only a collection its app
 * declares readable outside it (`agentReadable`), under the declared read scope
 * (the agent namespace: kernel:data:read). An undeclared one is its app's alone.
 */
export async function checkStoreSource(
  orgId: string,
  app: string,
  collection: string,
  viewer: { scopes: string[] },
): Promise<StoreSourceCheck> {
  if (app !== AGENT_STORE_APP) {
    await ensureAppsForOrg(orgId)
    if (!(await appVisibleToOrg(app, orgId))) {
      return { ok: false, code: "unknown_tool", message: `${app} is not an app of this workspace` }
    }
    if (!(await isAppActiveForOrgAsync(orgId, app))) {
      return {
        ok: false,
        code: "not_allowed",
        message: `${app}: ${APP_DISABLED_CODE}, the app is turned off`,
      }
    }
  }
  const declared = getDeclaredCollection(orgId, app, collection)
  if (!declared) {
    return {
      ok: false,
      code: "unknown_tool",
      message: `${app} declares no collection '${collection}'`,
    }
  }
  if (!declared.agentReadable) {
    return {
      ok: false,
      code: "not_allowed",
      message: `${app}'s collection '${collection}' is not readable outside the app`,
    }
  }
  if (!hasScope(declared.readScope, viewer.scopes)) {
    return {
      ok: false,
      code: "no_access",
      message: `${app}/${collection} needs ${declared.readScope}`,
    }
  }
  return { ok: true, declared }
}
