// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The thread list's shape, as pure functions over store rows.
//
// Three surfaces draw the same conversations: the desktop sidebar and the
// docked chat window (a one line directory, HomeSidebar) and the phone Chats
// root (an inbox, ChatsList). They must agree on the section order, what a
// channel is, which DM survives a twin, which room is the viewer's own agent,
// which agents are listed, and which channels fold. Every one of those
// decisions lives here, once (`chatSections`), and the components only render
// what comes back.
//
// THE ORDER (D32): Agents first (the member's own agent, then the org's role
// agents, messaged yet or not), always in view without scrolling; then, on the
// phone inbox, Unread (people and channels with something to read: an agent
// row keeps its own unread count where it is); then Direct messages (people,
// and another member's agent only when a DM with it exists); then Channels,
// folded to a few rows.
//
// No store reads, no signals: each function answers for the rows it is given,
// so a memo in either component tracks exactly what it passes in.
import type { AttentionItem } from "@liaison/shared"
import type { AgentDisplay } from "~/modules/threads/agent-directory"
import {
  conversationDisplayName,
  isChannel,
  namingAgentSeat,
} from "~/modules/threads/conversation-display"
import { dmCounterpartKey, visibleDmIds } from "~/modules/threads/dm-dedupe"
import type { Thread } from "~/modules/threads/thread-store"

/** How many channel rows a list shows before folding the rest under the
 *  "N more channels" row. Channels sit last, so the fold keeps the agents and
 *  the people above it in view even in the small docked window. */
export const CHANNEL_ROW_CAP = 3

/** One group's three ordered pin tiers, in render order: the org's pins, the
 *  member's own pins, then everything else by recency. */
export interface ThreadGroup {
  pinned: Thread[]
  userPinned: Thread[]
  unpinned: Thread[]
}

export function groupIsEmpty(g: ThreadGroup): boolean {
  return g.pinned.length === 0 && g.userPinned.length === 0 && g.unpinned.length === 0
}

/** The group's rows in render order. */
export function orderedGroup(g: ThreadGroup): Thread[] {
  return [...g.pinned, ...g.userPinned, ...g.unpinned]
}

function filterGroup(g: ThreadGroup, keep: (t: Thread) => boolean): ThreadGroup {
  return {
    pinned: g.pinned.filter(keep),
    userPinned: g.userPinned.filter(keep),
    unpinned: g.unpinned.filter(keep),
  }
}

/** A discoverable channel the member is not in yet. The listing carries human
 *  seat COUNTS, never the seats; the agents are named, since which agent
 *  answers in a channel is the reason to join one. */
export interface DiscoverableChannel {
  id: string
  handle: string
  title: string | null
  topic: string | null
  description?: string | null
  participantCount: number
  agentCount: number
  agents?: Array<{ id: string; handle: string; displayName: string }>
}

/** The search field's question, asked of one conversation: its display name or
 *  its handle contains the query, case-insensitively. An empty query matches. */
export function threadMatchesQuery(t: Thread, query: string, currentUserId: string): boolean {
  const q = query.toLowerCase()
  if (!q) return true
  const name = conversationDisplayName(t, currentUserId).toLowerCase()
  return name.includes(q) || t.handle.toLowerCase().includes(q)
}

/**
 * The viewer's 1:1 with one agent (their own, or a role agent), or undefined.
 *
 * THE 1:1, NOT ANY ROOM THE AGENT SITS IN: `namingAgentSeat` is the product's
 * "sole agent counterpart" rule, so an untitled room with the agent AND a
 * colleague is not it. And THE MOST RECENTLY UPDATED candidate, never the
 * first the store lists: a throwaway room of the same shape that happens to be
 * pinned must not become the head row while the real conversation sits below.
 */
export function pickAgentDmThread(
  threads: Thread[],
  agentId: string | undefined,
  currentUserId: string,
): Thread | undefined {
  if (!agentId) return undefined
  let best: Thread | undefined
  for (const t of threads) {
    if (isChannel(t, currentUserId)) continue
    const seat = namingAgentSeat(t, currentUserId)
    if (seat === null || (seat.agentId !== agentId && seat.id !== agentId)) continue
    if (best === undefined || t.updatedAt > best.updatedAt) best = t
  }
  return best
}

export interface SectionedThreads {
  channels: ThreadGroup
  directMessages: ThreadGroup
}

/**
 * Channels and Direct messages, pin tiers preserved inside each.
 *
 * A35: a titled room is a channel whatever its discoverability AND its
 * membership (amended 2026-10-12), and an `agent_chat` is a DM whatever its
 * title. A channel never takes a DM's slot. A DM is identified by its counterpart,
 * so of two rooms with the same counterpart only the most recent is listed,
 * decided across ALL tiers at once (a per-tier dedupe leaves a pinned twin
 * beside its unpinned original). An agent listed in the Agents section has a
 * row of its own there, so its DM, matched by counterpart key, is kept out of
 * the group (`agentDmKeys`).
 */
