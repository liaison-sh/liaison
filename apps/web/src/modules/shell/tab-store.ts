// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { z } from "zod"
import {
  getTabType,
  patternToUrl,
  resolveRegisteredTabType,
  subscribeToTabTypeRemoval,
} from "~/framework/app-registry"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { confirmDiscard, listUnsavedWork } from "~/lib/unsaved-work"
import { shellTier } from "~/modules/shell/shell-tier"

export interface Tab {
  id: string
  type: string
  entityId: string
  label: string
  isPreview: boolean
  routePath?: string
}

// --- Tab close eviction hooks ---
// Per-tab-type evictor: called when the LAST open tab for a given (type,
// entityId) closes, so the owning store can drop its per-entity payload
// (messages, detail record, ...). Kept as a side registry here (not on
// TabTypeRegistration) because kernel AND manifest-registered types both
// need it, and manifest tab types have no code-level hook surface. Registered
// once from bootstrap.ts per store; keyed by normalized type.
const tabEvictors = new Map<string, (entityId: string) => void>()

/** Register an eviction callback for a tab type — called on last-tab-close for an entity. */
export function registerTabEvictor(type: string, evictor: (entityId: string) => void): void {
  tabEvictors.set(normalizeTabType(type), evictor)
}

// --- Entity-id aliases (one entity, one tab) ---
// Some tab types answer to more than one spelling of the SAME entity. The
// agent page is addressed both as `self` (what a link written before the agent
// directory loaded carries) and as the personal agent's handle; they are one
// agent, so they must be one tab and not two side by side. A type registers a
// canonicalizer here and `makeTabId` / `openTab` run every entity id through
// it. Side registry rather than a field on TabTypeRegistration, exactly as the
// evictors above: manifest-registered tab types have no code-level hook.
const tabEntityAliases = new Map<string, (entityId: string) => string>()

/** Register the canonical spelling of an entity id for a tab type. */
export function registerTabEntityAlias(type: string, resolve: (entityId: string) => string): void {
  tabEntityAliases.set(normalizeTabType(type), resolve)
}

/**
 * The canonical entity id for (type, entityId). Identity for any type that has
 * registered no alias. A resolver that cannot answer yet (the directory has
 * not loaded) returns its own argument, so the alias costs nothing before it
 * can be applied and starts collapsing the spellings the moment it can.
 */
export function canonicalEntityId(type: string, entityId: string): string {
  const resolve = tabEntityAliases.get(normalizeTabType(type))
  if (!resolve) return entityId
  try {
    return resolve(entityId) || entityId
  } catch {
    return entityId
  }
}

/** True if any OPEN tab still references (type, entityId) — call AFTER splice. */
function hasOpenTabFor(type: string, entityId: string): boolean {
  const normalized = normalizeTabType(type)
  return tabStore.tabs.some(
    (t) => normalizeTabType(t.type) === normalized && t.entityId === entityId,
  )
}

/** Invoke the registered evictor for (type, entityId) iff no open tab still references it. */
function maybeEvictEntityData(type: string, entityId: string): void {
  const normalized = normalizeTabType(type)
  const evictor = tabEvictors.get(normalized)
  if (!evictor) return
  if (hasOpenTabFor(normalized, entityId)) return
  evictor(entityId)
}

interface TabStoreState {
  tabs: Tab[]
  activeTabId: string | null
  recentlyClosed: Tab[]
}

const STORAGE_KEY = "liaison:tabs"
const MAX_RECENT = 10

// The kernel Home tab, addressed by its fully-qualified registry id. The bare
// alias "home" is AMBIGUOUS — both the kernel (`kernel:home`, url "/") and the
// knowledge app (`knowledge:home`, url "/knowledge") register a local tab type
// named "home", so `resolveRegisteredTabType("home")` returns undefined. A tab
// created with the bare type therefore never resolves to a component and renders
// blank, and its id (`home:home`) never collapses onto the real singleton
// (`kernel:home:home`) that the activity bar + URL sync produce — yielding a
// duplicate, empty "Home" tab. Always address the kernel home by its qualified id.
const HOME_TAB_TYPE = "kernel:home"

function normalizeTabType(type: string): string {
  return resolveRegisteredTabType(type) ?? type
}

export function makeTabId(type: string, entityId: string): string {
  return `${normalizeTabType(type)}:${canonicalEntityId(type, entityId)}`
}

/**
 * True for the persistent kernel Home tab. Compare via normalization — the
 * stored `.type` is the qualified `kernel:home`, never the bare `home` alias,
 * so literal `tab.type === "home"` checks silently never match.
 */
export function isHomeTab(tab: Pick<Tab, "type" | "entityId">): boolean {
  return normalizeTabType(tab.type) === normalizeTabType(HOME_TAB_TYPE) && tab.entityId === "home"
}

function defaultTabPath(type: string, entityId: string): string {
  const reg = getTabType(type)
  return reg ? patternToUrl(reg.urlPattern, entityId) : "/"
}

