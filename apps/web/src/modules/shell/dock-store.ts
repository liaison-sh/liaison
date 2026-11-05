// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSignal } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { shellTier } from "~/modules/shell/shell-tier"

const STORAGE_KEY = "liaison.dock.v1"

// Design-pass constants, in pixels. The dock is ONE connected bar anchored
// flush to the bottom right corner of the main panel; an open conversation (or
// the Chats roster) is a window resting on the bar, right aligned with the
// item it belongs to.

/** The floating window an open conversation or the Chats roster shows. */
export const DOCK_TAB_WIDTH = 360
export const DOCK_TAB_HEIGHT = 460
/**
 * A conversation with an agent gets a larger window: agent replies are long
 * (lists, tables, approvals) and read poorly in a messenger-sized column. It
 * is sized from the main panel, still anchored on the bar in the corner, and
 * never narrower or shorter than a person's window. Around half the panel's
 * width keeps the page the agent is talking about readable beside it.
 */
export const DOCK_AGENT_WINDOW = {
  widthShare: 0.46,
  maxWidth: 560,
  heightShare: 0.78,
  maxHeight: 760,
} as const
/** The bar's height, border included. */
export const DOCK_PILL_HEIGHT = 32
/** A conversation item never grows past this; its name truncates instead. */
export const DOCK_ITEM_MAX_WIDTH = 170
/** The overflow item at its widest: three overlapped avatars and "+NN". */
export const DOCK_OVERFLOW_ITEM_WIDTH = 96
/** Air between the bar and the window above it: none, the window rests on the bar. */
export const DOCK_WINDOW_GAP = 0
/** The collapse/expand-all item at the bar's far left, its count included. */
export const DOCK_TOGGLE_ITEM_WIDTH = 44
/** Each chat's flight into Chats when every chat is folded away, and the
 *  delay between two of them. Reduced motion fades them in place instead. */
export const DOCK_FOLD_MS = 280
export const DOCK_FOLD_STAGGER_MS = 40
export const DOCK_FOLD_FADE_MS = 120

/**
 * THE ONE CLASS SET every item of the dock bar wears: the Chats item, a
 * conversation item and the overflow item. Height, padding, gap, font size
 * and the hover surface all live here, so the three cannot drift into three
 * different shapes (they had, as separate pills: an outline `Button` at
 * `rounded-sm` beside a conversation pill with a second border).
 *
 * The items carry no border, radius or surface of their own: the BAR owns
 * those (ChatDock), and the items are joined inside it, separated by 1px
 * dividers. The bar's `bg-elevated` is what keeps the page underneath from
 * reading through (on the Tickets page the "16 hours ago" of the row below
 * once collided with the word Chats).
 *
 * It carries no text colour on purpose: each item sets its own.
 *
 * Every item also marks itself `data-dock-pill`, which is what the drift test
 * (DockPills.test.tsx) enumerates.
 */
export const DOCK_PILL_CLASS =
  "relative inline-flex h-full shrink-0 items-center gap-1.5 px-2.5 py-0 text-[12.5px] font-medium outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover"

/**
 * The unread count, everywhere in the bar. Red on purpose: the grey accent
 * the old pills used read as decoration, not as something waiting.
 */
export const DOCK_BADGE_CLASS =
  "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[4px] bg-danger px-1 text-[10.5px] font-semibold leading-none tabular-nums text-white"

/** The window's frame, shared by a conversation and the roster. It rests on
 *  the bar: square bottom corners, no bottom border (the bar's top is it). */
export const DOCK_WINDOW_CLASS =
  "flex flex-col overflow-hidden rounded-t-[10px] border border-b-0 border-border-strong bg-elevated shadow-dock-window"

/**
 * The most conversations the dock will ever hold. The strip was unbounded
 * while every tab arrived by a deliberate click; now an incoming message can
 * add one, so an afternoon of chatter would otherwise grow the persisted list
 * without limit (and with it the overflow menu and the storage blob).
 *
 * The cap is enforced by EVICTION, never by refusal: a new conversation is the
 * one the user has not seen yet, so it wins over the least recently active
 * COLLAPSED tab, which is the one they have already put away.
 */
export const DOCK_MAX_TABS = 12

/** Air kept between a window and the dock's left edge, and above an open
 *  window by a pane that scrolls its end clear of it. The bar itself has no
 *  gap: it is anchored flush to the panel's bottom and right edges. */
export const DOCK_GAP = 8
/** Room the bar leaves free at the panel's left end. */
export const DOCK_EDGE_RESERVE = 48

