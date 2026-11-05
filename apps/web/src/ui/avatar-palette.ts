// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * ONE avatar palette for the whole app.
 *
 * Every initials disc, wherever it renders, reads the same eight `--avatar-N`
 * pairs from `theme.css`, keyed by a stable hash of the seed (a user id, a
 * contact id, an email address). Mail and tickets used to carry their own
 * vivid `bg-*-600` Tailwind palette, so the same person wore one colour in a
 * thread and another in their mailbox, and the mail discs sat at a saturation
 * nothing else in the app used.
 *
 * The seed decides the slot, so the colour survives a rename and a refetch.
 *
 * Agents draw from their own `--agent-avatar-N` set (a gradient behind the
 * bolt). Their slot is STORED (`kernel.agents.avatar_color`, chosen so an
 * org's agents differ, and editable in the agent's Settings): an agent wears
 * the slot the client knows for it (`lib/agent-avatar-colors`), else the one
 * the caller passes, and only an agent no read has carried a slot for falls
 * back to the hash of its id. No agent wears a person's colour.
 */

import { isAgentAvatarColor } from "@liaison/shared"
import { knownAgentAvatarColor } from "~/lib/agent-avatar-colors"

export const AVATAR_PALETTE_SIZE = 8

export function avatarPaletteIndex(seed: string | null | undefined): number {
  if (!seed) return 0
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  return Math.abs(hash) % AVATAR_PALETTE_SIZE
}

export function avatarColors(seed: string | null | undefined): { bg: string; text: string } {
  const i = avatarPaletteIndex(seed)
  return { bg: `var(--avatar-${i}-bg)`, text: `var(--avatar-${i}-text)` }
}

/** The slot an agent's disc wears: the known stored slot, then the caller's,
 *  then the hash of the id. */
export function agentAvatarSlot(agentId: string | null | undefined, color?: number | null): number {
  const known = knownAgentAvatarColor(agentId)
  if (known !== undefined) return known
  if (isAgentAvatarColor(color)) return color
  return avatarPaletteIndex(agentId)
}

/** An agent's disc: `background` takes the gradient, `solid` is the same hue
 *  for a bare bolt drawn without a disc. */
export function agentAvatarColors(
  agentId: string | null | undefined,
  color?: number | null,
): {
  background: string
  solid: string
  text: string
} {
  const i = agentAvatarSlot(agentId, color)
  return {
    background: `var(--agent-avatar-${i}-bg)`,
    solid: `var(--agent-avatar-${i}-solid)`,
    text: "#ffffff",
  }
}

/** The inline style of an agent's disc, for the surfaces that draw one. */
export function agentAvatarStyle(
  agentId: string | null | undefined,
  color?: number | null,
): Record<string, string> {
  const c = agentAvatarColors(agentId, color)
  return { background: c.background, color: c.text }
}
