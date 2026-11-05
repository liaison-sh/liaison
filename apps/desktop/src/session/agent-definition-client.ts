// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The composed agent definition a local session runs with: the system prompt,
// the skill index, the scoped memory and the hot MCP tool list, composed by the
// SAME server function the in-app turn goes through
// (`apps/api/src/modules/agent/directory/definition-routes.ts:159`).
//
// It is fetched ONCE per session start and identically whichever group the
// model picker was on. "Local models" and "Liaison models" decide where the
// turn executes and nothing else, so this request carries no runtimeLocation:
// a definition that differed by runtime would make the two halves of the
// product two different agents.
//
// Identity comes from the bearer and from nowhere else. There is no `asUser`
// and there never will be: the route answers a request carrying one with 400
// rather than ignoring it (`definition-routes.ts:160-171`).
//
// NOTE ON ACCESS: the route is gated on the mentionable listing's own
// predicate, so any member who can DM the agent can fetch its definition
// (`kernel:threads:read`, the agent live and in their org). Two refusals
// remain and both have to SURFACE: a 404 for an agent the listing would not
// return, and a 403 for a personal agent a colleague owns, whose definition
// carries that colleague's own memory. A caller handed an empty definition
// would start a session with no system prompt and no skills and look like a
// working but lobotomized agent, so a 403 is its own error type and the window
// says the account cannot read this agent rather than starting the session
// anyway.

export interface AgentDefinition {
  systemPrompt: string
  /**
   * An INDEX, not playbooks. The route used to hand over every skill's whole
   * body and the whole tool catalog, and this composition appended all of it to
   * the system prompt of EVERY local turn (about 63,000 tokens on the owner's
   * personal agent). Both are pointers now, exactly as the in-app turn carries
   * them: a skill body is loaded with skill_read, a tool is found by searching
   * tools.
   */
  skillIndex: unknown[]
  scopedMemory: unknown[]
  /** The tools loaded from the start, never the whole catalog. */
  mcpToolList: unknown[]
}

/**
 * What the agents route calls this agent (`kernel/agents.ts`, the `agent_kind`
 * enum). The desktop uses it for ONE decision: a personal agent keeps the
 * operator's own Claude Code connectors inside a local session, every other
 * kind runs on an isolated config.
 */
export type AgentKind = "personal" | "role" | "system"

/**
 * The definition route answers with the four PARTS
 * (`definition-routes.ts:/:agentId/definition`), never with one composed
 * string: the cloud turn assembles them into separate system parts in
 * `assembleContext`, so there is no server side composed text to copy. This is
 * the desktop's composition, and it renders the parts in the order the
 * server's own budget measures them (`context.ts`,
 * `renderAgentDefinitionText`): the system prompt, the skill index, the memory
 * index, then the hot tool list, every part separated by a blank line. The two
 * preambles below are the same sentences the server measures
 * (`AGENT_DEFINITION_SKILLS_PREAMBLE`, `AGENT_DEFINITION_TOOLS_PREAMBLE`), so
 * the budget the API guards is the budget a session actually carries.
 */
export const SKILLS_PREAMBLE =
  "Each line below names a Liaison skill, served by the Liaison MCP server, never by a local Skill tool: load one by calling the tool mcp__liaison__kernel__skill_read with the skill's exact name, then follow its instructions. mcp__liaison__kernel__skill_search finds one by keyword. Both are loaded from the start: call them directly, no tool search first."

export const TOOLS_PREAMBLE =
  "These are the tools loaded from the start, not the whole catalog: every other tool is found by searching tools with task keywords, then called by the exact name the search returns."

/**
 * What a Liaison tool is called INSIDE a local session: the sidecar registers
 * the Liaison MCP server as `liaison` (`sidecar/auto-policy.ts`
 * `LIAISON_MCP_SERVER`), and the SDK names its tools `mcp__<server>__<tool>`.
 * The definition route answers with the server's own names
 * (`kernel__skill_read`); a hot tool listed under that name is a name the
 * session has no tool for, and a model that called it got "No such tool".
 */
export const LOCAL_TOOL_PREFIX = "mcp__liaison__"

/** `- name: description` for a row carrying both, skipping a row carrying neither. */
function namedLines(rows: unknown[], prefix = ""): string[] {
  return rows
    .map((row) => row as { name?: unknown; description?: unknown })
    .filter((row) => typeof row?.name === "string" && row.name.length > 0)
    .map((row) => {
      const description = typeof row.description === "string" ? row.description : ""
      const name = `${prefix}${row.name as string}`
      return description ? `- ${name}: ${description}` : `- ${name}`
    })
}

