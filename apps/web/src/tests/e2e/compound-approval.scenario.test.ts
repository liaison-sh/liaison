// SPDX-License-Identifier: FSL-1.1-ALv2
// Compound / sequenced gated operations — E2E journeys through the real running
// application: real API server, real Postgres + RLS, real Redis/BullMQ, real
// browser. Exercises the ref-token → bundle-linkage → deterministic-cascade
// mechanism through its production entry points (the HTTP tool endpoint and the
// inline bundle ApprovalCard).
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { createScenarioThread, formBundle, openBundleCard } from "./helpers/bundle-seed"

const QA_PASSWORD = "QaPass1!"

function ks(schemaPrefix: string): string {
  return schemaPrefix ? `"${schemaPrefix}kernel"` : "kernel"
}

// ── Smoke test (build this first) ────────────────────────────────────────────
// Proves the new outputs/hint envelope flows end-to-end through the real HTTP
// path and that the test app's sequencing tool is live — before any
// bundle/cascade logic is exercised.
test("smoke — gatedProduce blocks with a well-formed @ref outputs map and a hint", async ({
  env,
  world,
  qa,
}) => {
  const amina = qa.amina
  const threadId = await createScenarioThread(env, {
    ownerUserId: amina.id,
    orgId: world.org.id,
    title: "Compound approval smoke",
  })

  // The agent's call (approvals are for agents; Amina's own call would run on
  // her scopes or be refused, never park).
  const res = await api(env.serverUrl, "/api/_test/agent-tool-call", {
    method: "POST",
    token: amina.token,
    body: { toolName: "test:gatedProduce", threadId, params: { seed: "smoke" } },
  })
  expect(res.status).toBe(200)
  const blocked = res.body?.data?.blocked as {
    approvalRequestId?: string
    outputs?: Record<string, string>
    hint?: string
  }
  expect(typeof blocked?.approvalRequestId).toBe("string")
  expect(blocked.outputs?.value).toBe(`@ref:${blocked.approvalRequestId}:value`)
  expect(typeof blocked.hint).toBe("string")
  expect((blocked.hint ?? "").length).toBeGreaterThan(0)
})

