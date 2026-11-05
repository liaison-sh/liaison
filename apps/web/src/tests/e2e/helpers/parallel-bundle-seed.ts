// SPDX-License-Identifier: FSL-1.1-ALv2
// Parallel approval bundle E2E helper. Forms a real 2-member bundle of
// *independent* gated approvals (no @ref linkage) by:
//   1. Making two distinct gated calls through the agent's tool gate with one
//      step bundle id, as the agent runtime does when PARALLEL_APPROVAL_BUNDLING
//      is on and the model emits two parallel tool calls in one step: the gate
//      parks both in that bundle at positions 0 and 1, depends_on_id NULL.
//   2. Posting a browser-visible agent tool-call message in the thread so the
//      inline bundle ApprovalCard mounts (mirrors `formBundle`).
import { randomUUID } from "node:crypto"
import type { WorkerEnv } from "@liaison/test-helpers"
import { expect, type Locator, type Page } from "@playwright/test"
import { type BlockedEnvelope, callGatedTool, postToolCallMessage } from "./bundle-seed"

export interface ParallelBundleSeed {
  /** Bundle UUID shared by both members (fresh UUID, not any approval id). */
  bundleId: string
  /** Position-0 approval (renders as the card head). */
  headId: string
  /** Position-1 approval (renders as a BundleStepRow). */
  siblingId: string
  /** Both blocked envelopes from the underlying HTTP calls. */
  head: BlockedEnvelope
  sibling: BlockedEnvelope
}

/**
 * Form a 2-member parallel approval bundle for the given thread / requester.
 * Both members end up with bundle_id = `bundleId`, depends_on_id = NULL, positions 0/1.
 */
export async function formParallelBundle(
  env: WorkerEnv,
  opts: {
    orgId: string
    threadId: string
    token: string
    requesterUserId: string
  },
): Promise<ParallelBundleSeed> {
  // Two independent gated tools — no @ref between them. We use `test:gatedEcho`
  // twice with distinct messages: it lives under `test:gated:write` (a scope
  // Amina/Lucas retain per the QA seed) and has no referenceableOutputs, so the
  // two calls produce two genuinely independent approvals. Different message
  // payloads → distinct idempotency keys → no dedup.
  // The step's bundle id, as the agent stream loop allocates one per model step.
  const bundleId = randomUUID()
  const head = await callGatedTool(
    env,
    opts.token,
    "test:gatedEcho",
    opts.threadId,
    { message: "Re-enable license LIC-9871" },
    bundleId,
  )
  const sibling = await callGatedTool(
    env,
    opts.token,
    "test:gatedEcho",
    opts.threadId,
    { message: "Reply to ticket #5512" },
    bundleId,
  )

  // Browser-visible agent tool-call message. Only the bundle head's toolCall is
  // referenced — the sibling renders inside the head's ApprovalCard via
  // `bundleSteps()`, just like compound-approval's sequenced bundle. Embedding
  // both toolCalls here would put them through `groupToolCalls` (consecutive
  // same-toolName → StackedToolCallGroup, collapsed by default), hiding the
  // ApprovalCards behind an additional click — and rendering them as separate
  // cards rather than one bundle view. We want the bundle layout, so we mirror
  // the sequenced-bundle wiring: one toolCall in the message metadata.
  const toolCalls = [
    {
      toolCallId: `tc-${head.approvalRequestId.slice(0, 8)}`,
      toolName: "test:gatedEcho",
      args: { message: "Re-enable license LIC-9871" },
      result: {
        blocked: {
          reason: "approval_required",
          approvalRequestId: head.approvalRequestId,
          summary: head.summary,
        },
      },
      status: "completed" as const,
    },
  ]
  await postToolCallMessage(env, {
    orgId: opts.orgId,
    threadId: opts.threadId,
    requesterUserId: opts.requesterUserId,
    content: "Drafting two parallel approvals…",
    toolCalls,
  })

  return {
    bundleId,
    headId: head.approvalRequestId,
    siblingId: sibling.approvalRequestId,
    head,
    sibling,
  }
}

/**
 * Navigate to the thread and resolve the inline ApprovalCard for the bundle head.
 * Waits for `approval-bundle-steps` to be visible (the sibling step row).
 */
export async function openParallelBundleCard(
  page: Page,
  env: WorkerEnv,
  threadId: string,
  headId: string,
): Promise<Locator> {
  await page.goto(`http://localhost:${env.ports[1]}/threads/${threadId}`)
  const tab = page.locator('[data-testid="tab-content-area"] > [data-tab-active="true"]')
  await tab.getByTestId("message-row-tools-toggle").first().click()
  const card = tab.locator(`[data-testid="approval-card"][data-request-id="${headId}"]`)
  await expect(card).toBeVisible({ timeout: 15000 })
  await expect(card.getByTestId("approval-bundle-steps")).toBeVisible({ timeout: 15000 })
  return card
}
