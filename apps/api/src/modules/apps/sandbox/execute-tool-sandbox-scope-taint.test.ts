// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2b-FX12: a SANDBOXED app's write is judged against the CALLING turn's taint.
//
// T28 put the scope-taint write guard at `executeToolCore`, the entry a sandboxed
// app reaches through `ctx.executeTool`. But that callback runs in a worker-pool
// hop that has LOST the calling turn's AsyncLocalStorage frame, so the guard's
// in-frame read saw no run at all and evaluated NO taint: a tainted turn could
// launder scoped data into a non-enforcing table simply by routing the write
// through a sandboxed app.
//
// The turn's taint therefore travels the way the read-only mark (FX10a), the
// spawn frame (X4b) and the knowledge write scopes (T29) already travel: captured
// where the frame is still live, at bridge construction, and forwarded across the
// hop. Every dispatch below is made with NO frame active, exactly as a worker-pool
// callback is, and the bridge is built inside the frame, exactly as
// `executeToolHandler` builds it.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import type { RlsClient } from "~/db"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import {
  checkToolScopeTaint,
  SINK_APP_KNOWLEDGE_DOCUMENTS,
  SINK_KERNEL_AGENT_MEMORY,
  SINK_KERNEL_MESSAGES,
} from "~/modules/agent/scopes/scope-taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { toolRegistry } from "~/modules/apps/app-registries"
import { createRpcBridge, createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "fx12taint"
/** The scoped data the calling turn has read: what makes the turn tainted. */
const READ = "pennylane:payouts:read"
const WRITE_SCOPE = `${APP}:writes:write`
/** Non-enforcing sink: the laundering target A3 closes. */
const NON_ENFORCING = "kernel.contacts"

let orgId: string
let userId: string

/** One entry per handler invocation, so a refusal before dispatch is provable. */
const handlerCalls: string[] = []

type Envelope = { data?: unknown; error?: { code?: string; message?: string; retryable?: boolean } }

/** The nested write never ran: it was parked for approval (scope-taint.ts, rule 8). */
function expectParked(env: Envelope): void {
  expect(env.error).toBeUndefined()
  expect(JSON.stringify(env)).toContain("approvalRequestId")
}

function tool(name: string, writesToTable: string) {
  return {
    appName: APP,
    name,
    description: name,
    requiredScopes: [WRITE_SCOPE],
    writesToTable,
    handler: async () => {
      handlerCalls.push(name)
      return { ok: true }
    },
  }
}

/** The app's own row table, for the same-resource allowance (A46) across the hop. */
const OWN_TABLE = `app_${APP}.rows`
const ROW_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7"
const ROW_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7"
const READ_SCOPE = `${APP}:rows:read`

const TOOLS = [
  tool("writes_contacts", NON_ENFORCING),
  // A per-row read and a per-row write on the app's own table: the everyday
  // "read ticket A, reply to ticket A" shape, made from inside a sandbox.
  {
    appName: APP,
    name: "reads_row",
    description: "reads_row",
    requiredScopes: [READ_SCOPE],
    readOnly: true,
    readsFromTable: OWN_TABLE,
    targetRowParam: "rowId",
    handler: async (params: any) => {
      handlerCalls.push("reads_row")
      return { id: params.rowId }
    },
  },
  {
    ...tool("writes_row", OWN_TABLE),
    targetRowParam: "rowId",
  },
  tool("writes_messages", SINK_KERNEL_MESSAGES),
  tool("writes_memory", SINK_KERNEL_AGENT_MEMORY),
  tool("writes_documents", SINK_APP_KNOWLEDGE_DOCUMENTS),
]

function manifest(): Record<string, unknown> {
  return {
    name: APP,
    trusted: true,
    capabilities: [],
    schema: {},
    events: { emits: [] },
    connections: {},
    network: { allowedDomains: [] },
  }
}

/**
 * The bridge never touches its transaction on this path: `ctx.executeTool`
 * dispatches through `executeToolCore`, which opens its own. A db access here
 * would mean the test is exercising something else, so it throws.
 */
function poison(): RlsClient {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === "symbol" || prop === "then") return undefined
        throw new Error(`unexpected sandbox-bridge db access via txDb.${String(prop)}`)
      },
    },
  ) as RlsClient
}

