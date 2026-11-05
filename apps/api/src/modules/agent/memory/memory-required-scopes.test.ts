// SPDX-License-Identifier: FSL-1.1-ALv2
//
// D5 write inheritance for kernel.agent_memory (P2b-T29): a memory row written
// during a turn carries that turn's accumulated requiredScopes, so the read
// predicate can hide it from a viewer who lacks them. Colocated with the
// agent_memory write function (memory.ts).
//
// The turn's scopes come from the run frame, exactly as the message write path
// takes them: the snapshot from BEFORE the running tool call recorded its own
// scope (the memory tool's own `kernel:agent:memory` write scope is not a data
// read), then the accumulator, then the turn's effective scope, then the
// caller's scopes. Inside a turn where none of those is known the write is
// refused rather than landing untagged.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import {
  type RunContext,
  runContextStore,
  runWithToolCallScopesBefore,
} from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"

const ORG_ID = "00000000-0000-0000-0000-0000000d2901"
const USER_A = "00000000-0000-0000-0000-0000000d2902"
const AGENT_A = "00000000-0000-0000-0000-0000000d2903"

const actorA: UserContext = {
  actorType: "user",
  userId: USER_A,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

function frame(opts: { accumulated?: string[]; effectiveScope?: string[] }): RunContext {
  const accumulator = opts.accumulated === undefined ? undefined : createTurnScopeAccumulator()
  if (accumulator && opts.accumulated) accumulator.recordInjected(opts.accumulated)
  return {
    runId: "run-t29",
    parentRunId: null,
    rootRunId: "run-t29",
    nestingDepth: 0,
    ...(accumulator ? { turnScopeAccumulator: accumulator } : {}),
    ...(opts.effectiveScope ? { effectiveScope: opts.effectiveScope } : {}),
  }
}

/** Run `fn` the way the tool bridge runs a kernel tool handler: inside the run
 *  frame, with the pre-call scope snapshot bound. */
function inTurn<T>(
  opts: { accumulated?: string[]; effectiveScope?: string[]; scopesBefore?: string[] },
  fn: () => T,
): T {
  return runContextStore.run(frame(opts), () =>
    opts.scopesBefore ? runWithToolCallScopesBefore(opts.scopesBefore, fn) : fn(),
  )
}

async function readScopes(type: string, name: string): Promise<string[] | undefined> {
  const rows = await sql`SELECT required_scopes FROM kernel.agent_memory
    WHERE org_id = ${ORG_ID} AND user_id = ${USER_A} AND type = ${type} AND name = ${name}`
  return rows[0]?.required_scopes as string[] | undefined
}

describe("agent_memory requiredScopes write inheritance (D5)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'MemScopeOrg', 'mem-scope-org-t29') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_A}, ${ORG_ID}, 'mem-t29@test.com', 'Mem T29', 'x') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${AGENT_A}, ${ORG_ID}, 'personal', '@mem-t29', 'Liaison', ${USER_A})
      ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
  })

  it("a memory row written during a scope-tagged turn persists that turn's requiredScopes", async () => {
    const { handleMemorySetTool } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      const ctx = { userId: USER_A, orgId: ORG_ID, db: tx, scopes: ["*"] }
      await inTurn(
        // The turn read mail before this call; the memory tool's own write
        // scope was recorded into the accumulator but is not a data read.
        {
          accumulated: ["mail:read", "kernel:agent:memory"],
          scopesBefore: ["mail:read"],
        },
        () =>
          handleMemorySetTool(
            {
              type: "user",
              name: "vip-policy",
              description: "Quoted from a scoped mail thread",
              content: "The VIP dealer discount is 22 percent.",
            },
            ctx as never,
          ),
      )
    })
    expect(await readScopes("user", "vip-policy")).toEqual(["mail:read"])
    // The MEMORY.md index row quotes the entry's description and is re-injected
    // into every later turn, so it carries the same tag.
    expect(await readScopes("_index", "_index")).toEqual(["mail:read"])
  })

  it("a later turn's write UNIONS its scopes into the existing tag, never replacing it with less", async () => {
    const { handleMemorySet, handleMemorySetTool } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      const ctx = { userId: USER_A, orgId: ORG_ID, db: tx, scopes: ["*"] }
      await inTurn({ accumulated: ["mail:read"], scopesBefore: ["mail:read"] }, () =>
        handleMemorySetTool(
          { type: "user", name: "vip-policy", description: "v1", content: "v1" },
          ctx as never,
        ),
      )
      await inTurn({ accumulated: ["tickets:read"], scopesBefore: ["tickets:read"] }, () =>
        handleMemorySetTool(
          { type: "user", name: "vip-policy", description: "v2", content: "v2" },
          ctx as never,
        ),
      )
      // A human edit through the memories route asserts [] and must not strip
      // the tag the agent turns put on the row.
      await handleMemorySet(
        { type: "user", name: "vip-policy", description: "v3", content: "v3" },
        ctx as never,
        [],
      )
    })
    expect(await readScopes("user", "vip-policy")).toEqual(["mail:read", "tickets:read"])
    expect(await readScopes("_index", "_index")).toEqual(["mail:read", "tickets:read"])
  })

  it("the index tag is RECOMPUTED from the entries it holds, so a deleted memory's scope leaves it", async () => {
    const { handleMemorySetTool, handleMemoryDelete } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      const ctx = { userId: USER_A, orgId: ORG_ID, db: tx, scopes: ["*"] }
      await inTurn({ accumulated: ["mail:read"], scopesBefore: ["mail:read"] }, () =>
        handleMemorySetTool(
          { type: "user", name: "from-mail", description: "m", content: "m" },
          ctx as never,
        ),
      )
      await inTurn(
        { accumulated: ["boxtal:shipments:read"], scopesBefore: ["boxtal:shipments:read"] },
        () =>
          handleMemorySetTool(
            { type: "user", name: "from-boxtal", description: "b", content: "b" },
            ctx as never,
          ),
      )
    })
    expect(await readScopes("_index", "_index")).toEqual(["boxtal:shipments:read", "mail:read"])
    await withRlsContext(actorA, async (tx) => {
      const ctx = { userId: USER_A, orgId: ORG_ID, db: tx, scopes: ["*"] }
      await handleMemoryDelete({ type: "user", name: "from-boxtal" }, ctx as never)
    })
    // The index is injected into EVERY turn, so a monotonic union made every
    // later reply inherit every scope the tree had ever touched.
    expect(await readScopes("_index", "_index")).toEqual(["mail:read"])
  })

  it("a turn whose scopes are unknown is refused, never written untagged", async () => {
    const { handleMemorySetTool } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      // A frame with no accumulator, no effective scope, and a ctx carrying no
      // scopes: the turn's taint is unknowable, so fail closed.
      const ctx = { userId: USER_A, orgId: ORG_ID, db: tx }
      await expect(
        inTurn({}, () =>
          handleMemorySetTool(
            { type: "user", name: "unknowable", description: "x", content: "x" },
            ctx as never,
          ),
        ),
      ).rejects.toThrow(/scope_unknown/)
    })
    expect(await readScopes("user", "unknowable")).toBeUndefined()
  })

  it("a turn with no accumulator falls back to the turn's effective scope", async () => {
    const { handleMemorySetTool } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      const ctx = { userId: USER_A, orgId: ORG_ID, db: tx }
      await inTurn({ effectiveScope: ["tickets:read"] }, () =>
        handleMemorySetTool(
          { type: "user", name: "fallback", description: "x", content: "x" },
          ctx as never,
        ),
      )
    })
    expect(await readScopes("user", "fallback")).toEqual(["tickets:read"])
  })

  it("handleMemorySet refuses a missing or non-array requiredScopes", async () => {
    const { handleMemorySet } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      const ctx = { userId: USER_A, orgId: ORG_ID, db: tx }
      await expect(
        (handleMemorySet as (...a: unknown[]) => Promise<unknown>)(
          { type: "user", name: "no-scopes", description: "x", content: "x" },
          ctx,
        ),
      ).rejects.toThrow(/requiredScopes/)
      await expect(
        (handleMemorySet as (...a: unknown[]) => Promise<unknown>)(
          { type: "user", name: "no-scopes", description: "x", content: "x" },
          ctx,
          "mail:read",
        ),
      ).rejects.toThrow(/requiredScopes/)
    })
    expect(await readScopes("user", "no-scopes")).toBeUndefined()
  })

  it("an untagged agent_memory insert is rejected by the column itself", async () => {
    await expect(
      (async () => {
        await sql`INSERT INTO kernel.agent_memory
            (org_id, user_id, owner_agent_id, type, name, description, content)
          VALUES (${ORG_ID}, ${USER_A}, ${AGENT_A}, 'user', 'raw-untagged', 'd', 'c')`
      })(),
    ).rejects.toThrow()
    expect(await readScopes("user", "raw-untagged")).toBeUndefined()
  })
})
