// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THREADS_CREATE UNDER SCOPE TAINT (2026-09-25).
//
// Production: an agent asked to open a channel with three colleagues called `users_search`
// (kernel:users:read) then `threads_create`, and the create came back E_SCOPE_TAINT_BLOCKED:
// threads_create declared no write target, so any tainted turn refused it as an undeclared
// write. It now declares its real sink, kernel.messages (the initial message is stamped with
// the turn's scopes, exactly like threads_reply), and judges the two parts the message sink does
// not cover, the TITLE and the REFERENCES, against the people who read them: the requester plus
// the participants, each of whom must hold every scope the turn read. These tests drive the REAL
// tool bridge and the real kernel tools:
//
//   (a) users_search then a titled threads_create, participants all holding kernel:users:read:
//       created. (Refused on the tree before this change.)
//   (b) a title or references tainted by a scope one participant lacks: parked for the
//       requester to disclose (rule 11, 2026-11-03; refused before). A participant id that is no
//       account of the org fails closed.
//   (c) an unknown taint refuses a titled create.
//   (d) an external write (calendar create_event, which queues a push to Google) is refused
//       after a scoped read, as every undeclared write is.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import { sql } from "~/db"
import type { ActorContext } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { UNKNOWN_TURN_TAINT } from "~/modules/agent/scopes/scope-taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { initializedOrgRuntimes, toolRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000d5001"
const REQUESTER = "00000000-0000-4000-8000-0000000d5002"
const ALICE = "00000000-0000-4000-8000-0000000d5003"
const BOB = "00000000-0000-4000-8000-0000000d5004"
const NOT_IN_ORG = "00000000-0000-4000-8000-0000000d50aa"
const THREAD = "00000000-0000-4000-8000-0000000d5006"

const SECRET = "relevance_test:secret:read"
const COMMON = ["kernel:users:read", "kernel:threads:read", "kernel:threads:write"]

const actor: ActorContext = {
  actorType: "user",
  userId: REQUESTER,
  orgId: ORG,
  scopes: [...COMMON, SECRET, "calendar:events:write", "calendar:events:read"],
  dimensionGrants: {},
}

function freshFrame(): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    effectiveScope: actor.scopes as string[],
    turnScopeAccumulator: createTurnScopeAccumulator(),
  }
}

