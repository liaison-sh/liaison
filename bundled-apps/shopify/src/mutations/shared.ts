// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify mutation tools: the protocol every mutation shares (typed errors, preflight
// refusals, gated-target reads, the approval-execution protocol, runMutation, input
// unwrapping) and the small helpers more than one tool group uses.

import type { AppContext } from "@liaison/app-sdk"
import { emitEvent } from "../lib/emit"
import { getShopifyClient } from "../lib/get-client"

interface MutationError extends Error {
  code: string
  status?: number
}
// Every mutation error is a caller-input rejection (bad params, not-found, unsupported
// field, etc) unless a call site passes an explicit status: it defaults to 400 so the
// execute-tool logging boundary (apps/api/src/modules/apps/execute-tool.ts) warn-logs it
// instead of paging the prod watchdog as a critical. A handful of sites represent an
// upstream anomaly the caller could not have avoided (e.g. Shopify returning an empty/
// impossible payload) and pass 502 explicitly to keep those paging at error level.
export function makeMutationError(code: string, message: string, status = 400): MutationError {
  const e = new Error(message) as MutationError
  e.code = code
  e.status = status
  return e
}

// ─────────────────────────────────────────────────────────────────────────
//  Stage-time preflight plumbing
// ─────────────────────────────────────────────────────────────────────────
//
// A manifest `preflight` runs BEFORE the gated approval is created. It exists so a gated call is
// never parked for a human when the data it needs is missing or invalid: without it the handler's
// guards only fire AFTER the approver clicks approve, and the human is handed an error only the
// agent could have fixed (on a destructive tool, after part of the work already landed).
//
// Every preflight here is READ ONLY (lookups, no writes, no Shopify mutations) and reuses the SAME
// validation function the handler runs, so the two can never drift. It RETURNS the refusal rather
// than throwing: execute-tool reads the returned value through normalizeToolErrorResult, and a throw
// would only fall through to letting staging proceed.
export type PreflightResult = { ok: true } | { error: { code: string; message: string } }

/** Turn a validation THROW from a shared handler guard into the `{ error }` shape a preflight must
 *  return, preserving the handler's own code + message so the two surfaces agree verbatim. */
export function preflightRefusal(err: unknown, fallbackCode: string): PreflightResult {
  const code =
    typeof (err as { code?: unknown } | null)?.code === "string"
      ? (err as { code: string }).code
      : fallbackCode
  return { error: { code, message: err instanceof Error ? err.message : String(err) } }
}

/** Require the id a gated tool targets, with the SAME code + message the handler has always thrown.
 *  PURE. Shared by each handler and its stage-time preflight so the two can never drift. */
export function requireTargetId(params: Record<string, unknown>, key: string): string {
  const v = params[key]
  if (typeof v === "string" && v.trim() !== "") return v
  if (typeof v === "number" && Number.isFinite(v)) return String(v)
  throw makeMutationError("BAD_PARAM", `${key} is required`)
}

// One read-only probe for the TARGET of a gated tool: does the id resolve at all, is it the kind of
// record this tool acts on, and (for the state machines) what state is it in. `node` resolves every
// Shopify gid, so one query serves every preflight below and no per-tool copy can drift.
// Returns/fulfillments carry the status the transition guards read.
const GATED_TARGET_PROBE = `
  query GatedTargetProbe($id: ID!) {
    node(id: $id) {
      id
      __typename
      ... on Return { status }
      ... on Fulfillment { status }
    }
  }
`
interface GatedTargetNode {
  id: string
  __typename: string
  status?: string | null
}

/** A gid this probe can resolve. A legacy numeric id or a non-gid string is left alone (Shopify
 *  resolves those itself), exactly like `assertProductGid`. */
const isShopifyGid = (id: string): boolean => /^gid:\/\/shopify\/[A-Za-z]+\/.+/.test(id)

/**
 * READ-ONLY stage-time probe of the record a gated tool is about to change. Throws NOT_FOUND when the
 * id resolves to nothing and WRONG_ENTITY_FOR_TOOL when it resolves to a different kind of record.
 * Returns undefined when the id is not a gid (nothing knowable at staging, so nothing is refused).
 */
export async function readGatedTarget(
  ctx: AppContext,
  id: string,
  expectedType: string,
  tool: string,
): Promise<GatedTargetNode | undefined> {
  if (!isShopifyGid(id)) return undefined
  const client = await getShopifyClient(ctx)
  const data = await client.query<{ node?: GatedTargetNode | null }>(GATED_TARGET_PROBE, { id })
  const node = data.node
  if (!node) throw makeMutationError("NOT_FOUND", `${tool}: no ${expectedType} found for ${id}.`)
  if (node.__typename !== expectedType) {
    throw makeMutationError(
      "WRONG_ENTITY_FOR_TOOL",
      `${tool} acts on a ${expectedType}, but ${id} is a ${node.__typename} id. Use the tool that matches the record you want to change.`,
    )
  }
  return node
}