// ── S1 — headline journey ────────────────────────────────────────────────────
test("S1 — caller forms a 2-step bundle; human approves once and both steps execute", async ({
  page,
  env,
  world,
  qa,
}) => {
  // Amina (no `test:approve` per QA seed) forms the bundle as the agent;
  // Tobias holds `test:approve` and is auto-added to notify_user_ids by
  // eligibleApprovers, so the attention feed + bundle card render for him.
  const amina = qa.amina
  const tobias = qa.tobias
  const threadId = await createScenarioThread(env, {
    ownerUserId: amina.id,
    orgId: world.org.id,
    title: "Compound approval S1",
    additionalParticipantUserIds: [tobias.id],
  })

  const bundle = await formBundle(env, {
    orgId: world.org.id,
    threadId,
    token: amina.token,
    requesterUserId: amina.id,
    seed: "alpha",
    label: "original",
  })

  // The head's blocked envelope carries a copy-ready @ref token + a self-teaching hint.
  expect(bundle.head.outputs?.value).toBe(`@ref:${bundle.headId}:value`)
  expect(typeof bundle.head.hint).toBe("string")
  expect((bundle.head.hint ?? "").length).toBeGreaterThan(0)
  expect(bundle.step.sequenced).toBe(true)

  // GET /approvals?bundleId= returns the ordered steps through the real route.
  const listRes = await api(env.serverUrl, `/api/approvals?bundleId=${bundle.headId}`, {
    token: amina.token,
  })
  expect(listRes.status).toBe(200)
  const rows = listRes.body.data as Array<{
    id: string
    status: string
    bundlePosition: number
    bundleId: string | null
  }>
  expect(rows.map((r) => r.id)).toEqual([bundle.headId, bundle.stepId])
  expect(rows[0].bundlePosition).toBe(0)
  expect(rows[0].status).toBe("pending")
  expect(rows[1].bundlePosition).toBe(1)
  expect(rows[1].status).toBe("deferred")

  // DB linkage: head promoted to its own bundle, step depends on the head.
  const linkRows = (await env.db.sql.unsafe(
    `SELECT id, bundle_id, depends_on_id FROM ${ks(env.schemaPrefix)}.approval_requests
     WHERE id = ANY($1::uuid[]) ORDER BY bundle_position`,
    [[bundle.headId, bundle.stepId]],
  )) as Array<{ id: string; bundle_id: string | null; depends_on_id: string | null }>
  expect(linkRows[0].bundle_id).toBe(bundle.headId)
  expect(linkRows[1].bundle_id).toBe(bundle.headId)
  expect(linkRows[1].depends_on_id).toBe(bundle.headId)

  await loginAs(page, env, tobias.email, QA_PASSWORD)

  // Attention feed (spec T8): the bundle shows as exactly ONE needs-decision
  // item — the head. The deferred step is never its own feed item.
  await page.getByTestId("activity-home").click()
  await expect(page.getByTestId("home-feed")).toBeVisible({ timeout: 15000 })
  await expect(
    page.getByTestId(`attention-row-kernel-approval_request-${bundle.headId}`),
  ).toBeVisible({ timeout: 15000 })
  await expect(
    page.getByTestId(`attention-row-kernel-approval_request-${bundle.stepId}`),
  ).toHaveCount(0)

  // Open the inline bundle card in the thread.
  const card = await openBundleCard(page, env, threadId, bundle.headId)
  await expect(card.getByTestId("approval-bundle-steps")).toBeVisible()
  await expect(card.getByTestId("approval-bundle-step-1")).toContainText("Consume produced value")
  await expect(card.getByTestId("approval-card-action-approve")).toContainText("Approve sequence")

  await card.getByTestId("approval-card-action-approve").click()
  await expect(card.getByTestId("approval-card-status-badge")).toContainText("Approved", {
    timeout: 20000,
  })

  // Both steps reach `approved`; the @ref token resolved to the head's real output.
  await expect
    .poll(
      async () => {
        const r = (await env.db.sql.unsafe(
          `SELECT status FROM ${ks(env.schemaPrefix)}.approval_requests WHERE id = $1`,
          [bundle.stepId],
        )) as Array<{ status: string }>
        return r[0]?.status
      },
      { timeout: 15000 },
    )
    .toBe("approved")

  const headRow = (await env.db.sql.unsafe(
    `SELECT status FROM ${ks(env.schemaPrefix)}.approval_requests WHERE id = $1`,
    [bundle.headId],
  )) as Array<{ status: string }>
  expect(headRow[0].status).toBe("approved")

  const stepRow = (await env.db.sql.unsafe(
    `SELECT current_payload FROM ${ks(env.schemaPrefix)}.approval_requests WHERE id = $1`,
    [bundle.stepId],
  )) as Array<{ current_payload: { note?: string } }>
  expect(stepRow[0].current_payload.note).toBe("produced-alpha")

  const execRows = (await env.db.sql.unsafe(
    `SELECT result FROM ${ks(env.schemaPrefix)}.approved_handler_executions
     WHERE approval_request_id = $1 AND status = 'succeeded'`,
    [bundle.stepId],
  )) as Array<{ result: { consumed?: string } }>
  expect(execRows.length).toBe(1)
  expect(execRows[0].result.consumed).toBe("produced-alpha")
})