function frameOf(extra: Partial<RunContext>): RunContext {
  const runId = crypto.randomUUID()
  return { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, ...extra }
}

/** A run frame whose turn has accumulated `accumulated` (empty means untainted). */
function taintedFrame(accumulated: string[]): RunContext {
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected(accumulated)
  return frameOf({ effectiveScope: [READ, WRITE_SCOPE], turnScopeAccumulator })
}

type Kind = "createRpcBridge" | "createSessionRpcBridge"

/**
 * Builds the bridge where the frame is live (as `executeToolHandler` does) and
 * dispatches where it is not (as the QuickJS worker callback does).
 */
async function dispatchVia(
  kind: Kind,
  opts: { frame?: RunContext; callerScopes?: string[] },
  toolName: string,
  params = "{}",
): Promise<Envelope> {
  handlerCalls.length = 0
  const actor = {
    actorType: "user" as const,
    userId,
    orgId,
    scopes: opts.callerScopes ?? [],
    dimensionGrants: {},
  }
  const build = (): Record<string, any> =>
    kind === "createSessionRpcBridge"
      ? createSessionRpcBridge(
          APP,
          userId,
          orgId,
          {
            ctx: actor,
            run: <T>(fn: (tx: RlsClient) => Promise<T>) => fn(poison()),
          } as never,
          manifest() as never,
          opts.callerScopes,
        )
      : createRpcBridge(APP, userId, orgId, poison(), manifest() as never, opts.callerScopes)
  const bridge = opts.frame ? runContextStore.run(opts.frame, build) : build()
  return runContextStore.exit(async () => {
    expect(runContextStore.getStore()).toBeUndefined()
    return JSON.parse(await bridge.executeTool(`${APP}:${toolName}`, params)) as Envelope
  })
}

/**
 * The same hop, but several calls over ONE bridge, which is what an app handler
 * does: read a row, then write it back. Built in the frame, dispatched outside it.
 */
async function dispatchSequence(
  frame: RunContext,
  callerScopes: string[],
  calls: Array<[string, string]>,
): Promise<Envelope[]> {
  handlerCalls.length = 0
  const actor = {
    actorType: "user" as const,
    userId,
    orgId,
    scopes: callerScopes,
    dimensionGrants: {},
  }
  void actor
  const bridge = runContextStore.run(frame, () =>
    createRpcBridge(APP, userId, orgId, poison(), manifest() as never, callerScopes),
  )
  return runContextStore.exit(async () => {
    const out: Envelope[] = []
    for (const [toolName, params] of calls) {
      out.push(JSON.parse(await bridge.executeTool(`${APP}:${toolName}`, params)) as Envelope)
    }
    return out
  })
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  userId = (await minimal.person(orgId, { role: "admin" })).id
  for (const t of TOOLS) toolRegistry.set([orgId, APP, t.name], t as any)
})

afterAll(async () => {
  toolRegistry.deleteByPrefix([orgId, APP])
  await releaseTestLock()
})