/**
 * A route written under another spelling of the entity (`/agents/self/routines`
 * for the tab stored under the handle) is the same place: rebase it onto the
 * canonical spelling so its sub route survives normalization.
 */
function rebaseAliasRoute(
  type: string,
  givenEntityId: string,
  entityId: string,
  routePath: string | undefined,
): string | undefined {
  if (!routePath || givenEntityId === entityId) return routePath
  const aliasBase = defaultTabPath(type, givenEntityId)
  const rest = routePath.slice(aliasBase.length)
  if (!routePath.startsWith(aliasBase) || (rest !== "" && !/^[/?#]/.test(rest))) return routePath
  return `${defaultTabPath(type, entityId)}${rest}`
}

/**
 * The route as the tab the entity's canonical spelling names stores it: a URL
 * under an alias (`/agents/self/routines`) becomes the handle's route.
 */
export function canonicalTabRoute(type: string, givenEntityId: string, routePath: string): string {
  const t = normalizeTabType(type)
  return (
    rebaseAliasRoute(t, givenEntityId, canonicalEntityId(t, givenEntityId), routePath) ?? routePath
  )
}

function normalizeRoutePath(type: string, entityId: string, routePath?: string): string {
  const basePath = defaultTabPath(type, entityId)
  const reg = getTabType(type)
  // If the tab type isn't registered yet (e.g. localStorage rehydrated before the
  // owning app's manifest has loaded), preserve any persisted routePath that targets
  // the expected basePath — otherwise we'd strip query/fragment state across reloads.
  if (!reg) {
    if (routePath?.startsWith(basePath)) return routePath
    return basePath
  }
  if (!reg.preserveSubRoutes) return basePath
  if (!routePath) return basePath
  return routePath.startsWith(basePath) ? routePath : basePath
}

// Ephemeral-preview policy (VS Code "preview tab" model, generalized to every
// surface). A tab opens as an ephemeral preview by default — single-click to
// glance, italic label, and only ONE preview tab exists app-wide at a time
// (opening the next screen closes the previous preview). A preview is promoted
// to a permanent tab on genuine engagement: a real edit, in-tab navigation, or
// a double-click (see promoteActiveTab / updateTabRoutePath / TabBar). Callers
// that open something the user just deliberately created pass `preview: false`.
//
// The kernel Home tab is the sole exception: it is the persistent fallback that
// always anchors the tab bar, so it never opens ephemeral.
function defaultPreviewFor(type: string): boolean {
  return normalizeTabType(type) !== normalizeTabType(HOME_TAB_TYPE)
}

function makeHomeTab(): Tab {
  const type = normalizeTabType(HOME_TAB_TYPE)
  return {
    id: makeTabId(type, "home"),
    type,
    entityId: "home",
    label: "Home",
    isPreview: false,
    routePath: "/",
  }
}

function createInitialState(): TabStoreState {
  const home = makeHomeTab()
  return { tabs: [home], activeTabId: home.id, recentlyClosed: [] }
}

const persistedTabSchema = z.object({
  tabs: z.array(
    z.object({
      type: z.string(),
      entityId: z.string(),
      label: z.string(),
      isPreview: z.boolean().optional(),
      routePath: z.string().optional(),
    }),
  ),
  activeTabId: z.string().nullable(),
})

function loadFromStorage(): TabStoreState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const result = persistedTabSchema.safeParse(JSON.parse(raw))
      if (!result.success || result.data.tabs.length === 0) return createInitialState()
      const tabs = result.data.tabs.map((t) => ({
        id: makeTabId(t.type, t.entityId),
        type: normalizeTabType(t.type),
        entityId: t.entityId,
        label: t.label,
        isPreview: false, // Never restore as preview
        routePath: normalizeRoutePath(normalizeTabType(t.type), t.entityId, t.routePath),
      }))
      const restoredActiveId = result.data.activeTabId
      const activeTabId = tabs.some((t) => t.id === restoredActiveId)
        ? restoredActiveId
        : (tabs[0]?.id ?? null)
      return { tabs, activeTabId, recentlyClosed: [] }
    }
  } catch {}
  return createInitialState()
}

function persist(state: TabStoreState): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      tabs: state.tabs.map((t) => ({
        type: t.type,
        entityId: t.entityId,
        label: t.label,
        isPreview: t.isPreview,
        routePath: t.routePath,
      })),
      activeTabId: state.activeTabId,
    }),
  )
}

const [tabStore, setTabStore] = createStore<TabStoreState>(loadFromStorage())
const [tabNavigationVersion, setTabNavigationVersion] = createSignal(0)

