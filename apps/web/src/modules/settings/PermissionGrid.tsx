// SPDX-License-Identifier: FSL-1.1-ALv2

import { Check, ChevronDown, Search } from "lucide-solid"
import { type Component, createMemo, createSignal, For, Show, untrack } from "solid-js"
import { categoryChip, scopeIdTitle, scopeLabel } from "~/lib/capability-copy"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"

export interface ScopeCatalogEntry {
  scope: string
  app: string
  description?: string
}

export interface ScopeSource {
  fromRoles: string[]
  direct: boolean
}

export interface PermissionGridProps {
  catalog: ScopeCatalogEntry[]
  granted: string[]
  loading?: boolean
  mode: "edit" | "readonly"
  scopeSource?: (scope: string) => ScopeSource | undefined
  onAdd?: (scope: string) => void | Promise<void>
  onRemove?: (scope: string) => void | Promise<void>
  /** Prefix for data-testid attributes — e.g. "admin-role" or "admin-user" */
  testIdPrefix: string
  /** Input testid override — preserved for backwards compat */
  searchInputTestId?: string
  /** Optional fallback label when no catalog is loaded */
  emptyLabel?: string
  /**
   * Render each row as the WORDS the permission amounts to instead of its
   * `app:resource:action` identifier (charter agent.md: a scope name never
   * reaches the rendered page). The identifier stays in the row's `title`,
   * where an admin can still look it up. Surfaces that exist to author
   * identifiers (the admin roles and users grids) leave it off.
   */
  humanLabels?: boolean
  /**
   * Words for scopes whose identifier means nothing to a reader, whatever
   * `humanLabels` says: an MCP server's `mcp:<slug>` grant reads as the server's
   * name. Undefined keeps the default rendering.
   */
  scopeLabels?: (scope: string) => string | undefined
}

interface AppGroup {
  app: string
  wildcard?: ScopeCatalogEntry
  scopes: ScopeCatalogEntry[]
}

/**
 * The grant that names no app because it names them all. It is what a role
 * agent's ceiling holds, and what the agent Overview renders as "everything
 * this workspace allows"; a grid that only understood an APP wildcard counted
 * it as nothing and printed "0 / 42" beside that sentence.
 */
const GLOBAL_WILDCARD = "*"

/**
 * Synthesize catalog entries for granted scopes that aren't in the published
 * catalog. Lets the grid surface custom/legacy grants instead of hiding them.
 */
function augmentCatalog(catalog: ScopeCatalogEntry[], granted: string[]): ScopeCatalogEntry[] {
  const known = new Set(catalog.map((c) => c.scope))
  const extras: ScopeCatalogEntry[] = []
  for (const scope of granted) {
    // The GLOBAL wildcard names no app, so it is not an app of its own: it is
    // every app at once, handled by `hasGlobalWildcard` below. Synthesizing a
    // catalog entry for it drew an app group literally called "*".
    if (scope === GLOBAL_WILDCARD) continue
    if (known.has(scope)) continue
    const app = scope.split(":")[0] || "other"
    extras.push({ scope, app })
  }
  return extras.length === 0 ? catalog : [...catalog, ...extras]
}

function groupCatalog(catalog: ScopeCatalogEntry[]): AppGroup[] {
  const map = new Map<string, AppGroup>()
  for (const entry of catalog) {
    if (!map.has(entry.app)) map.set(entry.app, { app: entry.app, scopes: [] })
    const bucket = map.get(entry.app)!
    if (entry.scope === entry.app) bucket.wildcard = entry
    else bucket.scopes.push(entry)
  }
  for (const bucket of map.values()) {
    bucket.scopes.sort((a, b) => a.scope.localeCompare(b.scope))
  }
  const apps = [...map.values()]
  apps.sort((a, b) => {
    if (a.app === "kernel") return -1
    if (b.app === "kernel") return 1
    return a.app.localeCompare(b.app)
  })
  return apps
}

