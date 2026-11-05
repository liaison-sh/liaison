// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4a-T07: thread_participants seats agents next to humans in the SAME table.
// The database, not the caller, holds the shape: exactly one of user_id /
// agent_id is set, an agent belongs to the row's own org, and the same agent
// cannot be seated twice on one thread.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"

const ORG = crypto.randomUUID()
const OTHER_ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const AGENT_ONE = crypto.randomUUID()
const AGENT_TWO = crypto.randomUUID()
const FOREIGN_AGENT = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let THREAD = ""

// postgres.js is lazy: an un-awaited query builder never runs, so the rejection
// assertion has to await inside the promise it is handed.
const rejects = (fn: () => Promise<unknown>) => expect((async () => await fn())()).rejects

beforeAll(async () => {
  for (const [org, slug] of [
    [ORG, `p4a-a-${tag}`],
    [OTHER_ORG, `p4a-b-${tag}`],
  ]) {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${org}, 'P4a Org', ${slug})`
  }
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${USER}, ${ORG}, ${`p4a-${tag}@test.com`}, 'P4a', 'active', 'hash')`
  for (const [id, org, handle] of [
    [AGENT_ONE, ORG, `p4a-one-${tag}`],
    [AGENT_TWO, ORG, `p4a-two-${tag}`],
    [FOREIGN_AGENT, OTHER_ORG, `p4a-foreign-${tag}`],
  ]) {
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${id}, ${org}, 'role', ${handle}, 'P4a Agent')`
  }
  const [thread] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by)
    VALUES (${ORG}, ${`p4a-thr-${tag}`}, 'thread', ${USER}) RETURNING id`
  THREAD = thread!.id
})

afterAll(async () => {
  for (const org of [ORG, OTHER_ORG]) {
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${org}`
  }
})

async function insertParticipant(
  userId: string | null,
  agentId: string | null,
  type: string,
): Promise<void> {
  await sql`INSERT INTO kernel.thread_participants
    (thread_id, user_id, agent_id, org_id, participant_type)
    VALUES (${THREAD}, ${userId}, ${agentId}, ${ORG}, ${type})`
}

describe("thread_participants agent membership", () => {
  it("thread participants CHECK rejects a row with both user_id and agent_id set", async () => {
    await rejects(() => insertParticipant(USER, AGENT_ONE, "agent")).toThrow(
      /thread_participants_one_of_user_or_agent/,
    )
  })

  it("thread participants CHECK rejects a row with neither user_id nor agent_id set", async () => {
    await rejects(() => insertParticipant(null, null, "user")).toThrow(
      /thread_participants_one_of_user_or_agent/,
    )
  })

  it("thread participants allows two distinct agents on the same thread", async () => {
    await insertParticipant(null, AGENT_ONE, "agent")
    await insertParticipant(null, AGENT_TWO, "agent")
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.thread_participants
       WHERE thread_id = ${THREAD} AND participant_type = 'agent'`
    expect(row?.n).toBe(2)
  })

  it("thread participants rejects the same agent added twice to the same thread", async () => {
    await rejects(() => insertParticipant(null, AGENT_ONE, "agent")).toThrow(
      /thread_participants_thread_agent_idx/,
    )
  })

  it("thread participants still rejects the same human added twice to one thread", async () => {
    await insertParticipant(USER, null, "user")
    await rejects(() => insertParticipant(USER, null, "user")).toThrow(
      /thread_participants_thread_user_idx/,
    )
  })

  it("an upsert on the human seat must name the index predicate to infer it", async () => {
    // The human unique index is PARTIAL now, so Postgres only infers it when
    // the ON CONFLICT target repeats the predicate. Every caller that upserts a
    // participant carries WHERE user_id IS NOT NULL for that reason; without it
    // the statement fails 42P10 at plan time, which is a runtime break, not a
    // type error, and so has to be pinned here.
    const other = crypto.randomUUID()
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${other}, ${ORG}, ${`p4a-upsert-${tag}@test.com`}, 'P4a', 'active', 'hash')`
    for (let i = 0; i < 2; i++) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${THREAD}, ${other}, ${ORG})
        ON CONFLICT (thread_id, user_id) WHERE user_id IS NOT NULL DO NOTHING`
    }
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.thread_participants
       WHERE thread_id = ${THREAD} AND user_id = ${other}`
    expect(row?.n).toBe(1)

    // And the bare target no longer plans at all, which is why every call site
    // had to be updated rather than left alone.
    await rejects(
      () => sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${THREAD}, ${other}, ${ORG})
        ON CONFLICT (thread_id, user_id) DO NOTHING`,
    ).toThrow(/no unique or exclusion constraint matching the ON CONFLICT/)
  })

  it("thread participants rejects an agent belonging to another org", async () => {
    await rejects(() => insertParticipant(null, FOREIGN_AGENT, "agent")).toThrow(/foreign key/)
  })

  it("deleting an agent takes its membership rows with it", async () => {
    const doomed = crypto.randomUUID()
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${doomed}, ${ORG}, 'role', ${`p4a-doomed-${tag}`}, 'Doomed')`
    await insertParticipant(null, doomed, "agent")
    await sql`DELETE FROM kernel.agents WHERE id = ${doomed}`
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.thread_participants WHERE agent_id = ${doomed}`
    expect(row?.n).toBe(0)
  })
})