describe("sandbox ctx.executeTool: the calling turn's scope taint survives the hop", () => {
  for (const kind of ["createRpcBridge", "createSessionRpcBridge"] as const) {
    it(`${kind}: a tainted turn's sandboxed write to a non-enforcing sink never runs inline: it parks`, async () => {
      const env = await dispatchVia(
        kind,
        { frame: taintedFrame([READ]), callerScopes: [READ, WRITE_SCOPE] },
        "writes_contacts",
      )

      expectParked(env)
      expect(handlerCalls).toEqual([])
    })
  }

  // P3 carry-in X7: the one shape 2a's finding named and this file did not yet
  // spell out. An outer tool marked `readOnly` is ADMITTED on a tainted turn
  // (reads are never refused), so it is the one tool that can reach a nested
  // `ctx.executeTool` from inside a tainted turn. The nested write must still be
  // judged against the calling turn's captured taint: the marker is written by
  // the app's own manifest, so it must never buy the writes underneath it a pass.
  it("a readOnly outer tool does not buy its nested write a pass", async () => {
    expect(checkToolScopeTaint([READ], { readOnly: true })).toBeNull()

    const env = await dispatchVia(
      "createRpcBridge",
      { frame: taintedFrame([READ]), callerScopes: [READ, WRITE_SCOPE] },
      "writes_contacts",
    )

    expectParked(env)
    expect(handlerCalls).toEqual([])
  })

  it("allows the same sandboxed write on an untainted turn", async () => {
    const env = await dispatchVia(
      "createRpcBridge",
      { frame: taintedFrame([]), callerScopes: [READ, WRITE_SCOPE] },
      "writes_contacts",
    )

    expect(env.error).toBeUndefined()
    expect(handlerCalls).toEqual(["writes_contacts"])
  })

  for (const [toolName, sink] of [
    ["writes_messages", SINK_KERNEL_MESSAGES],
    ["writes_memory", SINK_KERNEL_AGENT_MEMORY],
    ["writes_documents", SINK_APP_KNOWLEDGE_DOCUMENTS],
  ] as const) {
    it(`allows a tainted turn's sandboxed write to the enforcing sink ${sink}`, async () => {
      const env = await dispatchVia(
        "createRpcBridge",
        { frame: taintedFrame([READ]), callerScopes: [READ, WRITE_SCOPE] },
        toolName,
      )

      expect(env.error).toBeUndefined()
      expect(handlerCalls).toEqual([toolName])
    })
  }

  it("allows the write when the bridge was built outside any turn, as a cron or webhook builds it", async () => {
    const env = await dispatchVia(
      "createRpcBridge",
      { callerScopes: [READ, WRITE_SCOPE] },
      "writes_contacts",
    )

    expect(env.error).toBeUndefined()
    expect(handlerCalls).toEqual(["writes_contacts"])
  })

  // FX22 F7 (A46b). A read made INSIDE the sandbox files its origin into the CALLING
  // turn, so the same-resource allowance works from a sandboxed app exactly as it does
  // in frame. The bridge forwards the turn's live origin STORE, not a snapshot taken
  // when it was built: a snapshot could only carry what the turn had read BEFORE the
  // handler started, and the read below happens after that.
  it("a read made inside the sandbox files its origin, so the write back to that row passes", async () => {
    const frame = taintedFrame([READ])
    const [read, sameRow] = await dispatchSequence(
      frame,
      [READ, READ_SCOPE, WRITE_SCOPE],
      [
        ["reads_row", JSON.stringify({ rowId: ROW_A })],
        ["writes_row", JSON.stringify({ rowId: ROW_A })],
      ],
    )

    expect(read.error).toBeUndefined()
    expect(sameRow.error).toBeUndefined()
    expect(handlerCalls).toEqual(["reads_row", "writes_row"])
    // And the origin landed on the calling turn itself, not on some copy of it.
    expect(frame.turnScopeAccumulator?.originRows()).toEqual({ [OWN_TABLE]: [ROW_A] })
  })

  it("the in-sandbox read widens nothing beyond the row it returned", async () => {
    const [, otherRow] = await dispatchSequence(
      taintedFrame([READ]),
      [READ, READ_SCOPE, WRITE_SCOPE],
      [
        ["reads_row", JSON.stringify({ rowId: ROW_A })],
        ["writes_row", JSON.stringify({ rowId: ROW_B })],
      ],
    )

    // Not the same resource: the write is judged, so it parks instead of running.
    expectParked(otherRow)
    expect(handlerCalls).toEqual(["reads_row"])
  })

  it("refuses the write when the calling turn's taint is undeterminable", async () => {
    // A frame with no accumulator, no effective scope and no caller scopes: the
    // same fail-closed case the sandbox message post refuses. Nothing knows what
    // this turn has read, so the worst case is assumed and the write is refused
    // before the scope check the missing caller scopes would also have failed.
    const env = await dispatchVia("createRpcBridge", { frame: frameOf({}) }, "writes_contacts")

    expect(env.error?.code).toBe("E_SCOPE_TAINT_BLOCKED")
    expect(handlerCalls).toEqual([])
  })
})
