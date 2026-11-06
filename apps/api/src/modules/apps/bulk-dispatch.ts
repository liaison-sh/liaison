// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash } from "node:crypto"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import type { ActorContext, UserContext } from "~/db/rls"
import { approvalRequests, threads } from "~/db/schema/kernel"
import { appsLogger as log } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { manifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import {
  type ExecuteToolCoreOptions,
  type ExecuteToolEnvelope,
  executeToolCore,
  type ToolOrigin,
} from "~/modules/apps/execute-tool"
import { insertThreadWithParticipants } from "~/modules/threads/thread"

const BULK_RESPONSE_TTL_SECONDS = 24 * 60 * 60
const BULK_LOCK_TTL_MS = 30_000
const BULK_LOCK_POLL_INTERVAL_MS = 50
const BULK_LOCK_POLL_TIMEOUT_MS = 5_000

export interface BulkDispatchArgs {
  app: string
  action: string
  ids: string[]
  params: Record<string, unknown>
  idempotencyKey: string
  actor: ActorContext
  // Provenance of the call that requested this bulk dispatch: "human-ui" for a
  // direct browser click, "in-app-agent" or "mcp" otherwise. Required, and must
  // be threaded into the per-item dispatchOne call below unchanged: without it,
  // each re-entrant item call would look like a fresh, unattributed call and
  // (now that origin is required) fail to compile rather than default to a
  // human-ui bypass.
  origin: ToolOrigin
  // The thread the items are judged and parked on, when the caller already has
  // one (a restricted session's, rest-tool-call.ts). Absent: as below.
  threadId?: string | undefined
}

export interface BulkItem {
  id: string
  status: "succeeded" | "failed" | "pending_approval"
  approvalRequestId?: string
  error?: string
  /**
   * Fields the bulk action declares in `itemResultFields`, copied from the
   * underlying tool's result for a succeeded item when present (for example
   * a warning the agent must read about that one item).
   */
  [resultField: string]: unknown
}

export interface BulkError {
  id: string
  code: string
  message: string
}

export interface BulkDispatchResponse {
  bulkRequestId: string
  total: number
  succeeded: number
  failed: number
  approvalsCreated: number
  errors: BulkError[]
  items: BulkItem[]
}

interface CachedBulkDispatchResponse {
  requestHash: string
  response: BulkDispatchResponse
}

export class BulkDispatchError extends Error {
  status: number
  code: string
  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
    this.name = "BulkDispatchError"
  }
}

export interface BulkDispatchDeps {
  dispatch?: (opts: ExecuteToolCoreOptions) => Promise<ExecuteToolEnvelope>
  ensureOriginThread?: (input: {
    orgId: string
    userId: string
    bulkRequestId: string
    label: string
    count: number
  }) => Promise<string | undefined>
}

interface BulkActionDecl {
  label: string
  underlyingTool: string
  dispatchMode: "perItem" | "aggregate"
  perItemParam?: string
  selectionParam?: string
  sharedFields?: string[]
  agentTool?: string
  minSelection?: number
  itemResultFields?: string[]
}

/** The declared `itemResultFields` present in a succeeded item's tool result. */
function pickItemResultFields(data: unknown, fields: string[]): Record<string, unknown> {
  if (!fields.length || !data || typeof data !== "object") return {}
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const value = (data as Record<string, unknown>)[f]
    if (value !== undefined && value !== null) out[f] = value
  }
  return out
}

function bulkCacheKey(orgId: string, idempotencyKey: string): string {
  return `bulk:${orgId}:${idempotencyKey}`
}

function bulkLockKey(orgId: string, idempotencyKey: string): string {
  return `bulk:${orgId}:${idempotencyKey}:lock`
}

function pickSharedParams(
  params: Record<string, unknown>,
  sharedFields: string[],
): Record<string, unknown> {
  if (!sharedFields.length) {
    const { ids: _ids, idempotencyKey: _idem, operation: _op, ...rest } = params
    return rest
  }
  const result: Record<string, unknown> = {}
  for (const f of sharedFields) {
    if (Object.hasOwn(params, f)) result[f] = params[f]
  }
  return result
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

function hashCanonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex")
}

