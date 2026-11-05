// SPDX-License-Identifier: FSL-1.1-ALv2

import { isAgentAvatarColor, PERSONAL_AGENT_DISPLAY_NAME } from "@liaison/shared"
import { createStore, reconcile } from "solid-js/store"
import { rememberAgentAvatarColor } from "~/lib/agent-avatar-colors"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { userFromToken } from "~/modules/auth/auth-store"
import {
  makeTabId,
  openTab,
  recanonicalizeTabEntities,
  tabStore,
  updateTabLabel,
} from "~/modules/shell/tab-store"
import { localizeAgentName } from "~/modules/threads/agent-name"

/** How an agent is shown wherever the UI has only its id: a participant row,
 *  a message author, a mention suggestion. */
export interface AgentDisplay {
  id: string
  handle: string
  name: string
  avatarUrl: string | null
  /** The stored slot of the agent avatar palette (0-7), null when the
   *  backend sent none. Also kept in `lib/agent-avatar-colors`, which every
   *  disc reads. */
  avatarColor?: number | null
  /** `role` is the org's own agent, `personal` belongs to one colleague.
   *  Undefined when the backend predates the field. */
  kind?: "role" | "personal" | "system"
  /** Set only on the VIEWER'S OWN personal agent: the listing echoes the owner
   *  for the caller and nobody else (apps/api definition-routes.ts). Null on
   *  every other row, so "mine" is decidable and "whose" is not. */
  ownerUserId?: string | null
  /** What the agents DIRECTORY draws on a card beyond the identity above
   *  (P4c-T34). They live here so one `/agents` read serves both surfaces and
   *  the directory has no reason to fetch the same listing a second time.
   *  Undefined on a backend that does not send the field. */
  purpose?: string | null
  state?: string | null
  channelCount?: number | null
}

interface AgentDirectoryState {
  byId: Record<string, AgentDisplay>
  loaded: boolean
}

const [directory, setDirectory] = createStore<AgentDirectoryState>({ byId: {}, loaded: false })

/** The org's agent list, fetched once per session. The route is the kernel's
 *  agent listing; the client tolerates its absence (an older backend) by
 *  leaving the cache empty rather than failing the surface that asked. */
const AGENTS_PATH = "/agents"

let inFlight: Promise<void> | null = null

function normalizeAgent(row: any): AgentDisplay | null {
  const id = row?.id
  if (typeof id !== "string" || id.length === 0) return null
  const handle = typeof row.handle === "string" ? row.handle : ""
  const name =
    typeof row.displayName === "string" && row.displayName.length > 0
      ? row.displayName
      : typeof row.name === "string" && row.name.length > 0
        ? row.name
        : handle
  const kind =
    row.kind === "role" || row.kind === "personal" || row.kind === "system" ? row.kind : undefined
  const ownerUserId = typeof row.ownerUserId === "string" ? row.ownerUserId : null
  const avatarColor = isAgentAvatarColor(row.avatarColor) ? row.avatarColor : null
  rememberAgentAvatarColor(id, avatarColor)
  return {
    id,
    handle,
    name,
    avatarUrl: row.avatarUrl ?? null,
    avatarColor,
    kind,
    ownerUserId,
    purpose: typeof row.purpose === "string" ? row.purpose : null,
    state: typeof row.state === "string" ? row.state : null,
    channelCount: typeof row.channelCount === "number" ? row.channelCount : null,
  }
}

/** The tab type of ONE agent's page (P4c-T33's namespaced key). */
export const AGENT_PAGE_TAB_TYPE = "agents:agent"

/**
 * The entity id the agent page is addressed by: the HANDLE, the way a person
 * names an agent. An id resolves to its handle through the directory; until
 * that has loaded the id itself is passed through, which the page also
 * accepts (it resolves by id or handle).
 */
export function agentPageEntityId(agentIdOrHandle: string): string {
  if (agentIdOrHandle.startsWith("@")) return agentIdOrHandle
  return getAgentDisplay(agentIdOrHandle)?.handle || agentIdOrHandle
}

/**
 * Open one agent's page. THE single call shape behind every surface that names
 * an agent: the sidebar row, the thread header participant row, the mention
 * chip, the dock tab header, the directory card. They all land on the same tab
 * for the same agent, so opening an agent from anywhere is one tab and not
 * five near-identical ones.
 */
