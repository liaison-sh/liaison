// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S3 — Live WS status transitions update the sub-run card in-place.
//
// What this proves: when a sub-run lands `running` then `done` via the BullMQ
// worker, the parent thread's `SubRunCard` re-renders inline (no page reload,
// no manual refresh). The WS pipeline broadcasts `entity=sub_run` ephemeral
// updates per `subrun-worker.ts:515` and the threads store patches the message
// metadata in place — driving `data-status` on the card from `running` → `done`.
//
// The stub deliberately pauses ~700ms between the sub-run loop starting and
// emitting `finalize`, so the UI has a stable window to observe `running`
// before the row transitions to `done`. The status badge text matches
// `STATUS_LABEL` in `SubRunCard.tsx:34`.

import path from "node:path"
import { createUserWithScopes } from "@liaison/test-helpers"
import { expect } from "@playwright/test"
import { createSubAgentTest } from "./fixtures/sub-agent-test"
import { loginAs } from "./fixtures/test"
import {
  seedAgentThread,
  seedModelPricingAndCredits,
  seedSubAgentDefinition,
} from "./helpers/agent-seed"
import { clearSubAgentTables } from "./helpers/agent-test-fixtures"

// Stub bundle lives in the API package and is loaded by the spawned API process.
// Resolve to an absolute path so the env var is process-independent.
const STUB = path.resolve(__dirname, "../../../../api/src/tests/e2e/helpers/sub-agent-s3-stub.ts")

const test = createSubAgentTest(STUB)

test.describe("Sub-agent dispatch — S3 live status", () => {
  test.beforeEach(async ({ env, world }) => {
    await clearSubAgentTables(env)
    await seedModelPricingAndCredits(env, world.org.id)
    // A kernel-owned role (its ceiling capped by the org admin's scopes): no
    // installed app declares these kernel scopes.
    await seedSubAgentDefinition(env, world.org.id, {
      agentType: "s3-investigator",
      whenToUse: "S3 live-status investigator",
      scopeCeiling: ["kernel:threads:read", "kernel:agents:spawn"],
      systemPrompt: "SUB_AGENT_E2E_SMOKE_ROLE\n\nS3 live-status role.",
      defaultMaxSteps: 5,
      defaultTimeoutMs: 30_000,
      defaultSchemaRetryBudget: 3,
    })
  })

  test("status badge transitions from running to done in-place", async ({ page, env, world }) => {
    // Mint a dedicated agent user with kernel:agents:spawn — Elodie doesn't
    // carry it by default in the QA seed. Same pattern as the API E2E.
    const agentUser = await createUserWithScopes(
      env.serverUrl,
      env.db.sql,
      world.admin.token,
      world.org.id,
      {
        email: `s3-agent-${Date.now()}@test.local`,
        password: "S3Pass1!",
        name: "S3 Agent",
        scopes: ["kernel:threads:read", "kernel:threads:write", "kernel:agents:spawn"],
        schemaPrefix: env.schemaPrefix,
      },
    )
    const threadId = await seedAgentThread(env, world.org.id, agentUser.id)

    // Login as the agent user and open the thread directly.
    await loginAs(page, env, agentUser.email, "S3Pass1!")
    await page.goto(`http://localhost:${env.ports[1]}/threads/${threadId}`)
    // Wait for the shell + a connected WS before firing the chat — otherwise
    // sub_run:update WS events may fire before the client subscribes.
    await page.waitForSelector("[data-shell]", { timeout: 30_000 })
    await page
      .waitForFunction(
        () => {
          return (
            (window as unknown as { __wsConnected?: boolean }).__wsConnected === true ||
            document.querySelector("[data-ws-connected='true']") !== null
          )
        },
        { timeout: 15_000 },
      )
      .catch(() => {
        // No global hook — fall back to a brief settle wait so the WS handshake completes.
        return page.waitForTimeout(1500)
      })

    // Drive the chat from the server side (SSE consumption — the stream API
    // is the same shape the UI uses, but firing it from the test avoids the
    // compose-bar interaction surface). The point of S3 is the post-spawn UI
    // observation, not the input path.
    // Auto mode (modelId omitted) resolves to the cheapest auto-eligible
    // model — never hardcode Anthropic for tests; the stub doesn't care.
    const sseRes = await fetch(`${env.serverUrl}/api/agent/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentUser.token}`,
      },
      body: JSON.stringify({
        threadId,
        content: "Dispatch sub-agent for S3",
      }),
    })
    const sseBody = await sseRes.text()
    if (sseRes.status !== 200) {
      throw new Error(`SSE failed status=${sseRes.status} body=${sseBody.slice(0, 500)}`)
    }

    // Wait for the sub-run card to appear in the UI (the WS event for the
    // sub_run message arrives independent of the SSE stream completion).
    const card = page.locator('[data-testid="sub-run-card"]').first()
    await card.waitFor({ state: "visible", timeout: 30_000 })

    // First observable state — either still queued or already running.
    const initialStatus = await card.getAttribute("data-status")
    expect(initialStatus).not.toBe("done")

    // Wait through `running` → `done`. The stub holds the sub-run for ~700ms.
    await expect(card).toHaveAttribute("data-status", "running", { timeout: 10_000 })
    await expect(card).toHaveAttribute("data-status", "done", { timeout: 15_000 })

    // Badge text matches the STATUS_LABEL map.
    await expect(card.getByTestId("sub-run-status-badge")).toContainText("Done")

    // DB confirmation — the row reached `done`.
    const ks = `${env.schemaPrefix}kernel`
    const rows = (await env.db.sql.unsafe(
      `SELECT status FROM "${ks}".agent_runs WHERE org_id = $1 AND subagent_type = 's3-investigator'`,
      [world.org.id],
    )) as unknown as Array<{ status: string }>
    expect(rows[0]?.status).toBe("done")
  })
})