export function sectionThreads(
  tiers: ThreadGroup,
  currentUserId: string,
  options: { agentDmKeys: ReadonlySet<string> },
): SectionedThreads {
  const channelLike = (t: Thread) => isChannel(t, currentUserId)
  const dmIds = visibleDmIds(
    orderedGroup(tiers).filter((t) => !channelLike(t)),
    currentUserId,
  )
  const dmLike = (t: Thread) => {
    if (channelLike(t) || !dmIds.has(t.id)) return false
    const key = dmCounterpartKey(t, currentUserId)
    return !(key !== null && options.agentDmKeys.has(key))
  }
  return { channels: filterGroup(tiers, channelLike), directMessages: filterGroup(tiers, dmLike) }
}

/**
 * Which channels show and which fold under "More".
 *
 * Every pinned channel and every unread one stays visible whatever the cap
 * says (those are the rows with news), as does the one being read. The cap
 * fills what is left with the most recently active others. A search is a
 * question, not a directory: while one is typed nothing folds.
 */
export function capChannels(
  group: ThreadGroup,
  options: { cap?: number; searching: boolean; isActive?: (id: string) => boolean },
): { shown: ThreadGroup; folded: Thread[] } {
  const cap = options.cap ?? CHANNEL_ROW_CAP
  const keep = new Set<string>()
  for (const t of group.pinned) keep.add(t.id)
  for (const t of group.userPinned) keep.add(t.id)
  for (const t of group.unpinned) {
    if (options.searching || options.isActive?.(t.id) || t.unreadCount > 0) keep.add(t.id)
  }
  if (!options.searching) {
    for (const t of group.unpinned) {
      if (keep.size >= cap) break
      keep.add(t.id)
    }
  }
  return {
    shown: {
      pinned: group.pinned,
      userPinned: group.userPinned,
      unpinned: group.unpinned.filter((t) => keep.has(t.id)),
    },
    folded: group.unpinned.filter((t) => !keep.has(t.id)),
  }
}

/** Discoverable channels the store does not already hold as joined, narrowed
 *  by the search. */
export function unjoinedChannels(
  discoverable: DiscoverableChannel[],
  threads: Thread[],
  query: string,
): DiscoverableChannel[] {
  const known = new Set(threads.map((t) => t.id))
  const q = query.toLowerCase()
  return discoverable.filter(
    (c) =>
      !known.has(c.id) &&
      (!q || (c.title ?? "").toLowerCase().includes(q) || c.handle.toLowerCase().includes(q)),
  )
}

/** When a conversation last moved: its last message, else its update stamp. */
function threadActivityAt(t: Pick<Thread, "lastMessage" | "updatedAt">): number {
  return Date.parse(t.lastMessage?.createdAt ?? "") || Date.parse(t.updatedAt ?? "") || 0
}

/** Something to read: an unread count on a conversation that is not muted
 *  (a muted room never surfaces unread state, as the tab badge counts it). */
export function needsReading(t: Pick<Thread, "unreadCount" | "isMuted">): boolean {
  return t.unreadCount > 0 && !t.isMuted
}

export interface InboxSections {
  /** Every conversation with something to read, newest first. */
  unread: Thread[]
  /** The rest, in their groups, pin tiers preserved. */
  channels: ThreadGroup
  directMessages: ThreadGroup
}

/**
 * The phone inbox: the conversations with something to read lifted into an
 * Unread section of their own, newest first, and LEFT OUT of their groups so a
 * row is never listed twice. `extra` carries rows that live outside the groups
 * and join Unread on the same terms.
 */
export function splitUnread(sections: SectionedThreads, extra: Thread[] = []): InboxSections {
  const seen = new Set<string>()
  const unread: Thread[] = []
  for (const t of [
    ...extra,
    ...orderedGroup(sections.channels),
    ...orderedGroup(sections.directMessages),
  ]) {
    if (seen.has(t.id) || !needsReading(t)) continue
    seen.add(t.id)
    unread.push(t)
  }
  unread.sort((a, b) => threadActivityAt(b) - threadActivityAt(a))
  const rest = (t: Thread) => !seen.has(t.id)
  return {
    unread,
    channels: filterGroup(sections.channels, rest),
    directMessages: filterGroup(sections.directMessages, rest),
  }
}

/** One row of the Agents section: the agent, and its DM with the member when
 *  one exists (pressing a row without one creates it). */
export interface AgentRow {
  agent: AgentDisplay
  thread: Thread | undefined
  /** The member's own personal agent, marked as theirs. */
  mine: boolean
}

export interface ChatSections {
  /** Every conversation with something to read, newest first. Empty unless
   *  `liftUnread` was asked for. A row here is left out of its section; an
   *  agent's DM is never here (it stays in Agents). */
  unread: Thread[]
  agents: AgentRow[]
  /** How many agents the section lists before the search and the chips
   *  narrow it: zero means the org has none to offer, and no header shows. */
  agentCount: number
  directMessages: ThreadGroup
  channels: ThreadGroup
}

/** The search asked of an agent: its name or handle contains the query. */
function agentMatchesQuery(agent: AgentDisplay, query: string): boolean {
  const q = query.toLowerCase()
  return !q || agent.name.toLowerCase().includes(q) || agent.handle.toLowerCase().includes(q)
}

