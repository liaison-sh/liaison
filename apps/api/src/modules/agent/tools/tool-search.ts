// SPDX-License-Identifier: FSL-1.1-ALv2
import type { UserContext } from "~/db/rls"
import {
  CONNECTOR_APP,
  connectorSearchHints,
  loadConnectedSystems,
} from "~/modules/agent/context/connected-systems"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import { turnToolScopes } from "~/modules/agent/scopes/effective-scope"
import { listDeferredTools } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import { ensureOrgToolLists } from "~/modules/mcp-client/index"

/**
 * The SDK name of a tool THIS turn can call right now without a search (in
 * its own tool set, not one of the deferred ones) whose name matches `wanted`
 * (compared by `key`), or null. A bare tool name is looked up in the kernel.
 * Judged on the turn's own built tool set: its scopes, hidden apps, read-only
 * and allowlist filters already applied, so a tool the turn cannot call is
 * never announced as loaded. No set on the frame, no claim.
 */
function loadedToolNamed(
  turnToolNames: ReadonlySet<string> | undefined,
  deferred: ReadonlySet<string>,
  wanted: string,
  key: (s: string) => string,
): string | null {
  if (!turnToolNames) return null
  for (const sdkName of turnToolNames) {
    if (deferred.has(sdkName)) continue
    if (key(sdkName) === wanted) return sdkName
    if (sdkName.startsWith("kernel__") && key(sdkName.slice("kernel__".length)) === wanted)
      return sdkName
  }
  return null
}

/**
 * The kernel-tool ctx the real dispatch hands every handler: the `AppContext`
 * built by `createAppContext`, of which this reads the org, the calling user
 * and `scopes` (the actor's scopes, injected by execute-tool). There is NO
 * `actor` on it: an earlier version read `ctx.actor`, which production never
 * set, so every match came back usable and nothing was ever flagged locked.
 */
interface ToolSearchContext {
  orgId: string
  userId?: string
  scopes?: string[]
}

interface ToolSearchResult {
  matches: Array<{
    name: string
    appName: string
    description: string
    // Present + true when the tool EXISTS but the actor lacks the RBAC scope to use it.
    // `requiredScope` is the exact scope to request via request_scope. Surfacing these
    // (rather than silently omitting them) is what stops a weak agent from FABRICATING
    // that it performed a scope-locked action it never could. [[BL-254]] / DECISIONS l500.
    locked?: boolean
    requiredScope?: string
    // Present + true when the tool is CALLABLE only inside a routine tick (web_watch /
    // watch_state). Discoverable here so the routine-authoring agent learns it exists and
    // references it in the routine PROMPT; it cannot be called directly from chat.
    routineOnly?: boolean
  }>
  query: string
  totalDeferredTools: number
  // True when the keyword query matched NOTHING but deferred tools exist, so `matches` is the
  // available deferred catalog (capped) rather than scored keyword hits — a present tool is never
  // invisible behind an imperfect query. The agent should enumerate these, not declare the
  // capability absent. (tool-ergonomics — marco-bulk-import-carrier-rate-sheet.)
  fellBackToCatalog?: boolean
  // Present when usable matches were just LOADED into the run's tool set — tells the model
  // (weak ones especially) it can now call them directly instead of re-searching or refusing.
  note?: string
}

/** "it" or "them", for a note naming `n` tools. */
function itOrThem(n: number): string {
  return n === 1 ? "it" : "them"
}

/**
 * Discovery side-effect: every USABLE match tool_search returns is unlocked for
 * the rest of the run — added to the run frame's `discoveredTools`, which the
 * agent loop's `prepareStep` folds into `activeTools` on the next step (and the
 * chat service persists per-thread). A tool registered after the run built its
 * tool set (an MCP server's list arriving with this search's own dial) joins
 * the set first (`admitTools`), so "call it now" is true on the next step of
 * THIS turn; a match the run still cannot hold is never announced as loaded.
 * Locked matches (missing scope) and routine-only tools are surfaced but never
 * unlocked. Outside a run frame (MCP gateway, direct API) this is a no-op —
 * those callers manage their own state.
 */