/**
 * Height of the dock strip box: the bar alone, anchored to the panel's bottom
 * edge. The strip lies over the bottom of the main panel (position absolute,
 * bottom 0, z-index 49, pointer-events off except on the bar) and reserves no
 * band: the page keeps the full height and the small right-aligned bar sits in
 * its bottom corner. An open window overflows upward out of this box.
 */
export const DOCK_STRIP_HEIGHT = DOCK_PILL_HEIGHT

export interface DockTab {
  threadId: string
  expanded: boolean
  openedAt: number
  lastActiveAt: number
}

interface PersistedDockState {
  tabs: DockTab[]
  activeThreadId: string | null
  chatsOpen: boolean
  /** Every chat folded into Chats by the collapse-all control. */
  allCollapsed: boolean
  /** The conversation whose window was open when they were folded. */
  foldedOpenId: string | null
}

function isDockTab(value: unknown): value is DockTab {
  if (!value || typeof value !== "object") return false
  const t = value as Record<string, unknown>
  return (
    typeof t.threadId === "string" &&
    typeof t.expanded === "boolean" &&
    typeof t.openedAt === "number" &&
    typeof t.lastActiveAt === "number"
  )
}

/** The most recently active `DOCK_MAX_TABS`, in the order they were stored.
 *  A blob written before the cap existed (or by a build without it) would
 *  otherwise rehydrate a strip of any size the old session had grown to. */
function trimToCap(stored: DockTab[]): DockTab[] {
  if (stored.length <= DOCK_MAX_TABS) return stored
  const keep = new Set(
    [...stored]
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, DOCK_MAX_TABS)
      .map((t) => t.threadId),
  )
  return stored.filter((t) => keep.has(t.threadId))
}

/** At most ONE open window. A blob written while the dock allowed several
 *  keeps the active conversation's window, else the most recently active. */
function oneWindow(stored: DockTab[], activeId: string | null): DockTab[] {
  const open = stored.filter((t) => t.expanded)
  if (open.length <= 1) return stored
  const keep =
    open.find((t) => t.threadId === activeId) ??
    open.reduce((a, b) => (b.lastActiveAt > a.lastActiveAt ? b : a))
  return stored.map((t) => (t.expanded && t !== keep ? { ...t, expanded: false } : t))
}

const EMPTY_STATE: PersistedDockState = {
  tabs: [],
  activeThreadId: null,
  chatsOpen: false,
  allCollapsed: false,
  foldedOpenId: null,
}

function readInitialState(): PersistedDockState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return EMPTY_STATE
    const parsed = JSON.parse(stored) as Partial<PersistedDockState>
    const activeId = typeof parsed.activeThreadId === "string" ? parsed.activeThreadId : null
    return {
      tabs: Array.isArray(parsed.tabs)
        ? oneWindow(trimToCap(parsed.tabs.filter(isDockTab)), activeId)
        : [],
      activeThreadId: activeId,
      chatsOpen: parsed.chatsOpen === true,
      allCollapsed: parsed.allCollapsed === true,
      foldedOpenId: typeof parsed.foldedOpenId === "string" ? parsed.foldedOpenId : null,
    }
  } catch {
    return EMPTY_STATE
  }
}

const initial = readInitialState()

const [tabs, _setTabs] = createSignal<DockTab[]>(initial.tabs)
const [chatsOpen, _setChatsOpen] = createSignal(initial.chatsOpen)
const [activeThreadId, _setActiveThreadId] = createSignal<string | null>(initial.activeThreadId)
const [visibleCapacity, _setVisibleCapacity] = createSignal(Number.POSITIVE_INFINITY)
const [allCollapsed, _setAllCollapsed] = createSignal(initial.allCollapsed)
let foldedOpenId: string | null = initial.foldedOpenId

export { activeThreadId, allCollapsed, chatsOpen, tabs, visibleCapacity }

export interface DockWindowSize {
  width: number
  height: number
}

/** The main panel the dock lies over, as ChatDock measures it; null until it
 *  has been measured (and in a layoutless test environment). */
const [panelSize, _setPanelSize] = createSignal<DockWindowSize | null>(null)
export function setDockPanelSize(size: DockWindowSize | null): void {
  _setPanelSize(size)
}

/** The window size for a conversation: a person's fixed size, or an agent's
 *  share of the measured panel (the person size until the panel is measured). */
export function dockWindowSize(kind: "person" | "agent"): DockWindowSize {
  const panel = panelSize()
  if (kind === "person" || !panel) return { width: DOCK_TAB_WIDTH, height: DOCK_TAB_HEIGHT }
  return agentWindowSize(panel)
}