/**
 * The whole list, in the D32 order, for every surface.
 *
 * `tiers` are the store's pin tiers already narrowed by whatever the surface
 * narrows by (the search, the desktop filter chips); `threads` is the whole
 * store, so an agent's DM is found even when it is not in view. `chip`, when
 * a filter chip is active, is its predicate: only agent rows whose DM passes
 * it are listed, as the conversations in the other sections are, except the
 * member's own agent when `mineAlwaysListed` (the desktop directory, where
 * that row is the guided tours' anchor): it shows whatever the chip or the
 * search says.
 *
 * `liftUnread` (the phone inbox) lifts the people DMs and channels with
 * something to read into Unread. Agent rows are never lifted: they stay in
 * Agents and carry their unread count there.
 *
 * AGENTS: the member's own agent first, then every role agent in directory
 * order, each with its DM when it has one. Another member's personal agent is
 * not listed (it belongs to one colleague; search and New message reach it),
 * and a DM with one stays under Direct messages.
 */
export function chatSections(input: {
  tiers: ThreadGroup
  threads: Thread[]
  agents: AgentDisplay[]
  personalAgent: AgentDisplay | undefined
  currentUserId: string
  query: string
  liftUnread: boolean
  chip?: (t: Thread) => boolean
  mineAlwaysListed?: boolean
}): ChatSections {
  const uid = input.currentUserId
  const listed: AgentDisplay[] = []
  if (input.personalAgent) listed.push(input.personalAgent)
  for (const a of input.agents) {
    if (a.kind === "role" && a.id !== input.personalAgent?.id) listed.push(a)
  }

  const agentDmKeys = new Set<string>()
  const candidates: AgentRow[] = []
  for (const agent of listed) {
    agentDmKeys.add(`agent:${agent.id}`)
    const thread = pickAgentDmThread(input.threads, agent.id, uid)
    if (thread) {
      const key = dmCounterpartKey(thread, uid)
      if (key) agentDmKeys.add(key)
    }
    const mine = agent.id === input.personalAgent?.id
    if (mine && input.mineAlwaysListed) {
      candidates.push({ agent, thread, mine })
      continue
    }
    const matches =
      agentMatchesQuery(agent, input.query) ||
      (thread !== undefined && input.query !== "" && threadMatchesQuery(thread, input.query, uid))
    if (!matches) continue
    if (input.chip && !(thread && input.chip(thread))) continue
    candidates.push({ agent, thread, mine })
  }

  const sections = sectionThreads(input.tiers, uid, { agentDmKeys })
  if (!input.liftUnread) {
    return { unread: [], agents: candidates, agentCount: listed.length, ...sections }
  }
  const inbox = splitUnread(sections)
  return {
    unread: inbox.unread,
    agents: candidates,
    agentCount: listed.length,
    directMessages: inbox.directMessages,
    channels: inbox.channels,
  }
}

/** The threads an unread `mention` attention item points at: the rows whose
 *  unread includes the viewer being named, which the list draws louder. */
export function mentionedThreadIds(items: readonly AttentionItem[]): Set<string> {
  const ids = new Set<string>()
  for (const item of items) {
    if (item.app !== "kernel" || item.entity !== "thread") continue
    if (item.kind === "mention" || item.alsoKinds?.includes("mention")) ids.add(item.entityId)
  }
  return ids
}

/** How the channels list is ordered (Home sidebar). Pin tiers stay on top; the
 *  order applies inside each tier. */
export type ChannelSort = "recent" | "name" | "unread"

/** Which channels the list is about: the ones the viewer is in, the public
 *  ones they could join, or both. */
export type ChannelMembership = "all" | "in" | "not-in"

/** The rows in the asked order. "recent" is last activity, newest first;
 *  "name" is A-Z on the display name; "unread" puts rooms with something to
 *  read first (muted rooms never count), each half by recency. */
export function sortThreads(
  rows: readonly Thread[],
  sort: ChannelSort,
  currentUserId: string,
): Thread[] {
  const byRecent = (a: Thread, b: Thread) => threadActivityAt(b) - threadActivityAt(a)
  const out = [...rows]
  if (sort === "name") {
    const label = (t: Thread) => conversationDisplayName(t, currentUserId)
    out.sort((a, b) => label(a).localeCompare(label(b), undefined, { sensitivity: "base" }))
  } else if (sort === "unread") {
    out.sort((a, b) => Number(needsReading(b)) - Number(needsReading(a)) || byRecent(a, b))
  } else {
    out.sort(byRecent)
  }
  return out
}

/** `sortThreads` inside each pin tier. */
export function sortGroup(g: ThreadGroup, sort: ChannelSort, currentUserId: string): ThreadGroup {
  return {
    pinned: sortThreads(g.pinned, sort, currentUserId),
    userPinned: sortThreads(g.userPinned, sort, currentUserId),
    unpinned: sortThreads(g.unpinned, sort, currentUserId),
  }
}