// --- First-activation latch (B2) ---
// Tracks which tab ids have ever been active, so MainPanel can lazily mount a
// rehydrated background tab's component only on its first activation instead
// of mounting every persisted tab at boot. A `Set` mirrored to a signal so
// reads are reactive (MainPanel's <Show when={hasTabBeenActive(tab.id)}>)
// without paying store-diffing cost for a value that only ever grows.
// Never unlatches — once mounted, keep-alive semantics are unchanged.
const [_activatedTabIds, _setActivatedTabIds] = createSignal<Set<string>>(
  new Set(tabStore.activeTabId ? [tabStore.activeTabId] : []),
)

/** True once the given tab has been activated at least once (reactive). */
export function hasTabBeenActive(tabId: string): boolean {
  return _activatedTabIds().has(tabId)
}

function latchTabActive(tabId: string): void {
  if (_activatedTabIds().has(tabId)) return
  _setActivatedTabIds((prev) => new Set(prev).add(tabId))
  // First activation of a background tab is the natural lazy-validation
  // trigger (validateTabs() skips never-activated tabs — see B2.1). Fire a
  // single validateEntity check now so a stale entity still gets evicted,
  // just deferred to when the user actually looks at it.
  const tab = tabStore.tabs.find((t) => t.id === tabId)
  if (!tab) return
  const reg = getTabType(tab.type)
  if (!reg?.validateEntity || reg.singleton) return
  void reg
    .validateEntity(tab.entityId)
    .then((valid) => {
      if (!valid) evictTab(tabId)
    })
    .catch(() => {
      // Validation error — don't evict
    })
}

/**
 * Carry a tab's first-activation latch onto a NEW id for the SAME tab.
 *
 * An entity-id alias can only answer once its source has loaded (the agent
 * directory names `self`'s handle after a roundtrip), so a tab opened before
 * that is stored under one id and re-keyed onto the canonical one afterwards
 * (`rehydrateTabs`). The latch is keyed by tab id, so the re-key orphaned it:
 * the tab stayed active, `hasTabBeenActive(tab.id)` went false, and MainPanel's
 * lazy first-mount gate never opened — a cold deep load of `/agents/self/<tab>`
 * showed the right tab, the right label and the right sidebar over an EMPTY
 * body, for ever (P4c FX-F4). A re-key is not a new tab; the latch follows it.
 */
function relatchTabId(oldId: string, newId: string): void {
  if (oldId === newId) return
  if (!_activatedTabIds().has(oldId)) return
  _setActivatedTabIds((prev) => {
    const next = new Set(prev)
    next.delete(oldId)
    next.add(newId)
    return next
  })
}

/** Prune a closed/evicted tab's latch entry — reopening mounts fresh. */
function unlatchTabActive(tabId: string): void {
  if (!_activatedTabIds().has(tabId)) return
  _setActivatedTabIds((prev) => {
    const next = new Set(prev)
    next.delete(tabId)
    return next
  })
}

subscribeToTabTypeRemoval((types) => {
  closeTabsByTypes(types)
})

export { tabNavigationVersion, tabStore }

function bumpTabNavigationVersion(): void {
  setTabNavigationVersion((version) => version + 1)
}

interface OpenTabOptions {
  type: string
  entityId: string
  label: string
  preview?: boolean
  routePath?: string
}

// --- Phone tab cap (M4) ---
// A PHONE KEEPS AT MOST SIX WORKING TABS MOUNTED.
//
// Every open tab stays mounted, hidden with `display: none`, so switching is
// free and scroll position survives (apps/web/CLAUDE.md). On a desktop that is
// a handful of megabytes. On a phone a session that opens ticket after ticket
// through a day of notifications ends up with thirty live components, thirty
// subscriptions and thirty sets of retained messages, and the webview is
// killed in the background: the user comes back to a cold start, which is the
// one thing keep-alive was for.
//
// So the OLDEST hidden tab is closed once the phone is over the cap. Closed,
// not unmounted: a half-open tab that is not in the bar is a tab the user
// cannot get back to or get rid of. Its ROUTE is untouched, so everything is
// one tap away again and reopens in the state the stores still hold.
//
// Nothing is ever taken away that the user is looking at or navigating with:
// the active tab and the five phone roots are never candidates, and neither is
// any singleton (Home and Settings are one instance each by definition).

/** How many non-singleton tabs a phone keeps mounted at once. */
export const PHONE_TAB_CAP = 6

/** The five fixed seats of the phone bar, which are navigation, not work. */
const PHONE_ROOT_TAB_TYPES = new Set([
  "kernel:home",
  "kernel:chats",
  "kernel:work",
  "kernel:search",
  "kernel:settings",
])

// LRU order. A monotonic counter rather than a clock: two activations inside
// one millisecond are common (a tab opened by a deep link and activated in the
// same tick) and would tie, which would make eviction order depend on array
// position instead of use.
let tabUseClock = 0
const tabLastUsed = new Map<string, number>()

function touchTab(tabId: string): void {
  tabUseClock += 1
  tabLastUsed.set(tabId, tabUseClock)
}

/** A tab never used in this session sorts oldest. */
function lastUsed(tabId: string): number {
  return tabLastUsed.get(tabId) ?? 0
}