export function agentWindowSize(panel: DockWindowSize): DockWindowSize {
  const share = (part: number, of: number, min: number, max: number) =>
    Math.round(Math.max(min, Math.min(of * part, max)))
  return {
    width: share(
      DOCK_AGENT_WINDOW.widthShare,
      panel.width,
      DOCK_TAB_WIDTH,
      DOCK_AGENT_WINDOW.maxWidth,
    ),
    height: share(
      DOCK_AGENT_WINDOW.heightShare,
      panel.height,
      DOCK_TAB_HEIGHT,
      DOCK_AGENT_WINDOW.maxHeight,
    ),
  }
}

// The heights of the windows that are up, so a message pane's clearance
// follows the tallest of them (an agent window is taller than a person's).
const [openWindowHeights, _setOpenWindowHeights] = createSignal<ReadonlyMap<symbol, number>>(
  new Map(),
)
/** A mounted DockWindow reports its height; call the returned function on
 *  cleanup. */
export function registerDockWindowHeight(key: symbol, height: number): () => void {
  _setOpenWindowHeights((prev) => new Map(prev).set(key, height))
  return () =>
    _setOpenWindowHeights((prev) => {
      const next = new Map(prev)
      next.delete(key)
      return next
    })
}

// Monotonic clock for tab recency. Date.now() alone collides within the same
// millisecond (openConversation calls in a tight loop, or in tests), which
// would make "least recently active" ambiguous; this keeps every activation
// strictly ordered while still starting from a real timestamp.
let clock = Date.now()
function tick(): number {
  clock += 1
  return clock
}

function persistState(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: tabs(),
        activeThreadId: activeThreadId(),
        chatsOpen: chatsOpen(),
        allCollapsed: allCollapsed(),
        foldedOpenId,
      }),
    )
  } catch {
    /* quota exceeded */
  }
}

// The dock is a docked strip at desktop only; at tablet and phone the same
// state drives a Chats sheet instead (a later task). The tier comes from the
// shell's own signal, so the dock and the grid can never disagree about where
// desktop ends.
export function dockAvailable(): boolean {
  return shellTier() === "desktop"
}

