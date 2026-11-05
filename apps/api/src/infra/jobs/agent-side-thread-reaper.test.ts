// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-T13: the idle TTL on an all agent side thread.
//
// The predicate is PARTICIPANT COMPOSITION, not a creator flag: `threads
// .created_by` holds a user id even for a thread an agent opened, so it cannot
// tell the two apart. A room with a human in it is never hidden, however idle.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import {
  AGENT_SIDE_THREAD_IDLE_MS,
  runAgentSideThreadReaper,
} from "~/infra/jobs/agent-side-thread-reaper"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const AGENT_A = crypto.randomUUID()
const AGENT_B = crypto.randomUUID()
const tag = ORG.slice(0, 8)

// A pinned clock, never the wall clock: the fixtures are placed relative to it.
const NOW = new Date("2026-09-13T12:00:00.000Z")
const LONG_AGO = new Date(NOW.getTime() - AGENT_SIDE_THREAD_IDLE_MS - 60_000)
const RECENTLY = new Date(NOW.getTime() - 60_000)

let idleAgentThread = ""
let freshAgentThread = ""
let humanThread = ""

async function makeThread(
  handle: string,
  opts: { human: boolean; lastMessageAt: Date },
): Promise<string> {
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by, created_at)
    VALUES (${ORG}, ${handle}, 'thread', ${USER}, ${opts.lastMessageAt.toISOString()}::timestamptz) RETURNING id`
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${t.id}, ${AGENT_A}, ${ORG}, 'agent')`
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${t.id}, ${AGENT_B}, ${ORG}, 'agent')`
  if (opts.human) {
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, participant_type)
      VALUES (${t.id}, ${USER}, ${ORG}, 'user')`
  }
  await sql`INSERT INTO kernel.messages
      (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes, created_at)
    VALUES (${t.id}, ${ORG}, ${USER}, 'agent', ${AGENT_A}, 'a side exchange', '{}'::text[],
            ${opts.lastMessageAt.toISOString()}::timestamptz)`
  return t.id
}

async function hidden(threadId: string): Promise<boolean> {
  const [row] = await sql<{ hidden_from_list: boolean }[]>`
    SELECT hidden_from_list FROM kernel.threads WHERE id = ${threadId}`
  return row.hidden_from_list
}

async function threadCount(): Promise<number> {
  const rows = await sql<{ id: string }[]>`SELECT id FROM kernel.threads WHERE org_id = ${ORG}`
  return rows.length
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Reaper Org', ${`p3b-t13-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`p3b-t13-${tag}@t.com`}, 'Reaper User')`
  for (const [id, handle] of [
    [AGENT_A, `@a-${tag}`],
    [AGENT_B, `@b-${tag}`],
  ]) {
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${id}, ${ORG}, 'role', ${handle}, 'Agent', '["*"]'::jsonb)`
  }
  idleAgentThread = await makeThread(`p3b-t13-idle-${tag}`, {
    human: false,
    lastMessageAt: LONG_AGO,
  })
  freshAgentThread = await makeThread(`p3b-t13-fresh-${tag}`, {
    human: false,
    lastMessageAt: RECENTLY,
  })
  humanThread = await makeThread(`p3b-t13-human-${tag}`, { human: true, lastMessageAt: LONG_AGO })
})

afterAll(async () => {
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("the agent side thread reaper", () => {
  it("an all agent thread idle past the ttl is hidden from the list", async () => {
    const { hiddenThreadIds } = await runAgentSideThreadReaper({ now: NOW })
    expect(hiddenThreadIds).toContain(idleAgentThread)
    expect(await hidden(idleAgentThread)).toBe(true)
  })

  it("an all agent thread inside the ttl is untouched", async () => {
    expect(await hidden(freshAgentThread)).toBe(false)
  })

  it("a thread with one human participant is never hidden, however idle", async () => {
    expect(await hidden(humanThread)).toBe(false)
  })

  it("a second run changes nothing", async () => {
    const { hiddenThreadIds } = await runAgentSideThreadReaper({ now: NOW })
    expect(hiddenThreadIds).toEqual([])
    expect(await hidden(idleAgentThread)).toBe(true)
    expect(await hidden(freshAgentThread)).toBe(false)
    expect(await hidden(humanThread)).toBe(false)
  })

  it("no thread row is deleted by the reaper", async () => {
    const before = await threadCount()
    await runAgentSideThreadReaper({ now: NOW })
    expect(await threadCount()).toBe(before)
    expect(before).toBe(3)
  })
})