export function composeAgentDefinitionText(definition: AgentDefinition): string {
  const parts: string[] = []
  if (definition.systemPrompt) parts.push(definition.systemPrompt)
  const skillLines = namedLines(definition.skillIndex)
  if (skillLines.length > 0) {
    parts.push(`## Skills available\n${SKILLS_PREAMBLE}\n${skillLines.join("\n")}`)
  }
  const memoryLines = definition.scopedMemory
    .map((row) => (row as { line?: unknown })?.line)
    .filter((line): line is string => typeof line === "string" && line.length > 0)
  if (memoryLines.length > 0) parts.push(`## Memory index\n${memoryLines.join("\n")}`)
  const toolLines = namedLines(definition.mcpToolList, LOCAL_TOOL_PREFIX)
  if (toolLines.length > 0) {
    parts.push(`## Liaison tools\n${TOOLS_PREAMBLE}\n${toolLines.join("\n")}`)
  }
  return parts.join("\n\n")
}

/**
 * The checksum of a composed definition: lowercase hex sha256 of its UTF-8
 * text, the SAME function the sidecar audits every turn with
 * (`sidecar/sdk-runner.ts` systemPromptChecksum), so a warm session's stored
 * checksum and its audited one are one value. It is taken BEFORE any cold
 * context is appended: that record changes every cold turn, and who the agent
 * is does not.
 */
export async function definitionChecksum(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

export interface AgentDefinitionOptions {
  serverAddress: string
  accessToken: string
  /**
   * A node job's definition (P4, A30): the server swaps the local session's
   * where-this-runs section for the node's. Absent for a local session.
   */
  runtime?: "node"
  /**
   * The conversation the session runs in. The server then composes the
   * definition under that room's floor (what a cloud turn there would read),
   * not the DM scope a session with no room gets.
   */
  threadId?: string | null
}

export class AgentDefinitionRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "AgentDefinitionRequestError"
    this.status = status
  }
}

/** The account may not read this agent's definition: 403, not an empty one. */
export class AgentDefinitionForbiddenError extends AgentDefinitionRequestError {
  constructor(message: string) {
    super(403, message)
    this.name = "AgentDefinitionForbiddenError"
  }
}

function isDefinition(value: unknown): value is AgentDefinition {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<AgentDefinition>
  return (
    typeof candidate.systemPrompt === "string" &&
    Array.isArray(candidate.skillIndex) &&
    Array.isArray(candidate.scopedMemory) &&
    Array.isArray(candidate.mcpToolList)
  )
}

export async function fetchAgentDefinition(
  agentId: string,
  options: AgentDefinitionOptions,
): Promise<AgentDefinition> {
  const base = options.serverAddress.replace(/\/+$/, "")
  const params = new URLSearchParams()
  if (options.runtime === "node") params.set("runtime", "node")
  if (options.threadId) params.set("threadId", options.threadId)
  const query = params.size > 0 ? `?${params.toString()}` : ""
  const response = await fetch(
    `${base}/api/agents/${encodeURIComponent(agentId)}/definition${query}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${options.accessToken}` },
    },
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
    const message = body?.error?.message ?? `definition request failed (${response.status})`
    if (response.status === 403) throw new AgentDefinitionForbiddenError(message)
    throw new AgentDefinitionRequestError(response.status, message)
  }
  const body = (await response.json()) as { data?: unknown }
  if (!isDefinition(body?.data)) {
    throw new AgentDefinitionRequestError(
      response.status,
      "definition response was not the documented shape",
    )
  }
  return body.data
}

/**
 * Which KIND of agent this is. It costs a SECOND round trip, recorded here
 * because it is a real cost: the definition route carries no `kind` field, and
 * the agents listing (`definition-routes.ts` GET /api/agents) is the only
 * route that does. The two cannot be merged from the desktop side.
 *
 * The listing hides `kind = system` agents (`listing.ts`, `ne(agents.kind,
 * "system")`), so an agent that is not in it is answered as `role` rather than
 * as personal: the kind decides whether the operator's own connectors stay in
 * the session, and the only unsafe answer is the one that keeps them. A
 * listing that cannot be read at all is the same answer, for the same reason.
 */
export async function fetchAgentKind(
  agentId: string,
  options: AgentDefinitionOptions,
): Promise<AgentKind> {
  const base = options.serverAddress.replace(/\/+$/, "")
  const response = await fetch(`${base}/api/agents`, {
    method: "GET",
    headers: { Authorization: `Bearer ${options.accessToken}` },
  })
  if (!response.ok) return "role"
  const body = (await response.json().catch(() => ({}))) as {
    data?: Array<{ id?: unknown; kind?: unknown }>
  }
  const row = (body?.data ?? []).find((agent) => agent?.id === agentId)
  return row?.kind === "personal" || row?.kind === "system" ? row.kind : "role"
}
