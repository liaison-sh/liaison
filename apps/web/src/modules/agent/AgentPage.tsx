// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * One agent's page, at `/agents/:handle`: a header and seven tabs.
 *
 * TABS ARE SUB ROUTES. `Overview` is the page itself (`/agents/:handle`) and
 * every other tab hangs off it (`/agents/:handle/skills`). The tab type
 * declares `preserveSubRoutes`, so the tab store keeps the deeper path instead
 * of rewriting it back to the base on every URL sync, exactly as Settings does.
 *
 * PERMISSION IS ABSENCE, NOT DISABLEMENT. A tab the viewer may not open is not
 * in the document at all: a member sees Overview, Skills, Routines, Memory and
 * Knowledge; `kernel:agents:admin` and a personal agent's OWNER also see
 * Activity and Settings. A disabled control would still tell a member that the
 * agent has settings worth guarding.
 *
 * EVERY PERMITTED TAB STAYS MOUNTED once the agent listing has resolved, the
 * inactive ones hidden, which is the shell's own tab policy. A panel whose
 * content loads ONCE on mount waits for the agent id: mounted against the
 * empty id it would fetch the wrong list, or none, and never retry. The Memory
 * tree in particular keeps its loaded tree, its open file and its scroll across
 * a tab switch, and its fetch is the one this surface has always made on mount.
 *
 * BACKEND CONTRACT. The tab reads and writes the agent's memory tree over
 * three REST calls, all of them under the same scope filter the memory verbs
 * use, so a human never sees a row a turn could not:
 *
 *   GET   /api/agents/:agentId/memory/tree
 *         -> { files: [{ path, name, description, type, modified,
 *                        requiredScopes, sourceKind, threadHandle }],
 *              index: { lines, nearLimit, full } }
 *   GET   /api/agents/:agentId/memory/file?path=<path>
 *         -> { path, content }
 *   PATCH /api/agents/:agentId/memory/file
 *         body { path, content, sourceKind: "human" } -> { path, content }
 *
 * The search box and the forget action add two more, the REST counterparts of
 * the `memory_search` verb and of the per thread forget:
 *
 *   GET   /api/agents/:agentId/memory/search?q=<query>
 *         -> { hits: [{ kind, key, path?, description?, snippet, threadHandle?,
 *                       messageId?, author?, date?, rowId?, requiredScopes,
 *                       fusedScore }] }   scope kernel:agent:memory:read
 *   POST  /api/agents/:agentId/memory/forget
 *         body { threadHandle } -> { episodesDeleted, checkpointsDeleted }
 *         scope kernel:agent:memory:write
 *
 * `threadHandle` is the segment the tree itself uses for a conversation:
 * `episodes/<threadHandle>/<date>.md` and `checkpoints/<threadHandle>.md`.
 *
 * The header and the Overview read ONE more route, the agent page read:
 *
 *   GET   /api/agents/:agentId -> see `AgentDetail`
 *
 * A backend that does not carry the TREE routes yet answers 404, which renders
 * as an EMPTY tree rather than as a failure: the tab is inert, never broken.
 * The search and forget routes degrade DIFFERENTLY on purpose: a 404 there is
 * a visible refusal, because "nothing found" and "this conversation is now
 * forgotten" are claims the tab must never make on a missing route's evidence.
 *
 * VISIBILITY (spec-memory.md, "Human controls"). A personal agent's tab is for
 * its owner and for `kernel:agents:admin`. A role agent's tab is for
 * `kernel:agents:admin` and for anyone holding all of a row's
 * `requiredScopes`, row by row: rows they lack are hidden and counted. The
 * server is the gate; this component's filter is what lets the count be shown.
 */
