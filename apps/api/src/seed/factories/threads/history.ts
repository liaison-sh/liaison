// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The thread history factory: messages that were sent over the last days, not
// a moment ago. Each message goes in through `sendMessage` as its author (the
// product's own write, participant check and event included), and is then
// moved back to the instant the spec gives it.
//
// Privileged raw SQL, by category: history. `sendMessage` stamps `now()`, and
// a conversation that "happened" over two weeks has no product writer, so the
// row's `created_at` (and the room's `updated_at`, which orders the Messages
// list) are set afterwards, the way time would have set them.
//
// Idempotent on the message's own key: a message carries `seedKey` in its
// metadata and a re-run finds it instead of sending it again.
import { and, eq, sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { messages, threads } from "~/db/schema/kernel/threads"
import { SEEDED_METADATA } from "~/modules/notifications/seeded"
import { sendMessage } from "~/modules/threads/message"
import type { SeedContext } from "~/seed/context"
import { asUser } from "~/seed/factories/people/actors"

export interface HistoryMessageSpec {
  /** Unique within the org: the message's idempotency key. */
  key: string
  threadId: string
  /** The person whose turn it is (for an agent message, the person it answered). */
  actor: UserContext
  /** Set for an agent's message: the agent that spoke. */
  agent?: { agentId: string; displayName: string }
  body: string
  at: Date
}

export interface HistoryMessage {
  key: string
  messageId: string
  threadId: string
  at: Date
}

async function existingByKey(ctx: SeedContext): Promise<Map<string, string>> {
  const rows = await withPrivilegedDb(ctx.orgId, "seed-thread-history:existing", (tx) =>
    tx
      .select({ id: messages.id, key: sql<string>`${messages.metadata}->>'seedKey'` })
      .from(messages)
      .where(and(eq(messages.orgId, ctx.orgId), sql`${messages.metadata} ? 'seedKey'`)),
  )
  return new Map(rows.map((r) => [r.key, r.id]))
}

/**
 * Write each message (skipping the ones an earlier run wrote), then place every
 * one at its instant and bring each touched room's `updated_at` to its newest
 * message. Returns one entry per spec, in spec order.
 */
export async function seedThreadHistory(
  ctx: SeedContext,
  specs: readonly HistoryMessageSpec[],
): Promise<HistoryMessage[]> {
  const known = await existingByKey(ctx)
  const out: HistoryMessage[] = []
  for (const spec of specs) {
    let messageId = known.get(spec.key)
    if (!messageId) {
      const sent = await asUser(spec.actor, (tx) =>
        sendMessage(
          tx as never,
          {
            orgId: ctx.orgId,
            userId: spec.actor.userId,
            threadId: spec.threadId,
            content: spec.body,
            authorType: spec.agent ? "agent" : "user",
            ...(spec.agent
              ? { agentId: spec.agent.agentId, agentAuthorLabel: spec.agent.displayName }
              : {}),
            requiredScopes: [],
            metadata: { ...SEEDED_METADATA, seedKey: spec.key },
          } as never,
        ),
      )
      if (!sent) throw new Error(`thread history: message '${spec.key}' was not written`)
      messageId = sent.id as string
    }
    out.push({ key: spec.key, messageId, threadId: spec.threadId, at: spec.at })
  }

  await withPrivilegedDb(ctx.orgId, "seed-thread-history:backdate", async (tx) => {
    for (const m of out) {
      await tx
        .update(messages)
        .set({ createdAt: m.at })
        .where(and(eq(messages.id, m.messageId), eq(messages.orgId, ctx.orgId)))
    }
    for (const threadId of new Set(out.map((m) => m.threadId))) {
      // The room reads as last active at its newest message.
      await tx
        .update(threads)
        .set({
          updatedAt: sql`coalesce((SELECT max(m.created_at) FROM ${messages} m WHERE m.thread_id = ${threadId}::uuid), ${threads.updatedAt})`,
        })
        .where(and(eq(threads.id, threadId), eq(threads.orgId, ctx.orgId)))
    }
  })
  return out
}