export interface EvictableTab {
  id: string
  type: string
}

/**
 * Which tabs to close to get back under the cap, OLDEST FIRST.
 *
 * Pure, and exported for the test: the interesting part is the choice, not the
 * store mutation. A tab is a candidate only when it is not the active one, not
 * a phone root, and not a singleton.
 */
export function phoneTabsToEvict(
  tabs: readonly EvictableTab[],
  activeTabId: string | null,
  isSingleton: (type: string) => boolean,
  usedAt: (tabId: string) => number = lastUsed,
  cap: number = PHONE_TAB_CAP,
): string[] {
  const counted = tabs.filter(
    (t) => !isSingleton(t.type) && !PHONE_ROOT_TAB_TYPES.has(normalizeTabType(t.type)),
  )
  const over = counted.length - cap
  if (over <= 0) return []
  return counted
    .filter((t) => t.id !== activeTabId)
    .sort((a, b) => usedAt(a.id) - usedAt(b.id))
    .slice(0, over)
    .map((t) => t.id)
}

/**
 * Closes the oldest hidden tabs until the phone is back under the cap. A no-op
 * on every other tier: a desktop has the memory and the tab bar to show what
 * is open, so nothing is taken away there.
 */
export function enforcePhoneTabCap(): void {
  if (shellTier() !== "phone") return
  const doomed = phoneTabsToEvict(
    tabStore.tabs.map((t) => ({ id: t.id, type: t.type })),
    tabStore.activeTabId,
    (type) => Boolean(getTabType(type)?.singleton),
  )
  for (const id of doomed) closeTab(id)
}

export function openTab(opts: OpenTabOptions): void {
  const type = normalizeTabType(opts.type)
  const reg = getTabType(type)
  // One entity, one tab: `self` and the personal agent's handle name the same
  // agent, so the tab is stored under the canonical spelling whichever the
  // caller used.
  const entityId = canonicalEntityId(type, opts.entityId)
  const id = makeTabId(type, entityId)
  const givenRoute = rebaseAliasRoute(type, opts.entityId, entityId, opts.routePath)
  const routePath = normalizeRoutePath(type, entityId, givenRoute)
  const preview = opts.preview ?? defaultPreviewFor(type)

  setTabStore(
    produce((s) => {
      // Singleton enforcement: if this type is singleton, activate existing tab of same type.
      // Update the entityId so apps that host internal navigation (e.g. Knowledge:
      // `doc-<id>`/`src-<id>` to switch sub-views) see the new value.
      if (reg?.singleton) {
        const existing = s.tabs.find((t) => normalizeTabType(t.type) === type)
        if (existing) {
          const previousId = existing.id
          existing.type = type
          existing.entityId = entityId
          existing.id = makeTabId(type, entityId)
          existing.label = opts.label
          existing.routePath = normalizeRoutePath(type, entityId, givenRoute ?? existing.routePath)
          if (existing.isPreview && (s.activeTabId === previousId || !preview)) {
            existing.isPreview = false
          }
          s.activeTabId = existing.id
          return
        }
      }

      const existing = s.tabs.find((t) => makeTabId(t.type, t.entityId) === id)
      if (existing) {
        const previousId = existing.id
        existing.type = type
        existing.id = id
        // The tab may have been opened under an older spelling of the same
        // entity (`self` before the agent directory could name the handle).
        existing.entityId = entityId
        existing.label = opts.label
        existing.routePath = routePath
        // Promote preview → permanent when re-opened (e.g. double-click)
        if (existing.isPreview && (s.activeTabId === previousId || !preview)) {
          existing.isPreview = false
        }
        s.activeTabId = id
        return
      }

      // Only one ephemeral preview tab exists app-wide: opening any new preview
      // closes the previous one, regardless of its type ("open another screen →
      // the temporary tab auto-closes").
      if (preview) {
        const previewIdx = s.tabs.findIndex((t) => t.isPreview)
        if (previewIdx !== -1) {
          s.tabs.splice(previewIdx, 1)
        }
      }

      s.tabs.push({
        id,
        type,
        entityId,
        label: opts.label,
        isPreview: preview,
        routePath,
      })
      s.activeTabId = id
    }),
  )
  bumpTabNavigationVersion()
  persist(tabStore)
  // openTab always makes its target the active tab (every branch above sets
  // s.activeTabId to it) — latch immediately, same as activateTab.
  if (tabStore.activeTabId) {
    latchTabActive(tabStore.activeTabId)
    touchTab(tabStore.activeTabId)
  }
  // AFTER the new tab is active, so it can never be the one evicted.
  enforcePhoneTabCap()
}

