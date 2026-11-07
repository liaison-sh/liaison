// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which sidebar sections are collapsed, remembered per user.
//
// A36 makes the AGENTS / DIRECT MESSAGES / CHANNELS headers collapsible, and a collapse
// the app forgets on every reload is not a collapse. The key is scoped by user
// id, so two accounts on one machine do not inherit each other's folded
// sections, and it carries the `liaison:` prefix, so `clearLiaisonStorage()`
// drops it on logout exactly like the theme preference it is modelled on.
//
// WHY NOT THE SERVER PREFERENCES ROW. `kernel.user_preferences` has no column
// for this, and adding one is a migration plus a partial route in apps/api,
// which another implementer holds in this worktree. A folded section is a
// per-device reading position, not portable state; the theme store made the
// same call for the same reason. If it ever has to follow the user across
// devices, `hydrateSidebarSections` is the seam a server value plugs into.

import { createSignal } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export type SidebarSectionId =
  /** The phone Chats root's Unread section (every conversation with
   *  something to read). The desktop sidebar has no such group. */
  | "unread"
  /** The Agents section (D32): the member's own agent, then the role agents. */
  | "agents"
  | "channels"
  | "directMessages"
  | "joinableChannels"
  /** The channels beyond the visible cap, folded under a "More" row at the
   *  foot of the Channels group. Same per-user memory as a section fold: a
   *  member who opened the fold finds it open on the next load. */
  | "channelsMore"
  /** The reply threads the member follows (S11), under Direct messages. */
  | "followedThreads"
  /** The followed threads beyond the visible set, folded under a "More" row
   *  at the foot of the section, as channelsMore does for Channels. */
  | "followedThreadsMore"
  /** Home's own sidebar (D21): Needs you, Your queues, Agents, Today. */
  | "homeNeeds"
  | "homeQueues"
  | "homeAgents"
  | "homeToday"
  /** Home's Dashboards section: the viewer's personal and org dashboards. */
  | "homeDashboards"

const SECTION_IDS: SidebarSectionId[] = [
  "unread",
  "agents",
  "channels",
  "directMessages",
  "joinableChannels",
  "channelsMore",
  "followedThreads",
  "followedThreadsMore",
  "homeNeeds",
  "homeQueues",
  "homeAgents",
  "homeToday",
  "homeDashboards",
]

/** Sections that start FOLDED. The channels a member has not joined are a
 *  footnote to the ones they have, so the sub-section under Channels opens
 *  only when it is asked for. Every other section starts open. */
const DEFAULT_COLLAPSED: SidebarSectionId[] = [
  "joinableChannels",
  "channelsMore",
  "followedThreadsMore",
]

function storageKey(userId: string): string {
  return `liaison:sidebar-sections:${userId || "anonymous"}`
}

/** What the user has explicitly said about a section, by id. A section absent
 *  from the record has never been touched and follows its default. The stored
 *  shape is this record; a bare array is what clients before the
 *  default-collapsed sections wrote, and reads as "these are collapsed". */
type SectionState = Partial<Record<SidebarSectionId, boolean>>

const [explicit, setExplicit] = createSignal<SectionState>({})
let loadedFor: string | null = null

function read(userId: string): SectionState {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    const state: SectionState = {}
    if (Array.isArray(parsed)) {
      for (const id of parsed) {
        if (SECTION_IDS.includes(id as SidebarSectionId)) state[id as SidebarSectionId] = true
      }
      return state
    }
    if (parsed && typeof parsed === "object") {
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (SECTION_IDS.includes(id as SidebarSectionId) && typeof value === "boolean") {
          state[id as SidebarSectionId] = value
        }
      }
    }
    return state
  } catch {
    // Private mode, or a value an older client wrote in another shape.
    return {}
  }
}

function write(userId: string, state: SectionState): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(state))
  } catch {
    // Best effort: the fold still holds for this session.
  }
}

/** Load this user's folded sections. Called on sidebar mount; re-reading for
 *  the SAME user is a no-op so a remount never discards an unsaved toggle. */
export function hydrateSidebarSections(userId: string): void {
  if (loadedFor === userId) return
  loadedFor = userId
  setExplicit(read(userId))
}

export function isSectionCollapsed(id: SidebarSectionId): boolean {
  return explicit()[id] ?? DEFAULT_COLLAPSED.includes(id)
}

export function toggleSectionCollapsed(id: SidebarSectionId, userId: string): void {
  hydrateSidebarSections(userId)
  const next: SectionState = { ...explicit(), [id]: !isSectionCollapsed(id) }
  setExplicit(next)
  write(userId, next)
}

/** Session teardown: forget the fold state so the next login reads its own. */
export function resetSidebarSections(): void {
  loadedFor = null
  setExplicit({})
}
onSessionTeardown(resetSidebarSections)