/** Refuse a state transition the target record cannot admit. The state is read at STAGE time, so a
 *  record that legitimately moves between staging and the approve is still caught by the handler's
 *  own Shopify userErrors: this is an early refusal, never a replacement for it. */
export function assertTargetState(
  node: GatedTargetNode | undefined,
  allowed: readonly string[],
  tool: string,
  what: string,
  action: string,
): void {
  const status = typeof node?.status === "string" ? node.status : undefined
  if (!status) return
  if (allowed.includes(status)) return
  throw makeMutationError(
    "INVALID_STATE",
    `${tool}: this ${what} is ${status}, so it cannot be ${action}. Only ${allowed.join(" or ")} admits that change.`,
  )
}

// ─────────────────────────────────────────────────────────────────────────
//  Approval-protocol wiring (post-approval replay outcome classification)
// ─────────────────────────────────────────────────────────────────────────
//
// When the kernel replays a gated handler after a human approve, it needs to know — on a
// throw — whether the side effect landed. Without a durable answer it declares the outcome
// AMBIGUOUS and leaves the approval wedged at `approving` (undecidable, invisible). These
// handlers CAN answer precisely: a validation error thrown before any mutation was sent, or
// a Shopify `userErrors` rejection, provably had no effect; only a transport failure AFTER a
// mutation was sent is genuinely unknown. `runMutation` marks the ctx once a mutation may
// have landed; `withApprovalProtocol` (applied to every mutation handler in handlers.ts)
// records started/succeeded/failed_no_effect through the kernel's approval bridges, which
// are no-ops outside an approval replay.

/** Ctxs on which at least one Shopify MUTATION may have landed (sent, or confirmed applied).
 *  Read-only queries (variant probes, price lookups) never mark. */
const ctxsWithExternalEffect = new WeakSet<object>()
export const markExternalEffect = (ctx: AppContext): void => {
  ctxsWithExternalEffect.add(ctx as object)
}

export interface ApprovalBridges {
  approval?: {
    approvalRequestId: string
    approvalDeciderId: string
    toolName: string
    approvalExecutionId?: string
  }
  approval_recordStarted?: (toolName: string) => Promise<void>
  approval_recordSucceeded?: (toolName: string, externalRefJson?: string) => Promise<void>
  approval_recordFailedNoEffect?: (toolName: string, errJson: string) => Promise<void>
  approval_recordAwaitingOutput?: (toolName: string, externalRefJson?: string) => Promise<void>
}

/** Ctxs whose approved execution recorded `awaiting_output` (its `pollHandler` finishes it). */
const ctxsAwaitingOutput = new WeakSet<object>()

/**
 * Under an approval replay, record that the tool's output is not ready yet: the kernel's poll
 * job then asks the tool's `pollHandler` with `externalRef` until it is, and the approval
 * protocol wrapper leaves the execution at `awaiting_output` instead of marking it succeeded.
 * Returns false (nothing recorded) outside an approval.
 */
export async function recordAwaitingOutput(
  ctx: AppContext,
  externalRef: unknown,
): Promise<boolean> {
  const bridged = ctx as unknown as ApprovalBridges
  const approval = bridged.approval
  if (!approval || typeof bridged.approval_recordAwaitingOutput !== "function") return false
  await bridged.approval_recordAwaitingOutput(approval.toolName, JSON.stringify(externalRef))
  ctxsAwaitingOutput.add(ctx as object)
  return true
}

type MutationHandler = (params: Record<string, unknown>, ctx: AppContext) => Promise<unknown>

/**
 * Record this handler's approval-protocol outcome around its execution. Outside an approval
 * replay (no `ctx.approval`) it is a pass-through. Semantics:
 *   - entry → recordStarted
 *   - clean return → recordSucceeded, unless the handler recorded `awaiting_output` (its
 *     `pollHandler` finishes the execution) (an `{error}` envelope return — e.g. shopify_not_connected —
 *     records failed_no_effect instead: the operation definitively did not run)
 *   - throw with NO mutation sent on this ctx → recordFailedNoEffect (kernel reverts the
 *     approval to pending and surfaces the message — validation errors become retryable)
 *   - throw AFTER a mutation was sent → leave the `started` row (kernel: ambiguous, held)
 */
