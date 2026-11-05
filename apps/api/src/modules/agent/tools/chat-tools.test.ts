// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"

const ORG_ID = "00000000-0000-0000-0000-000000d80001"
const USER_A = "00000000-0000-0000-0000-000000d80002"
const USER_B = "00000000-0000-0000-0000-000000d80003"
const THREAD_ID = "00000000-0000-0000-0000-000000d80004"
const READ_THREAD_ID = "00000000-0000-0000-0000-000000d80005"
const THREAD_MSG_ID = "00000000-0000-0000-0000-000000d80010"
const READ_THREAD_MSG_ID = "00000000-0000-0000-0000-000000d80011"

describe("chat tools", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'ChatToolOrg', 'chat-tool-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash, status) VALUES (${USER_A}, ${ORG_ID}, 'cta@test.com', 'Alice Chat', 'x', 'active') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash, status) VALUES (${USER_B}, ${ORG_ID}, 'ctb@test.com', 'Bob Chat', 'x', 'active') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, title, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'search-target', 'Q2 Planning Discussion', 'thread', ${USER_A}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, title, type, created_by) VALUES (${READ_THREAD_ID}, ${ORG_ID}, 'already-read', 'Already Read Thread', 'thread', ${USER_A}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_A}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_B}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${READ_THREAD_ID}, ${USER_A}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${READ_THREAD_ID}, ${USER_B}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes) VALUES (${THREAD_MSG_ID}, ${THREAD_ID}, ${ORG_ID}, ${USER_B}, 'user', 'We need to finalize the infrastructure migration timeline', '{}') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes) VALUES (${READ_THREAD_MSG_ID}, ${READ_THREAD_ID}, ${ORG_ID}, ${USER_B}, 'user', 'This thread is already read by Alice', '{}') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER_A}, ${THREAD_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER_B}, ${THREAD_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id, last_read_message_id) VALUES (${USER_A}, ${READ_THREAD_ID}, ${ORG_ID}, ${READ_THREAD_MSG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER_B}, ${READ_THREAD_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  const actorA: UserContext = {
    actorType: "user",
    userId: USER_A,
    orgId: ORG_ID,
    scopes: ["*"],
    dimensionGrants: {},
  }

  describe("handleThreadsList", () => {
    it("lists recent threads with unread counts", async () => {
      const { handleThreadsList } = await import("./chat-tools")
      const result = await withRlsContext(actorA, async (tx) => {
        return handleThreadsList({ limit: 10 }, { userId: USER_A, orgId: ORG_ID, db: tx } as any)
      })

      expect(result.threads.length).toBeGreaterThanOrEqual(2)
      const unreadThread = result.threads.find((t: any) => t.id === THREAD_ID)
      expect(unreadThread).toBeDefined()
      expect(typeof unreadThread.unreadCount).toBe("number")
      expect(unreadThread.unreadCount).toBeGreaterThanOrEqual(1)
      expect(unreadThread.lastMessage?.content).toContain("infrastructure migration")
    })

    it("filters to unread threads when unreadOnly is true", async () => {
      const { handleThreadsList } = await import("./chat-tools")
      const result = await withRlsContext(actorA, async (tx) => {
        return handleThreadsList({ unreadOnly: true }, {
          userId: USER_A,
          orgId: ORG_ID,
          db: tx,
        } as any)
      })

      expect(result.threads.some((t: any) => t.id === THREAD_ID)).toBe(true)
      expect(result.threads.some((t: any) => t.id === READ_THREAD_ID)).toBe(false)
    })
  })

  describe("handleThreadsSearch", () => {
    it("finds thread by title match", async () => {
      const { handleThreadsSearch } = await import("./chat-tools")
      const result = await withRlsContext(actorA, async (tx) => {
        return handleThreadsSearch({ query: "Q2 Planning" }, {
          userId: USER_A,
          orgId: ORG_ID,
          db: tx,
        } as any)
      })
      expect((result as any).threads.length).toBeGreaterThan(0)
      expect((result as any).threads[0].title).toContain("Q2 Planning")
    })

    it("finds thread by message content with matchContext", async () => {
      const { handleThreadsSearch } = await import("./chat-tools")
      const result = await withRlsContext(actorA, async (tx) => {
        return handleThreadsSearch({ query: "infrastructure migration" }, {
          userId: USER_A,
          orgId: ORG_ID,
          db: tx,
        } as any)
      })
      const threads = (result as any).threads
      expect(threads.length).toBeGreaterThan(0)
      const match = threads.find((t: any) => t.matchContext)
      expect(match).toBeDefined()
      expect(match.matchContext.snippet).toContain("infrastructure migration")
    })

    it("finds thread by participant name", async () => {
      const { handleThreadsSearch } = await import("./chat-tools")
      const result = await withRlsContext(actorA, async (tx) => {
        return handleThreadsSearch({ query: "Bob Chat" }, {
          userId: USER_A,
          orgId: ORG_ID,
          db: tx,
        } as any)
      })
      const match = (result as any).threads.find((t: any) => t.id === THREAD_ID)
      expect(match).toBeDefined()
      expect(match.matchContext?.participantName).toBe("Bob Chat")
    })

    it("returns empty array when no matches", async () => {
      const { handleThreadsSearch } = await import("./chat-tools")
      const result = await withRlsContext(actorA, async (tx) => {
        return handleThreadsSearch({ query: "zzz_nonexistent_query_zzz" }, {
          userId: USER_A,
          orgId: ORG_ID,
          db: tx,
        } as any)
      })
      expect((result as any).threads).toEqual([])
    })

    it("handles ILIKE special characters without SQL error (%, _, \\)", async () => {
      const { handleThreadsSearch } = await import("./chat-tools")
      const dangerousQuery = "100% done_task\\path"
      const result = await withRlsContext(actorA, async (tx) => {
        return handleThreadsSearch({ query: dangerousQuery }, {
          userId: USER_A,
          orgId: ORG_ID,
          db: tx,
        } as any)
      })
      expect((result as any).threads).toEqual([])
    })
  })

  describe("handleThreadsCreate", () => {
    it("creates thread with participants", async () => {
      const { handleThreadsCreate } = await import("./chat-tools")
      const result = await withRlsContext(actorA, async (tx) => {
        return handleThreadsCreate(
          { participantIds: [USER_A, USER_B], title: "Agent-created thread", forceCreate: true },
          { userId: USER_A, orgId: ORG_ID, db: tx } as any,
        )
      })
      expect((result as any).thread).toBeDefined()
      expect((result as any).thread.title).toBe("Agent-created thread")
      expect((result as any).thread.participants.length).toBe(2)
    })

    it("forwards references to createThread", async () => {
      const { handleThreadsCreate } = await import("./chat-tools")
      const result = await withRlsContext(actorA, async (tx) => {
        return handleThreadsCreate(
          {
            participantIds: [USER_A, USER_B],
            title: "Agent-created referenced thread",
            references: [{ app: "kernel", entityType: "thread", entityId: THREAD_ID }],
          },
          { userId: USER_A, orgId: ORG_ID, db: tx } as any,
        )
      })
      const rows =
        await sql`SELECT app, entity_type, entity_id FROM kernel.thread_references WHERE thread_id = ${(result as any).thread.id}`
      expect(rows.length).toBe(1)
      expect(rows[0].app).toBe("kernel")
      expect(rows[0].entity_type).toBe("thread")
      expect(rows[0].entity_id).toBe(THREAD_ID)
    })

    it("DM dedup returns existing thread on second create with same participants", async () => {
      const { handleThreadsCreate } = await import("./chat-tools")
      // Both calls have no title — DM candidate path
      const first = await withRlsContext(actorA, async (tx) => {
        return handleThreadsCreate({ participantIds: [USER_A, USER_B] }, {
          userId: USER_A,
          orgId: ORG_ID,
          db: tx,
        } as any)
      })
      const second = await withRlsContext(actorA, async (tx) => {
        return handleThreadsCreate({ participantIds: [USER_A, USER_B] }, {
          userId: USER_A,
          orgId: ORG_ID,
          db: tx,
        } as any)
      })
      expect((second as any).thread.id).toBe((first as any).thread.id)
      expect((second as any).thread.deduplicated).toBe(true)
    })

    it("returns error for invalid participant IDs", async () => {
      const { handleThreadsCreate } = await import("./chat-tools")
      const result = await withRlsContext(actorA, async (tx) => {
        return handleThreadsCreate(
          { participantIds: [USER_A, "00000000-0000-0000-0000-000000000000"] },
          { userId: USER_A, orgId: ORG_ID, db: tx } as any,
        ).catch((err: any) => ({ error: err.message }))
      })
      expect((result as any).error).toBeDefined()
    })
  })

  describe("handleThreadsRead", () => {
    it("returns messages from a thread the user participates in", async () => {
      const { handleThreadsRead } = await import("./chat-tools")
      const result = await withRlsContext(actorA, async (tx) => {
        return handleThreadsRead({ threadId: THREAD_ID }, {
          userId: USER_A,
          orgId: ORG_ID,
          db: tx,
        } as any)
      })

      expect("error" in result).toBe(false)
      const r = result as any
      expect(r.thread).toBeDefined()
      expect(r.thread.handle).toBe("search-target")
      expect(r.thread.title).toBe("Q2 Planning Discussion")
      expect(r.messages.length).toBeGreaterThan(0)
      expect(r.messages[0].authorName).toBeDefined()
      expect(r.messages[0].content).toBeDefined()
      expect(r.messages[0].createdAt).toBeDefined()

      console.log("\n=== threads_read result ===")
      console.log(`  Thread: #${r.thread.handle} — ${r.thread.title}`)
      console.log(`  Messages: ${r.messages.length}`)
      for (const m of r.messages) {
        console.log(`    [${m.authorType}] ${m.authorName}: ${m.content.slice(0, 80)}`)
      }
    })

    it("returns messages in chronological order (oldest first)", async () => {
      // Add a second message with a later timestamp
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, created_at, required_scopes)
        VALUES ('00000000-0000-0000-0000-000000d80020', ${THREAD_ID}, ${ORG_ID}, ${USER_B}, 'user', 'Agreed, let us finalize by Friday', '2099-01-01T00:00:00Z', '{}')
        ON CONFLICT DO NOTHING`

      try {
        const { handleThreadsRead } = await import("./chat-tools")
        const result = (await withRlsContext(actorA, async (tx) => {
          return handleThreadsRead({ threadId: THREAD_ID }, {
            userId: USER_A,
            orgId: ORG_ID,
            db: tx,
          } as any)
        })) as any

        expect(result.messages.length).toBeGreaterThanOrEqual(2)
        // Messages should be oldest-first
        for (let i = 1; i < result.messages.length; i++) {
          const prev = new Date(result.messages[i - 1].createdAt).getTime()
          const curr = new Date(result.messages[i].createdAt).getTime()
          expect(curr).toBeGreaterThanOrEqual(prev)
        }
      } finally {
        await sql`DELETE FROM kernel.messages WHERE id = '00000000-0000-0000-0000-000000d80020'`
      }
    })

    it("respects limit parameter", async () => {
      const { handleThreadsRead } = await import("./chat-tools")
      const result = (await withRlsContext(actorA, async (tx) => {
        return handleThreadsRead({ threadId: THREAD_ID, limit: 1 }, {
          userId: USER_A,
          orgId: ORG_ID,
          db: tx,
        } as any)
      })) as any

      expect(result.messages.length).toBeLessThanOrEqual(1)
    })

    it("truncates long messages to 2000 chars", async () => {
      const longContent = "A".repeat(3000)
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
        VALUES ('00000000-0000-0000-0000-000000d80021', ${THREAD_ID}, ${ORG_ID}, ${USER_A}, 'user', ${longContent}, '{}')
        ON CONFLICT DO NOTHING`

      try {
        const { handleThreadsRead } = await import("./chat-tools")
        const result = (await withRlsContext(actorA, async (tx) => {
          return handleThreadsRead({ threadId: THREAD_ID }, {
            userId: USER_A,
            orgId: ORG_ID,
            db: tx,
          } as any)
        })) as any

        const longMsg = result.messages.find((m: any) => m.content.startsWith("AAA"))
        expect(longMsg).toBeDefined()
        expect(longMsg.content.length).toBeLessThanOrEqual(2003) // 2000 + "..."
        expect(longMsg.content.endsWith("...")).toBe(true)
      } finally {
        await sql`DELETE FROM kernel.messages WHERE id = '00000000-0000-0000-0000-000000d80021'`
      }
    })

    it("excludes deleted messages", async () => {
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, deleted_at, required_scopes)
        VALUES ('00000000-0000-0000-0000-000000d80022', ${THREAD_ID}, ${ORG_ID}, ${USER_A}, 'user', 'This was deleted', NOW(), '{}')
        ON CONFLICT DO NOTHING`

      try {
        const { handleThreadsRead } = await import("./chat-tools")
        const result = (await withRlsContext(actorA, async (tx) => {
          return handleThreadsRead({ threadId: THREAD_ID }, {
            userId: USER_A,
            orgId: ORG_ID,
            db: tx,
          } as any)
        })) as any

        const deleted = result.messages.find((m: any) => m.content === "This was deleted")
        expect(deleted).toBeUndefined()
      } finally {
        await sql`DELETE FROM kernel.messages WHERE id = '00000000-0000-0000-0000-000000d80022'`
      }
    })

    it("returns error when user is not a participant", async () => {
      // Create a thread user A is NOT a participant of
      const otherThread = "00000000-0000-0000-0000-000000d80030"
      await sql`INSERT INTO kernel.threads (id, org_id, handle, title, type, created_by)
        VALUES (${otherThread}, ${ORG_ID}, 'private-thread', 'Private', 'thread', ${USER_B}) ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${otherThread}, ${USER_B}, ${ORG_ID}) ON CONFLICT DO NOTHING`

      try {
        const { handleThreadsRead } = await import("./chat-tools")
        const result = await withRlsContext(actorA, async (tx) => {
          return handleThreadsRead({ threadId: otherThread }, {
            userId: USER_A,
            orgId: ORG_ID,
            db: tx,
          } as any)
        })

        expect("error" in result).toBe(true)
        // A typed not-found: answers 404 and logs at warn, never a 500.
        expect((result as any).error.code).toBe("not_found")
        expect((result as any).error.message).toContain("not a participant")
      } finally {
        await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${otherThread}`
        await sql`DELETE FROM kernel.threads WHERE id = ${otherThread}`
      }
    })

    it("does not surface an approval-discussion thread the user participates in", async () => {
      // Approval threads carry internal decision context. Even though the
      // executing user IS a participant (RLS permits the read), the agent must
      // get the same not-found shape so existence isn't leaked.
      const approvalThread = "00000000-0000-0000-0000-000000d80031"
      const approvalMsg = "00000000-0000-0000-0000-000000d80032"
      await sql`INSERT INTO kernel.threads (id, org_id, handle, title, type, created_by)
        VALUES (${approvalThread}, ${ORG_ID}, 'approval-discussion', 'Approval Discussion', 'approval', ${USER_A}) ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${approvalThread}, ${USER_A}, ${ORG_ID}) ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
        VALUES (${approvalMsg}, ${approvalThread}, ${ORG_ID}, ${USER_A}, 'user', 'Internal approval rationale the agent must not read', '{}') ON CONFLICT DO NOTHING`

      try {
        const { handleThreadsRead } = await import("./chat-tools")
        const result = await withRlsContext(actorA, async (tx) => {
          return handleThreadsRead({ threadId: approvalThread }, {
            userId: USER_A,
            orgId: ORG_ID,
            db: tx,
          } as any)
        })

        expect("error" in result).toBe(true)
        // A typed not-found: answers 404 and logs at warn, never a 500.
        expect((result as any).error.code).toBe("not_found")
        expect((result as any).error.message).toContain("not a participant")
        // Existence/content of the approval thread must not leak.
        expect((result as any).thread).toBeUndefined()
        expect((result as any).messages).toBeUndefined()
      } finally {
        await sql`DELETE FROM kernel.messages WHERE id = ${approvalMsg}`
        await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${approvalThread}`
        await sql`DELETE FROM kernel.threads WHERE id = ${approvalThread}`
      }
    })
  })

  describe("handleThreadsReply — agent attribution", () => {
    it("posts as an attributed agent identity, never as the user", async () => {
      const { handleThreadsReply } = await import("./chat-tools")
      const result = await withRlsContext(actorA, async (tx) => {
        return handleThreadsReply({ threadId: THREAD_ID, content: "Attributed agent reply" }, {
          userId: USER_A,
          orgId: ORG_ID,
          db: tx,
          scopes: actorA.scopes,
        } as any)
      })
      expect((result as any).message).toBeDefined()

      const [msg] = await sql`SELECT author_type, metadata FROM kernel.messages
        WHERE thread_id = ${THREAD_ID} AND content = 'Attributed agent reply'`
      expect(msg.author_type).toBe("agent")
      expect(msg.metadata.agentAuthorLabel).toBe("Alice Chat's agent")
    })

    it("refuses to post into the thread the turn is already answering, so one turn writes one reply", async () => {
      const { handleThreadsReply } = await import("./chat-tools")
      const before = await sql`SELECT count(*)::int AS n FROM kernel.messages
        WHERE thread_id = ${THREAD_ID}`
      const result = await withRlsContext(actorA, async (tx) => {
        return handleThreadsReply({ threadId: THREAD_ID, content: "The answer, posted twice." }, {
          userId: USER_A,
          orgId: ORG_ID,
          db: tx,
          // The turn IS this thread.
          agentExecutionThreadId: THREAD_ID,
          scopes: actorA.scopes,
        } as any)
      })
      expect((result as any).message).toBeUndefined()
      expect((result as any).error.code).toBe("answering_thread")
      expect((result as any).error.message).toContain("conversation you are answering")
      // A typed refusal, not a server fault: the HTTP surface answers 400.
      const { statusForToolError } = await import("~/modules/apps/execute-tool")
      expect(statusForToolError((result as any).error.code)).toBe(400)
      const after = await sql`SELECT count(*)::int AS n FROM kernel.messages
        WHERE thread_id = ${THREAD_ID}`
      expect(after[0].n).toBe(before[0].n)
    })

    it("names the acting agent, never the human whose turn it is", async () => {
      const { handleThreadsReply } = await import("./chat-tools")
      const { runContextStore } = await import("~/modules/agent/runtime/run-context")
      const agentId = crypto.randomUUID()
      await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
        VALUES (${agentId}, ${ORG_ID}, 'role', '@chatfinance', 'Finance Desk', '["*"]'::jsonb, 'You help.')`
      const result = await withRlsContext(actorA, async (tx) =>
        runContextStore.run({ agentId } as any, () =>
          handleThreadsReply({ threadId: THREAD_ID, content: "Agent named reply" }, {
            userId: USER_A,
            orgId: ORG_ID,
            db: tx,
            scopes: actorA.scopes,
          } as any),
        ),
      )
      expect((result as any).message).toBeDefined()
      const [msg] = await sql`SELECT metadata FROM kernel.messages
        WHERE thread_id = ${THREAD_ID} AND content = 'Agent named reply'`
      expect(msg.metadata.agentAuthorLabel).toBe("Finance Desk")
    })

    it("attributes to the routine when the execution thread is a routine run-log", async () => {
      const { handleThreadsReply } = await import("./chat-tools")
      await sql`INSERT INTO kernel.routines
        (org_id, owner_user_id, name, description, kind, cron, timezone, prompt,
         scopes, visibility, status, created_by_actor_type, output_thread_id)
        VALUES (${ORG_ID}, ${USER_A}, 'daily-digest', 'd', 'recurring', '0 8 * * *',
                'UTC', 'p', '{}', 'personal', 'active', 'user', ${READ_THREAD_ID})`

      const result = await withRlsContext(actorA, async (tx) => {
        return handleThreadsReply({ threadId: THREAD_ID, content: "Routine-driven reply" }, {
          userId: USER_A,
          orgId: ORG_ID,
          db: tx,
          agentExecutionThreadId: READ_THREAD_ID,
          scopes: actorA.scopes,
        } as any)
      })
      expect((result as any).message).toBeDefined()

      const [msg] = await sql`SELECT author_type, metadata FROM kernel.messages
        WHERE thread_id = ${THREAD_ID} AND content = 'Routine-driven reply'`
      expect(msg.author_type).toBe("agent")
      expect(msg.metadata.agentAuthorLabel).toBe("Routine daily-digest")
    })

    it("signs a personal agent's post as its owner's agent, never the bare \"Personal agent\"", async () => {
      const { handleThreadsReply } = await import("./chat-tools")
      const { runContextStore } = await import("~/modules/agent/runtime/run-context")
      const agentId = crypto.randomUUID()
      await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling, system_prompt)
        VALUES (${agentId}, ${ORG_ID}, 'personal', '@chatalice', 'Personal agent', ${USER_A}, '["*"]'::jsonb, 'You help.')`
      const frame = {
        runId: "r-personal",
        parentRunId: null,
        rootRunId: "r-personal",
        nestingDepth: 0,
        agentId,
      }
      const post = (content: string, agentExecutionThreadId?: string) =>
        withRlsContext(actorA, async (tx) =>
          runContextStore.run(frame, () =>
            handleThreadsReply(
              { threadId: THREAD_ID, content },
              {
                userId: USER_A,
                orgId: ORG_ID,
                db: tx,
                ...(agentExecutionThreadId ? { agentExecutionThreadId } : {}),
                scopes: actorA.scopes,
              },
            ),
          ),
        )
      expect("message" in (await post("Personal agent reply"))).toBe(true)
      // A routine run keeps its own attribution, even when a personal agent drives it.
      expect("message" in (await post("Personal routine reply", READ_THREAD_ID))).toBe(true)
      const rows = await sql`SELECT content, metadata FROM kernel.messages
        WHERE thread_id = ${THREAD_ID} AND content IN ('Personal agent reply', 'Personal routine reply')`
      const label = (c: string) => rows.find((r) => r.content === c)?.metadata.agentAuthorLabel
      expect(label("Personal agent reply")).toBe("Alice's agent")
      expect(label("Personal routine reply")).toBe("Routine daily-digest")
    })

    it("posts the message once and reports the attachment failure as part of a success", async () => {
      const { handleThreadsReply } = await import("./chat-tools")
      const result = await withRlsContext(actorA, async (tx) => {
        return handleThreadsReply(
          {
            threadId: THREAD_ID,
            content: "Reply with bad attachment",
            attachments: ["00000000-0000-0000-0000-0000000000ff"],
          },
          { userId: USER_A, orgId: ORG_ID, db: tx, scopes: actorA.scopes } as any,
        )
      })
      // A success carrying the partial failure, never `{ error }`: the message
      // committed, so an approved call must not be re-pended and posted twice.
      expect("error" in (result as object)).toBe(false)
      expect((result as any).message?.id).toBeDefined()
      expect((result as any).attachmentError).toContain("could not be attached")

      // The message itself was posted, exactly once.
      const rows = await sql`SELECT id FROM kernel.messages
        WHERE thread_id = ${THREAD_ID} AND content = 'Reply with bad attachment'`
      expect(rows).toHaveLength(1)
    })
  })
})
