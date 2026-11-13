// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app performance report (`performance.ts`): what it carries (aggregate
// numbers per catalog app name and lane, custom apps masked, nothing else),
// and when it is queued (opted in and registered, once an hour; always on in
// the managed edition).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { messageSchemas } from "@liaison/control-plane-contract"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import {
  processRunHealth,
  RunHealthTestAccess,
  recordRunHealth,
} from "~/modules/apps/usage/run-health"
import type { RunSettledInfo } from "~/modules/apps/workers/run-settled"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { readIdentity, writeIdentity } from "./identity"
import { PerformanceTestAccess, performanceDataOf, performanceTick } from "./performance"
import { LiaisonTeamError, readSharing, setSharing } from "./settings"

const savedEndpoint = env.LIAISON_TEAM_ENDPOINT
const ORG = "00000000-0000-4000-8000-0000000fe4f0"
const HOUR = 60 * 60_000

function run(over: Partial<RunSettledInfo> = {}): RunSettledInfo {
  return {
    app: "tickets",
    orgId: ORG,
    entry: "tool:tickets_search",
    executor: "workerd",
    nested: false,
    ms: 200,
    ok: true,
    at: Date.now(),
    ...over,
  }
}

const performanceRows = () =>
  sql<{ data: Record<string, unknown> }[]>`
    SELECT data FROM kernel.control_plane_outbox WHERE type = 'performance' ORDER BY created_at`

async function registered(opts: { share: boolean }): Promise<void> {
  await setSharing({ register: true, sharePerformance: opts.share }, { userId: null })
  const id = await withSystemDb("test", (tx) => readIdentity(tx))
  if (!id) throw new Error("no identity")
  await withSystemDb("test", (tx) =>
    writeIdentity(tx, { ...id, state: "registered", registeredAt: new Date().toISOString() }),
  )
}

beforeAll(async () => {
  await acquireTestLock()
})
afterAll(async () => {
  ;(env as { LIAISON_TEAM_ENDPOINT: string }).LIAISON_TEAM_ENDPOINT = savedEndpoint
  _setEdition(null)
  PerformanceTestAccess.setCatalogNames(null)
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
  await releaseTestLock()
})
beforeEach(async () => {
  ;(env as { LIAISON_TEAM_ENDPOINT: string }).LIAISON_TEAM_ENDPOINT = "http://127.0.0.1:9/hook"
  _setEdition("self_hosted")
  PerformanceTestAccess.setCatalogNames(new Set(["tickets", "shopify"]))
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
})
afterEach(() => RunHealthTestAccess.clear())

describe("what the report carries", () => {
  it("numbers per catalog app and lane; a custom app is (custom); no org, no entry name", () => {
    for (let i = 0; i < 20; i++) recordRunHealth(run())
    recordRunHealth(run({ ok: false, errorKind: "queue_timeout", ms: 30_000 }))
    recordRunHealth(run({ app: "crm-sync-o1a2b3c4d", entry: "job:pull_accounts", ms: 9_000 }))
    recordRunHealth(run({ app: "uploaded-private-app", entry: "tool:lookup" }))
    const data = performanceDataOf(processRunHealth())
    const w = data.windows["15m"]
    expect(w.windowS).toBe(900)
    expect(w.lanes.interactive.timeouts).toBe(1)
    expect(w.lanes.interactive.errorKinds).toEqual({ queue_timeout: 1 })
    expect(w.apps.map((a) => a.app).sort()).toEqual(["(custom)", "(custom)", "tickets"])
    expect(w.slowest[0]).toEqual({
      app: "tickets",
      entryKind: "tool",
      lane: "interactive",
      ms: 30_000,
      ok: false,
      errorKind: "queue_timeout",
    })
    const text = JSON.stringify(data)
    for (const leak of [
      ORG,
      "crm-sync",
      "uploaded-private-app",
      "pull_accounts",
      "tickets_search",
    ]) {
      expect(text.includes(leak)).toBe(false)
    }
    const envelope = {
      v: 2,
      type: "performance",
      messageId: crypto.randomUUID(),
      instanceId: crypto.randomUUID(),
      ts: new Date().toISOString(),
      data,
    }
    expect(messageSchemas.performance.safeParse(envelope).success).toBe(true)
  })
})

describe("when it is queued", () => {
  it("off by default: a registered server sends none until the operator opts in", async () => {
    await registered({ share: false })
    expect(await performanceTick(new Date())).toBe(false)
    expect(await performanceRows()).toHaveLength(0)
  })

  it("needs registration: sharing performance without it is refused", async () => {
    await expect(setSharing({ sharePerformance: true }, { userId: null })).rejects.toBeInstanceOf(
      LiaisonTeamError,
    )
  })

  it("opted in: one report an hour", async () => {
    await registered({ share: true })
    recordRunHealth(run())
    const t0 = new Date()
    expect(await performanceTick(t0)).toBe(true)
    expect(await performanceTick(new Date(t0.getTime() + 10 * 60_000))).toBe(false)
    expect(await performanceTick(new Date(t0.getTime() + HOUR))).toBe(true)
    const rows = await performanceRows()
    expect(rows).toHaveLength(2)
    expect(rows[0]?.data).toMatchObject({
      edition: "self_hosted",
      windows: { "15m": { windowS: 900 } },
    })
  })

  it("turning registration off turns the report off too", async () => {
    await registered({ share: true })
    await setSharing({ register: false }, { userId: null })
    expect((await withSystemDb("test", (tx) => readSharing(tx))).sharePerformance).toBe(false)
  })

  it("a managed cell always shares it", async () => {
    _setEdition("managed")
    expect((await withSystemDb("test", (tx) => readSharing(tx))).sharePerformance).toBe(true)
  })
})
