// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Bare thread rows, for a test that needs a room, a participant or a message with known
// columns (a message's stamp of required scopes, say) and nothing the product's write adds.
// A test that needs a conversation as the product writes it takes `seedThreads` or
// `seedThreadHistory`.
//
// Privileged: written over the system connection, every column the schema's.
import { withSystemDb } from "~/db/privileged"
import { messages, threadParticipants, threads } from "~/db/schema/kernel/threads"

export type ThreadRowSeed = typeof threads.$inferInsert
export type ThreadParticipantRowSeed = typeof threadParticipants.$inferInsert
export type MessageRowSeed = typeof messages.$inferInsert

/** One thread row; its id. */
export async function seedThreadRow(row: ThreadRowSeed): Promise<string> {
  const [created] = await withSystemDb("seed-thread-row", (db) =>
    db.insert(threads).values(row).returning({ id: threads.id }),
  )
  return created?.id as string
}

/** One thread participant row. */
export async function seedThreadParticipantRow(row: ThreadParticipantRowSeed): Promise<void> {
  await withSystemDb("seed-thread-participant-row", (db) =>
    db.insert(threadParticipants).values(row),
  )
}

/** One message row; its id. */
export async function seedMessageRow(row: MessageRowSeed): Promise<string> {
  const [created] = await withSystemDb("seed-message-row", (db) =>
    db.insert(messages).values(row).returning({ id: messages.id }),
  )
  return created?.id as string
}