function parseCachedBulkResponse(cached: string, requestHash: string): BulkDispatchResponse {
  const parsed = JSON.parse(cached) as CachedBulkDispatchResponse | BulkDispatchResponse
  if ("requestHash" in parsed && "response" in parsed) {
    if (parsed.requestHash !== requestHash) {
      throw new BulkDispatchError(
        "idempotency_conflict",
        "idempotency key reused with different bulk request",
        409,
      )
    }
    return parsed.response
  }
  throw new BulkDispatchError(
    "idempotency_conflict",
    "idempotency cache entry is missing the original request hash",
    409,
  )
}

function normalizeBulkException(err: unknown): { code: string; message: string } {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown }
    return {
      code: typeof e.code === "string" ? e.code : "tool_error",
      message: typeof e.message === "string" ? e.message : String(err),
    }
  }
  return { code: "tool_error", message: String(err) }
}

async function defaultEnsureOriginThread(input: {
  orgId: string
  userId: string
  bulkRequestId: string
  label: string
  count: number
}): Promise<string | undefined> {
  try {
    const threadId = await withPrivilegedDb(input.orgId, "bulk-origin-thread", async (tx) => {
      const [existing] = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(
          and(
            eq(threads.orgId, input.orgId),
            drizzleSql`${threads.createdFrom}->>'app' = 'kernel'`,
            drizzleSql`${threads.createdFrom}->>'entityType' = 'bulk_request'`,
            drizzleSql`${threads.createdFrom}->>'entityId' = ${input.bulkRequestId}`,
            drizzleSql`${threads.createdFrom}->>'actorId' = ${input.userId}`,
          ),
        )
        .limit(1)
      if (existing) return existing.id

      const { thread } = await insertThreadWithParticipants(tx, {
        orgId: input.orgId,
        userId: input.userId,
        participantIds: [input.userId],
        title: `Bulk ${input.label} — ${input.count} items`,
        isPinned: false,
        createdFrom: {
          app: "kernel",
          entityType: "bulk_request",
          entityId: input.bulkRequestId,
          actorId: input.userId,
        },
        type: "thread",
      })
      // Hide from sidebar list.
      await tx.update(threads).set({ hiddenFromList: true }).where(eq(threads.id, thread.id))
      return thread.id
    })
    return threadId
  } catch (err) {
    log.error({ err, bulkRequestId: input.bulkRequestId }, "Failed to create bulk origin thread")
    return undefined
  }
}

async function waitForCachedResult(
  cacheKey: string,
  lockKey: string,
  requestHash: string,
): Promise<BulkDispatchResponse> {
  const deadline = Date.now() + BULK_LOCK_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, BULK_LOCK_POLL_INTERVAL_MS))
    const cached = await redis.get(cacheKey)
    if (cached) return parseCachedBulkResponse(cached, requestHash)
    const lockStillHeld = await redis.get(lockKey)
    if (!lockStillHeld) break
  }
  throw new BulkDispatchError(
    "idempotency_in_flight",
    "concurrent bulk dispatch with same idempotency key in progress",
    409,
  )
}

function getBulkActionDecl(orgId: string, app: string, action: string): BulkActionDecl | undefined {
  const manifest = manifestRegistry.get([orgId, app])
  const bulk = manifest?.bulk as Record<string, BulkActionDecl> | undefined
  return bulk?.[action]
}