// FX1 item 1 (0078): participant_type was free text, unconstrained against the
// id columns. A row carrying agent_id at the default 'user' is an invisible
// agent seat (every read filters on participant_type); a human row claiming
// 'agent' is the same lie the other way round.
describe("thread_participants participant_type matches the id columns", () => {
  it("thread participants CHECK rejects an agent row left at participant_type user", async () => {
    const hidden = crypto.randomUUID()
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${hidden}, ${ORG}, 'role', ${`p4a-hidden-${tag}`}, 'P4a Agent')`
    await rejects(() => insertParticipant(null, hidden, "user")).toThrow(
      /thread_participants_type_matches_ids/,
    )
  })

  it("thread participants CHECK rejects a human row claiming participant_type agent", async () => {
    const claimer = crypto.randomUUID()
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${claimer}, ${ORG}, ${`p4a-claim-${tag}@test.com`}, 'P4a', 'active', 'hash')`
    await rejects(() => insertParticipant(claimer, null, "agent")).toThrow(
      /thread_participants_type_matches_ids/,
    )
  })

  it("thread participants accepts a human row at participant_type user", async () => {
    const good = crypto.randomUUID()
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${good}, ${ORG}, ${`p4a-good-${tag}@test.com`}, 'P4a', 'active', 'hash')`
    await insertParticipant(good, null, "user")
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.thread_participants
       WHERE thread_id = ${THREAD} AND user_id = ${good}`
    expect(row?.n).toBe(1)
  })

  it("thread participants accepts an agent row at participant_type agent", async () => {
    const good = crypto.randomUUID()
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${good}, ${ORG}, 'role', ${`p4a-goodagent-${tag}`}, 'P4a Agent')`
    await insertParticipant(null, good, "agent")
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.thread_participants
       WHERE thread_id = ${THREAD} AND agent_id = ${good}`
    expect(row?.n).toBe(1)
  })
})

// FX3 item 2 (0079): 0078 tied participant_type to the id columns but left the
// column itself free text. 'bot' on an agent row satisfies BOTH checks (it is
// not 'user', and user_id is NULL) and is invisible to every read, all of
// which filter on participant_type = 'agent'. The vocabulary closes that.
describe("thread_participants participant_type is a closed vocabulary", () => {
  it("thread participants CHECK rejects a third participant_type on an agent row", async () => {
    const bot = crypto.randomUUID()
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${bot}, ${ORG}, 'role', ${`p4a-bot-${tag}`}, 'P4a Agent')`
    await rejects(() => insertParticipant(null, bot, "bot")).toThrow(
      /thread_participants_participant_type_vocabulary/,
    )
  })

  it("thread participants CHECK rejects a third participant_type on a human row", async () => {
    const member = crypto.randomUUID()
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${member}, ${ORG}, ${`p4a-bot-${tag}@test.com`}, 'P4a', 'active', 'hash')`
    await rejects(() => insertParticipant(member, null, "bot")).toThrow(
      /thread_participants_participant_type_vocabulary/,
    )
  })

  it("a row violating BOTH the id rule and the vocabulary still reports the id rule first", async () => {
    const both = crypto.randomUUID()
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${both}, ${ORG}, ${`p4a-both-${tag}@test.com`}, 'P4a', 'active', 'hash')`
    await rejects(() => insertParticipant(both, AGENT_ONE, "bot")).toThrow(
      /thread_participants_one_of_user_or_agent/,
    )
  })
})
