// SPDX-License-Identifier: FSL-1.1-ALv2

import { Command, Hash, MessageCircle, Search, User } from "lucide-solid"
import { batch, type Component, createEffect, createSignal, For, on, Show } from "solid-js"
import {
  type CommandRegistration,
  getCommands,
  getEntityOpener,
  getTabType,
} from "~/framework/app-registry"
import { ApiError } from "~/lib/api-error"
import { shortApprovalId } from "~/modules/approvals/ApprovalCard"
import { canAccessScope, userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openEntity } from "~/modules/shell/entity-opener"
import { formatKeyLabel } from "~/modules/shell/key-label"
import { openTab } from "~/modules/shell/tab-store"
import { conversationDisplayName } from "~/modules/threads/conversation-display"
import { getThread } from "~/modules/threads/thread-store"
import { createDebouncedSearch } from "~/primitives/createDebouncedSearch"
import { Dialog } from "~/ui/Dialog"

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
}

interface SearchResult {
  type: string
  id: string
  label: string
  secondary?: string
  command?: CommandRegistration
  /** Phase 16.6 — Server may flag results as `source: "external"` for app-routed
   *  entities (e.g. Shopify orders). Grouped under per-app sections in render. */
  source?: "local" | "external"
  /** Phase 16.6 — App namespace owning the result (e.g. "shopify"). */
  app?: string
  /** Phase 16.6 — Server-provided deep-link for external results. */
  deepLink?: string
}

interface SearchResponseThread {
  id: string
  title: string | null
  handle: string
}

interface SearchResponseUser {
  id: string
  name: string
  email: string
}

interface SearchResponseEntity {
  id: string
  entityType?: string
  type?: string
  label?: string
  title?: string
  name?: string
  app?: string
  /**
   * Server-set when the entity originates from an app's external system. The
   * fanout normalizer emits `"external:<app>"` (e.g. `"external:boxtal"`), so
   * this is a free-form string, not the bare `"external"` literal — the
   * ingestion step normalizes any `external*` value to the canonical flag.
   */
  source?: string
  /** Server-set deep-link path. */
  deepLink?: string
}

interface SearchResponse {
  threads?: SearchResponseThread[]
  users?: SearchResponseUser[]
  entities?: SearchResponseEntity[]
}

