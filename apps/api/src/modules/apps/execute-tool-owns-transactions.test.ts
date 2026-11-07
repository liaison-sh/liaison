// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `ownsTransactions` (app-registries.ts): a host handler that waits on long
// work (the app builder's build, an install's health gate) gets the call's
// session as `ctx.rlsSession` and no ambient transaction, and `ctx.db` refuses
// every use. Any other host handler keeps its whole-call transaction.
import { describe, expect, it } from "bun:test"
import type { RlsSession } from "~/db/rls"
import { executeToolHandler } from "~/modules/apps/execute-tool"

const ORG = "00000000-0000-4000-8000-00000000a001"
const USER = "00000000-0000-4000-8000-00000000a002"

/** A session whose `run` counts the transactions it opens. */
function fakeSession() {
  const live = { execute: () => undefined, marker: "live-tx" }
  const counter = { opened: 0 }
  const session = {
    ctx: { actorType: "user", userId: USER, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
    run: async <T>(fn: (tx: unknown) => Promise<T>) => {
      counter.opened++
      return fn(live)
    },
  } as unknown as RlsSession
  return { session, counter, live }
}

function tool(ownsTransactions: boolean) {
  return {
    appName: "kernel",
    name: "probe",
    ...(ownsTransactions ? { ownsTransactions: true } : {}),
  } as never
}

describe("executeToolHandler, ownsTransactions", () => {
  it("hands the session to the handler, opens no ambient transaction, and ctx.db refuses", async () => {
    const { session, counter } = fakeSession()
    let seen: { session: unknown; dbError: string } | null = null
    await executeToolHandler(
      tool(true),
      (async (_p: unknown, ctx: { rlsSession?: RlsSession; db: { select: () => void } }) => {
        let dbError = ""
        try {
          ctx.db.select()
        } catch (err) {
          dbError = (err as Error).message
        }
        seen = { session: ctx.rlsSession, dbError }
        return { ok: true }
      }) as never,
      USER,
      ORG,
      ["*"],
      session,
      {},
    )
    expect(seen).not.toBeNull()
    expect(seen!.session).toBe(session)
    expect(seen!.dbError).toContain("owns its transactions")
    expect(counter.opened).toBe(0)
  })

  it("any other host handler runs inside one transaction of the session", async () => {
    const { session, counter, live } = fakeSession()
    let db: unknown = null
    let rlsSession: unknown = "unset"
    await executeToolHandler(
      tool(false),
      (async (_p: unknown, ctx: { db: unknown; rlsSession?: unknown }) => {
        db = ctx.db
        rlsSession = ctx.rlsSession
        return { ok: true }
      }) as never,
      USER,
      ORG,
      ["*"],
      session,
      {},
    )
    expect(counter.opened).toBe(1)
    expect(db).toBe(live)
    expect(rlsSession).toBeUndefined()
  })
})
