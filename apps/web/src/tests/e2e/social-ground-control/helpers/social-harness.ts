// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B10 E2E harness — HTTP clients for the social `_test` install + mock-control
// routes. The actual work (register-from-source, connected-account seed, finding
// /conversation injection, lifecycle pause/resume, guide read) runs SERVER-SIDE
// in the spawned API process (see
// `apps/api/test-support/harness/social-install-routes.ts` +
// `apps/api/test-support/harness/social-mock-fetch.ts`). The social platform fetch
// (Facebook Graph) is mocked at the same sandbox-fetch bridge the Boxtal mock
// uses, composed at boot in `index.e2e.ts`.
import { api } from "@liaison/test-helpers"

function unwrap(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>
  return "data" in b && b.data && typeof b.data === "object"
    ? (b.data as Record<string, unknown>)
    : b
}

export interface InstalledSocialApp {
  appName: "social"
  connectedAccountId: string
  identifier: string
}

/** Install the bundled social app from source for an org + seed a connected account. */
export async function installSocialApp(opts: {
  serverUrl: string
  token: string
  orgId: string
  connectionName?: "meta" | "google"
}): Promise<InstalledSocialApp> {
  const resp = await api(opts.serverUrl, "/api/_test/social/install-for-test", {
    method: "POST",
    token: opts.token,
    body: {
      orgId: opts.orgId,
      ...(opts.connectionName ? { connectionName: opts.connectionName } : {}),
    },
  })
  if (resp.status !== 200) {
    throw new Error(`installSocialApp: ${resp.status} ${JSON.stringify(resp.body)}`)
  }
  return resp.body as InstalledSocialApp
}

/** Inject a finding directly (drives the Findings surface without a live fetch). */
export async function seedFinding(opts: {
  serverUrl: string
  token: string
  orgId: string
  platform?: "facebook" | "instagram" | "youtube"
  relation?: string
  contentText?: string
  status?: string
  authorHandle?: string
}): Promise<{ findingId: string; externalId: string }> {
  const { serverUrl, token, ...body } = opts
  const resp = await api(serverUrl, "/api/_test/social/seed-finding", {
    method: "POST",
    token,
    body,
  })
  if (resp.status !== 200) {
    throw new Error(`seedFinding: ${resp.status} ${JSON.stringify(resp.body)}`)
  }
  return resp.body as { findingId: string; externalId: string }
}

/** Inject a DM conversation (drives the Messages surface + window pill). */
export async function seedConversation(opts: {
  serverUrl: string
  token: string
  orgId: string
  platform?: "facebook" | "instagram"
  participantHandle?: string
  lastInboundAt?: string
}): Promise<{ conversationId: string }> {
  const { serverUrl, token, ...body } = opts
  const resp = await api(serverUrl, "/api/_test/social/seed-conversation", {
    method: "POST",
    token,
    body,
  })
  if (resp.status !== 200) {
    throw new Error(`seedConversation: ${resp.status} ${JSON.stringify(resp.body)}`)
  }
  return resp.body as { conversationId: string }
}

/** Read a finding via the production `findings_get` tool. */
export async function getFinding(opts: {
  serverUrl: string
  token: string
  findingId: string
}): Promise<Record<string, unknown>> {
  const resp = await api(opts.serverUrl, "/api/apps/social/tools/findings_get", {
    method: "POST",
    token: opts.token,
    body: { params: { finding_id: opts.findingId } },
  })
  return { status: resp.status, ...unwrap(resp.body) }
}

