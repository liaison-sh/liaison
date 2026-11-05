// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2b-T28, A3: the scope-taint WRITE guard at the shared dispatch entry.
//
// 2a already refuses a tainted turn's write in the tool bridge's execute
// closure. That closure only sees the calls the CHAT turn makes: a cross-app
// `internalCall`, a nested dispatch, the sandbox bridge's `ctx.executeTool` and
// an approved re-entry all reach `executeToolCore` without passing through it.
// So the guard sits here too, exactly as the read-only-run boundary does, and
// for the same reason. Both layers call the same `checkScopeTaint` and the same
// `TAINT_ENFORCING_SINKS`, so they can never disagree.
//
// Two behaviours are pinned deliberately against regression: a read-only tool
// is never refused (the guard must not be stricter than the bridge, or every
// read during a tainted turn would break), and NO RUN FRAME AT ALL evaluates no
// taint, because a human request, a job, a cron, a webhook or the MCP gateway
// genuinely has no turn behind it.
//
// A frame that EXISTS but carries no accumulator is a different case and fails
// CLOSED. It was originally allowed on the belief that routine ticks ran that
// way, but a routine tick reaches this boundary through runAgentChat, which
// mints its own frame with an accumulator and is the frame the tool bridge
// opens around every call. No production caller builds a turn frame without an
// accumulator today, so such a frame means the turn's taint is simply unknown,
// and an unknown taint is resolved to the worst case like every other.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { SINK_KERNEL_MESSAGES } from "~/modules/agent/scopes/scope-taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeToolCore } from "~/modules/apps/execute-tool"

const ORG = "00000000-0000-0000-0000-000000000b28"
const APP = "taintw"
const TAINTED = ["pennylane:payouts:read"]

const ACTOR = {
  actorType: "user" as const,
  userId: "00000000-0000-0000-0000-0000000b28aa",
  orgId: ORG,
  scopes: [
    `${APP}:contacts:write`,
    `${APP}:messages:write`,
    `${APP}:alpha:read`,
    `${APP}:beta:write`,
  ],
  dimensionGrants: {},
} as any

/** One entry per handler invocation, so a refusal before dispatch is provable. */
const handlerCalls: string[] = []

function tool(name: string, scope: string, extra: Record<string, unknown>) {
  return {
    appName: APP,
    name,
    description: name,
    requiredScopes: [scope],
    handler: async () => {
      handlerCalls.push(name)
      return { ok: true }
    },
    ...extra,
  }
}

const TOOLS = [
  // A write to a table outside the closed list: the laundering sink A3 closes.
  tool("writes_contacts", `${APP}:contacts:write`, { writesToTable: "kernel.contacts" }),
  // A write to an enforcing sink: always allowed, tainted or not.
  tool("writes_messages", `${APP}:messages:write`, { writesToTable: SINK_KERNEL_MESSAGES }),
  // A declared read: never refused, or a tainted turn could not read at all.
  tool("reads_alpha", `${APP}:alpha:read`, { readOnly: true }),
  // Neither marker: a write to an unknown table, so it fails closed.
  tool("undeclared", `${APP}:beta:write`, {}),
]

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Taint Write Guard Org', 'taint-write-guard-org') ON CONFLICT DO NOTHING`
  for (const t of TOOLS) toolRegistry.set([ORG, APP, t.name], t as any)
})

afterAll(() => {
  for (const t of TOOLS) toolRegistry.delete([ORG, APP, t.name])
})

function frameWith(accumulated: string[] | null): RunContext {
  const runId = crypto.randomUUID()
  const base = {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    background: false,
  }
  if (accumulated === null) return base as RunContext
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected(accumulated)
  return { ...base, turnScopeAccumulator } as RunContext
}

/**
 * Dispatch `name` through executeToolCore. `accumulated` null means a run frame
 * that carries no accumulator; `noFrame` means no agent run at all.
 */
async function dispatch(
  name: string,
  accumulated: string[] | null,
  opts: { noFrame?: boolean } = {},
) {
  handlerCalls.length = 0
  const call = () =>
    executeToolCore({
      toolName: `${APP}:${name}`,
      orgId: ORG,
      actor: ACTOR,
      params: {},
      // Main made `origin` mandatory on ExecuteToolCoreOptions so a caller that
      // forgets it can no longer read as a human click. These dispatches stand
      // in for an agent turn, which is exactly "in-app-agent".
      origin: "in-app-agent",
    })
  return opts.noFrame ? await call() : await runContextStore.run(frameWith(accumulated), call)
}

function errorCodeOf(env: unknown): string | undefined {
  const e = env as { error?: { code?: string } }
  return e.error?.code
}

describe("executeToolCore: scope-taint write guard", () => {
  it("refuses a tainted turn's write to a sink outside the closed list, before the handler runs", async () => {
    const env = await dispatch("writes_contacts", TAINTED)
    expect(errorCodeOf(env)).toBe("E_SCOPE_TAINT_BLOCKED")
    expect((env as any).error.message).toContain("kernel.contacts")
    expect((env as any).error.retryable).toBe(false)
    expect(handlerCalls).toEqual([])
  })

  it("refuses a tainted turn's undeclared write, so an unmarked tool fails closed", async () => {
    const env = await dispatch("undeclared", TAINTED)
    expect(errorCodeOf(env)).toBe("E_SCOPE_TAINT_BLOCKED")
    expect(handlerCalls).toEqual([])
  })

  it("allows the same write on an untainted turn", async () => {
    const env = await dispatch("writes_contacts", [])
    expect(errorCodeOf(env)).toBeUndefined()
    expect(handlerCalls).toEqual(["writes_contacts"])
  })

  it("allows a tainted turn to write an enforcing sink", async () => {
    const env = await dispatch("writes_messages", TAINTED)
    expect(errorCodeOf(env)).toBeUndefined()
    expect(handlerCalls).toEqual(["writes_messages"])
  })

  it("never refuses a read on a tainted turn", async () => {
    const env = await dispatch("reads_alpha", TAINTED)
    expect(errorCodeOf(env)).toBeUndefined()
    expect(handlerCalls).toEqual(["reads_alpha"])
  })

  it("evaluates no taint outside an agent run, so a human request or job still writes", async () => {
    const env = await dispatch("writes_contacts", null, { noFrame: true })
    expect(errorCodeOf(env)).toBeUndefined()
    expect(handlerCalls).toEqual(["writes_contacts"])
  })

  it("refuses a write from a run frame whose taint is unknowable, rather than failing open", async () => {
    // A frame with no accumulator cannot say what the turn has read. That is
    // not the same as saying it read nothing: it is the unknown case, and the
    // guard resolves an unknown taint to the worst case everywhere else.
    const env = await dispatch("writes_contacts", null)
    expect(errorCodeOf(env)).toBe("E_SCOPE_TAINT_BLOCKED")
    expect(handlerCalls).toEqual([])
  })

  it("still lets an unknowable-taint frame write an enforcing sink and read", async () => {
    // The refusal is the ordinary taint rule applied to the worst case, not a
    // new prohibition: the enforcing sinks and read-only tools stay reachable,
    // so such a turn can still answer and still post its reply.
    const wrote = await dispatch("writes_messages", null)
    expect(errorCodeOf(wrote)).toBeUndefined()
    expect(handlerCalls).toEqual(["writes_messages"])

    const read = await dispatch("reads_alpha", null)
    expect(errorCodeOf(read)).toBeUndefined()
    expect(handlerCalls).toEqual(["reads_alpha"])
  })
})