export const PermissionGrid: Component<PermissionGridProps> = (props) => {
  const i18n = useI18n()
  const [filter, setFilter] = createSignal("")
  const [manualCollapsed, setManualCollapsed] = createSignal<Set<string>>(new Set())
  const [pendingScopes, setPendingScopes] = createSignal<Set<string>>(new Set())

  /** The app's name for this reader. ONE catalog, translated, for the header
   *  and the rows alike: a local table beside it meant this component called
   *  the same app "Kernel" in its header and "Workspace" in its rows. */
  function groupLabel(app: string): string {
    return categoryChip(app, i18n.t).label
  }

  /** What a row SHOWS, which is what the search box must search. */
  function rowLabel(entry: ScopeCatalogEntry): string {
    const named = props.scopeLabels?.(entry.scope)
    if (named) return named
    return props.humanLabels ? scopeLabel(entry.scope, i18n.t, entry.description) : entry.scope
  }

  /** The label a row SHOWS in place of its identifier, if any. */
  function shownLabel(entry: ScopeCatalogEntry): string | undefined {
    return props.scopeLabels?.(entry.scope) ?? (props.humanLabels ? rowLabel(entry) : undefined)
  }

  const groups = createMemo(() => groupCatalog(augmentCatalog(props.catalog, props.granted)))
  const grantedSet = createMemo(() => new Set(props.granted))
  const filterLower = createMemo(() => filter().trim().toLowerCase())

  const hasGlobalWildcard = createMemo(() => grantedSet().has(GLOBAL_WILDCARD))

  function isWildcardGranted(app: string): boolean {
    return hasGlobalWildcard() || grantedSet().has(app)
  }

  function isPending(scope: string): boolean {
    return pendingScopes().has(scope)
  }

  function isScopeGranted(scope: string): boolean {
    return grantedSet().has(scope)
  }

  function matchesFilter(entry: ScopeCatalogEntry): boolean {
    const q = filterLower()
    if (!q) return true
    if (entry.scope.toLowerCase().includes(q)) return true
    if (entry.description?.toLowerCase().includes(q)) return true
    if (entry.app.toLowerCase().includes(q)) return true
    // A reader searches for what they READ. In `humanLabels` mode that is the
    // phrase, not the identifier, so "edit tasks" has to find its own row.
    if (rowLabel(entry).toLowerCase().includes(q)) return true
    // The app NAME is what the group header shows, in either mode.
    if (groupLabel(entry.app).toLowerCase().includes(q)) return true
    return false
  }

  function filteredScopes(group: AppGroup): ScopeCatalogEntry[] {
    return group.scopes.filter(matchesFilter)
  }

  function visibleGroups(): Array<
    AppGroup & { rows: ScopeCatalogEntry[]; wildcardVisible: boolean }
  > {
    return groups()
      .map((g) => ({
        ...g,
        rows: filteredScopes(g),
        wildcardVisible: !!g.wildcard && (!filterLower() || matchesFilter(g.wildcard)),
      }))
      .filter((g) => g.rows.length > 0 || g.wildcardVisible)
  }

  function appGrantedCount(group: AppGroup): number {
    if (hasGlobalWildcard()) return appTotalCount(group)
    const set = grantedSet()
    let n = 0
    if (group.wildcard && set.has(group.wildcard.scope)) n += 1
    for (const s of group.scopes) if (set.has(s.scope)) n += 1
    return n
  }

  function appTotalCount(group: AppGroup): number {
    return group.scopes.length + (group.wildcard ? 1 : 0)
  }

  function isCollapsed(app: string): boolean {
    // While filtering, force-expand any section with visible rows.
    if (filterLower()) return false
    // Otherwise, default-expand if any scope is granted, else default-collapse.
    const explicit = manualCollapsed().has(app)
    if (explicit) return true
    return false
  }

  function toggleCollapsed(app: string) {
    setManualCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(app)) next.delete(app)
      else next.add(app)
      return next
    })
  }

  async function handleToggle(scope: string, currentlyGranted: boolean) {
    if (props.mode !== "edit") return
    if (isPending(scope)) return
    setPendingScopes((prev) => {
      const next = new Set(prev)
      next.add(scope)
      return next
    })
    try {
      if (currentlyGranted) {
        await props.onRemove?.(scope)
      } else {
        await props.onAdd?.(scope)
      }
    } finally {
      setPendingScopes((prev) => {
        const next = new Set(prev)
        next.delete(scope)
        return next
      })
    }
  }

  async function selectAllInApp(group: AppGroup) {
    if (props.mode !== "edit") return
    const ungranted = untrack(() => {
      const set = grantedSet()
      const out: string[] = []
      if (group.wildcard && !set.has(group.wildcard.scope)) out.push(group.wildcard.scope)
      for (const s of group.scopes) if (!set.has(s.scope)) out.push(s.scope)
      return out
    })
    for (const scope of ungranted) {
      // Sequential to avoid swarming the API; each call is fast.
      await handleToggle(scope, false)
    }
  }

  async function clearAllInApp(group: AppGroup) {
    if (props.mode !== "edit") return
    const granted = untrack(() => {
      const set = grantedSet()
      const out: string[] = []
      if (group.wildcard && set.has(group.wildcard.scope)) out.push(group.wildcard.scope)
      for (const s of group.scopes) if (set.has(s.scope)) out.push(s.scope)
      return out
    })
    for (const scope of granted) {
      await handleToggle(scope, true)
    }
  }

  function rowTestId(scope: string): string {
    if (props.mode !== "edit") return ""
    return isScopeGranted(scope)
      ? `${props.testIdPrefix}-remove-scope-${scope}`
      : `${props.testIdPrefix}-add-scope-${scope}`
  }

  return (
    <div class="flex flex-col gap-3">
      {/* Search bar */}
      <div class="relative">
        <Search
          size={13}
          class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
          aria-hidden
        />
        <input
          type="text"
          placeholder={i18n.t("kernel.searchPermissions")}
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          class="w-full rounded-md border border-border bg-bg/60 py-2 pl-9 pr-3 text-[12.5px] text-text outline-none transition-colors duration-150 placeholder:text-text-tertiary focus:border-accent-muted"
          data-testid={props.searchInputTestId ?? `${props.testIdPrefix}-scope-input`}
          aria-label={i18n.t("kernel.searchPermissions2")}
        />
      </div>

      <Show
        when={!props.loading}
        fallback={
          <div class="flex flex-col gap-2">
            <For each={[0, 1, 2]}>
              {() => (
                <div class="h-9 animate-pulse rounded-md border border-border-subtle bg-surface/40" />
              )}
            </For>
          </div>
        }
      >
        <Show
          when={visibleGroups().length > 0}
          fallback={
            <div class="rounded-md border border-dashed border-border-subtle bg-surface/30 px-3 py-6 text-center text-[12px] text-text-tertiary">
              {filterLower()
                ? i18n.t("kernel.capabilities.noPermissionsMatch", { filter: filter() })
                : (props.emptyLabel ?? i18n.t("kernel.capabilities.noPermissions"))}
            </div>
          }
        >
          <ul class="flex flex-col gap-2">
            <For each={visibleGroups()}>
              {(group) => {
                const collapsed = () => isCollapsed(group.app)
                const grantedCount = () => appGrantedCount(group)
                const totalCount = () => appTotalCount(group)
                const wildcardOn = () => !!group.wildcard && isWildcardGranted(group.app)
                return (
                  <li
                    class={cn(
                      "overflow-hidden rounded-lg border transition-colors duration-150",
                      wildcardOn()
                        ? "border-accent-border bg-accent-subtle"
                        : "border-border-subtle bg-surface/40",
                    )}
                    data-testid={`${props.testIdPrefix}-permission-app-${group.app}`}
                  >
                    {/* App header */}
                    <button
                      type="button"
                      onClick={() => toggleCollapsed(group.app)}
                      class="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors duration-150 hover:bg-surface-hover/40"
                      aria-expanded={!collapsed()}
                      data-testid={`${props.testIdPrefix}-permission-app-header-${group.app}`}
                    >
                      <ChevronDown
                        size={13}
                        class={cn(
                          "shrink-0 text-text-tertiary transition-transform duration-150",
                          collapsed() && "-rotate-90",
                        )}
                        aria-hidden
                      />
                      <span
                        class="font-display text-[13px] font-medium tracking-tight text-text"
                        title={props.humanLabels ? group.app : undefined}
                      >
                        {groupLabel(group.app)}
                      </span>
                      {/* The slug beside the name is an identifier on screen
                          (charter agent.md): the surfaces that author grants
                          keep it, the agent pages never show it. */}
                      <Show when={!props.humanLabels}>
                        <span
                          data-testid={`${props.testIdPrefix}-permission-app-slug-${group.app}`}
                          class="font-mono text-[10.5px] uppercase tracking-wider text-text-tertiary"
                        >
                          {group.app}
                        </span>
                      </Show>
                      <span class="ml-auto flex items-center gap-2">
                        <span
                          class={cn(
                            "rounded-full border px-2 py-[1px] font-mono text-[10px]",
                            grantedCount() > 0
                              ? "border-accent-border bg-accent-glow text-accent"
                              : "border-border-subtle text-text-tertiary",
                          )}
                        >
                          {grantedCount()} / {totalCount()}
                        </span>
                      </span>
                    </button>

                    <Show when={!collapsed()}>
                      <div class="border-t border-border-subtle px-3.5 pb-2.5 pt-2">
                        {/* Section actions — edit only */}
                        <Show when={props.mode === "edit"}>
                          <div class="mb-1.5 flex items-center justify-end gap-3 text-[10.5px] uppercase tracking-wider">
                            <button
                              type="button"
                              class="text-text-tertiary hover:text-text disabled:opacity-30"
                              disabled={grantedCount() === totalCount()}
                              onClick={() => void selectAllInApp(group)}
                              data-testid={`${props.testIdPrefix}-permission-app-select-all-${group.app}`}
                            >
                              {i18n.t("kernel.settingsUi.selectAll")}
                            </button>
                            <span class="text-border" aria-hidden>
                              ·
                            </span>
                            <button
                              type="button"
                              class="text-text-tertiary hover:text-text disabled:opacity-30"
                              disabled={grantedCount() === 0}
                              onClick={() => void clearAllInApp(group)}
                              data-testid={`${props.testIdPrefix}-permission-app-clear-${group.app}`}
                            >
                              {i18n.t("kernel.settingsUi.clear")}
                            </button>
                          </div>
                        </Show>

                        {/* Wildcard row */}
                        <Show when={group.wildcardVisible ? group.wildcard : undefined}>
                          {(wildcard) => {
                            const w = wildcard()
                            const granted = () => isScopeGranted(w.scope)
                            // A global wildcard grants this app's full access
                            // without naming it, exactly as an app wildcard
                            // grants each sub-scope below without naming them.
                            const inherited = () => !granted() && hasGlobalWildcard()
                            const pending = () => isPending(w.scope)
                            return (
                              <ScopeRow
                                scope={w.scope}
                                label={shownLabel(w)}
                                titleText={scopeIdTitle(w.scope, i18n.t)}
                                description={
                                  w.description ??
                                  i18n.t("kernel.capabilities.fullAppAccess", {
                                    app: groupLabel(group.app),
                                  })
                                }
                                isWildcard={true}
                                granted={granted() || inherited()}
                                inherited={inherited()}
                                pending={pending()}
                                mode={props.mode}
                                source={props.scopeSource?.(w.scope)}
                                testId={rowTestId(w.scope)}
                                onToggle={() => void handleToggle(w.scope, granted())}
                              />
                            )
                          }}
                        </Show>

                        {/* Sub-scopes */}
                        <For each={group.rows}>
                          {(entry) => {
                            const granted = () => isScopeGranted(entry.scope)
                            const inherited = () => !granted() && wildcardOn()
                            const pending = () => isPending(entry.scope)
                            return (
                              <ScopeRow
                                scope={entry.scope}
                                label={shownLabel(entry)}
                                titleText={scopeIdTitle(entry.scope, i18n.t)}
                                description={entry.description}
                                isWildcard={false}
                                granted={granted() || inherited()}
                                inherited={inherited()}
                                pending={pending()}
                                mode={props.mode}
                                source={props.scopeSource?.(entry.scope)}
                                testId={rowTestId(entry.scope)}
                                onToggle={() => void handleToggle(entry.scope, granted())}
                              />
                            )
                          }}
                        </For>
                      </div>
                    </Show>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  )
}

// ─── Row primitive ───────────────────────────────────────────────────

interface ScopeRowProps {
  scope: string
  /** The words this permission amounts to; when set it REPLACES the id. */
  label?: string
  /** The hover phrase that carries the identifier, when the label hides it. */
  titleText?: string
  description?: string
  isWildcard: boolean
  granted: boolean
  inherited: boolean
  pending: boolean
  mode: "edit" | "readonly"
  source?: ScopeSource
  testId: string
  onToggle: () => void
}

const ScopeRow: Component<ScopeRowProps> = (props) => {
  const i18n = useI18n()
  const isInteractive = () => props.mode === "edit" && !props.inherited
  return (
    <button
      type="button"
      onClick={() => isInteractive() && props.onToggle()}
      disabled={!isInteractive()}
      data-testid={props.testId || undefined}
      title={props.label ? props.titleText : undefined}
      data-granted={props.granted ? "true" : "false"}
      data-inherited={props.inherited ? "true" : "false"}
      aria-pressed={props.mode === "edit" ? props.granted : undefined}
      class={cn(
        "group flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-150",
        isInteractive() && "hover:bg-surface-hover/60 cursor-pointer",
        !isInteractive() && "cursor-default",
        props.pending && "opacity-50",
      )}
    >
      <Checkbox
        checked={props.granted}
        inherited={props.inherited}
        wildcard={props.isWildcard}
        readonly={props.mode === "readonly"}
      />
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-2">
          <span
            class={cn(
              "font-mono text-[11.5px]",
              props.granted ? "text-text" : "text-text-secondary",
              props.inherited && "text-text-tertiary",
              props.isWildcard && "font-display tracking-tight text-[12.5px] font-medium",
            )}
          >
            {props.isWildcard && !props.label
              ? `${i18n.t("kernel.capabilities.fullAccessPrefix")} · `
              : ""}
            {props.label ?? props.scope}
          </span>
          <Show when={props.inherited}>
            <span class="rounded-full border border-accent-border bg-accent-glow px-1.5 py-[1px] font-mono text-[9.5px] uppercase tracking-wider text-accent">
              {i18n.t("kernel.settingsUi.inherited")}
            </span>
          </Show>
          <Show when={props.mode === "readonly" && props.source}>
            {(source) => (
              <Show when={source().fromRoles.length > 0 || source().direct}>
                <span class="ml-auto text-[10.5px] text-text-tertiary">
                  <Show
                    when={source().direct}
                    fallback={
                      <>
                        {i18n.t("kernel.settingsUi.via")} {source().fromRoles.join(", ")}
                      </>
                    }
                  >
                    {i18n.t("kernel.settingsUi.direct")}
                  </Show>
                </span>
              </Show>
            )}
          </Show>
        </span>
        {/* A labelled row already SAYS the description: repeating it under the
            label is the same sentence twice. */}
        <Show when={!props.label && props.description}>
          <span class="mt-0.5 block text-[11px] leading-snug text-text-tertiary">
            {props.description}
          </span>
        </Show>
      </span>
    </button>
  )
}

interface CheckboxProps {
  checked: boolean
  inherited: boolean
  wildcard: boolean
  readonly: boolean
}

const Checkbox: Component<CheckboxProps> = (props) => {
  return (
    <span
      class={cn(
        "mt-[2px] flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[3px] border transition-colors duration-150",
        !props.checked && "border-border bg-bg/40",
        props.checked && !props.inherited && "border-accent-muted bg-accent text-bg",
        props.inherited && "border-accent-border bg-accent-glow text-accent",
        props.readonly && "opacity-80",
      )}
      aria-hidden
    >
      <Show when={props.checked}>
        <Check size={10} stroke-width={3} />
      </Show>
    </span>
  )
}