import { MessageSquare } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onMount,
  Show,
} from "solid-js"
import { rememberAgentAvatarColor } from "~/lib/agent-avatar-colors"
import { ApiError } from "~/lib/api-error"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { createAttachedNodeName } from "~/modules/nodes/agent-node"
import { useApi } from "~/modules/shell/ApiContext"
import { dockAvailable, openConversation } from "~/modules/shell/dock-store"
import { shellTier } from "~/modules/shell/shell-tier"
import { openTab, tabStore, updateTabRoutePath } from "~/modules/shell/tab-store"
import { localizeAgentName } from "~/modules/threads/agent-name"
import { isHomeSurface } from "~/modules/threads/personal-dm-store"
import AgentGlyph from "~/ui/AgentGlyph"
import { AvatarImage } from "~/ui/AvatarImage"
import { agentAvatarStyle } from "~/ui/avatar-palette"
import AgentActivityTab from "./AgentActivityTab"
import AgentKnowledgeTab from "./AgentKnowledgeTab"
import AgentOverviewTab, { type AgentDetail, normalizeAgentDetail } from "./AgentOverviewTab"
import AgentRoutinesTab from "./AgentRoutinesTab"
import AgentSettingsTab from "./AgentSettingsTab"
import AgentSkillsTab from "./AgentSkillsTab"
import Chip from "./Chip"
import MemoryTree from "./MemoryTree"

interface Props {
  entityId: string
}

/** One row of the org's agent listing, as `GET /api/agents` answers it. */
interface AgentRow {
  id: string
  handle: string
  displayName: string
  kind?: "role" | "personal" | "system"
  /** Present only on a backend that discloses it; see `canViewMemory` below. */
  ownerUserId?: string | null
}

/** The tab strip, in order. `overview` is the page's own route. */
const TABS = [
  "overview",
  "skills",
  "routines",
  "memory",
  "knowledge",
  "activity",
  "settings",
] as const
type AgentTab = (typeof TABS)[number]

/** Catalog keys for the tab strip, in the strip's own order. Memory keeps the
 *  key it already had, so nothing that reads it moves. */
const TAB_LABEL_KEYS: Record<AgentTab, string> = {
  overview: "kernel.agents.tabOverview",
  skills: "kernel.agents.tabSkills",
  routines: "kernel.agents.tabRoutines",
  memory: "kernel.agentProfileTabMemory",
  knowledge: "kernel.agents.tabKnowledge",
  activity: "kernel.agents.tabActivity",
  settings: "kernel.agents.tabSettings",
}

/**
 * What each tab's own fetches need, named by the scope its API routes gate on:
 * `/api/agent/skills` and `/api/agent/routines` gate their GET on
 * `kernel:skills:read` and `kernel:routines:read`, and both memory reads the
 * tab makes (`/api/agents/:id/memory/*` and `/api/agent/memories`) gate on
 * `kernel:agent:memory:read`.
 *
 * THE PAGE ANSWERS THE DENIAL ITSELF. Every permitted tab stays mounted and
 * fetches on arrival, so a member who holds none of these met three separate
 * red "Permission denied" toasts before touching anything: the shell turns
 * EVERY 403 into one, whatever the calling store does with the rejection. The
 * session already carries the scopes, so a tab the viewer may not read asks
 * the server nothing and says so quietly instead.
 *
 * Overview and Knowledge are absent on purpose: neither route carries a scope
 * gate, and the Knowledge read degrades to an empty list on a refusal.
 */
const TAB_READ_SCOPES: Partial<Record<AgentTab, string>> = {
  skills: "kernel:skills:read",
  routines: "kernel:routines:read",
  memory: "kernel:agent:memory:read",
}

const KIND_LABEL_KEYS: Record<string, string> = {
  role: "kernel.agents.kindRole",
  personal: "kernel.agents.kindPersonal",
  system: "kernel.agents.kindSystem",
}

function isAgentTab(value: string): value is AgentTab {
  return (TABS as readonly string[]).includes(value)
}