export function closeTab(tabId: string): void {
  const idx = tabStore.tabs.findIndex((t) => t.id === tabId)
  if (idx === -1) return

  let removedTab: Tab | undefined
  setTabStore(
    produce((s) => {
      const removed = s.tabs.splice(idx, 1)[0]
      removedTab = removed

      // Push to recently closed — every tab, app tabs included. Home is the
      // fallback surface the strip recreates by itself, so it is never stacked.
      if (!isHomeTab(removed)) {
        s.recentlyClosed.unshift(removed)
        if (s.recentlyClosed.length > MAX_RECENT) {
          s.recentlyClosed = s.recentlyClosed.slice(0, MAX_RECENT)
        }
      }

      // If we closed the active tab, activate adjacent
      if (s.activeTabId === tabId) {
        if (s.tabs.length > 0) {
          const newIdx = Math.max(0, idx - 1)
          s.activeTabId = s.tabs[newIdx].id
        } else {
          const home = makeHomeTab()
          s.tabs.push(home)
          s.activeTabId = home.id
        }
      }
    }),
  )
  bumpTabNavigationVersion()
  persist(tabStore)
  unlatchTabActive(tabId)
  // A newly-promoted adjacent/home tab bypasses activateTab — latch it directly
  // (activating the active tab on close must never leave it un-mounted).
  if (tabStore.activeTabId) latchTabActive(tabStore.activeTabId)
  // Otherwise this map only grows: every tab ever opened in the session
  // leaves an entry behind, even long after it closes. A later re-open of
  // the same (type, entityId) gets a fresh timestamp from touchTab/activateTab
  // anyway, so dropping it here loses nothing.
  tabLastUsed.delete(tabId)
  // Splice already happened (produce ran synchronously above) — safe to check
  // "any other open tab" now.
  if (removedTab) maybeEvictEntityData(removedTab.type, removedTab.entityId)
}

/**
 * Close every tab except `keepId` and Home, then make `keepId` the active tab
 * (the tab the user pointed at stays, whatever was active before). Each closed
 * tab goes through closeTab, so "Reopen closed tab" restores them.
 */
export function closeOtherTabs(keepId: string): void {
  if (!tabStore.tabs.some((t) => t.id === keepId)) return
  const doomed = () => tabStore.tabs.filter((t) => t.id !== keepId && !isHomeTab(t))
  closeAfterAsking(doomed, keepId)
}

/** Close every tab to the right of `tabId` (Home is never among them), then make `tabId` active. */
export function closeTabsToRight(tabId: string): void {
  if (!tabStore.tabs.some((t) => t.id === tabId)) return
  const doomed = () => {
    const idx = tabStore.tabs.findIndex((t) => t.id === tabId)
    return idx === -1 ? [] : tabStore.tabs.slice(idx + 1).filter((t) => !isHomeTab(t))
  }
  closeAfterAsking(doomed, tabId)
}

/**
 * Closes `doomed()` and activates `keepId`, after asking when one of those
 * tabs holds unsaved work (a draft, a staged file, unsaved edits): the
 * question names what would be lost, and Keep closes nothing.
 */
function closeAfterAsking(doomed: () => Tab[], keepId: string): void {
  const ids = new Set(doomed().map((t) => t.id))
  const items = listUnsavedWork((tabId) => tabId !== undefined && ids.has(tabId))
  confirmDiscard("close-tabs", items, () => {
    // Answered later: the tab pointed at may have closed meanwhile.
    if (!tabStore.tabs.some((t) => t.id === keepId)) return
    activateTab(keepId)
    for (const tab of doomed().reverse()) closeTab(tab.id)
  })
}

/** Whether the tab strip has anything the "close other tabs" entry would close. */
export function hasClosableOthers(keepId: string): boolean {
  return tabStore.tabs.some((t) => t.id !== keepId && !isHomeTab(t))
}

/** Whether any closable tab sits to the right of `tabId`. */
export function hasClosableToRight(tabId: string): boolean {
  const idx = tabStore.tabs.findIndex((t) => t.id === tabId)
  return idx !== -1 && tabStore.tabs.slice(idx + 1).some((t) => !isHomeTab(t))
}

export function activateTab(tabId: string): void {
  latchTabActive(tabId)
  touchTab(tabId)
  if (tabStore.activeTabId === tabId) return
  setTabStore("activeTabId", tabId)
  bumpTabNavigationVersion()
  persist(tabStore)
  enforcePhoneTabCap()
}

export function promoteTab(tabId: string): void {
  const target = tabStore.tabs.find((t) => t.id === tabId)
  if (!target || !target.isPreview) return
  setTabStore(
    produce((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      if (tab) tab.isPreview = false
    }),
  )
  persist(tabStore)
}

/**
 * Promote the active tab from ephemeral preview to permanent. Called from the
 * genuine-engagement signals: a real content edit (input/change inside the tab
 * body — see MainPanel) and in-tab navigation (see updateTabRoutePath). Cheap
 * no-op once the tab is already permanent.
 */
export function promoteActiveTab(): void {
  const id = tabStore.activeTabId
  if (id) promoteTab(id)
}

