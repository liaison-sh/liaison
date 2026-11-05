// SPDX-License-Identifier: FSL-1.1-ALv2
import type { WorkerEnv } from "@liaison/test-helpers"
import { type ApiResponse, api } from "@liaison/test-helpers"
import { Queue } from "bullmq"
import { resolveJobQueue } from "~/infra/jobs/queue-classes"

interface WsLike {
  waitFor(eventType: string, predicate?: (msg: any) => boolean, timeout?: number): Promise<any>
  messages: any[]
}

// Scan-only wait that does not advance the underlying cursor: matches the predicate
// against the entire received-messages array on each tick. Robust against WS
// reconnects and mixed scenarios where the same connection sees several lifecycles.
async function scanForMessage(
  ws: WsLike,
  predicate: (msg: any) => boolean,
  timeoutMs: number,
): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const m of ws.messages) {
      if (predicate(m)) return m
    }
    // In-memory scan: a tight poll costs nothing and answers fast.
    await Bun.sleep(10)
  }
  const tail = ws.messages.slice(-10).map((m: any) => ({
    type: m?.type,
    app: m?.payload?.app,
    entity: m?.payload?.entity,
    action: m?.payload?.action,
  }))
  throw new Error(
    `WS scan timed out after ${timeoutMs}ms (received ${ws.messages.length} messages; last ${tail.length}: ${JSON.stringify(tail)})`,
  )
}

export function ks(env: WorkerEnv): string {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}

export async function triggerGatedEcho(
  url: string,
  token: string,
  threadId: string,
  message: string,
): Promise<{ res: ApiResponse; requestId: string; blocked: any }> {
  // Staged by the agent acting for `token`'s user: a person's own call never
  // parks an approval (it runs on their scope or is refused), so a pending
  // approval to decide comes from an agent's call, as in production.
  const res = await api(url, "/api/_test/agent-tool-call", {
    method: "POST",
    token,
    body: { toolName: "test:gatedEcho", threadId, params: { message } },
  })
  const blocked = res.body?.data?.blocked
  return { res, requestId: blocked?.approvalRequestId, blocked }
}

export async function decide(
  url: string,
  token: string,
  requestId: string,
  body: { decision: "approve" } | { decision: "deny"; reason: string },
): Promise<ApiResponse> {
  // An approve is bound to the payload the person was shown (and, for a bundle, every later
  // step): read them first.
  let withHash: Record<string, unknown> = body
  if (body.decision === "approve") {
    const row = (await api(url, `/api/approvals/${requestId}`, { token })).body?.data
    withHash = { ...body, payloadHash: row?.payloadHash }
    if (row?.bundleId) {
      const steps = (await api(url, `/api/approvals?bundleId=${row.bundleId}`, { token })).body
        ?.data as Array<{ id: string; status: string; payloadHash?: string }> | undefined
      const stepPayloadHashes: Record<string, string> = {}
      for (const s of steps ?? []) {
        if (s.id !== requestId && s.status === "deferred" && s.payloadHash) {
          stepPayloadHashes[s.id] = s.payloadHash
        }
      }
      if (Object.keys(stepPayloadHashes).length > 0) withHash = { ...withHash, stepPayloadHashes }
    }
  }
  return api(url, `/api/approvals/${requestId}/decide`, {
    method: "POST",
    token,
    body: withHash,
  })
}

export async function waitForApprovalEvent(
  ws: WsLike,
  action: "create" | "update",
  requestId: string,
  status?: string,
  timeoutMs = 15000,
): Promise<any> {
  return scanForMessage(
    ws,
    (m) => {
      if (m?.type !== "event") return false
      const p = m.payload
      if (!p) return false
      if (p.app !== "kernel" || p.entity !== "approval_request" || p.action !== action) return false
      const data = p.data ?? {}
      const matchId = data.id === requestId || data.approvalRequestId === requestId
      if (!matchId) return false
      if (status && data.status !== status) return false
      return true
    },
    timeoutMs,
  )
}

/** Like `waitForApprovalEvent(ws, "update", requestId)` but matches only an
 *  event carrying a `lastEdit` (i.e. a payload-edit update), so it cannot be
 *  satisfied by an unrelated "update" event still sitting in the buffer (any
 *  non-edit "update" carries `lastEdit: null`). Sidesteps the drain-timing
 *  race entirely for edit-specific assertions. */
export async function waitForApprovalEditEvent(
  ws: WsLike,
  requestId: string,
  timeoutMs = 15000,
): Promise<any> {
  return scanForMessage(
    ws,
    (m) => {
      if (m?.type !== "event") return false
      const p = m.payload
      if (!p) return false
      if (p.app !== "kernel" || p.entity !== "approval_request" || p.action !== "update")
        return false
      const data = p.data ?? {}
      const matchId = data.id === requestId || data.approvalRequestId === requestId
      if (!matchId) return false
      return Boolean(data.lastEdit)
    },
    timeoutMs,
  )
}

