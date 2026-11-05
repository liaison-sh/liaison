// SPDX-License-Identifier: FSL-1.1-ALv2
// Parallel approval bundling — E2E. Exercises a 2-member bundle of *independent*
// gated approvals (no @ref linkage between them) through the real API server,
// real Postgres + RLS, and the real browser. Validates that the FE
// `ApprovalCard` + `approvals-store` correctly render and index a bundle whose
// `bundle_id` is a fresh UUID distinct from any member's id, and whose members
// have `depends_on_id = NULL` (parallel roots).
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { createScenarioThread } from "./helpers/bundle-seed"
import { formParallelBundle, openParallelBundleCard } from "./helpers/parallel-bundle-seed"

const QA_PASSWORD = "QaPass1!"

function ks(schemaPrefix: string): string {
  return schemaPrefix ? `"${schemaPrefix}kernel"` : "kernel"
}

// ── S1 — DB shape: shared bundle_id, ordered positions, NULL deps ────────────
test("S1 — two independent gated calls form a parallel bundle (DB invariants)", async ({
  env,
  world,
  qa,
}) => {
  const amina = qa.amina
  const threadId = await createScenarioThread(env, {
    ownerUserId: amina.id,
    orgId: world.org.id,
    title: "Parallel approval bundle S1",
  })

  const bundle = await formParallelBundle(env, {
    orgId: world.org.id,
    threadId,
    token: amina.token,
    requesterUserId: amina.id,
  })

  expect(bundle.bundleId).not.toBe(bundle.headId)
  expect(bundle.bundleId).not.toBe(bundle.siblingId)
  expect(bundle.headId).not.toBe(bundle.siblingId)

  const rows = (await env.db.sql.unsafe(
    `SELECT id, bundle_id, bundle_position, depends_on_id, status
     FROM ${ks(env.schemaPrefix)}.approval_requests
     WHERE bundle_id = $1 ORDER BY bundle_position`,
    [bundle.bundleId],
  )) as Array<{
    id: string
    bundle_id: string
    bundle_position: number
    depends_on_id: string | null
    status: string
  }>

  expect(rows).toHaveLength(2)
  expect(rows[0].bundle_id).toBe(bundle.bundleId)
  expect(rows[1].bundle_id).toBe(bundle.bundleId)
  expect(rows[0].bundle_position).toBe(0)
  expect(rows[1].bundle_position).toBe(1)
  expect(rows[0].depends_on_id).toBeNull()
  expect(rows[1].depends_on_id).toBeNull()
  expect(rows[0].id).toBe(bundle.headId)
  expect(rows[1].id).toBe(bundle.siblingId)
  expect(rows[0].status).toBe("pending")
  expect(rows[1].status).toBe("pending")
})

// ── S2 — API listing returns both members in position order ──────────────────
test("S2 — GET /api/approvals?bundleId returns parallel members ordered", async ({
  env,
  world,
  qa,
}) => {
  const amina = qa.amina
  const threadId = await createScenarioThread(env, {
    ownerUserId: amina.id,
    orgId: world.org.id,
    title: "Parallel approval bundle S2",
  })

  const bundle = await formParallelBundle(env, {
    orgId: world.org.id,
    threadId,
    token: amina.token,
    requesterUserId: amina.id,
  })

  const listRes = await api(env.serverUrl, `/api/approvals?bundleId=${bundle.bundleId}`, {
    token: amina.token,
  })
  expect(listRes.status).toBe(200)
  const data = listRes.body.data as Array<{
    id: string
    bundleId: string | null
    bundlePosition: number
    dependsOnId: string | null
    status: string
  }>
  expect(data.map((r) => r.id)).toEqual([bundle.headId, bundle.siblingId])
  expect(data[0].bundlePosition).toBe(0)
  expect(data[1].bundlePosition).toBe(1)
  expect(data[0].dependsOnId).toBeNull()
  expect(data[1].dependsOnId).toBeNull()
  expect(data[0].bundleId).toBe(bundle.bundleId)
  expect(data[1].bundleId).toBe(bundle.bundleId)
})

