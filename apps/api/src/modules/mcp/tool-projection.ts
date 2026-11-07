// SPDX-License-Identifier: FSL-1.1-ALv2
import type { Schema } from "ai"
import { z } from "zod"
import type { UserContext } from "~/db/rls"
import { appsLogger as log } from "~/lib/logger"
import { sanitizeJsonSchemaForProviders } from "~/modules/agent/providers/provider-schema"
import { turnToolScopes } from "~/modules/agent/scopes/effective-scope"
import {
  ALL_DEFERRED_TOOLS_UNLOCKED,
  buildToolSet,
  canonicalToolNamesBySdkName,
  type DiscoveredTools,
} from "~/modules/agent/tools/tool-bridge"
import { appVisibleToOrg } from "~/modules/apps/app-org-scope"
import { toolRegistry } from "~/modules/apps/app-registries"
import { primeOrgApps } from "~/modules/apps/org-apps"
import { isToolAllowedByAgentPolicy, loadAgentToolPolicy } from "~/modules/mcp/agent-tool-policy"
import {
  connectionRunsNodeSessions,
  notForNodeSessionSdkNames,
} from "~/modules/mcp/node-session-connection"

export const LIAISON_TOOL_SEARCH = "liaison_tool_search"
export const LIAISON_APPROVAL_STATUS = "liaison_approval_status"
export const LIAISON_CALL_TOOL = "liaison_call_tool"
/** The gateway's own tools: always listed, never filtered by scope or agent policy. */
export const LIAISON_META_TOOLS: ReadonlySet<string> = new Set([
  LIAISON_TOOL_SEARCH,
  LIAISON_APPROVAL_STATUS,
  LIAISON_CALL_TOOL,
])
const AGENTS_ASK_SDK_NAME = "kernel__agents_ask"

// The single Zod→JSON-Schema seam for ALL MCP tool schemas. Zod v4 ships a
// native z.toJSONSchema (repo zod ^4.4.3) — no extra dependency, no per-tool
// converter choice. If a future SDK bump mandates a specific converter, change
// THIS helper only; the rest of the code is converter-agnostic.
export function toJsonSchema(schema: z.ZodTypeAny | Schema<unknown>): Record<string, unknown> {
  // `buildToolSet` hands back a pre-projected AI SDK Schema for any tool whose
  // JSON projection had to be normalized for a provider (tuple `items`); its
  // JSON Schema is already the right answer and z.toJSONSchema cannot read it.
  const preProjected = (schema as Schema<unknown>).jsonSchema
  if (preProjected && typeof (schema as z.ZodTypeAny).safeParse !== "function") {
    return sanitizeJsonSchemaForProviders(preProjected) as Record<string, unknown>
  }
  return sanitizeJsonSchemaForProviders(z.toJSONSchema(schema as z.ZodTypeAny)) as Record<
    string,
    unknown
  >
}

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** MCP's own extension field, read by clients that understand its keys. */
  _meta?: Record<string, unknown>
}

/**
 * Tools a client should hold from its first prompt instead of deferring them
 * behind its own tool search. Claude Code (and the Agent SDK inside the
 * desktop's local session) reads `_meta["anthropic/alwaysLoad"]` per tool;
 * other clients ignore the key. Only the two skill tools: every Liaison
 * instruction ("kernel__skill_read the matching skill FIRST") sends the model
 * to them on turn one, and a deferred one cost a ToolSearch round trip, or a
 * guessed name that does not exist, before the first real call. The rest of
 * the catalog stays deferrable: pinning all of it once overflowed the prompt.
 */
export const ALWAYS_LOAD_TOOLS: ReadonlySet<string> = new Set([
  "kernel__skill_read",
  "kernel__skill_search",
])

/** The `_meta` a tool is listed with, or nothing. */
export function mcpToolMeta(name: string): Record<string, unknown> | undefined {
  return ALWAYS_LOAD_TOOLS.has(name) ? { "anthropic/alwaysLoad": true } : undefined
}