/**
 * The entity id of the VIEWER'S OWN agent page. `self` is only the fallback
 * spelling, kept for the window before the directory has loaded: the page
 * accepts it, but it is a SECOND name for an agent that already has one, so
 * every opener resolves it to the handle as soon as the handle is knowable.
 */
export function personalAgentPageEntityId(): string {
  return personalAgentFor(userFromToken()?.userId)?.handle || "self"
}

/**
 * THE canonical entity id of an agent page: one agent, one spelling, therefore
 * one tab. An id becomes its handle, `self` becomes the viewer's own personal
 * agent's handle, and anything the directory cannot name yet passes through
 * unchanged (the page resolves by id or handle either way).
 */
export function canonicalAgentPageEntityId(entityId: string): string {
  if (entityId === "self") return personalAgentPageEntityId()
  return agentPageEntityId(entityId)
}

/** The name an agent page tab should carry, from the directory. Undefined
 *  until the directory has loaded, which is exactly why the tab label is
 *  re-resolved when it does (see `relabelOpenAgentTabs`). */
export function agentPageLabel(entityId: string): string | undefined {
  const canonical = canonicalAgentPageEntityId(entityId)
  const handle = canonical.startsWith("@") ? canonical : `@${canonical}`
  const agent = Object.values(directory.byId).find(
    (row) => row.handle === handle || row.id === canonical || row.id === entityId,
  )
  return agent?.name ? localizeAgentName(agent.name) : undefined
}

/**
 * A COLD DEEP LOAD lands on `/agents/@handle` before anything has fetched the
 * org's agents, so the tab type's `resolveLabel` has nothing to read and the
 * tab keeps the generic "Agent". The label is re-resolved here the moment the
 * directory arrives, which is the only moment at which the answer changes.
 */
function relabelOpenAgentTabs(): void {
  for (const tab of tabStore.tabs) {
    if (makeTabId(tab.type, tab.entityId) !== makeTabId(AGENT_PAGE_TAB_TYPE, tab.entityId)) continue
    const name = agentPageLabel(tab.entityId)
    if (name && name !== tab.label) updateTabLabel(tab.id, name)
  }
}

export function openAgentPage(agent: { id: string; name?: string; handle?: string }): void {
  const known = getAgentDisplay(agent.id)
  // A caller that already knows the handle (a seat, a directory card) spends no
  // roundtrip; everyone else gets the directory's answer, or the raw id until
  // the directory can give one.
  const entityId =
    agent.handle && agent.handle.startsWith("@")
      ? agent.handle
      : canonicalAgentPageEntityId(agent.id)
  openTab({
    type: AGENT_PAGE_TAB_TYPE,
    entityId,
    label: agent.name || known?.name || entityId,
  })
  // The caller may only have had the uuid (a sidebar row on a cold load): the
  // tab is open under it for now, so ask for the directory and let it re-key
  // the tab onto the handle. Nothing to do once the spelling is canonical.
  if (!entityId.startsWith("@")) ensureAgentDirectory()
}

/**
 * The loader the directory uses when a surface needs it and nothing has asked
 * for it yet. Registered once by the shell, which owns the API client; kept as
 * a hook rather than an import so this module stays free of transport.
 */
let directoryLoader: (() => Promise<void>) | null = null

export function registerAgentDirectoryLoader(load: () => Promise<void>): void {
  directoryLoader = load
}

/**
 * Make sure the directory is on its way. Fire and forget: the callers that
 * need it (openAgentPage on a raw id) are answered by `recanonicalizeTabEntities`
 * when the fetch lands, not by awaiting it here.
 */
export function ensureAgentDirectory(): void {
  if (directory.loaded || !directoryLoader) return
  void directoryLoader()
}

/** Synchronous, cache-only. Returns undefined until `loadAgentDirectory`
 *  has resolved, and for any id the org's agent list does not carry. */
export function getAgentDisplay(agentId: string | null | undefined): AgentDisplay | undefined {
  if (!agentId) return undefined
  const entry = directory.byId[agentId]
  return entry ? readerFacing(entry) : entry
}

/**
 * An agent's CURRENT handle, by id, for a surface that names an agent from a
 * stored mention token (`@[label](agent:<id>)`): the label is a copy of the
 * handle at the time of writing, and a handle can change. Reactive on the
 * directory, which it asks for when it has not loaded yet; undefined until it
 * has, and for an agent the listing does not carry (the caller keeps the
 * stored label).
 */
