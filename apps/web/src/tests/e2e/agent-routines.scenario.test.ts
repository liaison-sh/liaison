// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agent App: Routines — end-to-end UI scenarios.
 *
 * Run via Strobe:
 *   debug_test projectRoot=... suite=e2e test="Agent App: Routines"
 *
 * Describe title is metachar-free per the Strobe regex memory rule.
 */
import { api } from "@liaison/test-helpers"
import { loginAsAmina, openOwnAgentTab } from "./agent-bootstrap"
import { scriptRoutineRun } from "./agent-turn"
import { expect, test } from "./fixtures/test"
import {
  alignOwnAgentCeiling,
  restoreScope,
  revokeScope,
  seedModelPricingAndCredits,
} from "./helpers/agent-seed"
import {
  clearAgentAppTables,
  forceRoutineTick,
  getRoutineByName,
  pollUntil,
  restoreAgentAppBaseline,
} from "./helpers/agent-test-fixtures"

test.describe("Agent App: Routines", () => {
  // This file calls clearAgentAppTables, which truncates the worker-shared
  // skills/routines seed. Restore the baseline so later files in the reused
  // Playwright worker (e.g. the skills/routines visual scenarios) still see it.
  test.afterAll(async ({ env }) => {
    await restoreAgentAppBaseline(env)
  })

  test("clicking Routines opens the agent's routines tab, with no Mine or Shared sub-tabs", async ({
    page,
    env,
  }) => {
    await loginAsAmina(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openOwnAgentTab(page, "routines")
    await expect(page.getByTestId("routines-list")).toBeVisible()
    // Routines are a TAB of one agent's page now (P4c-T39). The list is scoped
    // to that agent, so the Mine/Shared split has nothing left to say and is
    // rendered only on the unscoped list (RoutinesList.tsx, `when={!scoped()}`).
    await expect(page.getByTestId("routines-subtab-mine")).toHaveCount(0)
    await expect(page.getByTestId("routines-subtab-shared")).toHaveCount(0)
    await page.screenshot({ path: "test-results/agent-routines-empty.png" })
  })

  test("routine creation — fill the create surface and submit", async ({
    page,
    env,
    world,
    qa,
  }) => {
    // A routine runs at its agent's full ceiling, so authoring one needs every
    // scope in that ceiling (`ceiling_not_covered`). Amina is an ordinary
    // member whose seeded agent carries a wider ceiling than her grants: put
    // the ceiling back where the product provisions it (the recompute every
    // grant change runs), which is also the state later files should see.
    await alignOwnAgentCeiling(env, world.org.id, qa.amina.id)
    await loginAsAmina(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openOwnAgentTab(page, "routines")

    await page.getByTestId("routines-new-routine").click()
    // Creation is a full tab surface, not a modal.
    await page.getByTestId("routine-create").waitFor({ state: "visible" })
    await page.getByTestId("routines-new-name").fill("daily-greeting")
    await page.getByTestId("schedule-preset-daily").click()
    await page.getByTestId("schedule-time").fill("08:00")
    await page.getByTestId("routines-new-prompt").fill("say hi")
    await page.getByTestId("routines-new-save").click()
    // On save the create tab closes and the routine's own detail tab opens.
    await expect(page.getByTestId("routine-detail")).toBeVisible({ timeout: 10_000 })
    // Re-open the list — the new routine is there.
    await openOwnAgentTab(page, "routines")
    await expect(page.getByTestId("routine-row-daily-greeting")).toBeVisible({
      timeout: 10_000,
    })
    await page.screenshot({ path: "test-results/agent-routines-created.png" })
  })

  // ─── S4 — routine creation + forced cron tick → output-thread + history ──
  test("S4 — forced cron tick produces an output-thread turn and run-history row", async ({
    page,
    env,
    world,
    qa,
  }) => {
    test.setTimeout(180_000)
    await seedModelPricingAndCredits(env, world.org.id)
    await clearAgentAppTables(env)
    // Same ceiling alignment as the create test above: amina authors a routine.
    await alignOwnAgentCeiling(env, world.org.id, qa.amina.id)
    await loginAsAmina(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openOwnAgentTab(page, "routines")

    // 1. Create a routine via the create surface (a tab, not a modal).
    await page.getByTestId("routines-new-routine").click()
    await page.getByTestId("routine-create").waitFor({ state: "visible" })
    await page.getByTestId("routines-new-name").fill("forced-tick-test")
    // Recurring is the default kind; weekdays is the default preset.
    await page.getByTestId("schedule-preset-weekdays").click()
    await page.getByTestId("schedule-time").fill("08:00")
    await page
      .getByTestId("routines-new-prompt")
      .fill("Respond with the literal token CRON-TOK-9X9.")
    await page.getByTestId("routines-new-save").click()
    // On save the create tab closes and the routine's own detail tab opens.
    await expect(page.getByTestId("routine-detail")).toBeVisible({ timeout: 10_000 })

    // 2. Look up the routine id via API.
    const routine = await pollUntil(
      () => getRoutineByName(env, qa.amina.token, "forced-tick-test"),
      { timeout: 5_000, label: "forced-tick-test-row" },
    )

    // 3. Script the run's model turn: the lane runs the scripted provider
    //    (agent-turn.ts), so the tick replays this reply instead of calling a
    //    real model. Unscripted, the run would reach a provider with the
    //    lane's placeholder key and fail.
    await scriptRoutineRun(env, {
      routineId: routine.id,
      steps: [{ text: "CRON-TOK-9X9" }],
    })

    // 4. Force-fire one tick via the BullMQ helper.
    await forceRoutineTick(env, world.org.id, routine.id)

    // 5. Wait for the worker to write the run row (succeeded). Poll the API.
    const ks = `${env.schemaPrefix}kernel`
    const succeeded = await pollUntil(
      async () => {
        const row = await getRoutineByName(env, qa.amina.token, "forced-tick-test")
        if (row?.lastRunStatus === "succeeded") return row
        // Diagnostic — log non-success run statuses so we can see what's going on.
        const runRows = (await env.db.sql.unsafe(
          `SELECT status, error FROM "${ks}".routine_runs WHERE routine_id = $1 ORDER BY ran_at DESC LIMIT 1`,
          [routine.id],
        )) as unknown as Array<{ status: string; error: string | null }>
        if (runRows.length > 0) {
          // eslint-disable-next-line no-console
          console.log("[S4 diag] routine_runs latest:", runRows[0])
        }
        return null
      },
      { timeout: 90_000, interval: 1500, label: "forced-tick-test-succeeded" },
    )
    expect(succeeded.outputThreadId).toBeTruthy()

    // 6. UI reflects the succeeded status chip. The WS event is best-effort
    //    (ephemeral broadcast — the user-scoped fan-out can race the test); to
    //    reliably observe the chip, navigate away and back to force the
    //    routines store to re-load via `loadRoutines` on mount.
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openOwnAgentTab(page, "routines")
    // The chip says what a person reads, and a succeeded tick reads "Ran"
    // (kernel.agents.status.succeeded); the enum itself is asserted against
    // the database at the end of this test.
    await expect(page.getByTestId("routine-last-status-forced-tick-test")).toContainText("Ran", {
      timeout: 15_000,
    })

    // 7. Click the routine row → routine detail.
    await page.getByTestId("routine-open-forced-tick-test").click()
    await expect(page.getByTestId("routine-detail")).toBeVisible({ timeout: 10_000 })

    // 8. Run-history row appears with succeeded status.
    await expect(page.getByTestId("run-status-succeeded").first()).toBeVisible({
      timeout: 10_000,
    })

    // 9. The run row opens that run's transcript in the pane (the prompt and
    //    the agent's reply), and the full log stays one click away there.
    await page.locator('[data-testid^="run-history-row-"]').first().click()
    await expect(page.getByTestId("routine-run-transcript")).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid^="routine-run-message-"]').first()).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByTestId("routine-run-full-log")).toBeVisible()

    // 10. DB invariants.
    const runRows = (await env.db.sql.unsafe(
      `SELECT status, duration_ms FROM "${ks}".routine_runs WHERE routine_id = $1`,
      [routine.id],
    )) as unknown as Array<{ status: string; duration_ms: number | string }>
    expect(runRows.length).toBe(1)
    expect(runRows[0]!.status).toBe("succeeded")
    expect(Number(runRows[0]!.duration_ms)).toBeGreaterThan(0)

    const routRows = (await env.db.sql.unsafe(
      `SELECT output_thread_id, last_run_status FROM "${ks}".routines WHERE id = $1`,
      [routine.id],
    )) as unknown as Array<{ output_thread_id: string | null; last_run_status: string }>
    expect(routRows[0]!.output_thread_id).not.toBeNull()
    expect(routRows[0]!.last_run_status).toBe("succeeded")
  })

  // ─── S6 — routine pauses on scope drift; attention surfaced via WS chip ──
  test("S6 — routine pauses on scope drift; paused chip appears", async ({
    page,
    env,
    world,
    qa,
  }) => {
    test.setTimeout(180_000)
    await seedModelPricingAndCredits(env, world.org.id)
    await clearAgentAppTables(env)
    await loginAsAmina(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)

    // 1. Grant Amina an additional scope so the routine has one to declare.
    //    (kernel:tickets:write isn't part of the default QA seed; we use a
    //    scope that Amina already has and then revoke it to trigger drift.)
    //    The simplest path: declare scopes:["kernel:skills:write"] (Amina has
    //    it after the QA seed), then revoke it to force drift.
    const createRes = await api(env.serverUrl, "/api/agent/routines", {
      method: "POST",
      body: {
        name: "scope-drift",
        description: "Test routine for scope drift",
        cron: "0 8 * * 1-5",
        timezone: "America/Toronto",
        prompt: "noop",
        scopes: ["kernel:skills:write"],
      },
      headers: { Authorization: `Bearer ${qa.amina.token}` },
    })
    expect(createRes.status).toBe(201)
    const routineId = (createRes.body as { data: { id: string } }).data.id

    // 2. Revoke kernel:skills:write from Amina in the worker schema.
    //    Playwright workers are reused across test files, so this revoke MUST
    //    be restored in `finally` — otherwise Amina carries the missing scope
    //    into a later file (e.g. agent-skills S1) and its POST /api/agent/skills
    //    fails with 403. The try/finally guarantees restoration even on a
    //    mid-test assertion failure.
    const ks = `${env.schemaPrefix}kernel`
    const revoked = await revokeScope(env, world.org.id, qa.amina.id, "kernel:skills:write")
    try {
      // 3. Force-fire one tick.
      await forceRoutineTick(env, world.org.id, routineId)

      // 4. Wait for the worker to write the skipped_scope_mismatch row.
      await pollUntil(
        async () => {
          const rows = (await env.db.sql.unsafe(
            `SELECT status FROM "${ks}".routine_runs WHERE routine_id = $1`,
            [routineId],
          )) as unknown as Array<{ status: string }>
          return rows.length > 0 && rows[0]!.status === "skipped_scope_mismatch" ? rows : null
        },
        { timeout: 60_000, interval: 1000, label: "scope-drift-skipped-row" },
      )

      // 5. UI: navigate to Routines and observe the paused chip on the row.
      await openOwnAgentTab(page, "routines")
      // Load-tolerant: the routines list does an on-demand fetch after its
      // lazy chunk mounts — under 2-worker contention that can exceed 10s.
      await expect(page.getByTestId("routine-row-scope-drift")).toBeVisible({
        timeout: 30_000,
      })
      await expect(page.getByTestId("routine-paused-scope-drift")).toBeVisible({
        timeout: 30_000,
      })

      // 6. DB: routines.status = 'paused_scope_mismatch'.
      const routRow = (await env.db.sql.unsafe(
        `SELECT status FROM "${ks}".routines WHERE id = $1`,
        [routineId],
      )) as unknown as Array<{ status: string }>
      expect(routRow[0]!.status).toBe("paused_scope_mismatch")
    } finally {
      // Restore the scope so the shared worker is clean for subsequent files.
      await restoreScope(env, world.org.id, revoked)
    }
  })
})
