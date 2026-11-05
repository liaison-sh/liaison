// SPDX-License-Identifier: FSL-1.1-ALv2
// ctx.effects through the sandbox bridge (P3 M14, S11): the claim / complete /
// release / settleUnknown steps of the effect ledger, scoped to the app's own
// keys in its own org. On the base the bridge has no `effects` call.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { effectLedgerStats } from "~/lib/effect-once"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const ORG = crypto.randomUUID()
const OTHER_ORG = crypto.randomUUID()
const tx = { execute: async () => [], queueEvent: async () => {} }
const manifestOf = (name: string) => ({
  name,
  schema: {},
  events: {},
  connections: {},
  network: {},
})
const bridgeFor = (app: string, org = ORG) =>
  createRpcBridge(app, `system:${app}`, org, tx as never, manifestOf(app) as never)
const k = () => `einv:${crypto.randomUUID()}`
const json = (s: string) => JSON.parse(s)

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES
    (${ORG}, 'Effects bridge', ${`effects-${ORG.slice(0, 8)}`}),
    (${OTHER_ORG}, 'Effects other', ${`effects-${OTHER_ORG.slice(0, 8)}`})`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG}, ${OTHER_ORG})`
})

describe("ctx.effects bridge", () => {
  it("claims, completes and then replays the stored result", async () => {
    const b = bridgeFor("widgets")
    const key = k()
    expect(json(await b.effects_claim(key))).toEqual({ state: "claimed" })
    expect(json(await b.effects_claim(key))).toEqual({ state: "in_flight" })
    expect(json(await b.effects_complete(key, JSON.stringify({ ref: "PA-1" })))).toEqual({
      ok: true,
    })
    expect(json(await b.effects_claim(key))).toEqual({ state: "done", result: { ref: "PA-1" } })
    const [row] = await sql`SELECT key FROM kernel.effect_ledger WHERE org_id = ${ORG}
      AND key = ${`app:widgets:${key}`}`
    expect(row).toBeDefined()
  })

  it("a claim from app A cannot read or complete app B's key", async () => {
    const a = bridgeFor("widgets")
    const b = bridgeFor("gadgets")
    const key = k()
    expect(json(await a.effects_claim(key))).toEqual({ state: "claimed" })
    // The same guest key is another ledger key for app B: B's claim is fresh,
    // and B completing it leaves A's claim pending.
    expect(json(await b.effects_claim(key))).toEqual({ state: "claimed" })
    await b.effects_complete(key, JSON.stringify({ by: "b" }))
    expect(json(await a.effects_claim(key))).toEqual({ state: "in_flight" })
    // Another org's bridge of the same app sees nothing of it either.
    expect(json(await bridgeFor("widgets", OTHER_ORG).effects_claim(key))).toEqual({
      state: "claimed",
    })
  })

  it("release frees a key; an unknown key is settled by the app's decision", async () => {
    const b = bridgeFor("widgets")
    const key = k()
    await b.effects_claim(key)
    await b.effects_release(key)
    expect(json(await b.effects_claim(key))).toEqual({ state: "claimed" })

    // A claim whose process died: unknown, until the app says what happened.
    const lost = k()
    await sql`INSERT INTO kernel.effect_ledger (org_id, key, state, claimed_by)
      VALUES (${ORG}, ${`app:widgets:${lost}`}, 'pending', ${crypto.randomUUID()})`
    const before = effectLedgerStats().unknown
    expect(json(await b.effects_claim(lost))).toEqual({ state: "unknown" })
    // Counted (and logged `effect_unknown`) like a kernel effect's unknown claim.
    expect(effectLedgerStats().unknown).toBe(before + 1)
    expect(
      json(
        await b.effects_settleUnknown(
          lost,
          JSON.stringify({ outcome: "done", result: { found: true } }),
        ),
      ),
    ).toEqual({ ok: true })
    expect(json(await b.effects_claim(lost))).toEqual({ state: "done", result: { found: true } })
  })

  it("markUnknown turns the run's own claim unknown, so the next run asks the remote side", async () => {
    const b = bridgeFor("widgets")
    const key = k()
    await b.effects_claim(key)
    expect(json(await b.effects_markUnknown(key))).toEqual({ ok: true })
    // The next run (another bridge) meets it unknown at once, not in flight.
    expect(json(await bridgeFor("widgets").effects_claim(key))).toEqual({ state: "unknown" })
  })

  it("a sibling run of the same app in the same process cannot complete, release or mark another run's claim", async () => {
    const a = bridgeFor("widgets")
    const sibling = bridgeFor("widgets")
    const key = k()
    await a.effects_claim(key)
    expect(json(await sibling.effects_complete(key, JSON.stringify({ by: "sibling" })))).toEqual({
      ok: false,
    })
    await sibling.effects_release(key)
    expect(json(await sibling.effects_markUnknown(key))).toEqual({ ok: false })
    // Still the first run's live claim, which only it completes.
    expect(json(await sibling.effects_claim(key))).toEqual({ state: "in_flight" })
    expect(json(await a.effects_complete(key, JSON.stringify({ by: "a" })))).toEqual({ ok: true })
  })

  it("a guest's tiny claim deadline cannot make a sibling's live claim look stale", async () => {
    const a = bridgeFor("widgets")
    const key = k()
    await a.effects_claim(key)
    await Bun.sleep(1100)
    expect(
      json(await bridgeFor("widgets").effects_claim(key, JSON.stringify({ pendingTtlS: 1 }))),
    ).toEqual({ state: "in_flight" })
  })

  it("refuses an empty or oversized key", async () => {
    const b = bridgeFor("widgets")
    await expect(b.effects_claim("")).rejects.toThrow(/key/)
    await expect(b.effects_claim("x".repeat(401))).rejects.toThrow(/key/)
  })
})