export function currentAgentHandle(agentId: string): string | undefined {
  const entry = directory.byId[agentId]
  if (!entry) {
    ensureAgentDirectory()
    return undefined
  }
  return entry.handle || undefined
}

/**
 * A personal agent nobody renamed carries the product's default name, stored in English; it
 * reads in the viewer's language on EVERY accessor. Only `getAgentDisplay` did this, so the
 * agent list, the Chats row and the agent page title that read `listAgentDirectory` or
 * `personalAgentFor` printed "Personal agent" in a French UI (third QA walk). A name someone
 * chose is returned as written.
 */
function readerFacing(entry: AgentDisplay): AgentDisplay {
  return entry.name === PERSONAL_AGENT_DISPLAY_NAME
    ? { ...entry, name: localizeAgentName(entry.name) }
    : entry
}

/**
 * The viewer's own Liaison: the personal agent this user owns.
 *
 * The right hand agent panel talks to exactly this agent (the server routes an
 * `agent_chat` thread to the caller's personal agent), and it is the agent the
 * desktop shell means when it offers to run a session on this machine. There
 * is at most one, and `undefined` until the directory has loaded.
 */
export function personalAgentFor(userId: string | null | undefined): AgentDisplay | undefined {
  if (!userId) return undefined
  const entry = Object.values(directory.byId).find(
    (agent) => agent.kind === "personal" && agent.ownerUserId === userId,
  )
  return entry ? readerFacing(entry) : entry
}

/** Every agent in the cache, ordered by handle. */
export function listAgentDirectory(): AgentDisplay[] {
  return Object.values(directory.byId)
    .sort((a, b) => a.handle.localeCompare(b.handle))
    .map(readerFacing)
}

/** Decorate one participant row with the live registry entry for its agent.
 *  Human seats pass through untouched; an agent seat the directory does not
 *  know keeps whatever the server put on the row. */
export function resolveParticipantDisplay<
  T extends {
    id: string
    name: string
    avatarUrl: string | null
    participantType?: "user" | "agent"
    agentId?: string | null
  },
>(participant: T): T {
  if (participant.participantType !== "agent") return participant
  const agent = getAgentDisplay(participant.agentId ?? participant.id)
  if (!agent) return participant
  return {
    ...participant,
    name: agent.name || participant.name,
    avatarUrl: participant.avatarUrl ?? agent.avatarUrl,
  }
}

/**
 * A colour saved for an agent (its Settings tab): the directory entry and the
 * colour every disc reads change together, so each surface repaints at once.
 */
export function setAgentAvatarColor(agentId: string, color: number): void {
  rememberAgentAvatarColor(agentId, color)
  if (directory.byId[agentId]) setDirectory("byId", agentId, "avatarColor", color)
}

export function agentDirectoryLoaded(): boolean {
  return directory.loaded
}

/** Fetch the org's agents once and populate the cache. Concurrent callers
 *  share the one in-flight request; a failed fetch leaves the directory
 *  unloaded so a later caller retries. */
export async function loadAgentDirectory(api: {
  get: (path: string) => Promise<any>
}): Promise<void> {
  if (directory.loaded) return
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const res = await api.get(AGENTS_PATH)
      const raw = res?.data ?? res?.agents ?? res
      const rows = Array.isArray(raw) ? raw : []
      const byId: Record<string, AgentDisplay> = {}
      for (const row of rows) {
        const agent = normalizeAgent(row)
        if (agent) byId[agent.id] = agent
      }
      setDirectory({ byId, loaded: true })
      // Tabs opened before this point were KEYED from nothing (a surface that
      // knew only the agent's uuid) and labelled from nothing. The key first:
      // one agent stays one tab, on `/agents/@handle`.
      recanonicalizeTabEntities(AGENT_PAGE_TAB_TYPE)
      relabelOpenAgentTabs()
    } catch {
      // Best effort: the surfaces that read the directory fall back to the
      // name the server already put on the row.
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export function resetAgentDirectory(): void {
  inFlight = null
  setDirectory("byId", reconcile({}))
  setDirectory("loaded", false)
}
onSessionTeardown(resetAgentDirectory)
