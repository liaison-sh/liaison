// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"

/**
 * Every kernel table that carries BOTH an org_id and a reference to
 * kernel.agents must name the agent through a COMPOSITE (agent, org_id)
 * foreign key, so the agent belongs to the ROW'S OWN ORG.
 *
 * 0070 (audit_log) and 0071 (approval_requests) each fixed ONE table of this
 * class and a third surfaced afterwards (routines). 0072 closes the class in
 * one migration: routines, skills, agent_memory, agent_skill_index and
 * agent_knowledge_pointers. A single-column foreign key checks EXISTENCE only,
 * so org A's row happily named org B's agent.
 *
 * Why that mattered beyond tidiness: an org-A routine naming an org-B agent
 * was accepted, and the audit row the routine tick then emits copies
 * routines.owner_agent_id onto itself, where audit_log's own composite guard
 * REJECTS it with 23503. The durable audit handler treats that as fatal, so
 * the outbox retried and dead-lettered, losing the audit row and the timeline
 * rows with it.
 *
 * ON DELETE semantics are PRESERVED exactly, per table, not harmonised:
 * routines / skills / agent_memory keep NO ACTION (deleting a referenced agent
 * is refused), and agent_skill_index / agent_knowledge_pointers keep CASCADE.
 * The user-erasure cascade in modules/erasure/erase-user.ts depends on both
 * halves of that: it explicitly clears routines and agent_memory rows and
 * NULLs skills.owner_agent_id BEFORE deleting a personal agent precisely
 * because those FKs block the delete, and it deliberately writes no statement
 * for the two CASCADE tables. Flipping either direction here would silently
 * change what erasure does.
 */
