// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 E2E harness I2 — approvals helper for web-side scenarios.
//
// Thin wrapper around the kernel `POST /api/approvals/:requestId/decide`
// route. The on-the-wire body shape (matching
// `apps/api/src/tests/e2e/helpers/approvals.ts:56`) is either
// `{ decision: "approve" }` or `{ decision: "deny", reason: string }`.
// The web-side helper exposes `reject` as a SDK-friendly synonym for
// `deny` and translates it internally so scenarios can read fluently.
import { type ApiResponse, api } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"

export interface DecideApprovalOptions {
  serverUrl: string
  token: string
  requestId: string
  decision: "approve" | "reject" | "deny"
  reason?: string
}

export async function decideApproval(opts: DecideApprovalOptions): Promise<ApiResponse> {
  // An approve is bound to the payload the person was shown (and, for a bundle, every later
  // step): read them first.
  let body: Record<string, unknown> = {
    decision: "deny" as const,
    reason: opts.reason ?? "rejected by E2E test",
  }
  if (opts.decision === "approve") {
    const row = (
      await api(opts.serverUrl, `/api/approvals/${opts.requestId}`, { token: opts.token })
    ).body?.data
    body = { decision: "approve" as const, payloadHash: row?.payloadHash }
    if (row?.bundleId) {
      const steps = (
        await api(opts.serverUrl, `/api/approvals?bundleId=${row.bundleId}`, { token: opts.token })
      ).body?.data as Array<{ id: string; status: string; payloadHash?: string }> | undefined
      const stepPayloadHashes: Record<string, string> = {}
      for (const s of steps ?? []) {
        if (s.id !== opts.requestId && s.status === "deferred" && s.payloadHash) {
          stepPayloadHashes[s.id] = s.payloadHash
        }
      }
      if (Object.keys(stepPayloadHashes).length > 0) body = { ...body, stepPayloadHashes }
    }
  }
  return api(opts.serverUrl, `/api/approvals/${opts.requestId}/decide`, {
    method: "POST",
    token: opts.token,
    body,
  })
}

export interface PendingApproval {
  id: string
  toolName: string
  status: string
  threadId?: string
  createdAt?: string
  summary?: Record<string, unknown>
}

export interface ListPendingApprovalsOptions {
  serverUrl: string
  token: string
  toolPrefix?: string
}

export async function listPendingApprovals(
  opts: ListPendingApprovalsOptions,
): Promise<PendingApproval[]> {
  // The approvals list route's decidable-feed mode requires BOTH query params
  // (the union schema is `.strict()`): `status=pending` alone is a 400.
  const resp = await api(opts.serverUrl, "/api/approvals?status=pending&decidableByMe=true", {
    method: "GET",
    token: opts.token,
  })
  if (resp.status !== 200) {
    throw new Error(`listPendingApprovals: ${resp.status} ${JSON.stringify(resp.body)}`)
  }
  const body = resp.body as
    | { data?: PendingApproval[] }
    | PendingApproval[]
    | { data?: { items?: PendingApproval[] } }
  let rows: PendingApproval[] = []
  if (Array.isArray(body)) {
    rows = body
  } else if ("data" in body && Array.isArray(body.data)) {
    rows = body.data
  } else if (
    "data" in body &&
    body.data &&
    typeof body.data === "object" &&
    "items" in body.data &&
    Array.isArray((body.data as { items?: PendingApproval[] }).items)
  ) {
    rows = (body.data as { items: PendingApproval[] }).items
  }
  if (opts.toolPrefix) {
    return rows.filter((r) => r.toolName?.startsWith(opts.toolPrefix!))
  }
  return rows
}

export interface WaitForApprovalOptions {
  serverUrl: string
  token: string
  toolPrefix: string
  timeoutMs?: number
}

export async function waitForApproval(opts: WaitForApprovalOptions): Promise<PendingApproval> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000)
  while (Date.now() < deadline) {
    const rows = await listPendingApprovals({
      serverUrl: opts.serverUrl,
      token: opts.token,
      toolPrefix: opts.toolPrefix,
    })
    if (rows.length > 0) return rows[0]
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(
    `waitForApproval: no pending approval with toolPrefix=${opts.toolPrefix} within timeout`,
  )
}

/**
 * Call a tool AS THE AGENT acting for the token's user (origin in-app-agent,
 * the real executeTool gate; `/api/_test/agent-tool-call`). Approvals are for
 * agents: a person's own call (`/api/apps/<app>/tools/<tool>`) runs on their
 * scopes or is refused, and never parks one, not even a handler's own
 * threshold approval. A scenario about the approval path stages the call here.
 * Same response shape as the tools route: `{ data: <handler result> }`, or
 * `{ data: { blocked } }` for a gated call.
 */
export async function callToolAsAgent(
  serverUrl: string,
  token: string,
  toolName: string,
  params: Record<string, unknown>,
  threadId?: string,
): Promise<ApiResponse> {
  return api(serverUrl, "/api/_test/agent-tool-call", {
    method: "POST",
    token,
    body: { toolName, params, ...(threadId ? { threadId } : {}) },
  })
}

/** The message bodies of the approval cards a ticket shows, in card order. */
export async function ticketApprovalCardBodies(page: Page): Promise<string[]> {
  const cards = page.getByTestId("tickets-detail-approval-card")
  const bodies: string[] = []
  for (let i = 0; i < (await cards.count()); i++) {
    const body = cards.nth(i).getByTestId("approval-card-message-body")
    bodies.push(((await body.textContent({ timeout: 5000 })) ?? "").trim())
  }
  return bodies
}
