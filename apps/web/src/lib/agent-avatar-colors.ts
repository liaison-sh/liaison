// SPDX-License-Identifier: FSL-1.1-ALv2
import { isAgentAvatarColor } from "@liaison/shared"
import { createStore, reconcile } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"

/**
 * THE AGENT COLOURS THE CLIENT KNOWS, by agent id: the stored slot
 * (`kernel.agents.avatar_color`) of every agent a read has carried so far.
 *
 * Every surface that draws an agent's disc reads it through
 * `agentAvatarColors` (`ui/avatar-palette.ts`), so a surface that knows only
 * the agent id (a message author, a reply stack, a seat) draws the same colour
 * as the agent page, and a colour saved in Settings repaints them all at once.
 * Reactive: a read inside JSX re-runs when a slot arrives or changes.
 */
const [colors, setColors] = createStore<Record<string, number>>({})

/** The stored slot for this agent, or undefined when no read has carried one. */
export function knownAgentAvatarColor(agentId: string | null | undefined): number | undefined {
  if (!agentId) return undefined
  return colors[agentId]
}

/** Record the slot a read carried. A missing or out-of-range value is ignored,
 *  never a reason to forget the slot already known. */
export function rememberAgentAvatarColor(agentId: string, color: unknown): void {
  if (!agentId || !isAgentAvatarColor(color)) return
  if (colors[agentId] !== color) setColors(agentId, color)
}

export function resetAgentAvatarColors(): void {
  setColors(reconcile({}))
}
onSessionTeardown(resetAgentAvatarColors)