export function withApprovalProtocol(fn: MutationHandler): MutationHandler {
  return async (params, ctx) => {
    const bridged = ctx as unknown as ApprovalBridges
    const approval = bridged.approval
    if (!approval || typeof bridged.approval_recordStarted !== "function") return fn(params, ctx)
    await bridged.approval_recordStarted(approval.toolName)
    try {
      const result = await fn(params, ctx)
      const isErrorEnvelope =
        result != null &&
        typeof result === "object" &&
        "error" in result &&
        (result as { error?: unknown }).error != null
      if (isErrorEnvelope) {
        await bridged.approval_recordFailedNoEffect?.(
          approval.toolName,
          JSON.stringify((result as { error: unknown }).error),
        )
      } else if (!ctxsAwaitingOutput.has(ctx as object)) {
        await bridged.approval_recordSucceeded?.(approval.toolName)
      }
      return result
    } catch (err) {
      if (!ctxsWithExternalEffect.has(ctx as object)) {
        try {
          await bridged.approval_recordFailedNoEffect?.(
            approval.toolName,
            JSON.stringify({
              code: (err as { code?: string })?.code ?? "handler_error",
              message: err instanceof Error ? err.message : String(err),
            }),
          )
        } catch {
          // recording failure must not mask the real error; kernel falls back to ambiguous
        }
      }
      throw err
    }
  }
}

export interface UserError {
  field?: string[] | null
  message: string
  code?: string | null
}

/** Read `userErrors` (any of the *UserError variants) from a mutation payload and throw if non-empty. */
export function assertNoUserErrors(
  payload: Record<string, unknown> | undefined,
  mutationName: string,
): void {
  if (!payload) return
  // Shopify uses `userErrors` for most, `inventoryUserErrors` etc for a few.
  const keys = Object.keys(payload).filter((k) => k.endsWith("UserErrors") || k === "userErrors")
  for (const k of keys) {
    const errs = payload[k] as UserError[] | undefined
    if (errs && errs.length > 0) {
      const message = errs.map((e) => `${(e.field ?? []).join(".")}: ${e.message}`).join("; ")
      throw makeMutationError("SHOPIFY_USER_ERROR", `${mutationName}: ${message}`)
    }
  }
}

/**
 * Emit a kernel event with the canonical `{ entity, action }` identity. The
 * kernel keys the event as `${entity}:${action}` (validated against
 * `manifest.events.emits`) and composes the channel as
 * `events:shopify:${entity}:${action}`.
 *
 * `entityId` is mandatory for attention-item rendering (templates interpolate
 * `entityId` e.g. "Refund on order #{{entityId}}"). Callers resolve it from
 * the mutation response via `runMutation`'s `entityIdPath` arg.
 */
export async function emitMutationEvent(
  ctx: AppContext,
  entity: string,
  action: string,
  entityId: string | undefined,
  data: unknown,
): Promise<void> {
  await emitEvent(ctx, { entity, action, entityId, data })
}

/**
 * Resolve a dot-path against a payload (e.g. "refund.id" → payload.refund.id).
 * Numeric segments index into arrays ("metafields.0.id" → payload.metafields[0].id),
 * so collection-returning mutations can surface the first row's id.
 */
