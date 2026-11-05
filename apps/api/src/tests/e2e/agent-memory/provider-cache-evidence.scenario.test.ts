// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4m-T03: provider cache evidence on the guard runs (spec-memory.md S23
// scenario 3).
//
// The T01 and T02 guards prove the prefix the runtime ASSEMBLES is byte stable.
// That is necessary and not sufficient: the claim the contract actually makes
// is that the provider serves it from cache. This scenario reads the AI SDK's
// normalized `usage.cachedInputTokens` off a REAL provider turn and asserts it
// covers the prefix the harness measured.
//
// NOT RUN IS NOT A PASS. Without a usable Anthropic key the evidence cannot be
// gathered, and a scenario that quietly returned green would be worse than no
// scenario at all: it would report cache evidence nobody collected. So the
// gate is resolved once, before the suite is declared, with a minimal live
// call; when it cannot be satisfied the two evidence cases are reported as
// SKIPPED and the exact not run line is printed. The gate covers both halves
// of "usable": no key at all, and a key the provider refuses (an unfunded or
// rate limited account), because a present but unusable key is not evidence
// either.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { estimateTokens } from "~/modules/agent/context/compaction"
import { invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import { resetOrgRuntimeForTest } from "~/tests/helpers/org-runtime"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { LIVE_LLM } from "../helpers/live-llm"
import { type CapturedTurn, installRequestCapture } from "./helpers/capture-requests"

const ORG_ID = "4d000000-0000-4000-8000-000000000021"
const USER_ID = "4d000000-0000-4000-8000-000000000022"
const THREAD_ID = "4d000000-0000-4000-8000-000000000023"
const AGENT_ID = "4d000000-0000-4000-8000-000000000024"
const HAIKU_MODEL_ID = "claude-haiku-4-5"

/** Enough turns for a prefix to exist and be re-read; every one is billable. */
const EVIDENCE_TURNS = 4
const NO_KEY_LINE = "provider cache evidence: not run (no LIAISON_ANTHROPIC_API_KEY)"

/**
 * The one place the not run line is produced, so the reporting is testable
 * without a provider and cannot drift from what the gate prints.
 */
export function notRunLine(reason: string | null): string {
  if (reason === null) return NO_KEY_LINE
  return `provider cache evidence: not run (${reason})`
}

/**
 * Resolve the gate with a minimal live call. Returns null when real evidence
 * can be gathered, otherwise the reason the run is reported as not run.
 */
async function resolveEvidenceGate(): Promise<string | null> {
  // Even the gate's probe is a paid call: only a run that opted into live
  // models (LIAISON_E2E_LIVE_LLM=1) makes it.
  if (!LIVE_LLM) return "live model scenarios not enabled, set LIAISON_E2E_LIVE_LLM=1"
  const key = process.env.LIAISON_ANTHROPIC_API_KEY
  if (!key) return "no LIAISON_ANTHROPIC_API_KEY"
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL_ID,
        max_tokens: 1,
        messages: [{ role: "user", content: "ok" }],
      }),
    })
    if (res.ok) return null
    const body = await res.text()
    return `provider refused the key, HTTP ${res.status}: ${body.slice(0, 160)}`
  } catch (err) {
    return `provider unreachable: ${String(err).slice(0, 160)}`
  }
}

const GATE = await resolveEvidenceGate()
if (GATE !== null) console.log(notRunLine(GATE === "no LIAISON_ANTHROPIC_API_KEY" ? null : GATE))

const captured: CapturedTurn[] = []

describe("P4m-T03 provider cache evidence", () => {
  beforeAll(async () => {
    if (GATE !== null) return
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'CacheEvidenceOrg', 'cache-evidence-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'cacheevidence@test.com', 'Cache Evidence')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling, system_prompt)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'personal', '@cacheevidence', 'Cache Evidence', ${USER_ID}, '["*"]'::jsonb, 'You answer briefly.')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, agent_model_id)
      VALUES (${THREAD_ID}, ${ORG_ID}, 'cache-evidence-dm', 'agent_chat', ${USER_ID}, ${HAIKU_MODEL_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${ORG_ID}, '100.00000000', '0', 'EUR')`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${HAIKU_MODEL_ID}, 'Claude Haiku 4.5', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT (provider, model_id) DO NOTHING`

    // No script: the capture delegates to the REAL provider and records the
    // usage it reports.
    const capture = installRequestCapture({ currentAgentKey: () => AGENT_ID })
    try {
      for (let turn = 1; turn <= EVIDENCE_TURNS; turn++) {
        const msgId = crypto.randomUUID()
        await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
          VALUES (${msgId}, ${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'user', ${`Turn ${turn}. Reply with the single word ok.`}, '{}')`
        await invokeAgentForThread(
          THREAD_ID,
          msgId,
          { userId: USER_ID, orgId: ORG_ID, scopes: ["*"], dimensionGrants: {} },
          ORG_ID,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          AGENT_ID,
        )
      }
      captured.push(...capture.turns)
    } finally {
      capture.restore()
    }
  })

  afterAll(async () => {
    if (GATE !== null) return
    resetOrgRuntimeForTest(ORG_ID)
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("reports not run without an Anthropic key", () => {
    // The line a validator greps for, pinned exactly, and pinned as a REPORT
    // rather than a pass: it names the scenario and the reason in one string.
    expect(notRunLine(null)).toBe(NO_KEY_LINE)
    expect(notRunLine("provider refused the key, HTTP 400")).toBe(
      "provider cache evidence: not run (provider refused the key, HTTP 400)",
    )
    expect(notRunLine(null)).not.toContain("pass")
  })

  it.skipIf(GATE !== null)(
    "cached input tokens are at least 90 percent of the measured prefix tokens on every non rebuild turn",
    () => {
      expect(captured.length).toBe(EVIDENCE_TURNS)
      // The first turn builds the cache rather than reading it, and a rebuild
      // turn is excluded; there are no rebuilds on this tree, so the count
      // comes from the harness's own turn list either way.
      const evidenceTurns = captured.slice(1)
      expect(evidenceTurns.length).toBe(EVIDENCE_TURNS - 1)
      for (const turn of evidenceTurns) {
        expect(turn.usage).not.toBeNull()
        const prefixTokens = estimateTokens(turn.prefixText)
        expect(turn.usage?.cachedInputTokens ?? 0).toBeGreaterThanOrEqual(0.9 * prefixTokens)
      }
    },
  )

  it.skipIf(GATE !== null)(
    "cache creation tokens are no more than the tail plus the new messages",
    () => {
      for (const turn of captured.slice(1)) {
        expect(turn.usage).not.toBeNull()
        const bound = estimateTokens(turn.tailText) + estimateTokens(turn.newMessagesText)
        expect(turn.usage?.uncachedInputTokens ?? 0).toBeLessThanOrEqual(bound)
      }
    },
  )
})
