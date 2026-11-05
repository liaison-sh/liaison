// SPDX-License-Identifier: FSL-1.1-ALv2
import { createStore, produce, reconcile } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"

interface TypingEntry {
  userId: string
  userName: string
  expiresAt: number
}

interface PresenceStoreState {
  users: Record<string, "online" | "away" | "offline">
  typing: Record<string, TypingEntry[]> // threadId → typing users
  /** threadId → the ids of the agents currently taking a turn there. Keyed by
   *  (threadId, agentId) so N agents in one room are independent of each
   *  other. Unlike human typing this carries no TTL: the server sends one
   *  balanced typing:start / typing:stop pair per turn, however long it runs. */
  typingAgents: Record<string, string[]>
}

const [presenceStore, setPresenceStore] = createStore<PresenceStoreState>({
  users: {},
  typing: {},
  typingAgents: {},
})

export { presenceStore }

/**
 * How long one typing frame keeps a name on screen.
 *
 * It has to outlive the gap between two frames, or a person who never stops
 * typing still blinks out. The server throttles one typing broadcast per user
 * per thread per 4 s (`WebSocketManager.TYPING_THROTTLE_MS`) and the composer
 * only offers one every 3 s, so a continuous typist's frames land 6 s apart in
 * the worst case (offer at 0 s passes, at 3 s is inside the server window and
 * is dropped, at 6 s passes). At 4 s the indicator was therefore DARK for a
 * third of the time someone was typing, and any single observation of the
 * other side had a fair chance of seeing nothing at all. 7 s covers that gap
 * with a margin and still clears within a few seconds of the last keystroke.
 *
 * Both halves are per (thread, user), so this never holds a name that the
 * sender's own frames are not still refreshing.
 */
const TYPING_TTL = 7000
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function handlePresenceSync(users: Record<string, "online" | "away" | "offline">): void {
  setPresenceStore("users", users)
}

export function handlePresenceUpdate(userId: string, status: "online" | "away" | "offline"): void {
  setPresenceStore("users", userId, status)
}

export function handleTypingStart(threadId: string, userId: string, userName: string): void {
  setPresenceStore(
    produce((s) => {
      if (!s.typing[threadId]) s.typing[threadId] = []
      const existing = s.typing[threadId].find((t) => t.userId === userId)
      if (existing) {
        existing.expiresAt = Date.now() + TYPING_TTL
      } else {
        s.typing[threadId].push({ userId, userName, expiresAt: Date.now() + TYPING_TTL })
      }
    }),
  )

  // Clear any existing timer for this (threadId, userId) pair, then schedule new expiry
  const timerKey = `${threadId}:${userId}`
  const existing = typingTimers.get(timerKey)
  if (existing) clearTimeout(existing)
  typingTimers.set(
    timerKey,
    setTimeout(() => {
      typingTimers.delete(timerKey)
      setPresenceStore(
        produce((s) => {
          if (s.typing[threadId]) {
            s.typing[threadId] = s.typing[threadId].filter((t) => t.expiresAt > Date.now())
          }
        }),
      )
    }, TYPING_TTL + 100),
  )
}

export function handleAgentTypingStart(threadId: string, agentId: string): void {
  if (!threadId || !agentId) return
  setPresenceStore(
    produce((s) => {
      const current = s.typingAgents[threadId]
      if (!current) {
        s.typingAgents[threadId] = [agentId]
        return
      }
      if (!current.includes(agentId)) current.push(agentId)
    }),
  )
}

export function handleAgentTypingStop(threadId: string, agentId: string): void {
  if (!threadId || !agentId) return
  setPresenceStore(
    produce((s) => {
      const current = s.typingAgents[threadId]
      if (!current) return
      s.typingAgents[threadId] = current.filter((id) => id !== agentId)
    }),
  )
}

/** The agents currently taking a turn in this thread, in arrival order. */
export function getTypingAgents(threadId: string): string[] {
  return presenceStore.typingAgents[threadId] ?? []
}

export function getTypingUsers(threadId: string, excludeUserId: string): TypingEntry[] {
  return (presenceStore.typing[threadId] ?? []).filter(
    (t) => t.userId !== excludeUserId && t.expiresAt > Date.now(),
  )
}

/** Clear all timers and reset store state. Called on logout. */
export function resetPresenceStore(): void {
  for (const timer of typingTimers.values()) clearTimeout(timer)
  typingTimers.clear()
  setPresenceStore("users", reconcile({}))
  setPresenceStore("typing", reconcile({}))
  setPresenceStore("typingAgents", reconcile({}))
}
onSessionTeardown(resetPresenceStore)
