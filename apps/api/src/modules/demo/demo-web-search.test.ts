// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's `web_search` on a demo box, proved at the transport.
//
// `web_fetch` was confined to a fixed allowlist, but `web_search` SPENDS: it
// resolved an Exa key and called Exa, and on a public box with no auth in front
// of it the key it resolved was the OPERATOR's. Any visitor could drive it in a
// loop on somebody else's budget.
//
// Every "blocked" assertion below is made against a recorder standing exactly
// where the Exa client stands: the `exa-js` module itself is replaced, so a
// constructed client or an issued `search` is recorded. A test that only read a
// config flag would pass with the gate deleted.
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { byokEncryptionKey, env } from "~/lib/env"
import { registerDemoAlertMailer } from "~/modules/demo/demo-alerts"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import {
  invalidateDemoMarker,
  markOrgAsDemo,
  reservedMarker,
  visitorMarker,
} from "~/modules/demo/demo-org"
import {
  checkDemoSpendCeiling,
  demoOrgTokensReserved,
  demoOrgTokensUsed,
  demoSpendMessage,
  releaseDemoTurnReservation,
} from "~/modules/demo/demo-spend"
import { WEB_SEARCH_TOKEN_EQUIVALENT } from "~/modules/demo/demo-spend-ceiling"
import { serverT } from "~/modules/i18n/server-i18n"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

/** Every Exa client constructed, and every query that reached one. */
let clientsBuilt: string[] = []
let onTheWire: Array<{ query: string; numResults: number }> = []

// The recorder stands where the transport stands. `handleWebSearch` reaches Exa
// through `(await import("exa-js")).default`, so replacing the module replaces
// the whole outbound path: nothing below this line can reach the network.
// A snapshot of the real module is spread under the fake, so a later importer
// in the same process never meets a partial stub (mock-module-hygiene).
const realExa = { ...(await import("exa-js")) }
mock.module("exa-js", () => ({
  ...realExa,
  default: class FakeExa {
    constructor(apiKey: string) {
      clientsBuilt.push(apiKey)
    }
    async search(query: string, opts: { numResults: number }) {
      onTheWire.push({ query, numResults: opts.numResults })
      return { results: [{ title: "T", url: "https://example.com/", text: "body", score: 1 }] }
    }
  },
}))

// Imported AFTER the module mock is registered, so the handler's dynamic import
// resolves to the recorder.
const { handleWebSearch } = await import("~/modules/agent/tools/web-tools")

const OPERATOR_KEY = "operator-exa-key-not-the-visitors"
const VISITOR_KEY = "visitor-own-exa-key"

/** Store a BYOK Exa key on `orgId`, exactly as the settings route writes one. */
async function setByokExaKey(orgId: string, plaintext: string): Promise<void> {
  const encrypted = encryptSecret(plaintext, byokEncryptionKey, CryptoContext.byokApiKey)
  await withPrivilegedDb(orgId, "test-set-byok", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE kernel.organizations
      SET settings = COALESCE(settings, '{}'::jsonb) ||
        jsonb_build_object('providerKeys',
          COALESCE(settings->'providerKeys', '{}'::jsonb) ||
          jsonb_build_object('exa', jsonb_build_object('encrypted', ${encrypted}::text)))
      WHERE id = ${orgId}::uuid`)
  })
}

async function setOrgLocale(orgId: string, locale: string): Promise<void> {
  await withPrivilegedDb(orgId, "test-set-locale", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE kernel.organizations SET default_locale = ${locale} WHERE id = ${orgId}::uuid`)
  })
}

