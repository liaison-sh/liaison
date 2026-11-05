// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Threads that reference an entity (a ticket, a task): what a backlinks panel
// lists. Each is a thread the person starts with the reference attached,
// through `createThread` in an RLS transaction as that person.
import { createThread } from "~/modules/threads/thread"
import type { SeedContext } from "~/seed/context"
import { actorFor, asUser } from "~/seed/factories/people/actors"

export async function seedReferencingThreads(
  ctx: SeedContext,
  input: {
    userId: string
    app: string
    entityType: string
    entityId: string
    count: number
    /** Thread titles: `<titlePrefix> thread <n>`. */
    titlePrefix: string
  },
): Promise<{ threadIds: string[] }> {
  const actor = await actorFor(ctx, input.userId)
  const threadIds: string[] = []
  for (let i = 0; i < input.count; i++) {
    const created = await asUser(actor, (tx) =>
      createThread(
        tx as never,
        {
          orgId: ctx.orgId,
          userId: input.userId,
          participantIds: [],
          title: `${input.titlePrefix} thread ${i}`,
          references: [{ app: input.app, entityType: input.entityType, entityId: input.entityId }],
        } as never,
      ),
    )
    threadIds.push((created as { id: string }).id)
  }
  return { threadIds }
}