function unlockMatches(
  matches: Array<{ name: string; locked?: boolean; routineOnly?: boolean }>,
  /** Matches shown but NOT loaded (weak keyword hits): named so the model knows the door. */
  listedOnly: Array<{ name: string }> = [],
): string | undefined {
  const frame = currentRunContext()
  const discovered = frame?.discoveredTools
  if (!discovered) return undefined
  const usable = matches.filter((m) => !m.locked && !m.routineOnly).map((m) => m.name)
  const callable = frame?.admitTools ? frame.admitTools(usable) : new Set(usable)
  const unlocked: string[] = []
  const already: string[] = []
  const unavailable: string[] = []
  for (const name of usable) {
    if (!callable.has(name)) unavailable.push(name)
    else if (discovered.has(name)) already.push(name)
    else {
      discovered.add(name)
      unlocked.push(name)
    }
  }
  const notLoaded = listedOnly.filter((m) => !discovered.has(m.name)).map((m) => m.name)
  const parts: string[] = []
  if (unlocked.length > 0) {
    // Asked for: a tool an earlier turn listed by name only gets its schema
    // in the next note too.
    frame?.fixedToolList?.requestSchemas?.(unlocked)
    parts.push(
      `LOADED: ${unlocked.join(", ")}. ${howToCall(unlocked, "now")} Do not search for ${itOrThem(unlocked.length)} again.`,
    )
  }
  if (already.length > 0) parts.push(alreadyLoadedNote(already))
  if (unavailable.length > 0) {
    parts.push(
      `Not available to you in this turn: ${unavailable.join(", ")}. Say so rather than searching again.`,
    )
  }
  if (parts.length === 0 && notLoaded.length > 0) {
    parts.push("Nothing loaded: no listed match satisfied every term of the query.")
  }
  if (notLoaded.length > 0) {
    parts.push(
      `Listed but NOT loaded: ${notLoaded.join(", ")}; call one directly or query "select:<name>" to load it.`,
    )
  }
  return parts.length > 0 ? parts.join(" ") : undefined
}

/**
 * Load the named deferred tools into this run, as a tool result that hands the
 * next step does: the step it names is then one call away, not a search. Only
 * tools the turn may call are loaded (its scopes, Off apps and filters, judged
 * as `tool_search` judges them); the note says what was loaded and what is not
 * available. Outside a run frame it loads nothing and says nothing.
 */