// ── S3 — UI renders bundle with no depends-on chip on parallel members ───────
// Amina (no test:approve) forms the bundle; Tobias (has test:approve) is added
// as a participant so the inline ApprovalCard is reachable under RLS on the
// originating thread — mirrors the amina-forms/tobias-approves pattern from
// compound-approval.scenario.test.ts.
test("S3 — card shows head + sibling row, no depends-on chip on parallel roots", async ({
  page,
  env,
  world,
  qa,
}) => {
  const amina = qa.amina
  const tobias = qa.tobias
  const threadId = await createScenarioThread(env, {
    ownerUserId: amina.id,
    orgId: world.org.id,
    title: "Parallel approval bundle S3",
    additionalParticipantUserIds: [tobias.id],
  })

  const bundle = await formParallelBundle(env, {
    orgId: world.org.id,
    threadId,
    token: amina.token,
    requesterUserId: amina.id,
  })

  await loginAs(page, env, tobias.email, QA_PASSWORD)
  const card = await openParallelBundleCard(page, env, threadId, bundle.headId)

  // The head approval's title (gatedEcho) renders as the card title.
  await expect(card.getByTestId("approval-card-title")).toContainText("Re-enable license LIC-9871")

  // The sibling renders as approval-bundle-step-1.
  await expect(card.getByTestId("approval-bundle-step-1")).toBeVisible()
  await expect(card.getByTestId("approval-bundle-step-1")).toContainText("Reply to ticket #5512")

  // Parallel roots: NO depends-on chip on the sibling row (depends_on_id is NULL).
  await expect(card.getByTestId("approval-bundle-step-1-depends-on")).toHaveCount(0)

  // Visual snapshot — captures the rendered parallel bundle for regression.
  await expect(card).toHaveScreenshot("parallel-approval-bundle-card.png", {
    maxDiffPixelRatio: 0.02,
    // The floating Chats dock overlays the main panel and carries a live unread
    // count, so a card this wide masks it rather than baking that count in.
    mask: [page.locator("[data-chat-dock]")],
  })
})

// ── S4 — approving the head leaves the parallel sibling pending ──────────────
// Parallel members have depends_on_id = NULL, so the cascade engine has no edge
// to walk — approving position 0 must not change position 1's status.
test("S4 — approving the head does not cascade to a parallel sibling", async ({
  page,
  env,
  world,
  qa,
}) => {
  const amina = qa.amina
  const tobias = qa.tobias
  const threadId = await createScenarioThread(env, {
    ownerUserId: amina.id,
    orgId: world.org.id,
    title: "Parallel approval bundle S4",
    additionalParticipantUserIds: [tobias.id],
  })

  const bundle = await formParallelBundle(env, {
    orgId: world.org.id,
    threadId,
    token: amina.token,
    requesterUserId: amina.id,
  })

  await loginAs(page, env, tobias.email, QA_PASSWORD)
  const card = await openParallelBundleCard(page, env, threadId, bundle.headId)

  // Anchor: confirm the seed state before deciding — sibling must start with
  // depends_on_id = NULL and status = pending. This pins down which cascade
  // gate is being tested. A mutation that broke depends_on_id filtering but
  // left status filtering intact would slip past without this anchor.
  const seedRows = (await env.db.sql.unsafe(
    `SELECT id, status, depends_on_id FROM ${ks(env.schemaPrefix)}.approval_requests
     WHERE id = ANY($1::uuid[]) ORDER BY bundle_position`,
    [[bundle.headId, bundle.siblingId]],
  )) as Array<{ id: string; status: string; depends_on_id: string | null }>
  expect(seedRows[1].status).toBe("pending")
  expect(seedRows[1].depends_on_id).toBeNull()

  // Bundle Approve button approves the head only — parallel siblings have no
  // depends_on_id edge, so the cascade engine never visits them.
  await card.getByTestId("approval-card-action-approve").click()
  await expect(card.getByTestId("approval-card-status-badge")).toContainText("Approved", {
    timeout: 20000,
  })

  await expect
    .poll(
      async () => {
        const r = (await env.db.sql.unsafe(
          `SELECT status FROM ${ks(env.schemaPrefix)}.approval_requests WHERE id = $1`,
          [bundle.headId],
        )) as Array<{ status: string }>
        return r[0]?.status
      },
      { timeout: 15000 },
    )
    .toBe("approved")

  // Sibling still pending — no `depends_on_id` edge connects them.
  const siblingRow = (await env.db.sql.unsafe(
    `SELECT status FROM ${ks(env.schemaPrefix)}.approval_requests WHERE id = $1`,
    [bundle.siblingId],
  )) as Array<{ status: string }>
  expect(siblingRow[0].status).toBe("pending")

  // The per-row Approve button is what makes the parallel bundle actionable —
  // without it the sibling would have no UI path to approval. Clicking it
  // approves the sibling directly (no cascade involved).
  await card.getByTestId("approval-bundle-step-1-approve").click()
  await expect
    .poll(
      async () => {
        const r = (await env.db.sql.unsafe(
          `SELECT status FROM ${ks(env.schemaPrefix)}.approval_requests WHERE id = $1`,
          [bundle.siblingId],
        )) as Array<{ status: string }>
        return r[0]?.status
      },
      { timeout: 15000 },
    )
    .toBe("approved")
})
