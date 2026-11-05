// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P8-FX22 F3, A46b: a taint ORIGIN is what a scoped read RETURNED, never what its arguments
// asked for.
//
// A46 filed the origin from the call's arguments, before authorization, the gate and the
// handler. Any declaring read filed one: a read that failed, that was refused for want of a
// scope, that saw nothing, that named a foreign-org or nonexistent row, or that contributed no
// scopes at all. One extra `get(X)` therefore unlocked `reply(X)` for the rest of a tainted
// turn, whether or not the turn could see X.
//
// So the origin is filed at the END of the dispatch, from the RESULT: the read must have
// declared its table and its row, must have contributed requiredScopes to the turn, must have
// returned, and only the rows it actually returned are filed. Every failure path returns before
// the filing site and files nothing.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeToolCore } from "~/modules/apps/execute-tool"

const ORG = "00000000-0000-0000-0000-00000000fa22"
const APP = "taintorig"
const TABLE = `app_${APP}.rows`
const ROW_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ROW_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const READ_SCOPE = `${APP}:rows:read`
const WRITE_SCOPE = `${APP}:rows:write`
/** A scope the actor does NOT hold, so the read declaring it is refused. */
const SECRET_SCOPE = `${APP}:secret:read`
/** What makes the turn tainted before any of this runs. */
const TAINTED = ["pennylane:payouts:read"]

const ACTOR = {
  actorType: "user" as const,
  userId: "00000000-0000-0000-0000-00000000fa2a",
  orgId: ORG,
  scopes: [READ_SCOPE, WRITE_SCOPE],
  dimensionGrants: {},
} as any

function read(name: string, extra: Record<string, unknown>, handler: (p: any) => unknown) {
  return {
    appName: APP,
    name,
    description: name,
    requiredScopes: [READ_SCOPE],
    readOnly: true,
    readsFromTable: TABLE,
    targetRowParam: "rowId",
    handler: async (params: any) => handler(params),
    ...extra,
  }
}

const TOOLS = [
  // The ordinary per-row read: it returns the row it was asked for.
  read("reads_row", {}, (p) => ({ id: p.rowId, subject: "hello" })),
  // The same read whose result wraps the row, so it declares where the id lives.
  read("reads_wrapped", { resultRowPath: "row.id" }, (p) => ({ row: { id: p.rowId } })),
  // A read that returns SOMETHING ELSE than the row it was asked for.
  read("reads_other_row", {}, () => ({ id: ROW_B })),
  // A read that finds nothing, the shape an invisible or nonexistent row takes.
  read("reads_nothing", { resultRowPath: "row.id" }, () => ({ row: null })),
  // A read that fails.
  read("reads_throws", {}, () => {
    throw new Error("upstream is down")
  }),
  // A read the actor may not make.
  read("reads_forbidden", { requiredScopes: [SECRET_SCOPE] }, (p) => ({ id: p.rowId })),
  // A read that contributes no scopes to the turn, so it can widen nothing.
  read("reads_taint_free", { taintFree: true }, (p) => ({ id: p.rowId })),
  // And the write the allowance is measured for.
  {
    appName: APP,
    name: "writes_row",
    description: "writes_row",
    requiredScopes: [WRITE_SCOPE],
    writesToTable: TABLE,
    targetRowParam: "rowId",
    handler: async () => ({ ok: true }),
  },
]

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Taint Origin From Result', 'taint-origin-from-result') ON CONFLICT DO NOTHING`
  for (const t of TOOLS) toolRegistry.set([ORG, APP, t.name], t as any)
})

afterAll(() => {
  toolRegistry.deleteByPrefix([ORG, APP])
})

function taintedTurn(): RunContext {
  const runId = crypto.randomUUID()
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected(TAINTED)
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    background: false,
    turnScopeAccumulator,
  } as RunContext
}

function dispatch(turn: RunContext, name: string, params: Record<string, unknown>) {
  return runContextStore.run(turn, () =>
    executeToolCore({
      toolName: `${APP}:${name}`,
      orgId: ORG,
      actor: ACTOR,
      params,
      origin: "in-app-agent",
    }),
  )
}

const originsOf = (turn: RunContext) => turn.turnScopeAccumulator?.originRows()

