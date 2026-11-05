// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shared-conversation section: a turn in a thread other people read is
// told who they are and how to write for them; a private agent chat is told
// nothing. The live failure this pins: asked in a task's discussion to file
// subtasks and answer a teammate, the agent wrote as if the chat were private
// (retry notes, a blocker report, a "say the word" to the asker, and the
// teammate's answer as an unsent draft), all posted in front of the teammate.
// Every assertion is on the REAL assembled tail.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { assembleContext, resetSystemPromptCache } from "~/modules/agent/context/context"
import { SHARED_THREAD_HEADING } from "~/modules/agent/context/shared-thread-audience"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const ASKER = crypto.randomUUID()
const TEAMMATE = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let SHARED = ""
let PRIVATE = ""

const actor: UserContext = {
  actorType: "user",
  userId: ASKER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

/** The ephemeral runtime-context tail, exactly as the model receives it. */
function tail(result: Awaited<ReturnType<typeof assembleContext>>): string {
  const last = result.messages[result.messages.length - 1]
  const content = typeof last?.content === "string" ? last.content : ""
  return content.startsWith("<runtime-context") ? content : ""
}

async function thread(type: string, participants: string[]): Promise<string> {
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by)
    VALUES (${ORG}, ${`shared-${type}-${tag}`}, ${type}, ${ASKER}) RETURNING id`
  for (const userId of participants) {
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${t.id}, ${userId}, ${ORG})`
  }
  await sql`
    INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
    VALUES (${t.id}, ${ORG}, ${ASKER}, 'user', 'break this task into subtasks, then answer here', '{}'::text[])`
  return t.id
}

beforeAll(async () => {
  await acquireTestLock()
  resetSystemPromptCache()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Shared Thread Org', ${`shared-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ASKER}, ${ORG}, ${`asker-${tag}@test.com`}, 'Alex Rivera')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${TEAMMATE}, ${ORG}, ${`mate-${tag}@test.com`}, 'Sam Okafor')`
  SHARED = await thread("thread", [ASKER, TEAMMATE])
  PRIVATE = await thread("agent_chat", [ASKER])
})

afterAll(async () => {
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("the shared-conversation section", () => {
  it("names who reads the reply and how to write it, in a thread with a teammate", async () => {
    const result = await assembleContext({ threadId: SHARED, orgId: ORG, actor })
    const t = tail(result)
    expect(t).toContain(SHARED_THREAD_HEADING)
    expect(t).toContain("Alex Rivera asked you this in a conversation Sam Okafor can also read.")
    expect(t).toContain("no tool names, errors, retries or internal detail")
    expect(t).toContain("post the message to them, or don't")
    expect(t).toContain('"say the word"')
    expect(t).toContain("naming Alex Rivera if they need to act")
    expect(result.sharedAudience?.others).toEqual(["Sam Okafor"])
    // Volatile tail only: the cached system prefix is the same in both kinds of thread.
    expect(JSON.stringify(result.system)).not.toContain(SHARED_THREAD_HEADING)
  })

  it("is absent from a private agent chat", async () => {
    const result = await assembleContext({ threadId: PRIVATE, orgId: ORG, actor })
    expect(tail(result)).not.toContain(SHARED_THREAD_HEADING)
    expect(result.sharedAudience).toBeNull()
  })
})
