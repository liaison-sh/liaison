// SPDX-License-Identifier: FSL-1.1-ALv2
import { AGENT_AVATAR_COLOR_COUNT } from "@liaison/shared"
import { and, count, eq, isNotNull, isNull } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { agents } from "~/db/schema/kernel/agents"

/**
 * THE COLOUR A NEW AGENT WEARS: the slot its org's live agents use least, a
 * tie broken at random. Agents of one org therefore differ until all eight
 * slots are taken, and past eight the repeats spread evenly.
 *
 * Every path that inserts a `kernel.agents` row calls this in the same
 * transaction as its insert (the REST create, `liaison config apply` and the
 * agent's config tool through it, the built-in agent, a personal agent, the
 * demo seed), so no path leaves a new agent to the web's id-hash fallback.
 *
 * Two creates racing in one org can read the same counts; the random tie-break
 * makes a shared pick unlikely, and either agent's colour remains editable.
 */
export async function pickAgentAvatarColor(
  tx: PrivilegedDb,
  orgId: string,
  random: () => number = Math.random,
): Promise<number> {
  const rows = await tx
    .select({ color: agents.avatarColor, n: count() })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt), isNotNull(agents.avatarColor)))
    .groupBy(agents.avatarColor)
  return leastUsedAvatarColor(
    rows.map((r) => ({ color: r.color as number, n: Number(r.n) })),
    random,
  )
}

/** The pure half of `pickAgentAvatarColor`: the least-used slot, a tie at random. */
export function leastUsedAvatarColor(
  usage: ReadonlyArray<{ color: number; n: number }>,
  random: () => number = Math.random,
): number {
  const counts = new Array<number>(AGENT_AVATAR_COLOR_COUNT).fill(0)
  for (const { color, n } of usage) {
    if (Number.isInteger(color) && color >= 0 && color < AGENT_AVATAR_COLOR_COUNT) {
      counts[color] += n
    }
  }
  const least = Math.min(...counts)
  const candidates = counts.flatMap((n, color) => (n === least ? [color] : []))
  const pick = Math.min(candidates.length - 1, Math.floor(random() * candidates.length))
  return candidates[pick] as number
}
