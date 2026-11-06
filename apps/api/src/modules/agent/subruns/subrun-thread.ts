// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The hidden thread a sub agent works in. One insert, shared by the spawn
// (spawn-agent.ts) and the seed engine's sub run history, so a seeded sub run
// has exactly the thread shape a real spawn persists: type 'subrun', hidden
// from every list, the requester as creator, no participant seats.
import crypto from "node:crypto"
import type { PrivilegedDb } from "~/db"
import { threads } from "~/db/schema/kernel/threads"

export interface SubrunThreadInput {
  orgId: string
  subagentType: string
  /** What the sub agent was asked to do; the title keeps its first 60 characters. */
  description: string
  createdBy: string
  /** Inherited from the parent thread across the spawn boundary. */
  tainted?: boolean
  /**
   * A fixed id makes the insert idempotent (an existing row is left as it is).
   * Only history writers (the seed engine) pass one; a spawn always gets a fresh id.
   */
  id?: string
  createdAt?: Date
  updatedAt?: Date
}

/** Insert the hidden sub run thread inside the caller's privileged transaction; returns its id. */
export async function insertSubrunThread(
  tx: PrivilegedDb,
  input: SubrunThreadInput,
): Promise<string> {
  const handleSeed = input.id ?? crypto.randomUUID()
  const insert = tx.insert(threads).values({
    ...(input.id ? { id: input.id } : {}),
    orgId: input.orgId,
    handle: `subrun-${handleSeed.slice(0, 12)}`,
    title: `${input.subagentType}: ${input.description.slice(0, 60)}`,
    type: "subrun",
    hiddenFromList: true,
    createdBy: input.createdBy,
    tainted: input.tainted ?? false,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  })
  if (input.id) {
    await insert.onConflictDoNothing({ target: threads.id })
    return input.id
  }
  const [row] = await insert.returning({ id: threads.id })
  if (!row) throw new Error("insertSubrunThread: the insert returned no row")
  return row.id
}