export async function runBulkDispatch(
  args: BulkDispatchArgs,
  deps: BulkDispatchDeps = {},
): Promise<BulkDispatchResponse> {
  if (new Set(args.ids).size !== args.ids.length) {
    throw new BulkDispatchError("DUPLICATE_IDS", "ids contains duplicates", 422)
  }
  if (args.ids.length === 0) {
    throw new BulkDispatchError("EMPTY_SELECTION", "ids must not be empty", 422)
  }

  const orgId = args.actor.orgId
  const cacheKey = bulkCacheKey(orgId, args.idempotencyKey)
  const lockKey = bulkLockKey(orgId, args.idempotencyKey)
  const requestHash = hashCanonical({
    app: args.app,
    action: args.action,
    ids: args.ids,
    params: args.params,
  })

  const cached = await redis.get(cacheKey)
  if (cached) return parseCachedBulkResponse(cached, requestHash)

  const claimed = await redis.set(lockKey, "1", "PX", BULK_LOCK_TTL_MS, "NX")
  if (!claimed) return waitForCachedResult(cacheKey, lockKey, requestHash)

  try {
    const decl = getBulkActionDecl(orgId, args.app, args.action)
    if (!decl) {
      throw new BulkDispatchError(
        "UNKNOWN_BULK_ACTION",
        `bulk action "${args.app}.${args.action}" not registered`,
        404,
      )
    }
    if (decl.minSelection && args.ids.length < decl.minSelection) {
      throw new BulkDispatchError(
        "BELOW_MIN_SELECTION",
        `bulk action requires at least ${decl.minSelection} items`,
        422,
      )
    }

    const tool = toolRegistry.get([orgId, args.app, decl.underlyingTool])
    if (!tool) {
      throw new BulkDispatchError(
        "MISSING_TOOL",
        `underlying tool ${args.app}:${decl.underlyingTool} not registered`,
        500,
      )
    }

    const dispatch = deps.dispatch ?? executeToolCore
    const ensureOriginThread = deps.ensureOriginThread ?? defaultEnsureOriginThread
    const sharedParams = pickSharedParams(args.params, decl.sharedFields ?? [])
    const bulkRequestId = args.idempotencyKey
    const actorUserId =
      args.actor.actorType === "user" ? (args.actor as UserContext).userId : "system"

    // A person's own bulk click is decided per item on the tool's own scope
    // (approvals are for agents, not persons): each item runs on their
    // authority or is refused. The one exception is an org two-approver
    // policy, under which an item parks for a second approver; that approval
    // gets its own anchor thread lazily (executeToolCore), so no shared origin
    // thread is created here for a person.
    const personOrigin = args.origin === "human-ui" && args.actor.actorType === "user"
    let originatingThreadId = args.threadId
    if (!originatingThreadId && tool.gated && !personOrigin) {
      originatingThreadId = await ensureOriginThread({
        orgId,
        userId: actorUserId,
        bulkRequestId,
        label: decl.label,
        count: args.ids.length,
      })
    }

    const items: BulkItem[] = []
    const errors: BulkError[] = []
    let succeeded = 0
    let failed = 0
    let approvalsCreated = 0

    const dispatchOne = async (params: Record<string, unknown>, perItemKey: string) => {
      const opts: ExecuteToolCoreOptions = {
        toolName: `${args.app}:${decl.underlyingTool}`,
        orgId,
        actor: args.actor,
        params,
        threadId: originatingThreadId,
        callChain: [],
        internalCall: { callerApp: args.app, idempotencyKey: perItemKey },
        // Carry the caller's origin through the re-entrant call. Without it
        // the item looks like a direct human UI click and skips the gate.
        origin: args.origin,
      }
      try {
        return await dispatch(opts)
      } catch (err) {
        return {
          error: { ...normalizeBulkException(err), retryable: false },
        } as ExecuteToolEnvelope
      }
    }

    const handleBlocked = async (
      envelope: Extract<ExecuteToolEnvelope, { blocked: unknown }>,
      itemId: string,
    ) => {
      approvalsCreated++
      const approvalRequestId = envelope.blocked.approvalRequestId
      items.push({ id: itemId, status: "pending_approval", approvalRequestId })
      if (approvalRequestId) {
        try {
          await withPrivilegedDb(orgId, "bulk-approval-metadata", (tx) =>
            tx
              .update(approvalRequests)
              .set({
                metadata: drizzleSql`metadata || ${JSON.stringify({
                  bulkRequestId,
                  bulkAction: `${args.app}.${args.action}`,
                  bulkItemId: itemId,
                })}::jsonb`,
              })
              .where(eq(approvalRequests.id, approvalRequestId)),
          )
        } catch (err) {
          log.error(
            { err, approvalRequestId, bulkRequestId },
            "Failed to write bulk metadata on approval",
          )
        }
      }
    }

    if (decl.dispatchMode === "perItem") {
      if (!decl.perItemParam) {
        throw new BulkDispatchError(
          "MISCONFIGURED",
          `bulk.${args.action}: perItem mode requires perItemParam`,
          500,
        )
      }
      for (const id of args.ids) {
        const params = { [decl.perItemParam]: id, ...sharedParams }
        const envelope = await dispatchOne(params, `${bulkRequestId}:${id}`)
        if ("error" in envelope) {
          failed++
          errors.push({ id, code: envelope.error.code, message: envelope.error.message })
          items.push({ id, status: "failed", error: envelope.error.message })
        } else if ("blocked" in envelope) {
          await handleBlocked(envelope, id)
        } else {
          succeeded++
          items.push({
            id,
            status: "succeeded",
            ...pickItemResultFields(envelope.data, decl.itemResultFields ?? []),
          })
        }
      }
    } else {
      if (!decl.selectionParam) {
        throw new BulkDispatchError(
          "MISCONFIGURED",
          `bulk.${args.action}: aggregate mode requires selectionParam`,
          500,
        )
      }
      // Customform-driven aggregate actions may already supply the canonical
      // selection in params[selectionParam] — for example tickets:merge filters
      // the target ticket out of the source list. Honor the explicit value
      // when present; fall back to the full selection otherwise.
      const explicitSelection = Array.isArray(args.params[decl.selectionParam])
        ? (args.params[decl.selectionParam] as unknown[]).filter(
            (v): v is string => typeof v === "string",
          )
        : null
      const dispatchSelection =
        explicitSelection && explicitSelection.length > 0 ? explicitSelection : args.ids
      const params = { [decl.selectionParam]: dispatchSelection, ...sharedParams }
      const envelope = await dispatchOne(params, bulkRequestId)
      if ("error" in envelope) {
        for (const id of args.ids) {
          failed++
          errors.push({ id, code: envelope.error.code, message: envelope.error.message })
          items.push({ id, status: "failed", error: envelope.error.message })
        }
      } else if ("blocked" in envelope) {
        approvalsCreated++
        const approvalRequestId = envelope.blocked.approvalRequestId
        for (const id of args.ids) items.push({ id, status: "pending_approval", approvalRequestId })
        if (approvalRequestId) {
          try {
            await withPrivilegedDb(orgId, "bulk-aggregate-approval-metadata", (tx) =>
              tx
                .update(approvalRequests)
                .set({
                  metadata: drizzleSql`metadata || ${JSON.stringify({
                    bulkRequestId,
                    bulkAction: `${args.app}.${args.action}`,
                  })}::jsonb`,
                })
                .where(eq(approvalRequests.id, approvalRequestId)),
            )
          } catch (err) {
            log.error(
              { err, approvalRequestId, bulkRequestId },
              "Failed to write bulk metadata on aggregate approval",
            )
          }
        }
      } else {
        for (const id of args.ids) {
          succeeded++
          items.push({ id, status: "succeeded" })
        }
      }
    }

    const response: BulkDispatchResponse = {
      bulkRequestId,
      total: args.ids.length,
      succeeded,
      failed,
      approvalsCreated,
      errors,
      items,
    }
    await redis.set(
      cacheKey,
      JSON.stringify({ requestHash, response }),
      "EX",
      BULK_RESPONSE_TTL_SECONDS,
    )
    return response
  } finally {
    await redis
      .del(lockKey)
      .catch((err) => log.warn({ err, lockKey }, "Failed to release bulk lock"))
  }
}