// ── S2 — human edits a deferred step before approving ────────────────────────
test("S2 — a human edits a deferred step's drafted field before approving the sequence", async ({
  page,
  env,
  world,
  qa,
}) => {
  // Same agent-vs-approver split as S1 — Amina forms, Tobias approves.
  const amina = qa.amina
  const tobias = qa.tobias
  const threadId = await createScenarioThread(env, {
    ownerUserId: amina.id,
    orgId: world.org.id,
    title: "Compound approval S2",
    additionalParticipantUserIds: [tobias.id],
  })

  const bundle = await formBundle(env, {
    orgId: world.org.id,
    threadId,
    token: amina.token,
    requesterUserId: amina.id,
    seed: "alpha",
    label: "original",
  })

  await loginAs(page, env, tobias.email, QA_PASSWORD)
  const card = await openBundleCard(page, env, threadId, bundle.headId)
  const step = card.getByTestId("approval-bundle-step-1")
  await expect(step).toBeVisible()

  await step.getByTestId("approval-bundle-step-1-edit").click()

  // L4 — the token-bearing `note` field exposes no editor; only `label` is editable.
  await expect(step.getByTestId("approval-bundle-step-1-field-note")).toHaveCount(0)
  const labelInput = step.getByTestId("approval-bundle-step-1-field-label")
  await expect(labelInput).toBeVisible()
  await labelInput.fill("edited-by-human")
  await step.getByTestId("approval-bundle-step-1-save").click()

  await card.getByTestId("approval-card-action-approve").click()
  await expect(card.getByTestId("approval-card-status-badge")).toContainText("Approved", {
    timeout: 20000,
  })

  // The edit persisted on the deferred step's own payload and carried through
  // the cascade. The head badge flipping to "Approved" reflects the *head's*
  // decision; the deferred step transitions to "approved" asynchronously as the
  // cascade runs (same outbox/event path the handler-execution poll below waits
  // on). Reading the step row once here races that finalization and observes the
  // transient "approving" state — poll until the cascade settles instead.
  await expect
    .poll(
      async () => {
        const rows = (await env.db.sql.unsafe(
          `SELECT status, current_payload FROM ${ks(env.schemaPrefix)}.approval_requests WHERE id = $1`,
          [bundle.stepId],
        )) as Array<{ status: string; current_payload: { label?: string } }>
        const row = rows[0]
        return row ? { status: row.status, label: row.current_payload?.label } : null
      },
      { timeout: 15000 },
    )
    .toEqual({ status: "approved", label: "edited-by-human" })

  await expect
    .poll(
      async () => {
        const r = (await env.db.sql.unsafe(
          `SELECT result FROM ${ks(env.schemaPrefix)}.approved_handler_executions
           WHERE approval_request_id = $1 AND status = 'succeeded'`,
          [bundle.stepId],
        )) as Array<{ result: { label?: string } }>
        return r[0]?.result?.label
      },
      { timeout: 15000 },
    )
    .toBe("edited-by-human")
})

// ── S3 — denying the head cancels the deferred remainder ─────────────────────
test("S3 — denying the bundle head cancels the deferred remainder", async ({
  page,
  env,
  world,
  qa,
}) => {
  const amina = qa.amina
  const threadId = await createScenarioThread(env, {
    ownerUserId: amina.id,
    orgId: world.org.id,
    title: "Compound approval S3",
  })

  const bundle = await formBundle(env, {
    orgId: world.org.id,
    threadId,
    token: amina.token,
    requesterUserId: amina.id,
  })

  await loginAs(page, env, amina.email, QA_PASSWORD)
  const card = await openBundleCard(page, env, threadId, bundle.headId)

  await card.getByTestId("approval-card-action-deny").click()
  const reasonInput = card.getByTestId("approval-card-deny-reason")
  await expect(reasonInput).toBeVisible()
  await reasonInput.fill("Not needed after all")
  await card.getByTestId("approval-card-action-deny-submit").click()

  await expect(card.getByTestId("approval-card-status-badge")).toContainText("Denied", {
    timeout: 20000,
  })

  // Head denied; the deferred step is cancelled — never executed.
  const headRow = (await env.db.sql.unsafe(
    `SELECT status FROM ${ks(env.schemaPrefix)}.approval_requests WHERE id = $1`,
    [bundle.headId],
  )) as Array<{ status: string }>
  expect(headRow[0].status).toBe("denied")

  await expect
    .poll(
      async () => {
        const r = (await env.db.sql.unsafe(
          `SELECT status FROM ${ks(env.schemaPrefix)}.approval_requests WHERE id = $1`,
          [bundle.stepId],
        )) as Array<{ status: string }>
        return r[0]?.status
      },
      { timeout: 15000 },
    )
    .toBe("cancelled")

  const execRows = (await env.db.sql.unsafe(
    `SELECT id FROM ${ks(env.schemaPrefix)}.approved_handler_executions
     WHERE approval_request_id = $1`,
    [bundle.stepId],
  )) as Array<{ id: string }>
  expect(execRows.length).toBe(0)
})
