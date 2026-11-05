// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S13, LIVE: `web_search` for an org whose only search-capable key is
// OpenRouter's. Exa's key is removed for this file (restored after), so the
// tool must resolve the OpenRouter web-plugin backend; a current-events query
// must come back with at least three results with URLs, at least three of them
// with an excerpt of 200 characters or more. No test seam: the real request
// goes to OpenRouter (under a cent).
//
//   bun run scripts/test-run.ts live --file src/tests/live/openrouter-web-search.live.test.ts
// It FAILS, never skips, when OPENROUTER_API_KEY is missing.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { handleWebSearch, resolveWebSearchBackend } from "~/modules/agent/tools/web-tools"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-4000-8000-0000000f3001"
const USER_ID = "00000000-0000-4000-8000-0000000f3002"

const WRAPPER = /^<external-content source="untrusted">\n([\s\S]*)\n<\/external-content>$/

describe("web_search on an OpenRouter key, live (S13)", () => {
  const saved: Record<string, string | undefined> = {}

  beforeAll(async () => {
    await acquireTestLock()
    for (const k of ["EXA_API_KEY", "OPENROUTER_BASE_URL"]) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'OpenRouterSearchLive', 'openrouter-search-live') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'openrouter-search-live@test.com', 'Search Live') ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("answers a current-events query with cited pages through OpenRouter", async () => {
    expect(process.env.OPENROUTER_API_KEY ?? "").toMatch(/^sk-or-/)
    expect((await resolveWebSearchBackend(ORG_ID))?.backend).toBe("openrouter")

    const result = await handleWebSearch(
      { query: "What are the main world news headlines this week?", numResults: 5 },
      { userId: USER_ID, orgId: ORG_ID },
    )
    if ("error" in result) throw new Error(result.error)
    expect(result.backend).toBe("openrouter")
    expect(result.results.length).toBeGreaterThanOrEqual(3)
    for (const r of result.results) expect(r.url).toMatch(/^https?:\/\//)
    const excerpts = result.results.map((r) => WRAPPER.exec(r.snippet)?.[1] ?? "")
    expect(excerpts.filter((e) => e.length >= 200).length).toBeGreaterThanOrEqual(3)

    // Metered at the cost OpenRouter reported.
    const rows = await sql<{ model: string; raw_cost: string }[]>`
      SELECT model, raw_cost FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
    expect(rows.map((r) => r.model)).toContain("openrouter/google/gemini-3.1-flash-lite")
    expect(Number(rows[0].raw_cost)).toBeGreaterThan(0)
  })
})