async function run<T>(frame: RunContext, body: (tools: any) => Promise<T>): Promise<T> {
  const tools = buildToolSet(ORG, actor, THREAD, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  return runContextStore.run(frame, () => body(tools))
}

async function cleanup(): Promise<void> {
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_references WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
}

async function threadsTitled(title: string): Promise<{ id: string }[]> {
  return sql<{ id: string }[]>`
    SELECT id FROM kernel.threads WHERE org_id = ${ORG} AND title = ${title}`
}

describe("threads_create under scope taint", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Threads Create Taint Org', 'threads-create-taint-org') ON CONFLICT DO NOTHING`
    for (const [id, name] of [
      [REQUESTER, "Requester"],
      [ALICE, "Alice Relevance"],
      [BOB, "Bob Relevance"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${ORG}, ${`${id}@relevance.test`}, ${name}, 'active', 'hash')
        ON CONFLICT DO NOTHING`
    }
    const grant = async (ids: string[], scopes: string[]) => {
      for (const id of ids) {
        for (const scope of scopes) {
          await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
            VALUES (${id}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
        }
      }
    }
    await grant([REQUESTER, ALICE, BOB], COMMON)
    await grant([REQUESTER, ALICE], [SECRET])
    await grant([REQUESTER], ["calendar:events:write", "calendar:events:read"])
    await cleanup()
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'threads-create-taint-dm', 'agent_chat', ${REQUESTER})
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${REQUESTER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${REQUESTER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`

    // Kernel tools plus the in-tree apps (calendar among them).
    await ensureAppsForOrg(ORG)

    // A read that really runs and carries a scope Bob lacks.
    toolRegistry.set([ORG, "relevance_test", "read_secret"], {
      appName: "relevance_test",
      name: "read_secret",
      description: "a scoped read Bob may not see",
      requiredScopes: [SECRET],
      readOnly: true,
      params: z.object({}),
      handler: async () => ({ secret: "launch code" }),
    } as any)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await cleanup()
    await releaseTestLock()
  })

  it("(a) users_search then a titled threads_create with colleagues who all hold kernel:users:read creates the channel", async () => {
    const frame = freshFrame()
    const { found, created } = await run(frame, async (tools) => {
      const found = (await tools.kernel__users_search.execute({ query: "Relevance" }, {})) as any
      const created = (await tools.kernel__threads_create.execute(
        { participantIds: [ALICE, BOB], title: "Launch channel", initialMessage: "Welcome" },
        {},
      )) as any
      return { found, created }
    })

    expect(JSON.stringify(found)).toContain(ALICE)
    expect(frame.turnScopeAccumulator?.snapshot()).toContain("kernel:users:read")
    expect(created.code).toBeUndefined()
    expect(created.error).toBeUndefined()
    expect(created.thread?.title).toBe("Launch channel")
    expect(await threadsTitled("Launch channel")).toHaveLength(1)
    // The initial message is stamped with what the turn read, like a threads_reply post.
    const [message] = await sql<{ required_scopes: string[] }[]>`
      SELECT required_scopes FROM kernel.messages WHERE thread_id = ${created.thread.id}`
    expect(message?.required_scopes).toContain("kernel:users:read")
    expect(frame.scopeTaintRefused).toBeFalsy()
  })

  it("(b) a title tainted by a scope one participant lacks parks for the requester instead of being refused", async () => {
    const frame = freshFrame()
    const { refused, allowed } = await run(frame, async (tools) => {
      await tools.relevance_test__read_secret.execute({}, {})
      const refused = (await tools.kernel__threads_create.execute(
        { participantIds: [ALICE, BOB], title: "The launch code", forceCreate: true },
        {},
      )) as any
      // Same turn, same taint, an audience that holds it: Alice does.
      const allowed = (await tools.kernel__threads_create.execute(
        { participantIds: [ALICE], title: "The launch code", forceCreate: true },
        {},
      )) as any
      return { refused, allowed }
    })

    // 2026-11-03 (rule 11): no longer refused. It parks for the requester, who holds the
    // secret; approving it is the disclosure to Bob. Nothing is created before that.
    expect(JSON.stringify(refused)).not.toContain("E_SCOPE_TAINT_BLOCKED")
    expect(refused.blocked).toBe(true)
    const [row] = await sql<{ metadata: { taintAudienceMustHold?: string[] } }[]>`
      SELECT metadata FROM kernel.approval_requests WHERE id = ${refused.approvalRequestId}`
    expect(row?.metadata.taintAudienceMustHold).toContain(SECRET)
    const titled = await threadsTitled("The launch code")
    expect(titled).toHaveLength(1)
    expect(allowed.thread?.id).toBe(titled[0]?.id)
  })

  it("(b) references tainted by a scope one participant lacks park the same way, untitled or not", async () => {
    const frame = freshFrame()
    const refused = await run(frame, async (tools) => {
      await tools.relevance_test__read_secret.execute({}, {})
      return (await tools.kernel__threads_create.execute(
        {
          participantIds: [BOB],
          references: [{ app: "tickets", entityType: "ticket", entityId: "the launch code" }],
          forceCreate: true,
        },
        {},
      )) as any
    })
    // Parks the same way (rule 11): nothing is written before the requester decides.
    expect(JSON.stringify(refused)).not.toContain("E_SCOPE_TAINT_BLOCKED")
    expect(refused.blocked).toBe(true)
    expect(await sql`SELECT 1 FROM kernel.thread_references WHERE org_id = ${ORG}`).toHaveLength(0)
  })

  it("(b) a participant id that is no account of the org fails closed", async () => {
    const frame = freshFrame()
    const refused = await run(frame, async (tools) => {
      await tools.kernel__users_search.execute({ query: "Alice" }, {})
      return (await tools.kernel__threads_create.execute(
        { participantIds: [ALICE, NOT_IN_ORG], title: "Ghost channel", forceCreate: true },
        {},
      )) as any
    })
    expect(JSON.stringify(refused)).toContain("E_SCOPE_TAINT_BLOCKED")
    expect(await threadsTitled("Ghost channel")).toHaveLength(0)
  })

  it("(c) an unknown taint refuses a titled create", async () => {
    const frame = freshFrame()
    frame.turnScopeAccumulator?.recordInjected([...UNKNOWN_TURN_TAINT])
    const created = await run(frame, async (tools) => {
      return (await tools.kernel__threads_create.execute(
        { participantIds: [ALICE], title: "Unknown taint", forceCreate: true },
        {},
      )) as any
    })
    expect(JSON.stringify(created)).toContain("E_SCOPE_TAINT_BLOCKED")
    expect(await threadsTitled("Unknown taint")).toHaveLength(0)
  })

  it("(d) calendar create_event, an external write, never runs inline after a scoped read (rule 8)", async () => {
    const def = toolRegistry.get([ORG, "calendar", "create_event"])
    expect(def).toBeDefined()
    expect(def?.writesToTable).toBeUndefined()
    const frame = freshFrame()
    const out = await run(frame, async (tools) => {
      await tools.kernel__users_search.execute({ query: "Alice" }, {})
      return (await tools.calendar__create_event.execute(
        {
          calendarId: "00000000-0000-4000-8000-0000000d50cc",
          title: "Launch",
          start: "2026-10-01T09:00:00Z",
          end: "2026-10-01T10:00:00Z",
        },
        {},
      )) as any
    })
    // The bridge defers it to the dispatch, which parks it: an ungated write the taint alone
    // stopped is a disclosure decided by holding what the turn read (rule 8h), which the
    // requester does. No event is created.
    expect(out.blocked).toBe(true)
    expect(out.id).toBeUndefined()
    const [row] = await sql<{ approve_scope: string | null }[]>`
      SELECT approve_scope FROM kernel.approval_requests WHERE id = ${out.approvalRequestId}`
    expect(row?.approve_scope).toBe("kernel:users:read")
  })
})
