// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Thread messages for api end-to-end scenarios, made in the server under test
// by the seed route's `threads.injectMessage` (test-support/seed/inject.ts).
// An agent-authored row speaks as the agent the reply path itself would name
// (`speaker: "runtime"`, `resolveActingAgentIdForWrite`), and carries the tag
// a cleanly ended, tool-free turn writes unless the scenario names one; both
// rules are the runtime's, pinned by
// `modules/threads/thread-seed-runtime-parity.test.ts`.
import type { WorkerEnv } from "@liaison/test-helpers"
import { seedFactory } from "./seed-factory"

/** One seeded thread message. */
export interface SeedMessage {
  threadId: string
  orgId: string
  authorId: string
  /** Defaults to "user". */
  authorType?: "user" | "agent" | "system"
  content: string
  /** Agent-authored rows: defaults to the agent the reply path would name. */
  authorAgentId?: string
  metadata?: Record<string, unknown>
  /** Milliseconds since the epoch. Defaults to now. */
  createdAt?: number
  /** Who may read the row; default the tag a clean, tool-free turn writes (none). */
  requiredScopes?: string[]
}

/** One message on a thread; its id. */
export async function seedThreadMessage(env: WorkerEnv, message: SeedMessage): Promise<string> {
  const { id } = await seedFactory<{ id: string }>(env, message.orgId, "threads.injectMessage", {
    threadId: message.threadId,
    authorId: message.authorId,
    authorType: message.authorType ?? "user",
    content: message.content,
    speaker: "runtime",
    ...(message.authorAgentId ? { authorAgentId: message.authorAgentId } : {}),
    ...(message.metadata ? { metadata: message.metadata } : {}),
    ...(message.requiredScopes ? { requiredScopes: message.requiredScopes } : {}),
    ...(message.createdAt !== undefined
      ? { createdAt: new Date(message.createdAt).toISOString() }
      : {}),
  })
  return id
}

/** Several messages in order; their ids, in the order given. */
export async function seedThreadMessages(
  env: WorkerEnv,
  messages: SeedMessage[],
): Promise<string[]> {
  const ids: string[] = []
  for (const message of messages) ids.push(await seedThreadMessage(env, message))
  return ids
}