/**
 * Projects buildToolSet()'s catalog (the SAME registry the in-app agent uses)
 * into MCP Tool[]. The gateway audience defers NOTHING (see `isDeferredTool`):
 * the first `tools/list` is the complete callable catalog, so a client that
 * snapshots at `initialize` and ignores `notifications/tools_list_changed`
 * still reaches every tool its scopes allow. `discovered` no longer gates
 * visibility and is retained only so callers keep a stable signature. The two
 * meta-tools are always present.
 *
 * `ctx.agentId`, when set, is the agent an MCP connection is BOUND to. Its
 * live `toolAllowlist`/`toolDenylist` is read fresh (never memoized) and
 * applied as a SECOND filter stage over the set `buildToolSet` already
 * returned, so the fail-closed `requiredScopes` check runs first and this can
 * only ever remove tools. The two meta tools are exempt from both lists.
 *
 * `effectiveScope`, when given, is a pre-computed turn scope (the same value
 * `computeEffectiveScopeForTurn` produces for the in-app agent). It narrows the
 * catalog through buildToolSet's own rule: intersected with the actor's scopes,
 * so it never widens past them, and an empty one admits no tool. Absent, the
 * actor's scopes apply unchanged.
 */
/**
 * SDK names of this org's `agentBoundOnly` tools. One registry walk, done only
 * on the connection that is about to have them removed.
 */
function agentBoundOnlySdkNames(orgId: string): Set<string> {
  const names = new Set<string>()
  for (const [key, def] of toolRegistry.entriesOf(orgId)) {
    if (key[0] !== orgId) continue
    if (!def.agentBoundOnly) continue
    names.add(`${key[1]}__${key[2].replace(/[^a-zA-Z0-9_-]/g, "_")}`)
  }
  return names
}