export async function waitForSystemMessageEvent(
  ws: WsLike,
  threadId: string,
  expectedMetadataType: string,
  timeoutMs = 15000,
): Promise<any> {
  return scanForMessage(
    ws,
    (m) => {
      if (m?.type !== "event") return false
      const p = m.payload
      if (!p) return false
      if (p.app !== "kernel" || p.entity !== "message" || p.action !== "create") return false
      const data = p.data ?? {}
      if (data.threadId !== threadId) return false
      if (data.authorType !== "system") return false
      return data.metadata?.type === expectedMetadataType
    },
    timeoutMs,
  )
}

export async function dbFetchApproval(env: WorkerEnv, requestId: string): Promise<any> {
  const [row] = await env.db.sql.unsafe(
    `SELECT id, status, tool_name, thread_id, originating_thread_id, current_payload, notify_user_ids, expires_at, decided_by, decided_at, approving_started_at, reason
     FROM ${ks(env)}.approval_requests WHERE id = $1`,
    [requestId],
  )
  return row
}

export async function dbFetchHandlerExecution(
  env: WorkerEnv,
  requestId: string,
  toolName: string,
): Promise<any> {
  const [row] = await env.db.sql.unsafe(
    `SELECT approval_request_id, tool_name, status, external_ref, error, actor_id, attempts
     FROM ${ks(env)}.approved_handler_executions
     WHERE approval_request_id = $1 AND tool_name = $2`,
    [requestId, toolName],
  )
  return row
}

export async function dbFetchSystemMessages(
  env: WorkerEnv,
  threadId: string,
  metadataType?: string,
): Promise<any[]> {
  const rows = await env.db.sql.unsafe(
    `SELECT id, content, author_type, metadata, created_at
     FROM ${ks(env)}.messages
     WHERE thread_id = $1 AND author_type = 'system'
     ORDER BY created_at ASC`,
    [threadId],
  )
  if (metadataType) {
    return rows.filter((r: any) => r.metadata?.type === metadataType)
  }
  return rows
}

export async function dbCountOutboxEventsForRequest(
  env: WorkerEnv,
  requestId: string,
  action: "create" | "update",
): Promise<number> {
  const rows = await env.db.sql.unsafe(
    `SELECT COUNT(*)::int AS c FROM ${ks(env)}.pending_events
     WHERE payload->>'app' = 'kernel'
       AND payload->>'entity' = 'approval_request'
       AND payload->>'action' = $2
       AND (payload->'data'->>'id' = $1 OR payload->>'entityId' = $1)`,
    [requestId, action],
  )
  return rows[0]?.c ?? 0
}

export async function dbCountOutboxMessageCreatesForThread(
  env: WorkerEnv,
  threadId: string,
): Promise<number> {
  const rows = await env.db.sql.unsafe(
    `SELECT COUNT(*)::int AS c FROM ${ks(env)}.pending_events
     WHERE payload->>'app' = 'kernel'
       AND payload->>'entity' = 'message'
       AND payload->>'action' = 'create'
       AND payload->'data'->>'threadId' = $1
       AND payload->'data'->>'authorType' = 'system'`,
    [threadId],
  )
  return rows[0]?.c ?? 0
}

/**
 * Enqueue a kernel job on its real class queue (infra/jobs/queue-classes.ts)
 * the way the server does: `jobId` is the deduplication id, and the job's
 * class priority applies. Then wait for it to finish so callers can assert
 * deterministic post-state.
 */
export async function enqueueKernelJobNow(
  env: WorkerEnv,
  name: string,
  payload: unknown,
  jobId: string,
): Promise<void> {
  const route = resolveJobQueue("kernel", name)
  const queue = new Queue(route.queueName, {
    connection: env.redis.redis,
    prefix: `${env.redisPrefix}bull`,
  })
  try {
    const job = await queue.add(name, payload, {
      deduplication: { id: jobId },
      ...(route.priority ? { priority: route.priority } : {}),
      attempts: 1,
      delay: 0,
      removeOnComplete: false,
      removeOnFail: false,
    })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const fresh = job.id ? await queue.getJob(job.id) : undefined
      if (!fresh) break
      const state = await fresh.getState()
      if (state === "completed" || state === "failed") break
      await Bun.sleep(20)
    }
  } finally {
    await queue.close()
  }
}

export async function expectNoWsEvent(
  ws: WsLike,
  predicate: (msg: any) => boolean,
  observeMs = 1500,
): Promise<void> {
  // Snapshot existing matches so we only flag *new* matches that arrive during
  // the observation window. Robust to a shared WS that has already seen prior
  // matching events for unrelated scenarios.
  const seen = new Set<unknown>()
  for (let i = 0; i < ws.messages.length; i++) {
    if (predicate(ws.messages[i])) seen.add(i)
  }
  const deadline = Date.now() + observeMs
  while (Date.now() < deadline) {
    for (let i = 0; i < ws.messages.length; i++) {
      if (seen.has(i)) continue
      if (predicate(ws.messages[i])) {
        throw new Error("Unexpected WS event observed within window")
      }
      seen.add(i)
    }
    await Bun.sleep(10)
  }
}

