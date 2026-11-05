// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pending approvals for browser tests, staged through the kernel's own gate
// (`approvals.gated`, apps/api/test-support/seed/gated-approval.ts): the
// requester's agent makes the gated call, the gate parks it, picks whom it
// notifies, writes its summary and announces it live. Never a hand-written
// approval row or outbox event.

import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { seedFactory } from "./seed"

export interface ApprovalActor {
  id: string
  email: string
  password: string
  name: string
  token: string
}

const APPROVAL_ACTOR_PASSWORD = "Pass1234!"

/** A per-test person with exactly the scopes the scenario needs (no broad QA grants). */
export async function createApprovalActor(
  world: TestWorld,
  opts: { name?: string; scopes: string[] },
): Promise<ApprovalActor> {
  const [user] = await world.addUsers([
    {
      name: opts.name ?? `Actor-${Math.random().toString(36).slice(2, 8)}`,
      scopes: [
        "kernel:threads:read",
        "kernel:threads:write",
        "kernel:users:read",
        // The live approval events reach a reader who holds these.
        "kernel:approvals:read",
        "kernel:approvals:write",
        ...opts.scopes,
      ],
    },
  ])
  return {
    id: user.id,
    email: user.email,
    password: APPROVAL_ACTOR_PASSWORD,
    name: user.name,
    token: user.token,
  }
}

export interface GatedApprovalSeed {
  approvalRequestId: string
  handle: string
  /** The conversation the call was made in, where the card shows. */
  threadId: string
}

/**
 * A pending approval of `toolName` (default `test:gatedEcho`) requested by
 * `requesterUserId`'s agent in a new conversation titled `title` (or in
 * `threadId`). `approverUserIds` get the deciding scope first; `lines` are the
 * test app's echo summary lines; `toolCallMessage: false` leaves the blocked
 * call out of the agent's message (no inline card); `mention` has the
 * requester name the approval in a message.
 */
export function seedGatedApproval(
  env: WorkerEnv,
  orgId: string,
  opts: {
    requesterUserId: string
    title?: string
    threadId?: string
    participantUserIds?: string[]
    approverUserIds?: string[]
    approveScope?: string
    toolName?: string
    params?: Record<string, unknown>
    lines?: string[]
    toolCallMessage?: boolean
    mention?: boolean
  },
): Promise<GatedApprovalSeed> {
  const { lines, params, ...rest } = opts
  const toolParams = params ?? {
    message: "Please approve this response.",
    ...(lines ? { lines } : {}),
  }
  return seedFactory(env, orgId, "approvals.gated", { ...rest, params: toolParams })
}

/** The kernel's expiry job, run on a pending approval now. */
export async function expireApproval(
  env: WorkerEnv,
  orgId: string,
  approvalRequestId: string,
): Promise<void> {
  await seedFactory(env, orgId, "approvals.expire", { approvalRequestId })
}

/** An org-shared skill (what an `update_skill` approval diffs against); its id. */
export async function seedOrgSkill(
  env: WorkerEnv,
  orgId: string,
  name: string,
  body: string,
): Promise<string> {
  const { id } = await seedFactory<{ id: string }>(env, orgId, "skills.org", { name, body })
  return id
}