describe("kernel agent foreign keys carry the row's own org", () => {
  const ORG_A = crypto.randomUUID()
  const ORG_B = crypto.randomUUID()
  const USER_A = crypto.randomUUID()
  const AGENT_A = crypto.randomUUID()
  const AGENT_B = crypto.randomUUID()
  const tag = ORG_A.slice(0, 8)

  // A valid org-A skill, needed as agent_skill_index.skill_id's referent.
  let SKILL_A = ""
  // A valid org-A thread, needed as agent_runs.thread_id's referent.
  let THREAD_A = ""

  async function seedOrg(orgId: string, slug: string): Promise<void> {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${orgId}, 'FX25 Org', ${slug})`
  }

  beforeAll(async () => {
    await seedOrg(ORG_A, `fx25-a-${tag}`)
    await seedOrg(ORG_B, `fx25-b-${tag}`)
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER_A}, ${ORG_A}, ${`fx25-a-${tag}@test.com`}, 'A', 'active', 'hash')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${AGENT_A}, ${ORG_A}, 'role', ${`fx25-a-${tag}`}, 'Agent A')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${AGENT_B}, ${ORG_B}, 'role', ${`fx25-b-${tag}`}, 'Agent B')`
    const [skill] = await sql<{ id: string }[]>`
      INSERT INTO kernel.skills
        (org_id, owner_agent_id, name, description, body, required_scopes, created_by_actor_type)
      VALUES (${ORG_A}, ${AGENT_A}, ${`anchor-${tag}`}, 'd', 'b', '{}', 'user')
      RETURNING id`
    SKILL_A = skill!.id
    const [thread] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, type, created_by)
      VALUES (${ORG_A}, ${`fx25-thr-${tag}`}, 'thread', ${USER_A})
      RETURNING id`
    THREAD_A = thread!.id
  })

  afterAll(async () => {
    for (const org of [ORG_A, ORG_B]) {
      await sql`DELETE FROM kernel.agent_local_claims WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.scope_requests WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.agent_runs WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.agent_knowledge_pointers WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.agent_skill_index WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.routines WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.skills WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.messages WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.threads WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.agents WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.users WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${org}`
    }
  })

  // ---- one insert helper per table under test -----------------------------
  // Each inserts into ORG_A naming whatever agent it is handed, and supplies
  // the NOT NULL columns and nothing else: the agent column is what is on trial.

  async function insertRoutine(agentId: string | null, name: string): Promise<void> {
    await sql`INSERT INTO kernel.routines
      (org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone,
       prompt, scopes, created_by_actor_type)
      VALUES (${ORG_A}, ${USER_A}, ${agentId}, ${name}, 'd', 'recurring', '0 9 * * *', 'UTC',
              'p', '{}', 'user')`
  }

  async function insertSkill(agentId: string | null, name: string): Promise<void> {
    await sql`INSERT INTO kernel.skills
      (org_id, owner_agent_id, name, description, body, required_scopes, created_by_actor_type)
      VALUES (${ORG_A}, ${agentId}, ${name}, 'd', 'b', '{}', 'user')`
  }

  async function insertMemory(agentId: string | null, name: string): Promise<void> {
    await sql`INSERT INTO kernel.agent_memory
      (org_id, owner_agent_id, type, name, description, content, required_scopes)
      VALUES (${ORG_A}, ${agentId}, 'user', ${name}, 'd', 'c', '{}')`
  }

  async function insertSkillIndex(agentId: string, name: string): Promise<void> {
    await sql`INSERT INTO kernel.agent_skill_index (org_id, agent_id, skill_name, skill_id)
      VALUES (${ORG_A}, ${agentId}, ${name}, ${SKILL_A})`
  }

  // X11: agent_runs.agent_id joined this class with 0074.
  async function insertAgentRun(agentId: string | null, prompt: string): Promise<void> {
    const runId = crypto.randomUUID()
    await sql`INSERT INTO kernel.agent_runs
      (id, org_id, agent_id, root_run_id, thread_id, actor, prompt,
       max_steps, timeout_ms, schema_retry_budget)
      VALUES (${runId}, ${ORG_A}, ${agentId}, ${runId}, ${THREAD_A},
              ${JSON.stringify({ actorType: "system", orgId: ORG_A, purpose: "job", scopes: [] })}::jsonb,
              ${prompt}, 4, 1000, 1)`
  }

  // P4a: thread_participants.agent_id joined this class with 0075.
  async function insertParticipant(agentId: string): Promise<void> {
    await sql`INSERT INTO kernel.thread_participants
      (thread_id, user_id, agent_id, org_id, participant_type)
      VALUES (${THREAD_A}, NULL, ${agentId}, ${ORG_A}, 'agent')`
  }

  // P4a: messages.author_agent_id joined this class with 0076.
  async function insertMessage(agentId: string, content: string): Promise<void> {
    await sql`INSERT INTO kernel.messages
      (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
      VALUES (${THREAD_A}, ${ORG_A}, ${USER_A}, 'agent', ${agentId}, ${content}, '{}')`
  }

  // A32: agent_local_claims.agent_id joined this class with 0092.
  async function insertLocalClaim(agentId: string, holder: string): Promise<void> {
    await sql`INSERT INTO kernel.agent_local_claims
      (org_id, thread_id, agent_id, user_id, holder_key, expires_at)
      VALUES (${ORG_A}, ${THREAD_A}, ${agentId}, ${USER_A}, ${holder}, now() + interval '1 minute')`
  }

  // scope_requests.agent_id joined this class with 0109.
  // One scope per call: a pending request is unique on (org, requester, scopes).
  async function insertScopeRequest(agentId: string, reason: string): Promise<void> {
    await sql`INSERT INTO kernel.scope_requests
      (org_id, requested_by, requested_by_type, agent_id, target_user_id, requested_scopes, reason)
      VALUES (${ORG_A}, ${USER_A}, 'agent', ${agentId}, ${USER_A}, ${[`fx25:${reason}:read`]}, ${reason})`
  }

  async function insertPointer(agentId: string): Promise<void> {
    await sql`INSERT INTO kernel.agent_knowledge_pointers (org_id, agent_id, collection_id)
      VALUES (${ORG_A}, ${agentId}, ${crypto.randomUUID()})`
  }

  const GHOST = "00000000-0000-4000-8000-0000000025ff"

  // postgres.js is lazy: an un-awaited query builder never runs, so the
  // rejection assertion has to await inside the promise it is handed.
  const rejects = (fn: () => Promise<unknown>) => expect((async () => await fn())()).rejects

  describe("routines.owner_agent_id", () => {
    it("accepts an agent of the routine's own org", async () => {
      await insertRoutine(AGENT_A, `own-${tag}`)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.routines
         WHERE org_id = ${ORG_A} AND name = ${`own-${tag}`}`
      expect(row?.n).toBe(1)
    })

    it("rejects an agent that belongs to another org and keeps no row behind", async () => {
      await rejects(() => insertRoutine(AGENT_B, `cross-${tag}`)).toThrow(/foreign key/)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.routines
         WHERE org_id = ${ORG_A} AND name = ${`cross-${tag}`}`
      expect(row?.n).toBe(0)
    })

    it("rejects an agent id that is no agent at all", async () => {
      await rejects(() => insertRoutine(GHOST, `ghost-${tag}`)).toThrow(/foreign key/)
    })

    it("still accepts a null owner agent", async () => {
      await insertRoutine(null, `null-${tag}`)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.routines
         WHERE org_id = ${ORG_A} AND name = ${`null-${tag}`}`
      expect(row?.n).toBe(1)
    })
  })

  describe("skills.owner_agent_id", () => {
    it("accepts an agent of the skill's own org", async () => {
      await insertSkill(AGENT_A, `own-${tag}`)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.skills
         WHERE org_id = ${ORG_A} AND name = ${`own-${tag}`}`
      expect(row?.n).toBe(1)
    })

    it("rejects an agent that belongs to another org and keeps no row behind", async () => {
      await rejects(() => insertSkill(AGENT_B, `cross-${tag}`)).toThrow(/foreign key/)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.skills
         WHERE org_id = ${ORG_A} AND name = ${`cross-${tag}`}`
      expect(row?.n).toBe(0)
    })

    it("rejects an agent id that is no agent at all", async () => {
      await rejects(() => insertSkill(GHOST, `ghost-${tag}`)).toThrow(/foreign key/)
    })
  })

  describe("agent_memory.owner_agent_id", () => {
    it("accepts an agent of the memory row's own org", async () => {
      await insertMemory(AGENT_A, `own-${tag}`)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.agent_memory
         WHERE org_id = ${ORG_A} AND name = ${`own-${tag}`}`
      expect(row?.n).toBe(1)
    })

    it("rejects an agent that belongs to another org and keeps no row behind", async () => {
      await rejects(() => insertMemory(AGENT_B, `cross-${tag}`)).toThrow(/foreign key/)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.agent_memory
         WHERE org_id = ${ORG_A} AND name = ${`cross-${tag}`}`
      expect(row?.n).toBe(0)
    })

    it("rejects an agent id that is no agent at all", async () => {
      await rejects(() => insertMemory(GHOST, `ghost-${tag}`)).toThrow(/foreign key/)
    })
  })

  describe("agent_skill_index.agent_id", () => {
    it("accepts an agent of the index row's own org", async () => {
      await insertSkillIndex(AGENT_A, `own-${tag}`)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.agent_skill_index
         WHERE org_id = ${ORG_A} AND skill_name = ${`own-${tag}`}`
      expect(row?.n).toBe(1)
    })

    it("rejects an agent that belongs to another org and keeps no row behind", async () => {
      await rejects(() => insertSkillIndex(AGENT_B, `cross-${tag}`)).toThrow(/foreign key/)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.agent_skill_index
         WHERE org_id = ${ORG_A} AND skill_name = ${`cross-${tag}`}`
      expect(row?.n).toBe(0)
    })
  })

  describe("thread_participants.agent_id", () => {
    it("accepts an agent of the thread's own org", async () => {
      await insertParticipant(AGENT_A)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.thread_participants
         WHERE org_id = ${ORG_A} AND agent_id = ${AGENT_A}`
      expect(row?.n).toBe(1)
    })

    it("rejects an agent that belongs to another org and keeps no row behind", async () => {
      await rejects(() => insertParticipant(AGENT_B)).toThrow(/foreign key/)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.thread_participants
         WHERE org_id = ${ORG_A} AND agent_id = ${AGENT_B}`
      expect(row?.n).toBe(0)
    })

    it("rejects an agent id that is no agent at all", async () => {
      await rejects(() => insertParticipant(GHOST)).toThrow(/foreign key/)
    })
  })

  describe("messages.author_agent_id", () => {
    it("accepts an agent of the message's own org", async () => {
      await insertMessage(AGENT_A, `own-msg-${tag}`)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.messages
         WHERE org_id = ${ORG_A} AND content = ${`own-msg-${tag}`}`
      expect(row?.n).toBe(1)
    })

    it("rejects an agent that belongs to another org and keeps no row behind", async () => {
      await rejects(() => insertMessage(AGENT_B, `cross-msg-${tag}`)).toThrow(/foreign key/)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.messages
         WHERE org_id = ${ORG_A} AND content = ${`cross-msg-${tag}`}`
      expect(row?.n).toBe(0)
    })

    it("rejects an agent id that is no agent at all", async () => {
      await rejects(() => insertMessage(GHOST, `ghost-msg-${tag}`)).toThrow(/foreign key/)
    })
  })

  describe("agent_knowledge_pointers.agent_id", () => {
    it("accepts an agent of the pointer row's own org", async () => {
      await insertPointer(AGENT_A)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.agent_knowledge_pointers
         WHERE org_id = ${ORG_A} AND agent_id = ${AGENT_A}`
      expect(row?.n).toBe(1)
    })

    it("rejects an agent that belongs to another org and keeps no row behind", async () => {
      await rejects(() => insertPointer(AGENT_B)).toThrow(/foreign key/)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.agent_knowledge_pointers
         WHERE org_id = ${ORG_A} AND agent_id = ${AGENT_B}`
      expect(row?.n).toBe(0)
    })
  })

  describe("agent_local_claims.agent_id", () => {
    it("accepts an agent of the claim's own org", async () => {
      await insertLocalClaim(AGENT_A, `own-claim-${tag}`)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.agent_local_claims
         WHERE org_id = ${ORG_A} AND holder_key = ${`own-claim-${tag}`}`
      expect(row?.n).toBe(1)
    })

    it("rejects an agent that belongs to another org and keeps no row behind", async () => {
      // A claim tells the SERVER to stand down for that agent in that thread.
      // A single-column key would accept org B's agent here, which is one org
      // handing another org's runtime to a machine of its own.
      await rejects(() => insertLocalClaim(AGENT_B, `cross-claim-${tag}`)).toThrow(/foreign key/)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.agent_local_claims
         WHERE org_id = ${ORG_A} AND holder_key = ${`cross-claim-${tag}`}`
      expect(row?.n).toBe(0)
    })

    it("rejects an agent id that is no agent at all", async () => {
      await rejects(() => insertLocalClaim(GHOST, `ghost-claim-${tag}`)).toThrow(/foreign key/)
    })
  })

  describe("scope_requests.agent_id", () => {
    it("accepts an agent of the request's own org", async () => {
      await insertScopeRequest(AGENT_A, `own-sr-${tag}`)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.scope_requests
         WHERE org_id = ${ORG_A} AND reason = ${`own-sr-${tag}`}`
      expect(row?.n).toBe(1)
    })

    it("rejects an agent that belongs to another org and keeps no row behind", async () => {
      // The admin row names this agent as the one that asked. A single-column
      // key (0098) accepted org B's agent here, crediting org A's request to a
      // speaker that never sat in org A.
      await rejects(() => insertScopeRequest(AGENT_B, `cross-sr-${tag}`)).toThrow(/foreign key/)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.scope_requests
         WHERE org_id = ${ORG_A} AND reason = ${`cross-sr-${tag}`}`
      expect(row?.n).toBe(0)
    })

    it("rejects an agent id that is no agent at all", async () => {
      await rejects(() => insertScopeRequest(GHOST, `ghost-sr-${tag}`)).toThrow(/foreign key/)
    })
  })

  // ---- ON DELETE behaviour is preserved per table, not harmonised ---------

  describe("ON DELETE behaviour is unchanged by the composite key", () => {
    /** Seed a throwaway agent in ORG_A and return its id. */
    async function doomedAgent(label: string): Promise<string> {
      const id = crypto.randomUUID()
      await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
        VALUES (${id}, ${ORG_A}, 'role', ${`${label}-${tag}`}, 'Doomed')`
      return id
    }

    it("routines: deleting an agent that owns a routine is REFUSED", async () => {
      // NO ACTION, exactly as before 0072. erase-user.ts relies on this: it
      // deletes the personal agent's routines FIRST, and this refusal is what
      // would catch it if that statement were ever dropped.
      const doomed = await doomedAgent("d-routine")
      await insertRoutine(doomed, `doomed-routine-${tag}`)
      await rejects(() => sql`DELETE FROM kernel.agents WHERE id = ${doomed}`).toThrow(
        /foreign key/,
      )
    })

    it("skills: deleting an agent that owns a skill is REFUSED", async () => {
      const doomed = await doomedAgent("d-skill")
      await insertSkill(doomed, `doomed-skill-${tag}`)
      await rejects(() => sql`DELETE FROM kernel.agents WHERE id = ${doomed}`).toThrow(
        /foreign key/,
      )
    })

    it("agent_memory: deleting an agent that owns a memory row is REFUSED", async () => {
      const doomed = await doomedAgent("d-memory")
      await insertMemory(doomed, `doomed-memory-${tag}`)
      await rejects(() => sql`DELETE FROM kernel.agents WHERE id = ${doomed}`).toThrow(
        /foreign key/,
      )
    })

    it("agent_skill_index: deleting the agent CASCADE-deletes its index rows", async () => {
      const doomed = await doomedAgent("d-index")
      await insertSkillIndex(doomed, `doomed-index-${tag}`)
      await sql`DELETE FROM kernel.agents WHERE id = ${doomed}`
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.agent_skill_index WHERE agent_id = ${doomed}`
      expect(row?.n).toBe(0)
    })

    it("thread_participants: deleting the agent CASCADE-deletes its membership rows", async () => {
      // A BINDING row, like 0073's connections: the seat goes with the agent.
      // SET NULL is not even available, the one-of-user-or-agent CHECK refuses
      // a row with neither id set.
      const doomed = await doomedAgent("d-participant")
      await insertParticipant(doomed)
      await sql`DELETE FROM kernel.agents WHERE id = ${doomed}`
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.thread_participants WHERE agent_id = ${doomed}`
      expect(row?.n).toBe(0)
    })

    it("messages: deleting the agent CLEARS the attribution and keeps the message", async () => {
      // A HISTORY row, like audit_log's: SET NULL (author_agent_id), so the
      // erasure of a personal agent costs the name and never the conversation.
      const doomed = await doomedAgent("d-message")
      await insertMessage(doomed, `doomed-msg-${tag}`)
      await sql`DELETE FROM kernel.agents WHERE id = ${doomed}`
      const [row] = await sql<{ author_agent_id: string | null }[]>`
        SELECT author_agent_id FROM kernel.messages
         WHERE org_id = ${ORG_A} AND content = ${`doomed-msg-${tag}`}`
      expect(row).toBeDefined()
      expect(row?.author_agent_id).toBeNull()
    })

    it("agent_local_claims: deleting the agent CASCADE-deletes its claims", async () => {
      // CASCADE, exactly as 0090 wrote it: a lease is about a live agent.
      const doomed = await doomedAgent("d-claim")
      await insertLocalClaim(doomed, `doomed-claim-${tag}`)
      await sql`DELETE FROM kernel.agents WHERE id = ${doomed}`
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.agent_local_claims WHERE agent_id = ${doomed}`
      expect(row?.n).toBe(0)
    })

    it("scope_requests: deleting the agent CLEARS the agent and keeps the request", async () => {
      // SET NULL (agent_id), exactly as 0098 wrote it: the request is the
      // human's, so the agent's erasure costs the name and never the request.
      const doomed = await doomedAgent("d-scope-request")
      await insertScopeRequest(doomed, `doomed-sr-${tag}`)
      await sql`DELETE FROM kernel.agents WHERE id = ${doomed}`
      const [row] = await sql<{ agent_id: string | null }[]>`
        SELECT agent_id FROM kernel.scope_requests
         WHERE org_id = ${ORG_A} AND reason = ${`doomed-sr-${tag}`}`
      expect(row).toBeDefined()
      expect(row?.agent_id).toBeNull()
    })

    it("agent_knowledge_pointers: deleting the agent CASCADE-deletes its pointers", async () => {
      const doomed = await doomedAgent("d-pointer")
      await insertPointer(doomed)
      await sql`DELETE FROM kernel.agents WHERE id = ${doomed}`
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.agent_knowledge_pointers
         WHERE agent_id = ${doomed}`
      expect(row?.n).toBe(0)
    })

    it("deleting an ORG still cascades its agents and their memory away", async () => {
      // A composite key that names org_id must not deadlock the org cascade:
      // organizations -> agents and organizations -> agent_memory both fire in
      // the SAME statement, and the agent_memory -> agents key is NO ACTION.
      // NO ACTION is checked at end of statement, which is exactly what lets
      // both children go together; a RESTRICT there would fail immediately.
      //
      // agent_memory (not routines) is the probe here because routines require
      // a NOT NULL owner_user_id and kernel.users holds the org back with its
      // own RESTRICT (users_org_fk) -- an unrelated constraint that would mask
      // what this test is about.
      const org = crypto.randomUUID()
      const agent = crypto.randomUUID()
      const short = org.slice(0, 8)
      await seedOrg(org, `fx25-cascade-${short}`)
      await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
        VALUES (${agent}, ${org}, 'role', ${`fx25-c-${short}`}, 'Cascade')`
      await sql`INSERT INTO kernel.agent_memory
        (org_id, owner_agent_id, type, name, description, content, required_scopes)
        VALUES (${org}, ${agent}, 'user', 'm', 'd', 'c', '{}')`

      await sql`DELETE FROM kernel.organizations WHERE id = ${org}`

      const [left] = await sql<{ n: number }[]>`
        SELECT (SELECT count(*) FROM kernel.agent_memory WHERE org_id = ${org})
             + (SELECT count(*) FROM kernel.agents WHERE org_id = ${org}) AS n`
      expect(Number(left?.n)).toBe(0)
    })
  })

  // ---- the guard that stops this class recurring one table at a time -----

  describe("the class as a whole", () => {
    it("every org-scoped table referencing kernel.agents uses a composite key", async () => {
      const rows = await sql<
        { table_name: string; conname: string; cols: string[]; has_org: boolean }[]
      >`
        SELECT rel.relname AS table_name,
               con.conname,
               (SELECT array_agg(a.attname ORDER BY x.ord)
                  FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
                  JOIN pg_attribute a
                    ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS cols,
               EXISTS (SELECT 1 FROM pg_attribute o
                        WHERE o.attrelid = con.conrelid AND o.attname = 'org_id'
                          AND o.attnum > 0 AND NOT o.attisdropped) AS has_org
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = rel.relnamespace
          JOIN pg_class fr ON fr.oid = con.confrelid
          JOIN pg_namespace fn ON fn.oid = fr.relnamespace
         WHERE con.contype = 'f'
           AND fr.relname = 'agents' AND fn.nspname = 'kernel'
         ORDER BY rel.relname`

      // Every agent-referencing table in kernel carries an org_id, so every one
      // of these keys must be composite. If a future table legitimately has no
      // org_id, it lands in has_org=false and is exempted here rather than
      // silently weakening the rule for the others.
      const offenders = rows
        .filter((r) => r.has_org && !r.cols.includes("org_id"))
        .map((r) => `${r.table_name}.${r.conname} (${r.cols.join(", ")})`)
      expect(offenders).toEqual([])

      // And the class is not empty: if these tables ever lose their FK
      // altogether the test must not pass vacuously.
      expect(rows.length).toBeGreaterThanOrEqual(8)
    })

    it("the composite keys all point at the shared agents_id_org_uk unique key", async () => {
      const [uk] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_constraint
         WHERE conname = 'agents_id_org_uk' AND connamespace = 'kernel'::regnamespace`
      expect(uk?.n).toBe(1)
    })
  })

  describe("agent_runs.agent_id", () => {
    it("accepts an agent of the run's own org", async () => {
      await insertAgentRun(AGENT_A, `own-run-${tag}`)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.agent_runs
         WHERE org_id = ${ORG_A} AND prompt = ${`own-run-${tag}`}`
      expect(row?.n).toBe(1)
    })

    it("rejects an agent that belongs to another org and keeps no row behind", async () => {
      await rejects(() => insertAgentRun(AGENT_B, `cross-run-${tag}`)).toThrow(/foreign key/)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.agent_runs
         WHERE org_id = ${ORG_A} AND prompt = ${`cross-run-${tag}`}`
      expect(row?.n).toBe(0)
    })

    it("rejects an agent id that is no agent at all", async () => {
      await rejects(() => insertAgentRun(GHOST, `ghost-run-${tag}`)).toThrow(/foreign key/)
    })

    it("still accepts a null agent: a cron, a job or a webhook spawned it", async () => {
      await insertAgentRun(null, `null-run-${tag}`)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.agent_runs
         WHERE org_id = ${ORG_A} AND prompt = ${`null-run-${tag}`}`
      expect(row?.n).toBe(1)
    })
  })
})