export async function listMcpTools(
  ctx: {
    orgId: string
    actor: UserContext
    threadId?: string
    agentId?: string
    /** The named agents this connection may ask, appended to agents_ask. */
    agentsAskDirectory?: string
    /** The MCP connection: one a node job runs with loses `notForNodeSessions` tools. */
    connectionId?: string
    /**
     * W3-D4: keep the `agentBoundOnly` tools on a connection bound to no agent.
     * Only `liaison_call_tool`'s describe mode sets it: the call path resolves
     * those tools by name for any connection, so describing one must too.
     */
    keepAgentBoundOnly?: boolean
  },
  discovered?: DiscoveredTools,
  effectiveScope?: string[],
): Promise<McpToolDef[]> {
  // The narrowing rides the ACTOR, not a run frame. `buildToolSet` applies the
  // same rule either way (the turn's effective scope intersected with the
  // actor's own, never widening past them, an empty one admitting nothing),
  // but a frame means A TURN IS RUNNING, and this call is not one. A
  // hand-rolled `{ effectiveScope }` frame carries no scope accumulator, and a
  // frame that exists while being unable to say what its turn has read
  // resolves the taint to "unknown", which every write boundary refuses. The
  // set built here is projected into schemas and discarded, so nothing has
  // ever run under it -- but `buildToolSet` closes the frame over every tool's
  // `execute`, so the first caller to pass an effective scope AND invoke the
  // result would have had every gateway write refused with nothing to explain
  // why. Narrowing the actor leaves no frame to be entered.
  const scopedActor: UserContext = effectiveScope
    ? { ...ctx.actor, scopes: turnToolScopes(ctx.actor.scopes ?? [], { effectiveScope }) }
    : ctx.actor
  // buildToolSet leaves out apps the org admin hid (S14); prime its cache.
  await primeOrgApps(ctx.orgId)
  // When the MCP client hasn't done tool discovery yet, expose all deferred tools
  // so the external client gets the full catalog on first list.
  const set = buildToolSet(
    ctx.orgId,
    scopedActor,
    ctx.threadId,
    discovered ?? ALL_DEFERRED_TOOLS_UNLOCKED,
    "gateway",
  )
  // The agent-aware stage, appended AFTER the fail-closed catalog check above.
  // Loaded per call rather than per process: a denylist edit must apply on the
  // next request, not at the next restart.
  const agentPolicy = ctx.agentId ? await loadAgentToolPolicy(ctx.orgId, ctx.agentId) : null
  // One registry walk for the whole catalog: each SDK key's canonical
  // `app:tool`, so a policy curated in either form filters identically.
  const canonicalBySdkName = agentPolicy
    ? canonicalToolNamesBySdkName(ctx.orgId)
    : new Map<string, string>()
  // The agent-bound stage, appended AFTER the fail-closed catalog check and
  // AFTER the allow/deny stage above, so it can only ever remove tools. A tool
  // whose whole meaning is "as this agent, ask that agent" has none for a
  // connection that is nobody's agent, and A30 point 1 says so plainly: a plain
  // user token is a tool server for a dev agent, with no persona, no roster and
  // no coordination tools. The desktop's local session holds an AGENT-bound
  // token, so it passes this predicate with no desktop-specific code.
  const agentBoundNames =
    ctx.agentId || ctx.keepAgentBoundOnly ? null : agentBoundOnlySdkNames(ctx.orgId)
  const sessionBlocked = (await connectionRunsNodeSessions(ctx.orgId, ctx.connectionId))
    ? notForNodeSessionSdkNames(ctx.orgId)
    : null
  const tools: McpToolDef[] = []
  for (const [name, def] of Object.entries(set)) {
    const canonical = canonicalBySdkName.get(name)
    if (
      agentPolicy &&
      !isToolAllowedByAgentPolicy(agentPolicy, canonical ? [name, canonical] : name)
    ) {
      continue
    }
    if (agentBoundNames?.has(name)) continue
    if (sessionBlocked?.has(name)) continue
    // Another org's custom app lists nothing here (app-org-scope.ts).
    // An SDK name is `<app>__<tool>`; app names hold no underscore.
    const appName = canonical?.split(":")[0] ?? name.split("__")[0]
    if (appName && name.includes("__") && !(await appVisibleToOrg(appName, ctx.orgId))) continue
    const description = (def as { description?: string }).description ?? ""
    try {
      tools.push({
        name,
        // The directory rides on the tool a client reads when it considers
        // asking: the connect instructions are cut at 2048 characters.
        description:
          name === AGENTS_ASK_SDK_NAME && ctx.agentsAskDirectory
            ? `${description}\n\n${ctx.agentsAskDirectory}`
            : description,
        inputSchema: toJsonSchema((def as { inputSchema: z.ZodTypeAny }).inputSchema),
        ...(mcpToolMeta(name) ? { _meta: mcpToolMeta(name) } : {}),
      })
    } catch (err) {
      // Spec C4 failure mode: drop the one unconvertible tool, warn, never
      // fail the whole list.
      log.warn({ err, tool: name }, "MCP tools/list: unconvertible schema, omitting tool")
    }
  }
  return [
    ...tools,
    {
      name: LIAISON_TOOL_SEARCH,
      description:
        "Find a Liaison tool by task keywords, when the catalog is too large to scan by eye. Searches the user's CURRENT permissions, so it also finds tools granted after this session loaded its tool list. Returns a compact ranked index (name + one-line description + score). Call a returned name directly when it is in your tool list; when it is not (the permission is newer than your session), call it through liaison_call_tool. If a capability seems missing, it is missing because your scopes exclude it, not because it is hidden: this search comes back empty for a tool you lack the scope for, and kernel__describe_user_access (or an admin) tells you which scope is absent.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      name: LIAISON_CALL_TOOL,
      description:
        "Run any Liaison tool the user holds NOW by its exact name, including one granted after this session loaded its tool list (your client keeps the list it loaded at the start, so a newly granted tool is missing from it until the next session). Use it whenever liaison_tool_search names a tool you cannot call directly. Omit `arguments` to get the tool's description and input schema first; then call again with `arguments` matching that schema. Same permissions, approvals and results as calling the tool directly.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exact tool name from liaison_tool_search" },
          arguments: {
            type: "object",
            description: "The tool's arguments. Omit to get its input schema.",
          },
        },
        required: ["name"],
      },
    },
    {
      name: LIAISON_APPROVAL_STATUS,
      description:
        "Get the status (and result, if approved) of a gated tool approval by approvalRequestId.",
      inputSchema: {
        type: "object",
        properties: { approvalRequestId: { type: "string" } },
        required: ["approvalRequestId"],
      },
    },
  ]
}