export async function pollUntil<T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 5000,
  intervalMs = 20,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | null | undefined
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await Bun.sleep(intervalMs)
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms (last=${JSON.stringify(last)})`)
}

// ─── Phase 6.2 multi-actor helpers ───────────────────────────────────

export async function createFreshThread(
  url: string,
  token: string,
  ownerUserId: string,
  title: string,
): Promise<string> {
  const res = await api(url, "/api/threads", {
    method: "POST",
    token,
    body: {
      forceCreate: true,
      participantIds: [ownerUserId],
      title,
    },
  })
  if (res.status !== 200) {
    throw new Error(`createFreshThread failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return res.body.data.id
}

/** Create a gated request and return it with its settled DB row. An approval
 *  lives on the thread it was raised from: there is no separate discussion
 *  thread any more, so `row.thread_id === originatingThreadId`. */
export async function createGatedRequest(opts: {
  url: string
  env: WorkerEnv
  requesterToken: string
  originatingThreadId: string
  message: string
}): Promise<{ requestId: string; row: any; blocked: any }> {
  const { res, requestId, blocked } = await triggerGatedEcho(
    opts.url,
    opts.requesterToken,
    opts.originatingThreadId,
    opts.message,
  )
  if (res.status !== 200 || !requestId) {
    throw new Error(`createGatedRequest failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  const row = await dbFetchApproval(opts.env, requestId)
  return { requestId, row, blocked }
}

export async function dbFetchThread(env: WorkerEnv, threadId: string): Promise<any> {
  const [row] = await env.db.sql.unsafe(
    `SELECT id, type, created_from, title FROM ${ks(env)}.threads WHERE id = $1`,
    [threadId],
  )
  return row
}

export async function dbFetchThreadParticipants(
  env: WorkerEnv,
  threadId: string,
): Promise<string[]> {
  const rows = await env.db.sql.unsafe(
    `SELECT user_id FROM ${ks(env)}.thread_participants WHERE thread_id = $1 ORDER BY user_id`,
    [threadId],
  )
  return rows.map((r: any) => r.user_id)
}

export async function dbExistsThreadReference(
  env: WorkerEnv,
  originatingThreadId: string,
  requestId: string,
): Promise<boolean> {
  const rows = await env.db.sql.unsafe(
    `SELECT id FROM ${ks(env)}.thread_references
     WHERE thread_id = $1 AND app = 'kernel' AND entity_type = 'approval_request' AND entity_id = $2`,
    [originatingThreadId, requestId],
  )
  return rows.length > 0
}

export async function dbCountSystemMessages(
  env: WorkerEnv,
  threadId: string,
  metadataType: string,
): Promise<number> {
  const rows = await env.db.sql.unsafe(
    `SELECT COUNT(*)::int AS c FROM ${ks(env)}.messages
     WHERE thread_id = $1 AND author_type = 'system' AND metadata->>'type' = $2`,
    [threadId, metadataType],
  )
  return rows[0]?.c ?? 0
}

export async function editPayload(
  url: string,
  token: string,
  requestId: string,
  fields: Record<string, unknown>,
): Promise<ApiResponse> {
  return api(url, `/api/approvals/${requestId}/payload`, {
    method: "POST",
    token,
    body: { fields },
  })
}

export async function getApproval(
  url: string,
  token: string,
  requestId: string,
): Promise<ApiResponse> {
  return api(url, `/api/approvals/${requestId}`, { method: "GET", token })
}

export async function waitForApprovalEditMessage(
  ws: WsLike,
  threadId: string,
  requestId: string,
  timeoutMs = 15000,
): Promise<any> {
  return scanForMessage(
    ws,
    (m) => {
      if (m?.type !== "event") return false
      const p = m.payload
      if (!p) return false
      if (p.app !== "kernel" || p.entity !== "message" || p.action !== "create") return false
      const data = p.data ?? {}
      if (data.threadId !== threadId) return false
      if (data.authorType !== "system") return false
      if (data.metadata?.type !== "payload-edit") return false
      // Optional: match the request id when the diff metadata captures it.
      // The Phase 6.2 spec puts diff/editorUserId on metadata; the request id is not
      // included on the edit message metadata, so we filter by thread+type only.
      void requestId
      return true
    },
    timeoutMs,
  )
}

export function snapshotMessageCount(ws: WsLike): number {
  return ws.messages.length
}

export async function scanWindowForApprovalEvent(
  ws: WsLike,
  startIndex: number,
  requestId: string,
  observeMs = 1500,
): Promise<any | null> {
  const deadline = Date.now() + observeMs
  while (Date.now() < deadline) {
    for (let i = startIndex; i < ws.messages.length; i++) {
      const m = ws.messages[i]
      if (m?.type !== "event") continue
      const p = m.payload
      if (!p) continue
      if (p.app !== "kernel" || p.entity !== "approval_request") continue
      const data = p.data ?? {}
      if (data.id === requestId || data.approvalRequestId === requestId) return m
    }
    await Bun.sleep(50)
  }
  return null
}