export async function loadToolsForNextStep(
  ctx: ToolSearchContext,
  sdkNames: readonly string[],
): Promise<string | undefined> {
  if (!currentRunContext()?.discoveredTools) return undefined
  const actor: UserContext = {
    actorType: "user",
    userId: ctx.userId ?? "",
    orgId: ctx.orgId,
    scopes: turnToolScopes(ctx.scopes ?? [], currentRunContext()),
    dimensionGrants: {},
  }
  const catalog = new Map(
    listDeferredTools(ctx.orgId, actor, "agent", true).map((t) => [t.sdkName, t] as const),
  )
  const matches = sdkNames.map((name) => {
    const t = catalog.get(name)
    // A deferred tool the turn cannot see at all (an Off app, no such tool)
    // is reported as not available, like a locked one.
    return t ? { name, ...(t.locked ? { locked: true } : {}) } : { name, locked: true }
  })
  const note = unlockMatches(matches)
  const unavailable = matches.filter((m) => m.locked).map((m) => m.name)
  return (
    [
      note,
      unavailable.length > 0
        ? `Not available to you in this turn: ${unavailable.join(", ")} (a missing scope or an app that is off). Say so in plain words; an administrator can do this step.`
        : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined
  )
}

/**
 * What a search for tools the turn already holds answers: their exact names,
 * call now. Naming them in a search is asking for them: a tool loaded by name
 * only gets its schema in the note after this step (requestSchemas).
 */
function alreadyLoadedNote(names: readonly string[]): string {
  const unique = [...new Set(names)]
  currentRunContext()?.fixedToolList?.requestSchemas?.(unique)
  return `ALREADY LOADED: ${unique.join(", ")}. ${howToCall(unique, "now")} No search needed.`
}

/**
 * How the loaded `names` are called. On a thread with a fixed tool list
 * (providers/fixed-tool-list.ts) a tool loaded after the list was set is not
 * in it: it is called through kernel__call_tool, and its description and
 * parameters come in the note after this result (guide-notes.ts).
 */
function howToCall(names: readonly string[], when: string): string {
  const listed = currentRunContext()?.fixedToolList?.listed
  const direct = listed ? names.filter((n) => listed.has(n)) : [...names]
  const viaEntry = listed ? names.filter((n) => !listed.has(n)) : []
  const out: string[] = []
  if (direct.length > 0) {
    out.push(
      `Call ${direct.length === names.length ? itOrThem(direct.length) : direct.join(", ")} ${when} by ${direct.length === 1 ? "this exact name" : "these exact names"}.`,
    )
  }
  if (viaEntry.length > 0) {
    out.push(
      `${viaEntry.length === names.length ? (viaEntry.length === 1 ? "It is" : "They are") : `${viaEntry.join(", ")} ${viaEntry.length === 1 ? "is" : "are"}`} not in your tool list: call ${viaEntry.length === 1 ? "it" : "each"} ${when} through kernel__call_tool with {"name": "<exact name>", "arguments": {...}}; ${viaEntry.length === 1 ? "its" : "their"} description and parameters are in a "tools just loaded" note in this conversation.`,
    )
  }
  return out.join(" ")
}

/**
 * True when every usable tool a search would load is already loaded for this
 * run (and callable). Such a search loads nothing new, so it does not count
 * toward the per-turn search limit: it answers with the exact names instead.
 */
function allAlreadyLoaded(
  matches: ReadonlyArray<{ name: string; locked?: boolean; routineOnly?: boolean }>,
): boolean {
  const frame = currentRunContext()
  const discovered = frame?.discoveredTools
  if (!discovered) return false
  const usable = matches.filter((m) => !m.locked && !m.routineOnly).map((m) => m.name)
  if (usable.length === 0) return false
  if (!usable.every((n) => discovered.has(n))) return false
  const callable = frame?.admitTools ? frame.admitTools(usable) : new Set(usable)
  return usable.every((n) => callable.has(n))
}

/** Mark a locked tool's description so the agent (and, via its reply, the chat UI / persona /
 *  judge) sees the capability exists but is permission-blocked, plus the exact next step. */
function describeLocked(description: string, scope: string): string {
  return `🔒 LOCKED — you do NOT have the "${scope}" scope this tool requires. Do NOT call it, pretend you used it or fabricate its result; tell the user in ordinary words which access is missing (never the scope string or the tool name) and offer kernel__request_scope, which takes "${scope}". ${description}`
}

/** Mark a routine-only tool's description so the authoring agent understands it is REFERENCED in a
 *  routine prompt (it runs inside the routine's ticks) — NOT callable from this chat turn. This is
 *  what lets a weak agent learn the real stateful-diff path (web_watch + per-routine watermark)
 *  exists and author a routine prompt around it, instead of improvising a manual dedup workaround. */
function describeRoutineOnly(description: string): string {
  return `⏱ ROUTINE-ONLY — this tool runs INSIDE a routine tick, not in this chat. You CANNOT call it here; instead, REFERENCE it in the prompt of a kernel__create_routine you author (the routine's ticks will call it). ${description}`
}

// Hard limits on what a tool-search RESULT may carry. Discovery is an index,
// not a schema dump: a broad query ("update knowledge document") used to return
// every score>0 tool with its full multi-KB description over MCP — ~100KB in
// one result, blowing the client's tool-result token cap and forcing a
// spill-to-file. The full schema/description still reaches the client through
// the normal catalog surfacing (tools/list after discovery); the search result
// itself stays a compact, grep-able list.
export const TOOL_SEARCH_MAX_RESULTS = 20
export const TOOL_SEARCH_BYTE_BUDGET = 6_000
export const TOOL_SEARCH_SYNOPSIS_CHARS = 140

/**
 * Tool searches a demo visitor's turn may make. A weak model on a turn whose
 * tools were not loaded searched again and again (one live demo turn: eight
 * searches, two of them `select:` with a near-miss name, and no write) until
 * the turn's steps or time ran out. Past the limit a search unlocks nothing
 * more; it still names the tools that exist but are locked. Other orgs have
 * no limit: a request across several apps needs a search per app, and their
 * turns have no step budget for the loop to burn.
 */
export const TOOL_SEARCH_LIMIT_PER_TURN = 6

/** How many loaded tool names the over-the-limit answer lists. */
const LOADED_TOOLS_LISTED = 60

/** One-line synopsis of a tool description: whitespace-flattened, hard-capped. */
export function toolSynopsis(description: string, max = TOOL_SEARCH_SYNOPSIS_CHARS): string {
  const flat = description.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 3).trimEnd()}...`
}

export interface CompactToolHit {
  name: string
  description: string
  score: number
}

/**
 * Project scored matches (already filtered to score>0 and sorted best-first)
 * into the compact index the MCP gateway returns: per hit only
 * { name, one-line description, score }, capped by count AND total bytes, with
 * an honest note when matches were dropped.
 */
export function compactToolSearchResult(
  scored: ReadonlyArray<{ tool: { sdkName: string; description: string }; score: number }>,
  opts?: { maxResults?: number; byteBudget?: number },
): { tools: CompactToolHit[]; totalMatches: number; note?: string } {
  const maxResults = opts?.maxResults ?? TOOL_SEARCH_MAX_RESULTS
  const byteBudget = opts?.byteBudget ?? TOOL_SEARCH_BYTE_BUDGET
  const tools: CompactToolHit[] = []
  let bytes = 0
  for (const s of scored) {
    if (tools.length >= maxResults) break
    const hit: CompactToolHit = {
      name: s.tool.sdkName,
      description: toolSynopsis(s.tool.description),
      score: s.score,
    }
    const hitBytes = JSON.stringify(hit).length + 1
    if (tools.length > 0 && bytes + hitBytes > byteBudget) break
    tools.push(hit)
    bytes += hitBytes
  }
  const omitted = scored.length - tools.length
  return {
    tools,
    totalMatches: scored.length,
    ...(omitted > 0
      ? {
          note: `${omitted} more matches not shown, refine your query to narrow the results. Each shown tool is now in tools/list with its full schema, call it by its exact name.`,
        }
      : {}),
  }
}

/** Every app with a tool registered for the org, On or Off, hot or deferred. */
function orgAppNames(orgId: string): Set<string> {
  const names = new Set<string>()
  for (const [key] of toolRegistry.entriesOf(orgId)) names.add(key[1])
  names.delete("kernel")
  return names
}

/** The minimal shape the keyword scorer needs from a deferred-tool row. */
export interface ScorableDeferredTool {
  toolName: string
  appName: string
  description: string
  /**
   * Words the tool answers to beyond its name, weighed almost like a name part:
   * a connector tool's operation names and connected system ("add_company_note",
   * "crm"), which its static description cannot know.
   */
  keywords?: readonly string[]
}

/**
 * Tokenized keyword scoring shared by the in-agent `tool_search` and the MCP
 * gateway's `liaison_tool_search`. Tokenizes the query on the separators models
 * (and humans) actually type — whitespace, `,` `:` `.` `/` `_` `-` — so
 * "create skill" matches `create_skill` instead of requiring the exact
 * underscore form (the naive single-substring match this replaces made the
 * MCP discovery search return nothing for it).
 */
export function scoreDeferredTools<T extends ScorableDeferredTool>(
  tools: readonly T[],
  query: string,
  /** The org's app names, so a kernel tool is not held to match the app it acts on. */
  opts?: { appNames?: Iterable<string> },
): Array<{ tool: T; score: number; termsMatched: number; termCount: number }> {
  const terms = query
    .toLowerCase()
    .split(/[\s,:./_-]+/)
    .filter(Boolean)
  const appTerms = new Set([...(opts?.appNames ?? [])].map((n) => n.toLowerCase()))
  return tools.map((t) => {
    let score = 0
    let termsMatched = 0
    let termCount = 0
    const nameLower = t.toolName.toLowerCase()
    const nameParts = nameLower.split(/[^a-z0-9]+/)
    const descLower = t.description.toLowerCase()
    const isKernel = t.appName === "kernel"

    for (const term of terms) {
      const before = score
      // Exact name part match (high weight); a singular term also names its
      // plural part ("app" names `apps_set_enabled`).
      if (nameParts.some((p) => p === term || p === `${term}s`)) score += 10
      // A keyword the tool declares for this org (singular or plural either way)
      else if (t.keywords?.some((k) => k === term || k === `${term}s` || `${k}s` === term))
        score += 8
      // Partial name match
      else if (nameLower.includes(term)) score += 5
      // App name match
      else if (t.appName.toLowerCase().includes(term)) score += 6
      // Description match (lower weight)
      else if (descLower.includes(term)) score += 2
      if (score > before) termsMatched++
      // Another app's name is the ARGUMENT of a kernel tool, which acts on
      // apps ("turn the social app off"), not a term the tool must match.
      else if (isKernel && appTerms.has(term)) continue
      termCount++
    }

    return { tool: t, score, termsMatched, termCount }
  })
}

/**
 * The matches a keyword search LOADS, as opposed to lists. A query for
 * `mail:read` used to load its five padded hits: mail__read and then
 * google-drive__read, database__db_read, gitlab__gitlab_read_file and
 * mail__listAccounts, each of those a whole app whose full instruction guide
 * then rode in the cached prefix for the life of the thread. A strong match
 * satisfies EVERY query term and ties the best score; the rest stay listed,
 * one direct call or one `select:` away. A bare app name is a request for that
 * app's whole surface, so every usable hit is strong.
 */
export function strongMatches<T extends { score: number; termsMatched: number; termCount: number }>(
  scored: readonly T[],
  wholeAppQuery: boolean,
): T[] {
  if (wholeAppQuery) return [...scored]
  const top = scored.reduce((best, s) => Math.max(best, s.score), 0)
  return scored.filter((s) => s.score === top && s.termsMatched === s.termCount)
}

/** Words of a request that name no capability ("connect OUR crm"). */
const FILLER_WORDS = new Set(
  "a an the our my your their its it we us i you me to for of in on at with and or from please can could would some do does what how is are be this that".split(
    " ",
  ),
)

/** What a word must score alone to be kept: a tool's name part (10) or keyword (8). */
const NAMED_TERM_SCORE = 8

/**
 * The query a keyword search scores with. A strong match must satisfy every
 * term, so "connect our CRM" loaded nothing for want of "our", and a weak model
 * concluded the capability was missing. Filler words and words no tool answers
 * to at all (a vendor's name: "connect HubSpot") are dropped, but only when
 * every word kept NAMES a tool (a name part or a keyword) or an installed app:
 * a word found only in descriptions ("post" in "post to facebook" with the
 * social app off) must not load whatever mentions it. Null: the query is
 * scored as typed. `outside` holds the dropped words no tool answers to: the
 * name of a system Liaison has no app for (creditOutsideSystemNames).
 */
function loadingTerms(
  tools: readonly ScorableDeferredTool[],
  terms: readonly string[],
  appNames: Iterable<string>,
): { query: string; outside: string[] } | null {
  const apps = [...appNames].map((a) => a.toLowerCase())
  const best = (term: string) =>
    Math.max(0, ...scoreDeferredTools(tools, term, { appNames: apps }).map((s) => s.score))
  const kept = terms.filter((term) => !FILLER_WORDS.has(term) && best(term) > 0)
  if (kept.length === 0 || kept.length === terms.length) return null
  const named = kept.every((term) => best(term) >= NAMED_TERM_SCORE || apps.includes(term))
  if (!named) return null
  const outside = terms.filter((term) => !FILLER_WORDS.has(term) && !kept.includes(term))
  return { query: kept.join(" "), outside }
}

/**
 * A word no tool answers to is the name of a system Liaison has no app for
 * ("connect HubSpot"), and the API connector is the app that connects any such
 * system: its tools answer to that name as a keyword, exactly as they answer
 * to the name of a system already connected (withConnectorHints). So a
 * connector tool is scored on the kept words plus that name, every other tool
 * on the kept words alone. Without it, dropping the name left "connect", and
 * the tool with "connect" in its own name (sending a member a link for their
 * own Gmail) outscored the adapter save that connects the system named.
 */
function creditOutsideSystemNames<T extends ScorableDeferredTool>(
  scored: Array<{ tool: T; score: number; termsMatched: number; termCount: number }>,
  loading: { query: string; outside: string[] },
  appNames: Iterable<string>,
): Array<{ tool: T; score: number; termsMatched: number; termCount: number }> {
  if (loading.outside.length === 0) return scored
  const query = [loading.query, ...loading.outside].join(" ")
  return scored.map((s) => {
    if (s.tool.appName !== CONNECTOR_APP) return s
    const credited = { ...s.tool, keywords: [...(s.tool.keywords ?? []), ...loading.outside] }
    const [rescored] = scoreDeferredTools([credited], query, { appNames })
    return { ...rescored, tool: s.tool }
  })
}

/**
 * The connector tools with this org's connections folded in: the operation
 * names and system as keywords, and a summary leading the description, given
 * enough synopsis room to survive the cut.
 */
function withConnectorHints<T extends ScorableDeferredTool>(
  tools: T[],
  hints: Map<string, { keywords: string[]; summary: string }>,
): Array<T & { synopsisChars?: number }> {
  if (hints.size === 0) return tools
  return tools.map((t) => {
    const hint = t.appName === CONNECTOR_APP ? hints.get(t.toolName) : undefined
    if (!hint) return t
    return {
      ...t,
      keywords: [...(t.keywords ?? []), ...hint.keywords],
      description: `${hint.summary} ${t.description}`,
      synopsisChars: Math.min(Math.max(TOOL_SEARCH_SYNOPSIS_CHARS, hint.summary.length + 80), 480),
    }
  })
}

/**
 * Search deferred (app) tools by name or keyword. Returns matching tools
 * so the model can discover and use them on demand.
 *
 * Follows the Claude Code ToolSearch pattern:
 * - "select:tool_name1,tool_name2" → direct selection by name
 * - keyword search → searches tool names and descriptions
 */
export async function handleToolSearch(
  params: { query: string; maxResults?: number },
  ctx: ToolSearchContext,
): Promise<ToolSearchResult> {
  const { query, maxResults = 5 } = params
  const cap = Math.min(maxResults, 20)

  // THE PER-TURN LIMIT, on a demo visitor's turn only (counted on its run
  // frame). Applied below, once the catalog is known, so a locked tool is
  // still named past it.
  // A search for tools the turn already holds loads nothing, so it answers
  // with their exact names and is not counted: a weak model re-searched
  // loaded tools until the limit, then said it could not run them.
  const frame = currentRunContext()
  const overLimit =
    frame?.visitorTurn === true && (frame.toolSearchCount ?? 0) >= TOOL_SEARCH_LIMIT_PER_TURN
  const countSearch = () => {
    if (frame?.visitorTurn) frame.toolSearchCount = (frame.toolSearchCount ?? 0) + 1
  }

  // includeLocked: surface tools the actor lacks scope for (flagged locked) so a missing
  // permission is a VISIBLE signal at discovery time, not a silent omission the agent
  // papers over with a fabricated result. [[BL-254]] / DECISIONS l500.
  // Judged against the TURN's scope (ceiling ∩ grants), not the actor's alone:
  // a tool outside the acting agent's ceiling is refused at call time, so
  // reporting it as usable ("LOADED") told the agent it could do what it could
  // not, and the refusal that followed read as a failure to cover up.
  const actor: UserContext = {
    actorType: "user",
    userId: ctx.userId ?? "",
    orgId: ctx.orgId,
    scopes: turnToolScopes(ctx.scopes ?? [], currentRunContext()),
    dimensionGrants: {},
  }
  // An MCP connection last dialed before its tool list was stored gets its one dial now
  // (bounded wait), so its tools are in the catalogue this search reads.
  await ensureOrgToolLists(ctx.orgId)
  const allDeferred = withConnectorHints(
    listDeferredTools(ctx.orgId, actor, "agent", true),
    connectorSearchHints(await loadConnectedSystems(ctx.orgId, actor.scopes ?? [])),
  )

  // Discovery result = index, not schema dump: the base description is cut to a
  // one-line synopsis (the full description arrives with the tool itself once
  // loaded). The locked/routine-only behavioral prefixes are added AFTER the
  // cut so they always survive intact.
  const toMatch = (t: (typeof allDeferred)[number]) => {
    const short = toolSynopsis(t.description, t.synopsisChars)
    return {
      name: t.sdkName,
      appName: t.appName,
      description: t.locked
        ? describeLocked(short, t.requiredScope ?? "?")
        : t.routineOnly
          ? describeRoutineOnly(short)
          : short,
      ...(t.locked ? { locked: true, requiredScope: t.requiredScope } : {}),
      ...(t.routineOnly ? { routineOnly: true } : {}),
    }
  }

  // Past the limit: no tool is unlocked, but a tool that exists and is
  // locked is still named, so a missing permission stays a visible fact
  // rather than a gap the agent fills with a made-up result.
  const overLimitAnswer = (): ToolSearchResult => {
    const selectKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "")
    const selectNames = query.startsWith("select:")
      ? query.slice("select:".length).split(",").map(selectKey).filter(Boolean)
      : null
    const locked = allDeferred.filter((t) => t.locked)
    const lockedMatches = (
      selectNames
        ? locked.filter((t) =>
            selectNames.some((n) => selectKey(t.toolName) === n || selectKey(t.sdkName) === n),
          )
        : scoreDeferredTools(locked, query)
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((s) => s.tool)
    )
      .slice(0, cap)
      .map(toMatch)
    const loaded = [...(frame?.discoveredTools ?? [])].sort()
    const listed = loaded.slice(0, LOADED_TOOLS_LISTED)
    return {
      matches: lockedMatches,
      query,
      totalDeferredTools: allDeferred.length,
      note:
        `Search limit reached: this turn has already searched for tools ${TOOL_SEARCH_LIMIT_PER_TURN} times, so no more tools were loaded. ` +
        (lockedMatches.length > 0
          ? "The matches shown exist but are LOCKED: this turn lacks the scope they need, so say so instead of doing their work another way. "
          : "") +
        (listed.length > 0
          ? `The app tools loaded for this turn are: ${listed.join(", ")}${loaded.length > listed.length ? ", and more" : ""}. `
          : "") +
        "Call one of the tools you have now, or answer with what you have and say what you could not do.",
    }
  }

  // Direct selection: "select:tool1,tool2". Models write tool names in every
  // separator style — `tickets__reply`, `tickets:reply`, `tickets.reply`, bare
  // `reply` — so match on a normalized form (any separator run → `__`), not the
  // literal string. A near-miss select that returns [] sends a weak model into
  // a blind-call loop.
  if (query.startsWith("select:")) {
    // Compared with every separator removed: `projects_get`, `projects:get`,
    // `projects.get` and `projects__get` all name `projects__get`. A single
    // underscore between app and tool missed, and the model searched again.
    const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "")
    const names = query.slice("select:".length).split(",").map(key).filter(Boolean)
    const matches = allDeferred.filter((t) =>
      names.some((n) => key(t.toolName) === n || key(t.sdkName) === n),
    )
    const selected = matches.map(toMatch)
    // A name that is no deferred tool may be one the turn already has (a core
    // kernel tool such as memory_view): say so, so it is called, not searched.
    const matchedKeys = new Set(matches.flatMap((t) => [key(t.toolName), key(t.sdkName)]))
    const deferredSdkNames = new Set(allDeferred.map((t) => t.sdkName))
    const hotLoaded: string[] = []
    let unresolved = 0
    for (const n of names) {
      if (matchedKeys.has(n)) continue
      const held = loadedToolNamed(frame?.turnToolNames, deferredSdkNames, n, key)
      if (held) hotLoaded.push(held)
      else unresolved++
    }
    // Every name it asks for is held already: nothing to load, nothing counted.
    const nothingNew =
      unresolved === 0 &&
      selected.length + hotLoaded.length > 0 &&
      selected.every((m) => !m.locked && !m.routineOnly) &&
      (selected.length === 0 || allAlreadyLoaded(selected))
    if (nothingNew) {
      return {
        matches: selected,
        query,
        totalDeferredTools: allDeferred.length,
        note: alreadyLoadedNote([...selected.map((m) => m.name), ...hotLoaded]),
      }
    }
    if (overLimit) return overLimitAnswer()
    countSearch()
    const unlockNote = unlockMatches(selected)
    const loadedNote = hotLoaded.length > 0 ? alreadyLoadedNote(hotLoaded) : undefined
    const note = [unlockNote, loadedNote].filter(Boolean).join(" ")
    return {
      matches: selected,
      query,
      totalDeferredTools: allDeferred.length,
      ...(note ? { note } : {}),
    }
  }

  // Keyword search: score by name and description matches. Tokenize on the
  // separators models actually type (`tickets:reply`, `tickets.reply`,
  // `mail/compose`) — whitespace-only splitting scored those queries 0 against
  // everything and dumped the agent into the catalog fallback.
  const terms = query
    .toLowerCase()
    .split(/[\s,:./]+/)
    .filter(Boolean)

  // A query that names an app exactly (e.g. "tickets") means "show me this
  // app's tools" — return ALL of them (up to the hard cap) instead of an
  // arbitrary maxResults-sized slice of a same-score tie. The tie slice is how
  // `tickets__reply` got crowded out by search/get/create/addNote/assign.
  const appNames = new Set(allDeferred.map((t) => t.appName.toLowerCase()))
  const wholeAppQuery = terms.length === 1 && appNames.has(terms[0])
  const effectiveCap = wholeAppQuery ? Math.max(cap, 20) : cap

  const orgApps = orgAppNames(ctx.orgId)
  const loading = loadingTerms(allDeferred, terms, orgApps)
  const scored = loading
    ? creditOutsideSystemNames(
        scoreDeferredTools(allDeferred, loading.query, { appNames: orgApps }),
        loading,
        orgApps,
      )
    : scoreDeferredTools(allDeferred, query, { appNames: orgApps })

  const ranked = scored
    .filter((s) => s.score > 0)
    // Available tools first, then locked ones (so a usable tool is never crowded out of
    // the cap by a locked one), each group by descending score.
    .sort((a, b) => {
      const al = a.tool.locked ? 1 : 0
      const bl = b.tool.locked ? 1 : 0
      if (al !== bl) return al - bl
      return b.score - a.score
    })
    .slice(0, effectiveCap)
  const matches = ranked.map((s) => toMatch(s.tool))
  const strong = new Set(strongMatches(ranked, wholeAppQuery).map((s) => s.tool.sdkName))
  const strongHits = matches.filter((m) => strong.has(m.name))
  if (allAlreadyLoaded(strongHits)) {
    return {
      matches,
      query,
      totalDeferredTools: allDeferred.length,
      note: alreadyLoadedNote(
        strongHits.filter((m) => !m.locked && !m.routineOnly).map((m) => m.name),
      ),
    }
  }
  if (overLimit) return overLimitAnswer()
  countSearch()

  // NO-EMPTY-WHEN-TOOLS-EXIST fallback (tool-ergonomics — marco-bulk-import-carrier-rate-sheet).
  // A keyword query that scores 0 against every deferred tool would return `matches:[]` while
  // `totalDeferredTools>0` — an INVISIBLE catalog: the agent reasonably concludes "the capability
  // doesn't exist" and refuses, even though a usable tool is sitting right there (e.g. it searched
  // "packaging"/"template"/"shipment" — none a `pack_upsert` name-part — and never saw the one
  // deferred Boxtal tool). When the scored search finds nothing but deferred tools DO exist, surface
  // the deferred catalog itself (available tools first, capped) so a present tool is never hidden
  // behind an imperfect query. The agent still sees totalDeferredTools, and `fellBackToCatalog` flags
  // that these are the available tools rather than keyword hits, so it enumerates instead of refusing.
  if (matches.length === 0 && allDeferred.length > 0) {
    const fallback = [...allDeferred]
      .sort((a, b) => (a.locked ? 1 : 0) - (b.locked ? 1 : 0))
      .slice(0, cap)
      .map(toMatch)
    // Deliberately NOT unlocked: these are an arbitrary catalog sample, not
    // keyword hits — auto-loading them pollutes the run's discovered set (and
    // injects unrelated apps' full instruction blocks). The agent picks the
    // right one and loads it explicitly.
    return {
      matches: fallback,
      query,
      totalDeferredTools: allDeferred.length,
      fellBackToCatalog: true,
      note: `No tool matched "${query}". The matches shown are a sample of the deferred catalog (NOT loaded). Search again with different keywords, or load a specific tool with query "select:<name>".`,
    }
  }

  const note = unlockMatches(
    strongHits,
    matches.filter((m) => !strong.has(m.name) && !m.locked && !m.routineOnly),
  )
  return {
    matches,
    query,
    totalDeferredTools: allDeferred.length,
    ...(note ? { note } : {}),
  }
}