function normalizeRow(raw: any): AgentRow | null {
  if (typeof raw?.id !== "string") return null
  return {
    id: raw.id,
    handle: typeof raw.handle === "string" ? raw.handle : "",
    displayName:
      typeof raw.displayName === "string" && raw.displayName.length > 0
        ? raw.displayName
        : (raw.handle ?? raw.id),
    kind:
      raw.kind === "role" || raw.kind === "personal" || raw.kind === "system"
        ? raw.kind
        : undefined,
    ownerUserId: typeof raw.ownerUserId === "string" ? raw.ownerUserId : null,
  }
}

/** The entity id the sidebar's New agent action opens the page with. */
const CREATE_ENTITY_ID = "new"

/** An agent ID rather than a handle: the page read only accepts one. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const AgentPage: Component<Props> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [rows, setRows] = createSignal<AgentRow[]>([])
  const [loaded, setLoaded] = createSignal(false)

  const basePath = () => `/agents/${props.entityId}`

  /** CREATE MODE (`/agents/new/settings`, the sidebar's New agent action) is
   *  the Settings form with no agent behind it yet. Neither read can resolve
   *  `new`, and that is not a missing agent: the page must never answer it with
   *  "This agent is not available." nor offer the tabs of an agent that does
   *  not exist. It is the form, under a "New agent" heading, and nothing else.
   *  Creating is an agents admin's act (the sidebar offers it to nobody else),
   *  so anyone else still gets the honest not-available answer. */
  const isCreate = () => props.entityId === CREATE_ENTITY_ID && hasScope("kernel:agents:admin")

  /** The tab the URL already names, so a deep link lands where it points. */
  function tabFromRoute(routePath: string | undefined): AgentTab {
    if (!routePath) return "overview"
    const base = basePath()
    if (!routePath.startsWith(base)) return "overview"
    const rest = routePath.slice(base.length).replace(/^\//, "").split(/[?#]/)[0]
    return isAgentTab(rest) ? rest : "overview"
  }

  /** A retired detail link becomes `?selected=<id>` on the tab it belongs to
   *  (P4c FX-F1): a skill or routine id for those tabs, a memory file path for
   *  Memory. The page is what reads it off the route; each tab is what knows
   *  how to open the thing it names. */
  function selectedFromRoute(routePath: string | undefined): string | null {
    if (!routePath) return null
    const q = routePath.indexOf("?")
    if (q === -1) return null
    const value = new URLSearchParams(routePath.slice(q)).get("selected")
    return value && value.length > 0 ? value : null
  }

  /** `&run=<id>`: one run of the selected routine, opened on its transcript. */
  function runFromRoute(routePath: string | undefined): string | null {
    if (!routePath) return null
    const q = routePath.indexOf("?")
    if (q === -1) return null
    const value = new URLSearchParams(routePath.slice(q)).get("run")
    return value && value.length > 0 ? value : null
  }

  const ownTab = () => tabStore.tabs.find((t) => t.entityId === props.entityId)
  const initialRoute = ownTab()?.routePath
  const [tab, setTab] = createSignal<AgentTab>(tabFromRoute(initialRoute))
  /** The deep link's selection, and the tab it was addressed to. It only rides
   *  the URL while its own tab is showing; the viewer picking something else
   *  clears it. */
  const [selected, setSelected] = createSignal<string | null>(selectedFromRoute(initialRoute))
  const [selectedTab, setSelectedTab] = createSignal<AgentTab>(tabFromRoute(initialRoute))
  const selectedFor = (id: AgentTab) =>
    selectedTab() === id ? (selected() ?? undefined) : undefined
  const [selectedRun, setSelectedRun] = createSignal<string | null>(runFromRoute(initialRoute))
  const clearSelected = () => {
    setSelected(null)
    setSelectedRun(null)
  }
  /** The Routines tab opened (or closed) a run: the URL names it. */
  const onRunChanged = (routineId: string, runId: string | null) => {
    setSelectedTab("routines")
    setSelected(routineId)
    setSelectedRun(runId)
  }

  // THE ROUTE IS READ REACTIVELY, not once. The tab's `routePath` can arrive
  // AFTER this component mounts (the shell opens the tab, the page is lazy, and
  // a legacy link is rewritten a navigation later), and a route read only at
  // init dropped the deep link: the page opened on Overview and the URL effect
  // below then rewrote `/agents/:handle/memory` back to the base.
  let lastRoute: string | undefined = initialRoute
  createEffect(() => {
    const route = ownTab()?.routePath
    if (route === lastRoute) return
    lastRoute = route
    setTab(tabFromRoute(route))
    setSelectedTab(tabFromRoute(route))
    setSelected(selectedFromRoute(route))
    setSelectedRun(runFromRoute(route))
  })

  /** THROTTLED IS NOT MISSING. A refused or broken listing leaves the page
   *  with nothing to show and it says the agent is not available. A 429 says
   *  something else entirely: the agent is there and the reader asked too
   *  often, so the page names the throttle and offers the one action that
   *  helps, asking again. */
  const [rateLimited, setRateLimited] = createSignal(false)

  async function loadAgents(): Promise<void> {
    setRateLimited(false)
    try {
      const res = (await api.get<any>("/agents")) ?? []
      const raw = Array.isArray(res) ? res : (res.data ?? [])
      setRows(
        (Array.isArray(raw) ? raw : []).map(normalizeRow).filter((r): r is AgentRow => r !== null),
      )
    } catch (err) {
      // The surface degrades to "not available" rather than to a stack trace.
      if (err instanceof ApiError && err.status === 429) setRateLimited(true)
      setRows([])
    } finally {
      setLoaded(true)
    }
  }

  onMount(() => {
    void loadAgents()
  })

  /** `self` addresses the viewer's own personal agent, so the route is
   *  reachable without knowing an id (the capture walk needs that). The
   *  listing only ever carries the viewer's OWN personal agent: somebody
   *  else's is not theirs to open.
   *
   *  `/agents/:handle` addresses an agent the way people do, so the handle is
   *  accepted as well as the id, with or without its leading `@`. Ids are
   *  uuids and handles start with `@`, so the two namespaces cannot collide. */
  const agent = createMemo<AgentRow | null>(() => {
    const all = rows()
    if (props.entityId === "self") return all.find((r) => r.kind === "personal") ?? null
    const byId = all.find((r) => r.id === props.entityId)
    if (byId) return byId
    const handle = props.entityId.startsWith("@") ? props.entityId : `@${props.entityId}`
    return all.find((r) => r.handle === handle) ?? null
  })

  /** The agent page read (P4c-T31): everything the header and the Overview
   *  show, in one call, so neither has to fan out. A backend without the route
   *  answers 404 and the page falls back to the listing row. */
  const [detail, { refetch: refetchDetail }] = createResource<AgentDetail | null, string>(
    // THE LISTING IS NOT THE ONLY WAY IN. It drops another colleague's
    // personal agent even for an agents admin (`directory/listing.ts`), while
    // the page read answers for one, and every in-app opener that has only an
    // id (a thread header seat, a mention chip) routes by that raw uuid. Read
    // by it when the listing is silent, or an admin opening a colleague's
    // agent lands on "not found" with an empty header.
    () => agent()?.id ?? (UUID_RE.test(props.entityId) ? props.entityId : undefined),
    async (agentId) => {
      try {
        const res = await api.get<any>(`/agents/${agentId}`)
        const read = normalizeAgentDetail(res?.data ?? res)
        // The page read answers for agents the listing withholds: its colour
        // is the one every disc of this agent wears.
        if (read) rememberAgentAvatarColor(read.id, read.avatarColor)
        return read
      } catch (err) {
        // A THROTTLED page read is not a missing agent either (the listing
        // rule, applied to the other read): say so, and offer the retry that
        // asks both of them again.
        if (err instanceof ApiError && err.status === 429) setRateLimited(true)
        return null
      }
    },
  )

  /** WHAT KIND OF AGENT THIS IS, or `undefined` while nothing has said yet.
   *  Either read may be the one that knows: the listing carries the
   *  `kind='system'` row for an agents admin, and the page read is the only
   *  answer for an agent the listing withholds. */
  const agentKind = () => detail()?.kind ?? agent()?.kind

  /** The agent this page is about, from whichever read has it, and whether
   *  ANY read has it: a listing that withholds the row is not an absent agent
   *  when the page read answered for it. */
  // A personal agent nobody renamed reads in the viewer's language (the stored default is
  // English); a chosen name as written.
  const agentName = () => localizeAgentName(agent()?.displayName ?? detail()?.displayName ?? "")
  /** Whose agent this is, by the read that ANSWERED. The page read is the
   *  authority: it discloses the owner to the owner and to an admin and
   *  withholds it from everyone else, so a `null` from it is an answer ("not
   *  yours") and not a gap for the listing's echo to fill. The listing speaks
   *  only while the page read has not. */
  const ownerUserId = () => {
    const answered = detail()
    return answered ? answered.ownerUserId : agent()?.ownerUserId
  }
  const agentHandle = () => agent()?.handle ?? detail()?.handle ?? ""
  /** The id every tab fetches with, from whichever read answered. */
  const agentId = () => agent()?.id ?? detail()?.id ?? ""
  const resolved = () => Boolean(agent() || detail())

  /** Both reads have had their say: until then the page says NOTHING about
   *  whether this agent exists, rather than flashing "not available". */
  const settled = () => loaded() && !detail.loading

  /** The retry asks BOTH reads: either of them can be the throttled one, and
   *  a page read that 429'd once would otherwise stay empty forever. */
  async function retryReads(): Promise<void> {
    await loadAgents()
    void refetchDetail()
  }

  /**
   * @base is a TEMPLATE, never a correspondent (charter agent.md): no Message
   * and no Add to channel on a system agent.
   *
   * UNKNOWN IS NOT "NOT SYSTEM". Both controls stay out of the DOM until the
   * kind is actually known, so a cold deep link cannot flash a Message button
   * on @base for the length of one round trip and then take it away. */
  const canCorrespond = () => agentKind() !== undefined && agentKind() !== "system"

  const isAgentsAdmin = createMemo(() => hasScope("kernel:agents:admin"))

  /** The owner of a PERSONAL agent, by the id the page read discloses (it
   *  discloses it to the owner and to an admin, and to nobody else). The
   *  listing row is the fallback for a backend without the page read. */
  const isOwner = createMemo(() => {
    if (agentKind() !== "personal") return false
    const me = userFromToken()?.userId
    if (!me) return false
    return ownerUserId() === me
  })

  /** Activity and Settings are the administration half of the page. */
  const canAdminister = createMemo(() => isAgentsAdmin() || isOwner())

  const canViewMemory = createMemo(() => {
    // WHICHEVER READ ANSWERED. The listing withholds a colleague's personal
    // agent even from an agents admin, so gating on it alone took the Memory
    // tab off a page the admin is entitled to read in full.
    if (!resolved()) return false
    if (isAgentsAdmin()) return true
    if (agentKind() === "personal") {
      // A backend that discloses the owner is believed; one that does not can
      // only have listed this personal agent to its owner.
      const owner = ownerUserId()
      return owner === null || owner === undefined || owner === userFromToken()?.userId
    }
    return true
  })

  /** May this viewer read what this tab would fetch? */
  const canReadTab = (id: AgentTab) => {
    const scope = TAB_READ_SCOPES[id]
    return !scope || hasScope(scope)
  }

  /** The quiet stand in for a tab whose data this viewer may not read. */
  const noAccess = (id: AgentTab) => (
    <p data-testid={`agent-page-no-access-${id}`} class="px-4 py-6 text-[13px] text-text-tertiary">
      {i18n.t("kernel.agents.noAccess")}
    </p>
  )

  const visibleTabs = createMemo<AgentTab[]>(() =>
    TABS.filter((t) => {
      if (isCreate()) return false
      if (t === "memory") return canViewMemory()
      if (t === "activity" || t === "settings") return canAdminister()
      return true
    }),
  )

  // A tab that stops being visible (a grant revoked mid session, say) must not
  // stay selected: the page falls back to Overview, which everyone who can open
  // the page at all may see.
  //
  // IT MUST NOT JUDGE BEFORE IT CAN (P4c FX-F2). `visibleTabs` is derived from
  // the agent listing and the page read, BOTH of which arrive after mount: for
  // the first frames of a cold load `agent()` is null, so Memory, Activity and
  // Settings are all "not visible" and a deep link to one of them was knocked
  // back to Overview permanently, the URL effect below then rewriting
  // `/agents/:handle/memory` to the bare page. A direct load of the Memory tab
  // and every legacy `/agent/memories` redirect landed on Overview in a real
  // browser while the unit tests, handed a routePath and a resolved listing,
  // stayed green. So: say nothing until the listing has landed, and until the
  // page read that decides `canAdminister` has landed for the agent it found.
  createEffect(() => {
    if (isCreate()) return
    if (!loaded()) return
    if (resolved() && detail.loading) return
    if (!visibleTabs().includes(tab())) setTab("overview")
  })

  // The URL follows the tab, the way Settings and the project workspace do it.
  createEffect(() => {
    const active = isCreate() ? "settings" : tab()
    const own = ownTab()
    if (!own) return
    const base = active === "overview" ? basePath() : `${basePath()}/${active}`
    const sel = selectedTab() === active ? selected() : null
    const run = sel && active === "routines" ? selectedRun() : null
    const next = sel
      ? `${base}?selected=${encodeURIComponent(sel)}${run ? `&run=${encodeURIComponent(run)}` : ""}`
      : base
    if (own.routePath !== next) updateTabRoutePath(own.id, next)
  })

  /** `Message`: the DM with this agent, on the surface that fits where the
   *  user is (the same rule `personal-dm-store` follows for the personal one):
   *  a thread TAB on a Home surface, the chat dock anywhere else. */
  async function message() {
    // Either read identifies the agent: the listing withholds a colleague's
    // personal agent that the page read answers for.
    const id = agentId()
    if (!id) return
    const res = await api.post<any>("/threads/dm", { agentId: id })
    const thread = res?.data ?? res
    const threadId = thread?.id
    if (typeof threadId !== "string" || threadId.length === 0) return
    // Phone: a conversation is a route, never the Chats sheet (F3).
    if (shellTier() === "phone" || (dockAvailable() && isHomeSurface())) {
      openTab({ type: "thread", entityId: threadId, label: agentName() })
      return
    }
    openConversation(threadId)
  }

  // L26: a cloud agent attached to the viewer's node runs there too.
  const attachedNode = createAttachedNodeName(api, () => agentId() || null)
  const runsOnLabel = () =>
    detail()?.runsOn === "local"
      ? i18n.t("kernel.agents.runsOnLocal")
      : attachedNode()
        ? i18n.t("kernel.agents.runsOnLiaisonAndNode", { node: attachedNode() ?? "" })
        : i18n.t("kernel.agents.runsOnLiaison")

  return (
    <div data-testid="agent-profile" class="flex h-full min-h-0 flex-col">
      <div class="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-3">
        <AvatarImage
          url={detail()?.avatarUrl}
          testId="agent-page-avatar"
          class="h-8 w-8 rounded-full object-cover"
          fallback={
            <span
              class="flex h-8 w-8 items-center justify-center rounded-full text-[16px]"
              style={agentAvatarStyle(agentId(), detail()?.avatarColor)}
            >
              <AgentGlyph />
            </span>
          }
        />

        <div class="min-w-0">
          <h1
            data-testid="agent-profile-name"
            class={`text-[15px] font-medium text-text ${resolved() ? "truncate" : ""}`}
          >
            <Show when={!isCreate()} fallback={i18n.t("kernel.agents.newAgent")}>
              <Show
                when={resolved()}
                fallback={
                  // Nothing is claimed while the reads are in flight: the page
                  // used to greet every reader with "not available" for as long
                  // as the listing took.
                  settled()
                    ? rateLimited()
                      ? i18n.t("kernel.agentProfileRateLimited")
                      : i18n.t("kernel.agentProfileNotFound")
                    : ""
                }
              >
                {agentName()}
              </Show>
            </Show>
          </h1>
          {/* THE RETRY IS ABOUT THE THROTTLED READ, not about the page being
              empty: a listing that answered while the page read was throttled
              leaves the purpose, the channels and the picture missing, and
              without this control nothing asks for them again. */}
          <Show when={!isCreate() && settled() && rateLimited() && !detail()}>
            <button
              type="button"
              data-testid="agent-page-retry"
              onClick={() => void retryReads()}
              class="mt-1 rounded-sm border border-border-subtle px-2 py-0.5 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
            >
              {i18n.t("kernel.agentProfileRetry")}
            </button>
          </Show>
          <Show when={!isCreate()}>
            <div class="flex flex-wrap items-center gap-2 text-[12px] text-text-tertiary">
              <span data-testid="agent-page-handle">{agentHandle()}</span>
              <Show when={agentKind()}>
                {(kind) => (
                  <Chip data-testid="agent-page-kind">
                    {KIND_LABEL_KEYS[kind()] ? i18n.t(KIND_LABEL_KEYS[kind()]) : kind()}
                  </Chip>
                )}
              </Show>
              <span data-testid="agent-page-runs-on">{runsOnLabel()}</span>
            </div>
          </Show>
        </div>

        <div class="ml-auto">
          {/* @base is a TEMPLATE, never a correspondent (charter agent.md):
              the system agent offers no Message at all, absent from the DOM
              rather than disabled. Its page stays reachable by URL, which is
              how an admin inspects the template. */}
          <Show when={resolved() && canCorrespond()}>
            <button
              type="button"
              data-testid="agent-page-message"
              onClick={() => void message()}
              class="flex min-h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] text-accent-foreground"
            >
              <MessageSquare size={13} />
              {i18n.t("kernel.agents.message")}
            </button>
          </Show>
        </div>
      </div>

      <Show when={!isCreate()}>
        <div
          role="tablist"
          aria-label={i18n.t("kernel.agents.tablist")}
          class="flex flex-wrap items-center gap-1 border-b border-border-subtle px-2"
        >
          <For each={visibleTabs()}>
            {(id) => (
              <button
                type="button"
                role="tab"
                aria-selected={tab() === id}
                data-agent-tab={id}
                data-testid={id === "memory" ? "agent-profile-tab-memory" : `agent-page-tab-${id}`}
                onClick={() => setTab(id)}
                class="min-h-11 rounded-md px-3 text-[13px] text-text-secondary hover:bg-surface-hover"
                classList={{ "bg-surface-active text-text": tab() === id }}
              >
                {i18n.t(TAB_LABEL_KEYS[id])}
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="min-h-0 flex-1 overflow-auto">
        <div
          data-testid="agent-page-panel-overview"
          style={panelStyle(!isCreate() && tab() === "overview")}
        >
          <AgentOverviewTab
            agentId={agentId()}
            agentName={agentName()}
            detail={detail() ?? null}
            canCorrespond={canCorrespond()}
          />
          {/* Memory is a tab the viewer may not have; saying so on the landing
              tab is how they learn the page is complete for them, rather than
              wondering which tab went missing. */}
          <Show when={settled() && resolved() && !canViewMemory()}>
            <p
              data-testid="agent-profile-memory-denied"
              class="px-4 pb-6 text-[13px] text-text-tertiary"
            >
              {i18n.t("kernel.agentProfileMemoryDenied")}
            </p>
          </Show>
        </div>

        <Show when={resolved() && visibleTabs().includes("skills")}>
          {/* A master/detail tab needs a definite height to split: `h-full` on
              the tab resolves against THIS panel, and a panel of auto height
              collapsed the whole thing into one narrow column with nothing
              beside it. */}
          <div
            data-testid="agent-page-panel-skills"
            class="h-full min-h-0"
            style={panelStyle(tab() === "skills")}
          >
            <Show when={canReadTab("skills")} fallback={noAccess("skills")}>
              <AgentSkillsTab
                agentId={agentId()}
                canCreate={canAdminister()}
                selected={selectedFor("skills")}
                onSelectedCleared={clearSelected}
                active={tab() === "skills"}
              />
            </Show>
          </div>
        </Show>

        <Show when={resolved() && visibleTabs().includes("routines")}>
          <div
            data-testid="agent-page-panel-routines"
            class="h-full min-h-0"
            style={panelStyle(tab() === "routines")}
          >
            <Show when={canReadTab("routines")} fallback={noAccess("routines")}>
              <AgentRoutinesTab
                agentId={agentId()}
                canCreate={canAdminister()}
                selected={selectedFor("routines")}
                run={selectedFor("routines") ? (selectedRun() ?? undefined) : undefined}
                onSelectedCleared={clearSelected}
                onRunChanged={onRunChanged}
                active={tab() === "routines"}
              />
            </Show>
          </div>
        </Show>

        <Show when={canViewMemory()}>
          {/* Memory is master/detail too, so its panel needs the same definite
              height Skills and Routines got: `h-full` on the tab resolves
              against THIS panel, and an auto height one left the tree and the
              editor stacked in one column. */}
          <div
            data-testid="agent-page-panel-memory"
            class="h-full min-h-0"
            style={panelStyle(tab() === "memory")}
          >
            <Show when={canReadTab("memory")} fallback={noAccess("memory")}>
              <MemoryTree
                agentId={agentId()}
                agentName={agentName()}
                selected={selectedFor("memory")}
                onSelectedCleared={clearSelected}
                active={tab() === "memory"}
              />
            </Show>
          </div>
        </Show>

        <Show when={visibleTabs().includes("knowledge")}>
          <div data-testid="agent-page-panel-knowledge" style={panelStyle(tab() === "knowledge")}>
            <AgentKnowledgeTab agentId={agentId()} />
          </div>
        </Show>

        <Show when={resolved() && visibleTabs().includes("activity")}>
          <div data-testid="agent-page-panel-activity" style={panelStyle(tab() === "activity")}>
            <AgentActivityTab agentId={agentId()} />
          </div>
        </Show>

        {/* Create mode has no agent row to wait for, and is the whole page;
            every other spelling waits: mounted against the empty id this read
            is `/api/agents//settings`, a 404 that takes the whole tab down
            with it. */}
        <Show when={isCreate() || (visibleTabs().includes("settings") && resolved())}>
          <div
            data-testid="agent-page-panel-settings"
            style={panelStyle(isCreate() || tab() === "settings")}
          >
            {/* Create mode keeps the raw "new" entity id: there is no agent row yet. */}
            <AgentSettingsTab
              agentId={isCreate() ? CREATE_ENTITY_ID : agentId()}
              runsOn={detail()?.runsOn}
            />
          </div>
        </Show>
      </div>
    </div>
  )
}

/** Inactive panels stay mounted and hidden, the shell's own tab policy. */
function panelStyle(active: boolean) {
  return active ? undefined : { display: "none" }
}

export default AgentPage
