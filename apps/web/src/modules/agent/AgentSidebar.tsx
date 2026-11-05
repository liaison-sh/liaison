// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The Agents app sidebar: a search box, a create action, and the org's agents,
 * one row each.
 *
 * IT IS THE ONLY ROSTER. There is no directory screen beside it any more: the
 * main area always shows an agent, the viewer's own by default, so listing the
 * agents twice (once here, once as cards) said the same thing twice and left
 * the page with nothing of its own to show.
 *
 * Order is the order a person thinks in: their own agent first, the role
 * agents after it, and the org's `@base` system agent last and dimmed, because
 * it is the floor every other agent stands on rather than a colleague. The
 * ordinary listing excludes `kind='system'` (A1), so `@base` shows up only in
 * a listing that carries it at all; the rule lives here so that listing does
 * not need a second one.
 *
 * A41: the listing never carries another user's personal agent (the server
 * omits it), so "the personal agent in this list" is always the viewer's own.
 *
 * THE SEARCH BOX SEARCHES WHAT THE AGENTS CARRY, not only their names: a
 * member typing "refund" wants the skill, the routine or the memory entry
 * without having to guess which agent owns it. One request answers all four
 * kinds (`GET /api/agents/search`), permission-scoped server side, and each
 * hit opens its agent's page on the tab it belongs to with the item selected.
 * It fires only once something is typed, so the sidebar still costs exactly
 * one request on mount.
 *
 * The listing is the shared agent directory the thread surfaces already fetch:
 * one request per session, cached, not a second fetch of the same route.
 */