/** Call a social tool by name (direct human-approver path). */
export async function socialTool(opts: {
  serverUrl: string
  token: string
  tool: string
  params: Record<string, unknown>
  /**
   * Call as the AGENT acting for the token's user (`/api/_test/agent-tool-call`).
   * Approvals are for agents: a person's own call runs on their scopes and never
   * parks one, so a scenario about the approval path stages the call here.
   */
  asAgent?: boolean
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = opts.asAgent
    ? await api(opts.serverUrl, "/api/_test/agent-tool-call", {
        method: "POST",
        token: opts.token,
        // An agent acts in a conversation: the caller's own agent DM, where
        // the staged call and its approved result belong.
        body: {
          toolName: `social:${opts.tool}`,
          params: opts.params,
          threadId: await agentDmThread(opts.serverUrl, opts.token),
        },
      })
    : await api(opts.serverUrl, `/api/apps/social/tools/${opts.tool}`, {
        method: "POST",
        token: opts.token,
        body: { params: opts.params },
      })
  return { status: resp.status, body: unwrap(resp.body) }
}

async function agentDmThread(serverUrl: string, token: string): Promise<string> {
  const res = await api(serverUrl, "/api/threads/dm", { method: "POST", token, body: {} })
  const id = (res.body as { data?: { id?: string } }).data?.id
  if (!id) throw new Error(`agent DM thread: ${res.status} ${JSON.stringify(res.body)}`)
  return id
}

/** The call parked for approval: the kernel gate (`blocked`) or the handler's own request. */
export function parkedForApproval(body: Record<string, unknown>): boolean {
  const blocked = body.blocked as { approvalRequestId?: string } | undefined
  return Boolean(blocked?.approvalRequestId) || body.status === "pending_approval"
}

export interface DmMessageRow {
  id?: string
  conversation_id?: string
  direction?: string
  body?: string | null
  sent_via_tag?: string | null
  delivery_status?: string | null
  occurred_at?: string | null
}

/**
 * Read a conversation + its messages via the production `dm_get` tool. Returns
 * the whole `dm_message` rows (no projection), so each carries `direction` +
 * `sent_via_tag` — the B-NEW-1 window-tag assertions inspect the outbound row.
 */
export async function dmGet(opts: {
  serverUrl: string
  token: string
  conversationId: string
}): Promise<{
  status: number
  conversation: Record<string, unknown> | null
  messages: DmMessageRow[]
}> {
  const resp = await api(opts.serverUrl, "/api/apps/social/tools/dm_get", {
    method: "POST",
    token: opts.token,
    body: { params: { conversation_id: opts.conversationId } },
  })
  const body = unwrap(resp.body)
  return {
    status: resp.status,
    conversation: (body.conversation ?? null) as Record<string, unknown> | null,
    messages: Array.isArray(body.messages) ? (body.messages as DmMessageRow[]) : [],
  }
}

/**
 * Read the decided gated-tool handler result after an approval (the re-entry's
 * return value, e.g. `{ status: "failed", reason: "gone" }`). `GET
 * /api/approvals/:id/result` returns `{ status, result }`; `result` is the
 * persisted handler output once the approved re-entry has executed.
 */
export async function getApprovalResult(opts: {
  serverUrl: string
  token: string
  requestId: string
}): Promise<{ status?: string; result?: Record<string, unknown> | null }> {
  const resp = await api(opts.serverUrl, `/api/approvals/${opts.requestId}/result`, {
    method: "GET",
    token: opts.token,
  })
  const body = unwrap(resp.body)
  return body as { status?: string; result?: Record<string, unknown> | null }
}

/** Enable an app routine template as one of the caller's routines. */
export async function enableTemplate(opts: {
  serverUrl: string
  token: string
  app: string
  key: string
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await api(
    opts.serverUrl,
    `/api/agent/routines/templates/${opts.app}/${opts.key}/enable`,
    { method: "POST", token: opts.token, body: {} },
  )
  return { status: resp.status, body: unwrap(resp.body) }
}

/** List the caller's routines (for the lifecycle status assertion). */
export async function listRoutines(opts: { serverUrl: string; token: string }): Promise<
  Array<{
    id: string
    appName?: string | null
    templateKey?: string | null
    status?: string
    sourceKind?: string
  }>
> {
  const resp = await api(opts.serverUrl, "/api/agent/routines", {
    method: "GET",
    token: opts.token,
  })
  const body = unwrap(resp.body)
  const rows = (body.data ?? body) as unknown
  return Array.isArray(rows) ? (rows as never) : ((body as { data?: never[] }).data ?? [])
}

/**
 * Delete a routine by id (`DELETE /api/agent/routines/:id`). Used to restore the
 * worker-shared baseline after a test that enables an app routine template, so a
 * sibling test in the same worker (e.g. B0's enable→pause→resume lifecycle) does
 * not collide with an already-enabled template (a 409 "Template already enabled").
 */
export async function deleteRoutine(opts: {
  serverUrl: string
  token: string
  id: string
}): Promise<void> {
  await api(opts.serverUrl, `/api/agent/routines/${opts.id}`, {
    method: "DELETE",
    token: opts.token,
  })
}

/** Deactivate the social app (teardown → pause instantiated app routines). */
export async function deactivateSocial(opts: {
  serverUrl: string
  token: string
  orgId: string
}): Promise<void> {
  const resp = await api(opts.serverUrl, "/api/_test/social/deactivate-for-test", {
    method: "POST",
    token: opts.token,
    body: { orgId: opts.orgId },
  })
  if (resp.status !== 200)
    throw new Error(`deactivateSocial: ${resp.status} ${JSON.stringify(resp.body)}`)
}

/** Reactivate the social app (register-from-source → resume paused app routines). */
export async function reactivateSocial(opts: {
  serverUrl: string
  token: string
  orgId: string
}): Promise<void> {
  const resp = await api(opts.serverUrl, "/api/_test/social/reactivate-for-test", {
    method: "POST",
    token: opts.token,
    body: { orgId: opts.orgId },
  })
  if (resp.status !== 200)
    throw new Error(`reactivateSocial: ${resp.status} ${JSON.stringify(resp.body)}`)
}

/** Read the seeded `social-overview` guide via the production `skill_read` path. */
export async function readGuide(opts: {
  serverUrl: string
  token: string
  orgId: string
  name?: string
}): Promise<{ name?: string; body?: string; error?: { code: string } }> {
  const resp = await api(opts.serverUrl, "/api/_test/social/read-guide-for-test", {
    method: "POST",
    token: opts.token,
    body: { orgId: opts.orgId, ...(opts.name ? { name: opts.name } : {}) },
  })
  return resp.body as { name?: string; body?: string; error?: { code: string } }
}

// — platform-fetch mock control + recorder —

export interface SocialMockRequest {
  url: string
  method: string
  headers: Record<string, string>
  actor: string | null
  body: string | null
  receivedAt: number
}

export async function resetSocialMock(serverUrl: string, token: string): Promise<void> {
  const resp = await api(serverUrl, "/api/_test/social/mock/reset", { method: "POST", token })
  if (resp.status !== 200)
    throw new Error(`resetSocialMock: ${resp.status} ${JSON.stringify(resp.body)}`)
}

/**
 * Force the social platform mock's next post-back HTTP status (the failure arms).
 * `410`/`404` → `gone` (terminal `failed`); `429` → `rate_limited` (`triaged`);
 * `200` clears the override. Mounted at `POST /api/_test/social/mock/mode`.
 */
export async function setSocialMockMode(
  serverUrl: string,
  token: string,
  postStatus: number,
): Promise<void> {
  const resp = await api(serverUrl, "/api/_test/social/mock/mode", {
    method: "POST",
    token,
    body: { postStatus },
  })
  if (resp.status !== 200)
    throw new Error(`setSocialMockMode: ${resp.status} ${JSON.stringify(resp.body)}`)
}

export async function getSocialRequests(
  serverUrl: string,
  token: string,
): Promise<SocialMockRequest[]> {
  const resp = await api(serverUrl, "/api/_test/social/mock/requests", { method: "GET", token })
  if (resp.status !== 200)
    throw new Error(`getSocialRequests: ${resp.status} ${JSON.stringify(resp.body)}`)
  return (resp.body as { requests: SocialMockRequest[] }).requests
}

/** Facebook Graph comment POSTs (the gate assertion: zero before approve). */
export function graphCommentPosts(reqs: SocialMockRequest[]): SocialMockRequest[] {
  return reqs.filter((r) => r.method === "POST" && /\/comments$/.test(new URL(r.url).pathname))
}

/** Graph `/me/messages` DM POSTs (B-NEW-1 send-time window-tag assertions). */
export function graphMessagePosts(reqs: SocialMockRequest[]): SocialMockRequest[] {
  return reqs.filter((r) => r.method === "POST" && /\/me\/messages$/.test(new URL(r.url).pathname))
}

/** Graph `/likes` POSTs (B-NEW-3: zero recorded for an unsupported like). */
export function graphLikePosts(reqs: SocialMockRequest[]): SocialMockRequest[] {
  return reqs.filter((r) => r.method === "POST" && /\/likes$/.test(new URL(r.url).pathname))
}