export function reopenLastClosed(): void {
  if (tabStore.recentlyClosed.length === 0) return
  setTabStore(
    produce((s) => {
      const tab = s.recentlyClosed.shift()!
      // Already open (a single-instance app tab opened again meanwhile): focus it.
      const open = s.tabs.find(
        (t) =>
          t.id === tab.id ||
          (getTabType(tab.type)?.singleton === true &&
            normalizeTabType(t.type) === normalizeTabType(tab.type)),
      )
      if (open) {
        s.activeTabId = open.id
        return
      }
      tab.isPreview = false
      s.tabs.push(tab)
      s.activeTabId = tab.id
    }),
  )
  persist(tabStore)
}

export function reorderTabs(fromIndex: number, toIndex: number): void {
  if (fromIndex === toIndex) return
  setTabStore(
    produce((s) => {
      const [moved] = s.tabs.splice(fromIndex, 1)
      s.tabs.splice(toIndex, 0, moved)
    }),
  )
  persist(tabStore)
}

export function updateTabLabel(tabId: string, label: string): void {
  setTabStore(
    produce((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      if (tab) tab.label = label
    }),
  )
  persist(tabStore)
}

export function updateTabRoutePath(tabId: string, routePath: string): void {
  const tab = tabStore.tabs.find((entry) => entry.id === tabId)
  if (!tab) return
  const nextPath = normalizeRoutePath(tab.type, tab.entityId, routePath)
  if (tab.routePath === nextPath) return
  setTabStore(
    produce((s) => {
      const current = s.tabs.find((entry) => entry.id === tabId)
      if (current) {
        current.routePath = nextPath
        // In-tab navigation is genuine engagement — promote an ephemeral
        // preview to a permanent tab so it survives opening the next screen.
        current.isPreview = false
      }
    }),
  )
  persist(tabStore)
}

/** URL → Tab: data-driven from tab type registry */
export function tabToUrl(tab: Tab): string {
  const reg = getTabType(tab.type)
  if (!reg) return "/"
  return normalizeRoutePath(tab.type, tab.entityId, tab.routePath)
}

/** Remove a tab silently (no recently-closed tracking) — used for stale tab eviction */
function evictTab(tabId: string): void {
  const idx = tabStore.tabs.findIndex((t) => t.id === tabId)
  if (idx === -1) return
  const wasActive = tabStore.activeTabId === tabId
  let removedTab: Tab | undefined
  setTabStore(
    produce((s) => {
      removedTab = s.tabs.splice(idx, 1)[0]
      if (s.activeTabId === tabId) {
        if (s.tabs.length > 0) {
          s.activeTabId = s.tabs[Math.max(0, idx - 1)].id
        } else {
          const home = makeHomeTab()
          s.tabs.push(home)
          s.activeTabId = home.id
        }
      }
    }),
  )
  // When the evicted tab was active, the Shell's tab→URL effect needs to
  // navigate to the new active tab's URL. The effect gates on
  // `tabNavigationVersion` so the URL→tab effect doesn't fight back — bump
  // it here so eviction-driven URL changes actually fire.
  if (wasActive) bumpTabNavigationVersion()
  persist(tabStore)
  unlatchTabActive(tabId)
  if (wasActive && tabStore.activeTabId) latchTabActive(tabStore.activeTabId)
  if (removedTab) maybeEvictEntityData(removedTab.type, removedTab.entityId)
}

/**
 * Evict the tab holding a given (type, entityId) — silent, no recently-closed
 * tracking. Views that discover their own entity no longer exists (404 /
 * zero-knowledge denial) call this to remove their dangling tab; manifest-app
 * tab types have no validateEntity hook (kernel-only capability), so
 * validateTabs() can't do it for them.
 */
export function evictTabByEntity(type: string, entityId: string): void {
  const normalized = normalizeTabType(type)
  const tab = tabStore.tabs.find(
    (t) => normalizeTabType(t.type) === normalized && t.entityId === entityId,
  )
  if (tab) evictTab(tab.id)
}

/**
 * Re-key every open tab of `type` onto the CANONICAL spelling of its entity.
 *
 * An entity-id alias can only answer once its source has loaded: the agent
 * directory names an agent's handle after a roundtrip, so a tab opened from a
 * surface that knew only the uuid (a Home sidebar agent row clicked on a cold
 * load) is stored, routed and URL-synced under that uuid. Re-labelling it is
 * not enough: the KEY is what makes one agent one tab, and a uuid tab sitting
 * beside an `@handle` tab is the same agent opened twice.
 *
 * So the owner of the alias calls this the moment its source resolves. A tab
 * whose canonical spelling is free moves onto it (id, route path and the
 * first-activation latch travel with it, and a preserved sub route keeps its
 * suffix); a tab whose canonical spelling is already open is MERGED into that
 * one rather than left behind as a duplicate.
 */
