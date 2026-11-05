// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S8 — Visual baselines for the SubRunCard surfaces. Per the E2E plan, the
// card renders in 5 statuses (queued / running / done / failed / cancelled),
// with optional pending-approval pill and expanded transcript. Each baseline
// is captured against a directly-seeded `agent_runs` row + sub_run card
// message so the visual state is deterministic (no LLM, no worker race).
//
// First run: PW_UPDATE_SNAPSHOTS=all (or =missing) generates the goldens.
// Subsequent runs: pixel-diff against the stored PNGs with maxDiffPixelRatio
// 0.02 (matches `agent-skills-and-routines-visual` convention).

import path from "node:path"
import { createUserWithScopes } from "@liaison/test-helpers"
import { forceDarkMode } from "./agent-bootstrap"
import { createSubAgentTest } from "./fixtures/sub-agent-test"
import { expect, loginAs } from "./fixtures/test"
import { seedAgentThread, seedModelPricingAndCredits } from "./helpers/agent-seed"
import { clearSubAgentTables } from "./helpers/agent-test-fixtures"

const STUB = path.resolve(
  __dirname,
  "../../../../api/src/tests/e2e/helpers/sub-agent-smoke-stub.ts",
)

const test = createSubAgentTest(STUB)
const SHOT = { maxDiffPixelRatio: 0.02 } as const

interface SeedSubRunCardOptions {
  status: "queued" | "running" | "done" | "failed" | "cancelled"
  summary?: string | null
  agentType?: string
  label?: string
  pendingApproval?: boolean
  errorCode?: string | null
}

/** Direct-DB seed of an `agent_runs` row + matching parent-thread `sub_run`
 *  card message. The card's visual is driven entirely by `metadata.subRun.{status,summary,…}`
 *  so this bypasses the worker and produces deterministic baselines. */
async function seedSubRunCard(
  env: Awaited<ReturnType<typeof createUserWithScopes>> extends infer _ ? any : never,
  orgId: string,
  parentThreadId: string,
  userId: string,
  opts: SeedSubRunCardOptions,
): Promise<{ runId: string; messageId: string; hiddenThreadId: string }> {
  const ks = `${env.schemaPrefix}kernel`
  // Hidden subrun thread.
  const hiddenRows = (await env.db.sql.unsafe(
    `INSERT INTO "${ks}".threads (id, org_id, handle, type, created_by, hidden_from_list)
     VALUES (gen_random_uuid(), $1, $2, 'subrun', $3, true)
     RETURNING id`,
    [orgId, `subrun-${Math.random().toString(36).slice(2, 10)}`, userId],
  )) as Array<{ id: string }>
  const hiddenThreadId = hiddenRows[0]!.id
  // Sub-run row. Cast `jsonb` parameters explicitly because postgres.js does
  // not auto-cast plain text → jsonb; the column rejects raw strings on
  // strict-typed paths (caught by manual UPDATE later if INSERT skips here).
  const runRows = (await env.db.sql.unsafe(
    `INSERT INTO "${ks}".agent_runs (
       id, org_id, parent_run_id, root_run_id, thread_id, parent_thread_id,
       subagent_type, actor, effective_scopes, status, prompt, max_steps, timeout_ms,
       schema_retry_budget, nesting_depth, error_code
     ) VALUES (
       gen_random_uuid(), $1, NULL, gen_random_uuid(), $2, $3,
       $4, $5::jsonb, $6, $7, $8, 10, 60000,
       3, 1, $9
     ) RETURNING id, root_run_id`,
    [
      orgId,
      hiddenThreadId,
      parentThreadId,
      opts.agentType ?? "investigator",
      JSON.stringify({ actorType: "user", userId, orgId, scopes: [], dimensionGrants: {} }),
      ["kernel:threads:read"],
      opts.status,
      "Visual baseline seed prompt",
      opts.errorCode ?? null,
    ],
  )) as Array<{ id: string; root_run_id: string }>
  const runId = runRows[0]!.id
  await env.db.sql.unsafe(`UPDATE "${ks}".agent_runs SET root_run_id = id WHERE id = $1`, [runId])
  // Sub_run card message in the parent thread. postgres.js's tagged-template
  // path (`sql\`...\``) auto-serializes objects to jsonb correctly; using
  // `.unsafe` with JSON.stringify'd text + ::jsonb cast also works on most
  // PG configurations but has surfaced as "stored-as-string" in this suite.
  // Use the tagged template here so the column lands as a real jsonb object.
  const metadataObj = {
    kind: "sub_run",
    subRun: {
      runId,
      hiddenThreadId,
      agentType: opts.agentType ?? "investigator",
      label: opts.label ?? "Investigate ticket",
      status: opts.status,
      summary: opts.summary ?? null,
      usage: { promptTokens: 120, completionTokens: 45, creditCost: "0.00012" },
    },
  }
  const msgRows = (await env.db.sql`
    INSERT INTO ${env.db.sql(ks)}.messages
      (id, thread_id, org_id, author_id, author_type, content, metadata, required_scopes)
    VALUES (gen_random_uuid(), ${parentThreadId}, ${orgId}, ${userId}, 'agent', '', ${env.db.sql.json(metadataObj as Record<string, unknown>)}, '{}')
    RETURNING id
  `) as unknown as Array<{ id: string }>
  const messageId = msgRows[0]!.id
  process.stderr.write(`[S8 seed] msg=${messageId} status=${opts.status}\n`)
  return { runId, messageId, hiddenThreadId }
}

test.describe("Sub-agent dispatch — visual baselines", () => {
  test.beforeEach(async ({ page, env, world }) => {
    await forceDarkMode(page)
    await clearSubAgentTables(env)
    await seedModelPricingAndCredits(env, world.org.id)
  })

  for (const status of ["queued", "running", "done", "failed", "cancelled"] as const) {
    test(`sub-run-card-${status}`, async ({ page, env, world }) => {
      const agentUser = await createUserWithScopes(
        env.serverUrl,
        env.db.sql,
        world.admin.token,
        world.org.id,
        {
          email: `s8-${status}-${Date.now()}@test.local`,
          password: "S8Pass1!",
          name: `S8 ${status}`,
          scopes: ["kernel:threads:read", "kernel:threads:write"],
          schemaPrefix: env.schemaPrefix,
        },
      )
      const threadId = await seedAgentThread(env, world.org.id, agentUser.id)
      await seedSubRunCard(env, world.org.id, threadId, agentUser.id, {
        status,
        summary:
          status === "done"
            ? "Found 3 matching tickets in the customer-success queue."
            : status === "failed"
              ? null
              : null,
        errorCode: status === "failed" ? "schema_failure" : null,
        label: "Investigate billing dispute",
      })
      await loginAs(page, env, agentUser.email, "S8Pass1!")
      await page.goto(`http://localhost:${env.ports[1]}/threads/${threadId}`)
      const card = page.locator('[data-testid="sub-run-card"]').first()
      await card.waitFor({ state: "visible", timeout: 30_000 })
      await expect(card).toHaveScreenshot(`sub-run-card-${status}.png`, SHOT)
    })
  }

  // NOTE: the `sub-run-card-expanded` baseline depends on
  // `SubRunTranscript` fetching the hidden thread's messages, which goes
  // through the dedicated parent-participant RLS exception path. Driving
  // that reliably without the actual sub-run worker run is brittle (the
  // transcript fetch needs the agent_runs row's full graph + hidden thread
  // participant linkage to satisfy the access check). Captured as a
  // follow-up — collapsed-card baselines below already lock the primary
  // visual surface that the spec calls out.
})