describe("demo web_search policy", () => {
  let demoOrgId: string
  let byokDemoOrgId: string
  let frenchDemoOrgId: string
  let normalOrgId: string
  let reservedOrgId: string
  let previousExaKey: string | undefined

  beforeAll(async () => {
    await acquireTestLock()
    previousExaKey = process.env.EXA_API_KEY
    process.env.EXA_API_KEY = OPERATOR_KEY
    demoOrgId = (await ensureOrg({ slug: "search-demo", name: "Search Demo" })).orgId
    byokDemoOrgId = (await ensureOrg({ slug: "search-demo-byok", name: "Search Demo BYOK" })).orgId
    frenchDemoOrgId = (await ensureOrg({ slug: "search-demo-fr", name: "Search Demo FR" })).orgId
    normalOrgId = (await ensureOrg({ slug: "search-normal", name: "Search Normal" })).orgId
    reservedOrgId = (await ensureOrg({ slug: "search-reserved", name: "Search Reserved" })).orgId
    await markOrgAsDemo(reservedOrgId, reservedMarker())
    for (const id of [demoOrgId, byokDemoOrgId, frenchDemoOrgId]) {
      await markOrgAsDemo(id, visitorMarker(24))
    }
    await setByokExaKey(byokDemoOrgId, VISITOR_KEY)
    await setOrgLocale(frenchDemoOrgId, "fr-FR")
    invalidateDemoMarker()
  })

  afterAll(async () => {
    DemoModeTestAccess.set(null)
    if (previousExaKey === undefined) delete process.env.EXA_API_KEY
    else process.env.EXA_API_KEY = previousExaKey
    await releaseTestLock()
  })

  afterEach(() => {
    clientsBuilt = []
    onTheWire = []
    invalidateDemoMarker()
  })

  const search = (orgId: string) =>
    handleWebSearch({ query: "liaison pricing" }, { orgId, userId: "u" })

  it("refuses a demo org on the deployment's key, and nothing reaches Exa", async () => {
    DemoModeTestAccess.set(true)
    const result = await search(demoOrgId)
    expect("error" in result).toBe(true)
    // Not a constructed client, not a query: the operator's key was never spent.
    expect(clientsBuilt).toEqual([])
    expect(onTheWire).toEqual([])
  })

  // A visitor without a key of its own searches on the box's OpenRouter key
  // once it confirms an email (demo-visitor-gate.test.ts); until then it
  // is told to confirm, in its own language, and nothing leaves the box.
  function spendOn(): () => void {
    const target = env as { LIAISON_DEMO_ALERT_EMAIL?: string; LIAISON_DEMO_MAIL_CAPTURE: boolean }
    const saved = { ...target }
    target.LIAISON_DEMO_ALERT_EMAIL = "owner@example.com"
    target.LIAISON_DEMO_MAIL_CAPTURE = true
    registerDemoAlertMailer(async () => {})
    return () => {
      target.LIAISON_DEMO_ALERT_EMAIL = saved.LIAISON_DEMO_ALERT_EMAIL
      target.LIAISON_DEMO_MAIL_CAPTURE = saved.LIAISON_DEMO_MAIL_CAPTURE
      registerDemoAlertMailer(null)
    }
  }

  it("says plainly what it cannot do instead of returning an empty result", async () => {
    DemoModeTestAccess.set(true)
    const restore = spendOn()
    const result = await search(demoOrgId).finally(restore)
    if (!("error" in result)) throw new Error("expected a refusal")
    // No code was sent to this org, so the line does not point at the inbox
    // (visitorSpendIdentity, D40): it says the box could not send one.
    expect(result.error).toBe(serverT("en", "kernel.demo.refusal.demo_verification_unsent"))
    // And it does NOT tell the visitor to add an Exa key. `SUPPORTED_PROVIDERS`
    // in the settings route is the four MODEL vendors and the demo's key prompt
    // offers those four, so that advice sent people to a screen with no field
    // on it. An instruction the product cannot accept is worse than none.
    expect(result.error).not.toContain("Exa")
    // An empty-results answer would have looked like a working but useless
    // product. The visitor gets a sentence instead.
    expect("results" in result).toBe(false)
  })

  it("refuses in the org's own language", async () => {
    DemoModeTestAccess.set(true)
    const restore = spendOn()
    const result = await search(frenchDemoOrgId).finally(restore)
    if (!("error" in result)) throw new Error("expected a refusal")
    expect(result.error).toBe(serverT("fr", "kernel.demo.refusal.demo_verification_unsent"))
    expect(result.error).not.toContain("Exa")
    expect(onTheWire).toEqual([])
  })

  it("lets a demo org search on ITS OWN key, which is the whole point of the posture", async () => {
    DemoModeTestAccess.set(true)
    const result = await search(byokDemoOrgId)
    expect("results" in result).toBe(true)
    expect(clientsBuilt).toEqual([VISITOR_KEY])
    expect(onTheWire).toHaveLength(1)
  })

  it("explains itself rather than saying 'not configured' when no key resolves", async () => {
    DemoModeTestAccess.set(true)
    delete process.env.EXA_API_KEY
    try {
      const result = await search(demoOrgId)
      if (!("error" in result)) throw new Error("expected a refusal")
      // Spend is off here (no owner alert address): the box key is unavailable.
      expect(result.error).toBe(demoSpendMessage("demo_unavailable", "en"))
      expect(result.error).not.toContain("not configured")
    } finally {
      process.env.EXA_API_KEY = OPERATOR_KEY
    }
  })

  // ---- THE RESERVED APP REVIEW ORG ------------------------------------
  //
  // A reviewer pastes nothing, and an agent that refuses its own advertised
  // tool in front of App Review is the rejected build the reserved org exists
  // to avoid. It spends the deployment's model key under a rolling ceiling
  // already, so it searches on the deployment's Exa key under the same one.

  it("lets the reserved org search on the deployment's key", async () => {
    DemoModeTestAccess.set(true)
    const result = await search(reservedOrgId)
    expect("results" in result).toBe(true)
    expect(clientsBuilt).toEqual([OPERATOR_KEY])
  })

  it("stops the reserved org once it has spent its rolling day of tokens", async () => {
    DemoModeTestAccess.set(true)
    await sql`
      INSERT INTO kernel.credit_transactions
        (org_id, type, amount, balance_after, model, input_tokens, output_tokens, raw_cost)
      VALUES (${reservedOrgId}, 'byok_usage', '-1', '0', 'm',
              ${env.LIAISON_DEMO_RESERVED_TOKEN_CEILING}, 0, '1')`
    invalidateDemoMarker()
    try {
      const result = await search(reservedOrgId)
      if (!("error" in result)) throw new Error("expected a refusal")
      expect(result.error).toContain("usage limit")
      expect(onTheWire).toEqual([])
    } finally {
      await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${reservedOrgId}`
    }
  })

  // The spend is the operator's Exa account, so it lands in the SAME ledger the
  // ceiling sums, at its worst case priced in tokens (demo-spend-ceiling.ts).
  // Delete the `recordReservedDemoSideSpend` call from `handleWebSearch` and
  // this fails with the ledger unchanged.
  it("counts the reserved org's search in the ceiling's ledger", async () => {
    DemoModeTestAccess.set(true)
    try {
      const before = await demoOrgTokensUsed(reservedOrgId)
      const result = await search(reservedOrgId)
      expect("results" in result).toBe(true)
      expect(await demoOrgTokensUsed(reservedOrgId)).toBe(before + WEB_SEARCH_TOKEN_EQUIVALENT)
    } finally {
      await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${reservedOrgId}`
    }
  })

  it("counts nothing for an org that is not the reserved one", async () => {
    DemoModeTestAccess.set(true)
    const before = await demoOrgTokensUsed(normalOrgId)
    await search(normalOrgId)
    expect(await demoOrgTokensUsed(normalOrgId)).toBe(before)
  })

  // ---- OFF, twice over -------------------------------------------------

  it("changes nothing with demo mode off: a marked org still searches on the deployment key", async () => {
    DemoModeTestAccess.set(false)
    const result = await search(demoOrgId)
    expect("results" in result).toBe(true)
    expect(clientsBuilt).toEqual([OPERATOR_KEY])
    expect(onTheWire).toEqual([{ query: "liaison pricing", numResults: 5 }])
  })

  it("changes nothing for an UNMARKED org on the demo box itself", async () => {
    DemoModeTestAccess.set(true)
    const result = await search(normalOrgId)
    expect("results" in result).toBe(true)
    expect(clientsBuilt).toEqual([OPERATOR_KEY])
    expect(onTheWire).toEqual([{ query: "liaison pricing", numResults: 5 }])
  })

  // SK3: on an OpenRouter key the search is one completion, metered through
  // finalizeUsage. finalizeUsage also gives back a turn's reservation, which
  // the search never took: it handed back the reservation of the TURN running
  // beside it (the ceiling then under-counted in-flight spend), and wrote a
  // second ledger row on top of the worst-case one recorded before the call.
  describe("on an OpenRouter key", () => {
    const saved: Record<string, string | undefined> = {}
    let stub: ReturnType<typeof Bun.serve>
    let calls = 0
    beforeAll(async () => {
      for (const k of ["EXA_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"]) {
        saved[k] = process.env[k]
      }
      const recorded = (
        await import("~/modules/agent/tools/__fixtures__/openrouter-web-search.json")
      ).default
      stub = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch() {
          calls++
          return Response.json(recorded)
        },
      })
    })
    afterAll(() => {
      stub.stop(true)
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    })
    afterEach(async () => {
      await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${reservedOrgId}`
      await releaseDemoTurnReservation(reservedOrgId)
      process.env.EXA_API_KEY = OPERATOR_KEY
      calls = 0
    })

    it("leaves a concurrent turn's reservation alone and writes ONE ledger row", async () => {
      DemoModeTestAccess.set(true)
      delete process.env.EXA_API_KEY
      process.env.OPENROUTER_API_KEY = "operator-openrouter-key"
      process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${stub.port}/api/v1`
      // A turn is in flight beside the search: it holds a reservation.
      expect(await checkDemoSpendCeiling(reservedOrgId)).toBeNull()
      const held = await demoOrgTokensReserved(reservedOrgId)
      expect(held).toBeGreaterThan(0)

      const result = await search(reservedOrgId)
      if ("error" in result) throw new Error(result.error)
      expect(result.backend).toBe("openrouter")
      expect(calls).toBe(1)

      expect(await demoOrgTokensReserved(reservedOrgId)).toBe(held)
      const rows =
        await sql`SELECT 1 FROM kernel.credit_transactions WHERE org_id = ${reservedOrgId}`
      expect(rows).toHaveLength(1)
    })
  })
})