export function recanonicalizeTabEntities(type: string): void {
  const normalized = normalizeTabType(type)
  const relatches: Array<[string, string]> = []
  let changed = false
  setTabStore(
    produce((s) => {
      const kept: Tab[] = []
      const byEntity = new Map<string, Tab>()
      for (const t of s.tabs) {
        if (normalizeTabType(t.type) !== normalized) {
          kept.push(t)
          continue
        }
        const canonical = canonicalEntityId(normalized, t.entityId)
        const winner = byEntity.get(canonical)
        if (winner) {
          // The same agent, twice. Drop this spelling and keep the one already
          // standing; an active duplicate hands its activation over, AND the
          // address it was opened on. That duplicate is the one a deep link
          // (`/agents/self/memory` before the directory could name the handle)
          // just opened while a restored tab of the same agent stood on another
          // sub-tab; keeping the old route landed the link on the old sub-tab
          // and rewrote the URL to it.
          changed = true
          if (s.activeTabId === t.id) {
            s.activeTabId = winner.id
            const previousBase = defaultTabPath(normalized, t.entityId)
            const suffix =
              t.routePath && t.routePath.startsWith(previousBase)
                ? t.routePath.slice(previousBase.length)
                : ""
            winner.routePath = normalizeRoutePath(
              normalized,
              winner.entityId,
              `${defaultTabPath(normalized, winner.entityId)}${suffix}`,
            )
          }
          relatches.push([t.id, winner.id])
          continue
        }
        if (canonical !== t.entityId) {
          changed = true
          const previousId = t.id
          const previousBase = defaultTabPath(normalized, t.entityId)
          const suffix =
            t.routePath && t.routePath.startsWith(previousBase)
              ? t.routePath.slice(previousBase.length)
              : ""
          t.entityId = canonical
          t.id = makeTabId(normalized, canonical)
          t.routePath = normalizeRoutePath(
            normalized,
            canonical,
            `${defaultTabPath(normalized, canonical)}${suffix}`,
          )
          if (s.activeTabId === previousId) s.activeTabId = t.id
          relatches.push([previousId, t.id])
        }
        byEntity.set(canonical, t)
        kept.push(t)
      }
      if (changed) s.tabs = kept
    }),
  )
  if (!changed) return
  for (const [previousId, nextId] of relatches) relatchTabId(previousId, nextId)
  bumpTabNavigationVersion()
  persist(tabStore)
  if (tabStore.activeTabId) latchTabActive(tabStore.activeTabId)
}

/** Validate all open tabs against their registered validateEntity hook. Evicts tabs whose resources no longer exist. */
let _validating = false
export async function validateTabs(): Promise<void> {
  if (_validating) return
  _validating = true
  try {
    const staleIds: string[] = []

    await Promise.all(
      tabStore.tabs.map(async (tab) => {
        const reg = getTabType(tab.type)
        if (!reg?.validateEntity || reg.singleton) return
        // Never-activated tabs never mounted (B2 lazy first-mount) — validating
        // them now would fire N network calls for background tabs the user
        // hasn't looked at yet (the reconnect-burst finding, L8). MainPanel's
        // latch call on first activation is the natural lazy-validation trigger
        // instead: skip here, let the tab validate itself when it mounts.
        if (!hasTabBeenActive(tab.id)) return
        try {
          const valid = await reg.validateEntity(tab.entityId)
          if (!valid) staleIds.push(tab.id)
        } catch {
          // Validation error — don't evict
        }
      }),
    )

    for (const id of staleIds) {
      evictTab(id)
    }
  } finally {
    _validating = false
  }
}

