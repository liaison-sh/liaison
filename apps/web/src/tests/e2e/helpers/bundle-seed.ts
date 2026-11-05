// SPDX-License-Identifier: FSL-1.1-ALv2
// Compound / sequenced gated-operations E2E helpers. Forms a real 2-step
// approval bundle through the agent's tool gate, then makes the bundle
// ApprovalCard reachable in a thread for the UI scenarios. The thread and the
// agent's tool-call message come from the seed factories (`./seed.ts`).
import { api, type WorkerEnv } from "@liaison/test-helpers"
import { expect, type Locator, type Page } from "@playwright/test"
import { seedFactory } from "./seed"

/**
 * The unwrapped `blocked` envelope. `POST /api/apps/tools/:toolName` returns the
 * standard success envelope `{ data: { blocked: {...} } }`; a raw `fetch` (the
 * `@liaison/test-helpers` `api` helper) therefore reads `.data.blocked`.
 */
export interface BlockedEnvelope {
  reason: string
  approvalRequestId: string
  summary?: { kind: string; title: string; lines: string[] } | unknown
  requesterCanApprove?: boolean
  outputs?: Record<string, string>
  hint?: string
  sequenced?: boolean
}

/**
 * Create a fresh thread owned by `ownerUserId` with that user as a participant.
 * Each scenario provisions its own thread so bundles never bleed across the
 * serially-run scenarios in a worker, and so the gated tool call (which posts
 * messages to the thread as the requester) has a thread the requester is in.
 */
export async function createScenarioThread(
  env: WorkerEnv,
  opts: {
    ownerUserId: string
    orgId: string
    title?: string
    /** Extra users to add as members so the approver (not just the requester)
     *  can navigate to the originating thread under RLS and see the inline
     *  bundle card. The owner is always added; duplicates here are no-ops. */
    additionalParticipantUserIds?: string[]
  },
): Promise<string> {
  const { threadId } = await seedFactory<{ threadId: string }>(
    env,
    opts.orgId,
    "threads.conversation",
    {
      userId: opts.ownerUserId,
      title: opts.title ?? "Compound approval scenario",
      participantUserIds: opts.additionalParticipantUserIds ?? [],
    },
  )
  return threadId
}

/** Call a gated tool AS THE AGENT acting for the token's user, and return its
 *  blocked envelope. Approvals are for agents: a person's own call runs on
 *  their scopes or is refused (403), it never parks an approval, so a pending
 *  approval is staged the way production stages one, from an agent's call
 *  (`/api/_test/agent-tool-call`, origin in-app-agent, the real executeTool
 *  gate). `stepBundleId` is the bundle id the agent stream loop gives every
 *  gated call of one model step (a parallel bundle). Exported so sibling bundle
 *  helpers (parallel-bundle-seed.ts) reuse it. */
export async function callGatedTool(
  env: WorkerEnv,
  token: string,
  toolName: string,
  threadId: string,
  params: Record<string, unknown>,
  stepBundleId?: string,
): Promise<BlockedEnvelope> {
  const res = await api(env.serverUrl, "/api/_test/agent-tool-call", {
    method: "POST",
    token,
    body: { toolName, threadId, params, ...(stepBundleId ? { stepBundleId } : {}) },
  })
  if (res.status !== 200) {
    throw new Error(`${toolName} returned HTTP ${res.status}: ${JSON.stringify(res.body)}`)
  }
  const blocked = res.body?.data?.blocked as BlockedEnvelope | undefined
  if (!blocked || typeof blocked.approvalRequestId !== "string") {
    throw new Error(`${toolName} did not return a blocked envelope: ${JSON.stringify(res.body)}`)
  }
  return blocked
}

/**
 * The agent's message keeping blocked tool calls in its metadata (what mounts
 * the inline ApprovalCard), by the seed engine's `threads.injectMessage`.
 */
export async function postToolCallMessage(
  env: WorkerEnv,
  opts: {
    orgId: string
    threadId: string
    requesterUserId: string
    content: string
    toolCalls: unknown[]
  },
): Promise<void> {
  await seedFactory(env, opts.orgId, "threads.injectMessage", {
    threadId: opts.threadId,
    authorId: opts.requesterUserId,
    authorType: "agent",
    content: opts.content,
    metadata: { toolCalls: opts.toolCalls },
    requiredScopes: [],
  })
}

export interface BundleSeed {
  /** The bundle head (gatedProduce) approval request id. */
  headId: string
  /** The deferred step (gatedConsume) approval request id. */
  stepId: string
  /** The `@ref:<headId>:value` token threaded into the step. */
  valueToken: string
  /** The head's blocked envelope. */
  head: BlockedEnvelope
  /** The step's blocked envelope. */
  step: BlockedEnvelope
}

/**
 * Form a 2-step approval bundle through the agent's tool gate:
 *   1. POST `test:gatedProduce` — captures the head id + `outputs.value` token.
 *   2. POST `test:gatedConsume` passing that token as `note` — links the bundle.
 *   3. Post a browser-visible agent tool-call message into the thread
 *      (`threads.injectMessage`) so the inline bundle ApprovalCard mounts (the
 *      gate posts only kernel *system* messages, which do not render the
 *      card). This mirrors the agent tool-call message `approvals.gated` writes.
 */
export async function formBundle(
  env: WorkerEnv,
  opts: {
    orgId: string
    threadId: string
    token: string
    requesterUserId: string
    seed?: string
    label?: string
  },
): Promise<BundleSeed> {
  const seed = opts.seed ?? "alpha"
  const label = opts.label ?? "original"

  const head = await callGatedTool(env, opts.token, "test:gatedProduce", opts.threadId, { seed })
  const valueToken = head.outputs?.value
  if (!valueToken) {
    throw new Error(`gatedProduce returned no outputs.value: ${JSON.stringify(head)}`)
  }

  const step = await callGatedTool(env, opts.token, "test:gatedConsume", opts.threadId, {
    note: valueToken,
    label,
  })
  if (step.sequenced !== true) {
    throw new Error(`gatedConsume was not flagged sequenced: ${JSON.stringify(step)}`)
  }

  // Browser-visible tool-call message referencing the bundle head. ToolCallRow →
  // ApprovalCard mounts the inline card from this agent message's metadata.
  const toolCalls = [
    {
      toolCallId: `tc-${head.approvalRequestId.slice(0, 8)}`,
      toolName: "test:gatedProduce",
      args: { seed },
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
    content: "Drafting the approval sequence…",
    toolCalls,
  })

  return {
    headId: head.approvalRequestId,
    stepId: step.approvalRequestId,
    valueToken,
    head,
    step,
  }
}

/** Navigate to the bundle head's thread and resolve the inline ApprovalCard.
 *  Waits for the stacked bundle steps to finish loading (the steps are fetched
 *  async via `listBundle`, which can lag the card mount under parallel load). */
export async function openBundleCard(
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