const CommandPalette: Component<CommandPaletteProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [query, setQuery] = createSignal("")
  const [results, setResults] = createSignal<SearchResult[]>([])
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [searchUnavailable, setSearchUnavailable] = createSignal(false)

  function commandResults(filter?: string): SearchResult[] {
    return getCommands()
      .filter((c) => !c.alias)
      .filter((c) => canAccessScope(c.scope))
      .filter((c) => !filter || c.label.toLowerCase().includes(filter.toLowerCase()))
      .map((c) => ({
        type: "command" as const,
        id: c.id,
        label: c.label,
        // The keystroke is declared as a platform-neutral `mod+<key>` spec:
        // the reader is shown the platform label, never the spec.
        secondary: c.shortcut ? formatKeyLabel(c.shortcut) : undefined,
        command: c,
      }))
  }

  const debouncedSearch = createDebouncedSearch(
    async (q: string) => {
      try {
        const data = await api.get<SearchResponse>(`/search?q=${encodeURIComponent(q)}&limit=5`)
        setSearchUnavailable(false)
        return data
      } catch (err) {
        if (err instanceof ApiError && (err.code === "SEARCH_UNAVAILABLE" || err.status === 503)) {
          setSearchUnavailable(true)
          return { threads: [], users: [], entities: [] } as SearchResponse
        }
        throw err
      }
    },
    {
      delay: 150,
      onResults: (data) => {
        const q = query()
        const items: SearchResult[] = []

        if (data.threads) {
          for (const t of data.threads) {
            // A35: an untitled row is a DM named by its participants, so the
            // hit is named by the same resolver every conversation surface
            // uses. The handle is the fallback only for a row the store has
            // never loaded, which carries no seats to be named by.
            const stored = getThread(t.id)
            items.push({
              type: "thread",
              id: t.id,
              label: stored
                ? conversationDisplayName(stored, userFromToken()?.userId ?? "")
                : (t.title ?? t.handle),
              secondary: t.handle,
            })
          }
        }
        if (data.users) {
          for (const u of data.users) {
            items.push({ type: "user", id: u.id, label: u.name, secondary: u.email })
          }
        }
        if (data.entities) {
          for (const e of data.entities) {
            // The server tags external app hits with `source: "external:<app>"`
            // (the fanout normalizer prefixes the app name — see
            // `external-handlers.ts normalizeHit`). Normalize any `external*`
            // source to the canonical `"external"` so the accessibility filter
            // and the detail-tab routing below treat app-routed hits uniformly.
            const isExternal = typeof e.source === "string" && e.source.startsWith("external")
            const entityType = e.entityType ?? e.type ?? "entity"
            const kind = e.app ? `${e.app}:${e.entityType}` : e.entityType
            items.push({
              type: entityType,
              id: e.id,
              label: e.label ?? e.title ?? e.name ?? e.id,
              // Approvals are cited by uuid in chat: print the first segment
              // next to the kind so a hit found by uuid is recognizable as
              // the one the agent named (the label is only `request-N`).
              secondary:
                entityType === "approval_request" ? `${kind} · ${shortApprovalId(e.id)}` : kind,
              source: isExternal ? "external" : "local",
              app: e.app,
              deepLink: e.deepLink,
            })
          }
        }

        // Defense-in-depth: filter results the user can't open (server should also enforce)
        // Keep "user" results even without a tab type — they're displayed for info/DM intent
        // Phase 16.6 — `source: "external"` results route through the kernel
        // `detail` tab type regardless of their entity-specific type (which the
        // kernel may not have a registration for).
        // Entities with no tab type of their own but a registered entity
        // opener (kernel approval_request opens the thread it lives in) are
        // openable too — filtering on tab type alone silently dropped every
        // approval hit, so searching a `request-N` handle found nothing.
        const accessible = items.filter(
          (r) =>
            r.type === "user" ||
            r.source === "external" ||
            Boolean(getTabType(r.type)) ||
            Boolean(r.app && getEntityOpener(r.app, r.type)),
        )
        setResults([...accessible, ...commandResults(q)])
      },
      onError: () => setResults(commandResults()),
    },
  )

  // Reset state when dialog opens so users don't see stale results
  createEffect(
    on(
      () => props.isOpen,
      (open) => {
        if (open) {
          batch(() => {
            setQuery("")
            setResults(commandResults())
            setSelectedIndex(0)
            setSearchUnavailable(false)
          })
        }
      },
    ),
  )

  function handleOpenChange(open: boolean) {
    if (!open) props.onClose()
  }

  function handleInput(q: string) {
    setQuery(q)
    setSelectedIndex(0)
    if (!q.trim()) {
      setResults(commandResults())
      return
    }
    debouncedSearch(q)
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, results().length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const selected = results()[selectedIndex()]
      if (selected) handleSelect(selected)
    } else if (e.key === "Escape") {
      props.onClose()
    }
  }

  function handleSelect(item: SearchResult) {
    props.onClose()
    if (item.type === "command" && item.command) {
      item.command.execute()
    } else if (item.type === "user") {
      // User results — no dedicated tab type yet (DM feature is future work).
      // Close palette silently; no-op is better than opening a broken tab.
      return
    } else if (item.source === "external" && item.app) {
      // Phase 16.6 — external app-routed result → kernel `detail` tab.
      // entityId is "<appName>/<entity>/<id>"; DetailTab parses it.
      openTab({
        type: "detail",
        entityId: `${item.app}/${item.type}/${item.id}`,
        label: item.label,
      })
    } else if (item.type !== "command" && getTabType(item.type)) {
      openTab({ type: item.type, entityId: item.id, label: item.label })
    } else if (item.type !== "command" && item.app && getEntityOpener(item.app, item.type)) {
      void openEntity(api, item.app, item.type, item.id, item.label)
    }
  }

  const iconFor = (type: string) => {
    if (type === "thread") return <MessageCircle size={14} />
    if (type === "user") return <User size={14} />
    if (type === "command") return <Command size={14} />
    return <Hash size={14} />
  }

  return (
    <Dialog open={props.isOpen} onOpenChange={handleOpenChange}>
      <Dialog.Content
        class="w-[520px] max-w-[min(520px,calc(100vw-2rem))] overflow-hidden border-border bg-bg p-0 shadow-2xl"
        positionerClass="items-start pt-[20vh]"
        overlayClass="bg-black/40 backdrop-blur-0"
      >
        <Dialog.Title class="sr-only">{i18n.t("kernel.commandPalette")}</Dialog.Title>
        <Dialog.Description class="sr-only">
          {i18n.t("kernel.shellUi.searchThreadsPeopleAndCommands")}
        </Dialog.Description>

        <div class="flex items-center gap-2.5 border-b border-border-subtle px-4 py-3">
          <Search size={16} class="shrink-0 text-text-tertiary" />
          <input
            autofocus
            type="text"
            data-testid="command-palette-input"
            placeholder={i18n.t("kernel.searchThreadsPeopleCommands")}
            class="w-full bg-transparent text-[14px] text-text outline-none placeholder:text-text-tertiary"
            value={query()}
            onInput={(e) => handleInput(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        <div class="max-h-[300px] overflow-y-auto py-1">
          <For each={results()}>
            {(item, i) => (
              <button
                type="button"
                class={`flex w-full items-center gap-2.5 px-4 py-2 text-left ${
                  selectedIndex() === i()
                    ? "bg-surface-hover text-text"
                    : "text-text-secondary hover:bg-surface-hover/50"
                }`}
                onClick={() => handleSelect(item)}
                onMouseEnter={() => setSelectedIndex(i())}
              >
                <span class="shrink-0 text-text-tertiary">{iconFor(item.type)}</span>
                <span class="flex-1 truncate text-[13px]">{item.label}</span>
                <Show when={item.secondary}>
                  <span class="shrink-0 text-[11px] text-text-tertiary">{item.secondary}</span>
                </Show>
              </button>
            )}
          </For>
          <Show when={searchUnavailable()}>
            <div
              data-testid="command-palette-search-unavailable"
              class="px-4 py-3 text-center text-[12px] text-text-tertiary"
            >
              {i18n.t("kernel.shellUi.searchIsStartingUpCommandsAre")}
            </div>
          </Show>
          <Show when={results().length === 0 && !searchUnavailable()}>
            <div class="px-4 py-6 text-center text-[13px] text-text-tertiary">
              {i18n.t("kernel.noResultsFound")}
            </div>
          </Show>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}

export default CommandPalette