/** Validate restored tabs against the current registry — call after bootstrap */
export function rehydrateTabs(): void {
  // The id a tab HAD before this pass, per (type, entityId): rehydration runs
  // after the manifest load, by which time an entity-id alias that could not
  // answer at open time (the agent directory, for `self`) can, so ids move.
  // The first-activation latch is keyed by id and has to move with them.
  const idsBefore = new Map<string, string>(
    tabStore.tabs.map((t) => [`${normalizeTabType(t.type)}\u0000${t.entityId}`, t.id]),
  )
  setTabStore(
    produce((s) => {
      const snapshot = JSON.stringify({ tabs: s.tabs, activeTabId: s.activeTabId })
      // Migration (one-shot): older builds persisted the kernel Home tab under the
      // bare, ambiguous type "home" (see HOME_TAB_TYPE). That tab resolves to no
      // component and renders blank; remap it to the canonical qualified id so it
      // resolves to the Home surface and dedupes against the real singleton.
      for (const t of s.tabs) {
        if (t.type === "home" && t.entityId === "home") {
          t.type = HOME_TAB_TYPE
        }
      }
      // Migration (one-shot): pre-refactor builds persisted singleton home tabs
      // with entityIds like `doc-xxx` / `src-xxx`. These would collide with the
      // canonical singleton `knowledge-home` entityId. Normalize them so the
      // singleton tab keeps a sane id — the user can reopen the doc/source
      // via the new per-article tab types.
      for (const t of s.tabs) {
        const type = normalizeTabType(t.type)
        if (
          type === "knowledge:home" &&
          typeof t.entityId === "string" &&
          (t.entityId.startsWith("doc-") || t.entityId.startsWith("src-"))
        ) {
          t.entityId = "knowledge-home"
        }
      }
      // Dedupe singleton tabs after normalization (keep the first). Singletons
      // must have exactly one instance; duplicates (e.g. a legacy blank Home tab
      // migrated onto the canonical `kernel:home`) are collapsed here.
      const seenSingleton = new Set<string>()
      s.tabs = s.tabs.filter((t) => {
        const type = normalizeTabType(t.type)
        if (!getTabType(type)?.singleton) return true
        if (seenSingleton.has(type)) return false
        seenSingleton.add(type)
        return true
      })
      const activeTab = s.tabs.find((t) => t.id === s.activeTabId) ?? null
      const before = s.tabs.length
      // IN PLACE, and only where a value actually moves. Rebuilding each tab
      // as a fresh object (`s.tabs.map(t => ({ ...t }))`) handed MainPanel's
      // `<For each={tabStore.tabs}>` a brand new item for every open tab, and
      // `For` keys on item identity: the whole tab body was disposed and
      // mounted again a beat after boot, when this pass runs (after the
      // manifests resolve). Everything the body was holding went with it, so a
      // menu, a dialog, a scroll position or a half typed draft vanished if
      // the user got there first. Normalization has to be able to change a
      // tab, so the writes stay: what goes is the unconditional rewrite of
      // tabs that normalization leaves exactly as they were.
      for (const t of s.tabs) {
        const type = normalizeTabType(t.type)
        const isRegistered = Boolean(getTabType(type))
        const id = makeTabId(type, t.entityId)
        const routePath = isRegistered
          ? normalizeRoutePath(type, t.entityId, t.routePath)
          : t.routePath
        if (t.type !== type) t.type = type
        if (t.id !== id) t.id = id
        if (t.routePath !== routePath) t.routePath = routePath
      }
      if (s.tabs.length === 0) {
        const home = makeHomeTab()
        s.tabs.push(home)
        s.activeTabId = home.id
      } else {
        const normalizedActiveId = activeTab ? makeTabId(activeTab.type, activeTab.entityId) : null
        if (normalizedActiveId && s.tabs.find((t) => t.id === normalizedActiveId)) {
          s.activeTabId = normalizedActiveId
        } else if (s.activeTabId && !s.tabs.find((t) => t.id === s.activeTabId)) {
          s.activeTabId = s.tabs[0].id
        }
      }
      if (
        s.tabs.length !== before ||
        JSON.stringify({ tabs: s.tabs, activeTabId: s.activeTabId }) !== snapshot
      ) {
        persist(s as TabStoreState)
      }
    }),
  )
  for (const t of tabStore.tabs) {
    const had = idsBefore.get(`${normalizeTabType(t.type)}\u0000${t.entityId}`)
    if (had) relatchTabId(had, t.id)
  }
  // The active tab is active by definition: whatever its id is now, it is
  // mounted. This also covers a tab whose entityId itself was migrated above.
  if (tabStore.activeTabId) latchTabActive(tabStore.activeTabId)
}

/** Close all tabs matching the given types — used when an app is unregistered */
export function closeTabsByTypes(types: string[]): void {
  const typeSet = new Set(types.map(normalizeTabType))
  const removed = tabStore.tabs.filter((t) => typeSet.has(normalizeTabType(t.type)))
  setTabStore(
    produce((s) => {
      s.tabs = s.tabs.filter((t) => !typeSet.has(normalizeTabType(t.type)))
      if (s.activeTabId && !s.tabs.find((t) => t.id === s.activeTabId)) {
        if (s.tabs.length > 0) {
          s.activeTabId = s.tabs[0].id
        } else {
          const home = makeHomeTab()
          s.tabs.push(home)
          s.activeTabId = home.id
        }
      }
    }),
  )
  persist(tabStore)
  for (const tab of removed) unlatchTabActive(tab.id)
  if (tabStore.activeTabId) latchTabActive(tabStore.activeTabId)
  // Splice already happened above — every removed (type, entityId) is gone
  // from s.tabs now, so eviction fires for all of them (closeTabsByTypes is
  // an app-uninstall wipe: nothing of that type remains open).
  for (const tab of removed) maybeEvictEntityData(tab.type, tab.entityId)
}

export function resetTabStore(): void {
  const initial = createInitialState()
  setTabStore(initial)
  persist(initial)
  _setActivatedTabIds(new Set(initial.activeTabId ? [initial.activeTabId] : []))
}
onSessionTeardown(resetTabStore)

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const TabStoreTestAccess = {
  /** Whether the LRU map still holds an entry for this tab id. */
  hasLastUsed(tabId: string): boolean {
    return tabLastUsed.has(tabId)
  },
}