describe("A46b: the origin comes from what the read returned", () => {
  it("files the row a successful scoped read returned, and only that row", async () => {
    const turn = taintedTurn()
    const env = await dispatch(turn, "reads_row", { rowId: ROW_A })
    expect((env as any).error).toBeUndefined()
    expect(originsOf(turn)).toEqual({ [TABLE]: [ROW_A] })

    // ...which is the whole point: the write back to that row now passes.
    const same = await dispatch(turn, "writes_row", { rowId: ROW_A })
    expect((same as any).error).toBeUndefined()
    const other = await dispatch(turn, "writes_row", { rowId: ROW_B })
    expect((other as any).error?.code).toBe("E_SCOPE_TAINT_BLOCKED")
  })

  it("files through the declared result path when the row is wrapped", async () => {
    const turn = taintedTurn()
    await dispatch(turn, "reads_wrapped", { rowId: ROW_A })
    expect(originsOf(turn)).toEqual({ [TABLE]: [ROW_A] })
  })

  it("a read that FAILED files nothing", async () => {
    const turn = taintedTurn()
    const env = await dispatch(turn, "reads_throws", { rowId: ROW_A })
    expect((env as any).error).toBeDefined()
    expect(originsOf(turn)).toEqual({})
    expect((await dispatch(turn, "writes_row", { rowId: ROW_A })) as any).toMatchObject({
      error: { code: "E_SCOPE_TAINT_BLOCKED" },
    })
  })

  it("a read the actor may not make files nothing", async () => {
    const turn = taintedTurn()
    const env = await dispatch(turn, "reads_forbidden", { rowId: ROW_A })
    expect((env as any).error).toBeDefined()
    expect(originsOf(turn)).toEqual({})
  })

  it("a read that contributes no scopes files nothing", async () => {
    const turn = taintedTurn()
    const env = await dispatch(turn, "reads_taint_free", { rowId: ROW_A })
    expect((env as any).error).toBeUndefined()
    expect(originsOf(turn)).toEqual({})
  })

  it("a read that names a row it did not return files nothing", async () => {
    const turn = taintedTurn()
    const env = await dispatch(turn, "reads_other_row", { rowId: ROW_A })
    expect((env as any).error).toBeUndefined()
    expect(originsOf(turn)).toEqual({})
  })

  it("a read that returned no row at all files nothing", async () => {
    const turn = taintedTurn()
    const env = await dispatch(turn, "reads_nothing", { rowId: ROW_A })
    expect((env as any).error).toBeUndefined()
    expect(originsOf(turn)).toEqual({})
  })

  it("origins are per turn: a second turn starts with none of the first turn's rows", async () => {
    const first = taintedTurn()
    await dispatch(first, "reads_row", { rowId: ROW_A })
    expect(originsOf(first)).toEqual({ [TABLE]: [ROW_A] })

    const second = taintedTurn()
    expect(originsOf(second)).toEqual({})
    const env = await dispatch(second, "writes_row", { rowId: ROW_A })
    expect((env as any).error?.code).toBe("E_SCOPE_TAINT_BLOCKED")
  })
})

describe("A46b: origins never travel into a sub-run", () => {
  it("a sub-run seeded the way subrun-worker seeds it carries the taint scopes and no origins", () => {
    const parent = createTurnScopeAccumulator()
    parent.recordInjected(TAINTED)
    parent.recordOriginRows(TABLE, [ROW_A])

    // subrun-worker.ts builds a fresh accumulator and seeds it with the parent's SCOPES
    // (the `parentTaintScopes` job field) and nothing else.
    const child = createTurnScopeAccumulator()
    child.recordInjected(parent.snapshot())
    expect(child.snapshot()).toEqual(parent.snapshot())
    expect(child.originRows()).toEqual({})
  })

  it("neither the sub-run job payload nor the worker mentions origin rows", async () => {
    const spawn = await Bun.file(
      new URL("../../modules/agent/subruns/spawn-agent.ts", import.meta.url).pathname,
    ).text()
    const worker = await Bun.file(
      new URL("../../modules/agent/subruns/subrun-worker.ts", import.meta.url).pathname,
    ).text()
    expect(spawn.includes("originRows")).toBe(false)
    expect(worker.includes("originRows")).toBe(false)
  })
})