import { Plus, Search } from "lucide-solid"
import { type Component, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { namespaceRegistryKey } from "~/framework/app-registry"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { makeTabId, openTab, tabStore } from "~/modules/shell/tab-store"
import {
  type AgentDisplay,
  listAgentDirectory,
  loadAgentDirectory,
  personalAgentFor,
} from "~/modules/threads/agent-directory"
import { AgentGlyph } from "~/ui/AgentGlyph"
import { agentAvatarColors } from "~/ui/avatar-palette"

const AGENT_TAB_TYPE = () => namespaceRegistryKey("agents", "agent")

/** How long the box waits before asking, so a typed word is one request and
 *  not one per keystroke. */
const SEARCH_DEBOUNCE_MS = 250

/** The kinds the server groups its answer by, in the order they are read. */
const RESULT_KINDS = ["agents", "skills", "routines", "memories"] as const
type ResultKind = (typeof RESULT_KINDS)[number]

const GROUP_LABEL_KEYS: Record<ResultKind, string> = {
  agents: "kernel.agents.searchGroupAgents",
  skills: "kernel.agents.searchGroupSkills",
  routines: "kernel.agents.searchGroupRoutines",
  memories: "kernel.agents.searchGroupMemory",
}

/** Which of the agent page's tabs a hit of this kind lives on. */
const KIND_TAB: Record<ResultKind, string | null> = {
  agents: null,
  skills: "skills",
  routines: "routines",
  memories: "memory",
}

interface SearchHit {
  kind: ResultKind
  /** What the tab's `?selected=` has to carry to open this very item. */
  selected: string | null
  agentHandle: string
  agentName: string
  label: string
  detail: string
}

/** The org's own floor agent. `kind` is authoritative; the handle is the
 *  fallback for a backend that predates the field. */
function isBaseAgent(agent: AgentDisplay): boolean {
  return agent.kind === "system" || agent.handle === "@base"
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** The server's grouped answer, flattened into rows the sidebar can draw. A
 *  shape it does not recognise yields no hits rather than a broken row. */
export function normalizeSearchHits(raw: any): SearchHit[] {
  const hits: SearchHit[] = []
  for (const kind of RESULT_KINDS) {
    const rows = Array.isArray(raw?.[kind]) ? raw[kind] : []
    for (const row of rows) {
      const agentHandle = text(row?.agentHandle) || text(row?.handle)
      if (!agentHandle) continue
      if (kind === "agents") {
        hits.push({
          kind,
          selected: null,
          agentHandle,
          agentName: text(row?.displayName) || agentHandle,
          label: text(row?.displayName) || agentHandle,
          detail: agentHandle,
        })
        continue
      }
      const selected = kind === "memories" ? text(row?.path) : text(row?.id)
      if (!selected) continue
      hits.push({
        kind,
        selected,
        agentHandle,
        agentName: text(row?.agentName) || agentHandle,
        label: text(row?.name) || selected,
        detail: text(row?.description),
      })
    }
  }
  return hits
}

const AgentSidebar: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [query, setQuery] = createSignal("")
  const [hits, setHits] = createSignal<SearchHit[]>([])
  const [searched, setSearched] = createSignal(false)

  onMount(() => {
    void loadAgentDirectory(api)
  })

  let debounce: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (debounce !== undefined) clearTimeout(debounce)
  })

  /** The newest query owns the answer: a slower earlier request must never
   *  overwrite the rows a later one already put on screen. */
  let inFlight = 0

  async function runSearch(value: string): Promise<void> {
    const ticket = ++inFlight
    try {
      const res = await api.get<any>(`/agents/search?q=${encodeURIComponent(value)}`)
      if (ticket !== inFlight) return
      setHits(normalizeSearchHits(res?.data ?? res))
    } catch {
      // A backend without the route leaves the roster exactly as it was: the
      // sidebar is still a working list of agents.
      if (ticket === inFlight) setHits([])
    } finally {
      if (ticket === inFlight) setSearched(true)
    }
  }

  function onInput(value: string) {
    setQuery(value)
    if (debounce !== undefined) clearTimeout(debounce)
    const trimmed = value.trim()
    if (trimmed.length === 0) {
      inFlight++
      setHits([])
      setSearched(false)
      return
    }
    debounce = setTimeout(() => void runSearch(trimmed), SEARCH_DEBOUNCE_MS)
  }

  const myAgent = createMemo<AgentDisplay | undefined>(() => {
    const all = listAgentDirectory()
    return (
      personalAgentFor(userFromToken()?.userId) ?? all.find((agent) => agent.kind === "personal")
    )
  })

  const rows = createMemo<AgentDisplay[]>(() => {
    const all = listAgentDirectory()
    const mine = myAgent()
    const base = all.filter(isBaseAgent)
    const others = all.filter((agent) => !isBaseAgent(agent) && agent.id !== mine?.id)
    return [...(mine ? [mine] : []), ...others, ...base]
  })

  const groups = createMemo<Array<{ kind: ResultKind; hits: SearchHit[] }>>(() =>
    RESULT_KINDS.map((kind) => ({ kind, hits: hits().filter((h) => h.kind === kind) })).filter(
      (group) => group.hits.length > 0,
    ),
  )

  const searching = () => query().trim().length > 0

  const canCreate = createMemo(() => hasScope("kernel:agents:admin"))

  function isActive(agent: AgentDisplay): boolean {
    return tabStore.activeTabId === makeTabId(AGENT_TAB_TYPE(), agent.handle)
  }

  function openAgent(agent: AgentDisplay) {
    openTab({
      type: AGENT_TAB_TYPE(),
      entityId: agent.handle,
      label: agent.name || agent.handle,
    })
  }

  /** A hit opens its OWN agent's page, on the tab the item lives on, with the
   *  item named in `?selected=`: the same deep link every retired detail
   *  screen redirects to. */
  function openHit(hit: SearchHit) {
    const tab = KIND_TAB[hit.kind]
    const base = `/agents/${hit.agentHandle}`
    const routePath =
      tab && hit.selected ? `${base}/${tab}?selected=${encodeURIComponent(hit.selected)}` : base
    openTab({
      type: AGENT_TAB_TYPE(),
      entityId: hit.agentHandle,
      label: hit.agentName,
      routePath,
    })
  }

  function onCreate() {
    openTab({
      type: AGENT_TAB_TYPE(),
      entityId: "new",
      label: i18n.t("kernel.agents.newAgent"),
      routePath: "/agents/new/settings",
    })
  }

  return (
    <nav data-testid="agent-sidebar" class="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div class="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <div class="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border-subtle px-2 py-1.5">
          <Search size={13} class="shrink-0 text-text-tertiary" />
          <input
            type="search"
            data-testid="agent-sidebar-search"
            value={query()}
            placeholder={i18n.t("kernel.agents.searchPlaceholder")}
            aria-label={i18n.t("kernel.agents.searchPlaceholder")}
            onInput={(e) => onInput(e.currentTarget.value)}
            class="min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-tertiary"
          />
        </div>
        <Show when={canCreate()}>
          <button
            type="button"
            data-testid="agent-sidebar-new-agent"
            title={i18n.t("kernel.agents.newAgent")}
            aria-label={i18n.t("kernel.agents.newAgent")}
            onClick={onCreate}
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border-subtle text-text-secondary transition-colors hover:bg-surface-hover"
          >
            <Plus size={14} />
          </button>
        </Show>
      </div>

      <Show
        when={searching()}
        fallback={
          <div class="flex min-h-0 flex-col py-1">
            <For each={rows()}>
              {(agent) => (
                <button
                  type="button"
                  data-testid={`agent-sidebar-row-${agent.handle}`}
                  data-agent-handle={agent.handle}
                  data-agent-mine={agent.id === myAgent()?.id ? "true" : undefined}
                  data-dimmed={isBaseAgent(agent) ? "true" : undefined}
                  aria-current={isActive(agent) ? "page" : undefined}
                  onClick={() => openAgent(agent)}
                  class={`flex w-full items-center gap-2 px-5 py-2 text-left text-[13px] outline-none transition-colors ${
                    isActive(agent)
                      ? "bg-surface-active font-medium text-text"
                      : "text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
                  } ${isBaseAgent(agent) ? "opacity-60" : ""}`}
                >
                  <span
                    class="flex shrink-0"
                    style={{ color: agentAvatarColors(agent.id, agent.avatarColor).solid }}
                  >
                    <AgentGlyph class="text-[14px]" />
                  </span>
                  <span class="truncate">{agent.name || agent.handle}</span>
                  <Show when={agent.id === myAgent()?.id}>
                    <span class="ml-auto shrink-0 text-[11px] text-text-tertiary">
                      {i18n.t("kernel.agents.yourAgent")}
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        }
      >
        <div data-testid="agent-sidebar-results" class="flex min-h-0 flex-col py-1">
          <For each={groups()}>
            {(group) => (
              <section data-testid={`agent-sidebar-result-group-${group.kind}`}>
                <header class="px-5 pt-3 pb-1 text-[11px] uppercase tracking-wide text-text-tertiary">
                  {i18n.t(GROUP_LABEL_KEYS[group.kind])}
                </header>
                <For each={group.hits}>
                  {(hit) => (
                    <button
                      type="button"
                      data-testid={`agent-sidebar-hit-${group.kind}-${hit.selected ?? hit.agentHandle}`}
                      data-agent-handle={hit.agentHandle}
                      onClick={() => openHit(hit)}
                      class="flex w-full flex-col items-start gap-0.5 px-5 py-2 text-left outline-none transition-colors hover:bg-surface-hover"
                    >
                      <span class="w-full truncate text-[13px] text-text">{hit.label}</span>
                      <span class="w-full truncate text-[11px] text-text-tertiary">
                        {group.kind === "agents" ? hit.detail : hit.agentName}
                      </span>
                    </button>
                  )}
                </For>
              </section>
            )}
          </For>
          <Show when={searched() && groups().length === 0}>
            <p
              data-testid="agent-sidebar-search-empty"
              class="px-5 py-3 text-[12px] text-text-tertiary"
            >
              {i18n.t("kernel.agents.searchEmpty")}
            </p>
          </Show>
        </div>
      </Show>
    </nav>
  )
}

export default AgentSidebar
