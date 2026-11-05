// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4a-T04/T05/T06: the Drizzle side of Home's schema change. An agent is a
// member of a thread through the SAME table a human is (spec-home.md "One
// channel type"), so `thread_participants.user_id` becomes nullable, a nullable
// `agent_id` joins it, and exactly one of the two is set. `threads` gains
// `discoverable` (a channel), `messages` gains `author_agent_id` (A8).
//
// These assertions read the Drizzle column map only. The database-side
// constraints (the CHECK, the two partial unique indexes, the composite
// agent/org foreign keys and the agent-author guard) are proven against a real
// Postgres in this slice's migration tests.
import { describe, expect, it } from "bun:test"
import { messages, threadParticipants, threads } from "./threads"

describe("thread participants carry agent membership", () => {
  it("thread participants schema exports participantType and agentId columns", () => {
    const cols = Object.keys(threadParticipants)
    expect(cols).toContain("participantType")
    expect(cols).toContain("agentId")
    expect(threadParticipants.participantType.default).toBe("user")
  })

  it("thread participants userId is nullable in the schema", () => {
    expect(threadParticipants.userId.notNull).toBe(false)
    // agentId is the other half of the pair and is nullable for the same reason.
    expect(threadParticipants.agentId.notNull).toBe(false)
  })
})

describe("threads carry discoverability", () => {
  it("threads schema exports a discoverable column defaulting to false", () => {
    expect(Object.keys(threads)).toContain("discoverable")
    expect(threads.discoverable.notNull).toBe(true)
    expect(threads.discoverable.default).toBe(false)
  })
})

describe("messages carry agent attribution", () => {
  it("messages schema exports authorAgentId as a nullable uuid column", () => {
    expect(Object.keys(messages)).toContain("authorAgentId")
    expect(messages.authorAgentId.notNull).toBe(false)
    expect(messages.authorAgentId.columnType).toBe("PgUUID")
    // 2b's requiredScopes is untouched by this slice and still mandatory.
    expect(messages.requiredScopes.notNull).toBe(true)
  })
})