function resolveDotPath(payload: unknown, path: string): string | undefined {
  const parts = path.split(".")
  let cur: unknown = payload
  for (const p of parts) {
    if (cur == null) return undefined
    if (Array.isArray(cur)) {
      const idx = Number(p)
      if (!Number.isInteger(idx)) return undefined
      cur = cur[idx]
      continue
    }
    if (typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  if (cur == null) return undefined
  return String(cur)
}

/**
 * Tiny helper: run a mutation, assert no userErrors, emit the event, return data.
 * `dataKey` is the top-level field on `data` (e.g. "refundCreate"); the helper
 * extracts that node for the response.
 *
 * `entityIdPath` is the dot-path inside the extracted `node` payload where the
 * newly-created resource id lives (e.g. "refund.id" for refundCreate). It is
 * propagated into the emit envelope's `entityId` so attention-template
 * interpolation can resolve it.
 *
 * `entityIdOverride` supplies the entityId directly when it is NOT present in
 * the mutation response (e.g. `publishablePublish` returns only
 * `publishable { __typename }`, so the publishable id must come from the input
 * params). When set, it takes precedence over `entityIdPath`.
 */
export async function runMutation<T extends Record<string, unknown>>(
  ctx: AppContext,
  args: {
    query: string
    variables: Record<string, unknown>
    dataKey: string
    eventEntity: string
    eventAction: string
    entityIdPath?: string
    entityIdOverride?: string
    // Post-process the extracted node before it is returned and emitted —
    // e.g. resolving the order-then-draft PO-number fallback onto the node
    // in `draft_orders_complete`. Runs AFTER the userErrors/entityId checks
    // (which read the untransformed node), so it never affects error/id
    // resolution, only the payload callers see and the event carries.
    transformNode?: (node: Record<string, unknown>) => Record<string, unknown>
  },
): Promise<T> {
  const client = await getShopifyClient(ctx)
  let data: Record<string, T>
  try {
    data = await client.query<Record<string, T>>(args.query, args.variables)
  } catch (err) {
    // The mutation was SENT; a transport/GraphQL-level failure leaves it unknown whether it
    // landed — mark the ctx so withApprovalProtocol classifies the outcome as ambiguous.
    markExternalEffect(ctx)
    throw err
  }
  const node = data[args.dataKey]
  if (!node || typeof node !== "object") {
    // Response received but not the expected shape — conservatively treat as possibly-landed.
    markExternalEffect(ctx)
    throw makeMutationError("SHOPIFY_EMPTY_PAYLOAD", `${args.dataKey} returned no payload`, 502)
  }
  // A non-empty `userErrors` response is a DEFINITIVE rejection — Shopify did not apply the
  // mutation — so assertNoUserErrors throwing here does NOT mark an external effect: the
  // approval cleanly reverts to pending with Shopify's message instead of wedging.
  assertNoUserErrors(node as Record<string, unknown>, args.dataKey)
  markExternalEffect(ctx)
  const entityId =
    args.entityIdOverride ??
    (args.entityIdPath ? resolveDotPath(node, args.entityIdPath) : undefined)
  const emittedNode = args.transformNode
    ? args.transformNode(node as Record<string, unknown>)
    : node
  await emitMutationEvent(ctx, args.eventEntity, args.eventAction, entityId, emittedNode)
  return emittedNode as T
}

// Bare entity-name wrappers a weak model sometimes adds around a mutation's GraphQL input.
const INPUT_WRAPPER_KEYS = new Set([
  "input",
  "product",
  "variant",
  "order",
  "draftorder",
  "customer",
  "return",
  "returnrequest",
])

/**
 * Resolve a mutation's GraphQL input object from the tool params, unwrapping a REDUNDANT single-key
 * wrapper a weak model sometimes adds. The manifest declares `params.input` as the Shopify input
 * type, but a weak model intermittently re-wraps the fields under another key — e.g.
 * `{input: {productInput: {…}}}` or `{input: {input: {…}}}` — which Shopify rejects ("Field is not
 * defined on ProductInput"), 422ing the APPROVED gated write. Unwrap ONLY a single-key OBJECT whose
 * key is a known wrapper alias (literal `input`, any `*Input` key, or a bare entity name) — never a
 * legitimate single-field input (e.g. `{purchasingEntity: {…}}` or `{setQuantities: […]}` are left
 * untouched: `purchasingEntity` is not a wrapper alias and arrays are never unwrapped).
 */
export function resolveMutationInput(params: Record<string, unknown>): Record<string, unknown> {
  let v: unknown = params.input ?? params
  for (let i = 0; i < 4 && v && typeof v === "object" && !Array.isArray(v); i++) {
    const keys = Object.keys(v as Record<string, unknown>)
    if (keys.length !== 1) break
    const k = keys[0] as string
    const isWrapper = k === "input" || /input$/i.test(k) || INPUT_WRAPPER_KEYS.has(k.toLowerCase())
    const inner = (v as Record<string, unknown>)[k]
    if (!isWrapper || inner === null || typeof inner !== "object" || Array.isArray(inner)) break
    v = inner
  }
  return (v ?? {}) as Record<string, unknown>
}

// ─────────────────────────────────────────────────────────────────────────
//  DraftOrderInput normalisation (weak-model API-version drift)
// ─────────────────────────────────────────────────────────────────────────

export type ShopClient = Awaited<ReturnType<typeof getShopifyClient>>

export const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Pull a gid out of a string or an `{id}` object (a weak model passes either). */
export function gidFrom(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v
  if (isRec(v) && typeof v.id === "string" && v.id.length > 0) return v.id
  return undefined
}

// Shopify Admin API 2026-04 REQUIRES the `@idempotent(key:)` field directive on several write
// mutations (productVariantsBulk*, inventory*). A deterministic key derived from the operation makes a
// true retry idempotent without randomness (QuickJS-sandbox-safe). Bounded to Shopify's String length.
export const idempotencyKey = (prefix: string, payload: unknown): string =>
  `${prefix}:${JSON.stringify(payload)}`.slice(0, 250)