function sortedByRecency(): DockTab[] {
  return [...tabs()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

/**
 * The bar's order: by recency, STABLE under a click, with the open window
 * always on the bar.
 *
 * Expanding or minimising an item does not touch its recency, so the item a
 * user clicks stays exactly where it was and its window opens right above it
 * (the strip used to sort expanded tabs first, which moved the clicked pill
 * out from under the pointer). Only a deliberate open (the roster, the
 * overflow menu) or a new conversation stamps recency and lands at the
 * front, next to Chats.
 *
 * An incoming message stamps a brand new item as the most recent; on a full
 * bar that could push the conversation the user is typing in into the
 * overflow menu, mid-sentence. The open window therefore keeps a seat: if
 * recency would overflow it, it takes the last visible seat instead.
 *
 * This reads the PERSISTED `expanded` flag, not the roster-adjusted one
 * below, so opening the Chats roster never reshuffles the bar underneath it.
 */
function orderedTabs(): DockTab[] {
  const byRecency = sortedByRecency()
  const capacity = visibleCapacity()
  const openAt = byRecency.findIndex((t) => t.expanded)
  if (openAt === -1 || openAt < capacity || capacity < 1) return byRecency
  const [open] = byRecency.splice(openAt, 1)
  byRecency.splice(capacity - 1, 0, open)
  return byRecency
}

// The bar's visible set. The roster window and a conversation window are
// MUTUALLY EXCLUSIVE: both float above the bar's right end, so
// with both on screen the roster covers the tab's own header controls
// (Collapse / Open in Home / Close) and swallows their clicks. The design pass
// (ws04c-t02, captures (b) and (c)) never shows the two together either:
// every conversation is a collapsed item while the Chats roster is open.
// The persisted `expanded` flag is untouched, so closing the roster restores
// whatever was expanded before.
export function visibleTabs(): DockTab[] {
  // Folded into Chats by the collapse-all control: the bar shows Chats alone.
  if (allCollapsed()) return []
  const rosterOpen = chatsOpen()
  return orderedTabs()
    .slice(0, visibleCapacity())
    .map((t) => (rosterOpen && t.expanded ? { ...t, expanded: false } : t))
}

/**
 * What a message pane reaching the main panel's bottom edge keeps clear of
 * while a dock WINDOW is open: the strip, the window's 1px border plus its gap
 * above the bar, the window itself, and one more gap of air. Shell.tsx
 * publishes it as --shell-dock-window-clearance (the `pb-dock-window-clearance`
 * utility in index.css), so the last message of a thread or a task discussion
 * scrolls up above the window instead of ending under it.
 */
export const DOCK_WINDOW_CLEARANCE =
  DOCK_STRIP_HEIGHT + DOCK_WINDOW_GAP + DOCK_TAB_HEIGHT + DOCK_GAP

/** DOCK_WINDOW_CLEARANCE for the window actually up: the tallest one open
 *  (an agent window is taller), or a person's window before any has reported. */
export function dockWindowClearance(): number {
  const tallest = Math.max(0, ...openWindowHeights().values())
  return DOCK_STRIP_HEIGHT + DOCK_WINDOW_GAP + (tallest || DOCK_TAB_HEIGHT) + DOCK_GAP
}

/** True while a floating window (a conversation or the Chats roster) is up. */
export function dockWindowOpen(): boolean {
  if (!dockAvailable()) return false
  return chatsOpen() || visibleTabs().some((t) => t.expanded)
}

export function overflow(): DockTab[] {
  if (allCollapsed()) return []
  return orderedTabs().slice(visibleCapacity())
}

/**
 * Fold every chat into Chats (the control at the bar's far left): every
 * window is put away and the bar shows Chats alone. The open conversation is
 * remembered, so `expandAll` brings the bar back as it was.
 */
export function collapseAll(): void {
  if (tabs().length === 0) return
  foldedOpenId = tabs().find((t) => t.expanded)?.threadId ?? null
  if (tabs().some((t) => t.expanded)) _setTabs(tabs().map((t) => ({ ...t, expanded: false })))
  _setAllCollapsed(true)
  persistState()
}

/** Bring the folded chats back, the window that was open open again. */
export function expandAll(): void {
  const reopen = foldedOpenId
  foldedOpenId = null
  _setAllCollapsed(false)
  if (reopen && tabs().some((t) => t.threadId === reopen)) expand(reopen)
  else persistState()
}

/** A deliberate open shows the bar again: the user asked for that chat. */
function unfold(): void {
  if (!allCollapsed()) return
  foldedOpenId = null
  _setAllCollapsed(false)
}

// `keepChats` is for the callers whose surface IS the roster (the tablet /
// phone Chats sheet, where the list and the thread are two states of one
// sheet). Everywhere else opening a conversation puts the roster away: on the
// desktop strip the roster panel would otherwise stay open on top of the tab
// that was just opened.
export function openConversation(
  threadId: string,
  opts: { expand?: boolean; keepChats?: boolean } = {},
): void {
  const expand = opts.expand ?? true
  const now = tick()
  unfold()
  const existing = tabs().find((t) => t.threadId === threadId)
  if (existing) {
    _setTabs(
      tabs().map((t) =>
        t.threadId === threadId
          ? { ...t, expanded: expand, lastActiveAt: now }
          : expand && t.expanded
            ? { ...t, expanded: false }
            : t,
      ),
    )
  } else {
    const tab: DockTab = { threadId, expanded: expand, openedAt: now, lastActiveAt: now }
    // The cap holds for a deliberate open too, by the same eviction rule. A
    // CLICK is explicit, though, so when nothing may be dropped the tab is
    // added anyway rather than swallowing the gesture: the strip is one over
    // its cap until the user collapses something, which the next eviction
    // then reclaims.
    const rest = tabsWithRoom() ?? tabs()
    // One window at a time: opening this one puts every other away.
    _setTabs([
      tab,
      ...(expand ? rest.map((t) => (t.expanded ? { ...t, expanded: false } : t)) : rest),
    ])
  }
  _setActiveThreadId(threadId)
  _setChatsOpen(opts.keepChats === true)
  persistState()
}

// An INCOMING message surfaces its conversation in the dock, Facebook-chat
// style: a collapsed pill appears in the strip so the message is one click
// away, and nothing else moves. It never steals focus (the active thread and
// whichever tab is expanded are left exactly as they were), never closes the
// Chats roster, and never makes a sound. A conversation already in the dock is
// left alone: its pill already carries the unread badge, which ConversationTab
// reads live from the thread store.
//
// The CALLER decides whether the message deserves surfacing (own message,
// channel, the thread already on screen); this function only owns the dock's
// side of it, plus the tier gate that makes the dock a desktop affordance.
/**
 * The seat a new tab takes when the strip is already at `DOCK_MAX_TABS`.
 *
 * The only tabs that may be evicted are the ones the user has already put
 * away: never an expanded window, never the active conversation. Returns the
 * tab list to build on, or `null` when every seat is held by something that
 * must not be taken.
 */
function tabsWithRoom(): DockTab[] | null {
  const current = tabs()
  if (current.length < DOCK_MAX_TABS) return current
  const active = activeThreadId()
  const victim = current
    .filter((t) => !t.expanded && t.threadId !== active)
    .reduce<DockTab | null>((a, b) => (a === null || b.lastActiveAt < a.lastActiveAt ? b : a), null)
  if (!victim) return null
  return current.filter((t) => t.threadId !== victim.threadId)
}

export function surfaceIncoming(threadId: string): void {
  if (!dockAvailable()) return
  if (!threadId) return
  if (tabs().some((t) => t.threadId === threadId)) return
  // Nothing droppable: the conversation simply does not surface. It is still
  // in the sidebar with its unread badge, which is a far smaller loss than
  // taking a window out from under the user for a message they did not ask
  // to see.
  const current = tabsWithRoom()
  if (current === null) return
  const now = tick()
  _setTabs([{ threadId, expanded: false, openedAt: now, lastActiveAt: now }, ...current])
  persistState()
}

// Step back from a conversation WITHOUT evicting it: the active thread goes
// away and its tab stays in `tabs`, collapsed. This is the navigation gesture
// (the Chats sheet's back and close at tablet/phone); `close()` stays the
// destructive one. Without it a sheet back dropped the conversation entirely,
// so widening to desktop afterwards showed an empty dock.
export function deactivate(): void {
  const id = activeThreadId()
  if (id) _setTabs(tabs().map((t) => (t.threadId === id ? { ...t, expanded: false } : t)))
  _setActiveThreadId(null)
  persistState()
}

export function collapse(threadId: string): void {
  _setTabs(tabs().map((t) => (t.threadId === threadId ? { ...t, expanded: false } : t)))
  persistState()
}

/**
 * Open a conversation's window from its bar item. ONE window at a time:
 * every other window is minimised, and the Chats roster (which floats over
 * the same corner) is put away. Recency is left alone so the item stays where
 * the user clicked it (see `orderedTabs`).
 */
export function expand(threadId: string): void {
  if (!tabs().some((t) => t.threadId === threadId)) return
  unfold()
  _setTabs(
    tabs().map((t) =>
      t.threadId === threadId
        ? { ...t, expanded: true }
        : t.expanded
          ? { ...t, expanded: false }
          : t,
    ),
  )
  _setActiveThreadId(threadId)
  _setChatsOpen(false)
  persistState()
}

export function close(threadId: string): void {
  _setTabs(tabs().filter((t) => t.threadId !== threadId))
  if (tabs().length === 0) unfold()
  if (activeThreadId() === threadId) _setActiveThreadId(null)
  persistState()
}

/**
 * Put every floating window away (conversations minimised to their bar items,
 * the Chats roster closed), keeping every conversation in the dock. A guided
 * scenario starts on a clear screen: a window another scenario left open would
 * cover what this one points at.
 */
export function putAwayWindows(): void {
  if (tabs().some((t) => t.expanded)) _setTabs(tabs().map((t) => ({ ...t, expanded: false })))
  _setActiveThreadId(null)
  _setChatsOpen(false)
  persistState()
}

export function toggleChats(): void {
  _setChatsOpen(!chatsOpen())
  persistState()
}

export function setVisibleCapacity(n: number): void {
  _setVisibleCapacity(n)
}

// Picking a conversation out of the More menu must PUT IT ON THE BAR. It
// becomes the most recently active tab and it opens, which is what the
// gesture means: the user reached past the visible row for this one. Being
// the one open window, it can never sort behind anything (see `orderedTabs`),
// and every other window is minimised, never closed: they keep their seats.
export function promoteFromOverflow(threadId: string): void {
  if (!overflow().some((t) => t.threadId === threadId)) return
  const now = tick()
  _setTabs(
    tabs().map((t) =>
      t.threadId === threadId
        ? { ...t, expanded: true, lastActiveAt: now }
        : t.expanded
          ? { ...t, expanded: false }
          : t,
    ),
  )
  _setActiveThreadId(threadId)
  _setChatsOpen(false)
  persistState()
}

export function resetDockStore(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ok */
  }
  _setTabs([])
  _setChatsOpen(false)
  _setActiveThreadId(null)
  _setVisibleCapacity(Number.POSITIVE_INFINITY)
  _setAllCollapsed(false)
  _setPanelSize(null)
  _setOpenWindowHeights(new Map())
  foldedOpenId = null
}

onSessionTeardown(resetDockStore)
