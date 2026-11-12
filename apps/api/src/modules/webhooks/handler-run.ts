// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * One run of an app's webhook handler, and how its result reads. Shared by the
 * inbound route (the first attempt, modules/webhooks/routes.ts) and the inbox
 * replay job (infra/jobs/webhook-inbox-jobs.ts), so a replay calls the handler
 * exactly as the delivery did: same actor, scopes, bridge, payload and the
 * lowercased header dict as its 3rd argument. The handler call itself is the
 * executor's (QuickJS or Workers), unchanged.
 */
import { and, asc, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { users } from "~/db/schema/kernel"
import {
  isManifestHandler,
  type ManifestHandlerRef,
  type webhookHandlers,
} from "~/modules/apps/app-registries"
import { createAppContext } from "~/modules/apps/context"
import { handlerRunHoldsTx } from "~/modules/apps/run-wide-tx"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { createSandboxRpcBridge, createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { executeManifestWebhook } from "~/modules/webhooks/manifest-execution"

export type WebhookRegistration = NonNullable<ReturnType<typeof webhookHandlers.get>>

/**
 * U4.12 (CI→projects webhook): a webhook whose manifest entry sets
 * `requiresUserActor: true` needs its RLS session's `app.current_user_id` to
 * be a REAL user — some kernel-owned, user-scoped tables (e.g.
 * `kernel.thread_participants`) have a `WITH CHECK (user_id =
 * current_setting('app.current_user_id')::uuid OR ...)` RLS policy that a
 * `SystemContext` actor (no user id, by design — a webhook's HMAC trust
 * boundary is not a specific human) can never satisfy. Resolve the org's
 * oldest ACTIVE user as the acting identity — the same "admin fallback until
 * personas are active" convention the provisioners use. Every other webhook
 * never sets the flag and is unaffected.
 */
export async function resolveWebhookUserActorId(orgId: string): Promise<string | null> {
  const [row] = await withPrivilegedDb(orgId, "webhook-user-actor-fallback", (db) =>
    db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.status, "active")))
      .orderBy(asc(users.createdAt))
      .limit(1),
  )
  return row?.id ?? null
}

/** The handler's acting identity: a system actor, or the org's fallback user when required. */
export function webhookActorFor(
  orgId: string,
  scopes: string[],
  userActorId: string | null,
): ActorContext {
  return userActorId
    ? {
        actorType: "user",
        userId: userActorId,
        orgId,
        scopes,
        dimensionGrants: { "*": ["*"] },
      }
    : { actorType: "system", orgId, purpose: "webhook", scopes }
}

function emptyManifest(appName: string) {
  return { name: appName, schema: {}, events: {}, connections: {}, network: {} }
}

/** Injectable seam so tests can observe the handler call without a sandbox. */
type ManifestExecutor = typeof executeManifestWebhook
let manifestExecutor: ManifestExecutor = executeManifestWebhook

/**
 * Whether a delivery of `registration` holds one transaction for the handler's
 * whole run (run-wide-tx.ts): a host (non-manifest) handler, a core app's, or a
 * listed exception's. A sandboxed app's handler otherwise opens a short
 * transaction per bridge call, and its caller takes no pinned jobs slot for it.
 */
export function webhookRunHoldsTx(registration: WebhookRegistration, appName: string): boolean {
  if (!isManifestHandler(registration.handler)) return true
  const ref = registration.handler as ManifestHandlerRef
  return handlerRunHoldsTx({
    trusted: ref.trusted === true,
    app: appName,
    entry: `webhook:${ref.exportName}`,
  })
}

/**
 * Run the handler once on the background pool (never the interactive request
 * pool: a burst of deliveries must not starve MCP/HTTP/agent traffic), as the
 * delivery's actor. A sandboxed app's handler gets a short transaction per
 * bridge call (none is open while it calls a provider); a core app's, a listed
 * exception's and a host handler run inside one transaction. Returns what the
 * handler returned.
 */
export async function runWebhookHandler(args: {
  registration: WebhookRegistration
  appName: string
  orgId: string
  scopes: string[]
  userActorId: string | null
  payload: unknown
  headers: Record<string, string>
  timeoutMs?: number
}): Promise<unknown> {
  const { registration, appName, orgId, scopes, userActorId, payload, headers } = args
  const actor = webhookActorFor(orgId, scopes, userActorId)
  if (!webhookRunHoldsTx(registration, appName)) {
    const handlerRef = registration.handler as ManifestHandlerRef
    const bridge = createSessionRpcBridge(
      appName,
      userActorId ?? "system",
      orgId,
      { run: (fn) => withRlsContext(actor, fn, { pool: "jobs" }) },
      registration._manifest ?? emptyManifest(appName),
      scopes,
      userActorId ? "user" : "system",
      undefined,
      { actor },
    )
    return manifestExecutor({
      appName,
      orgId,
      holdsTx: false,
      handlerRef,
      bundleSource: await loadBundle(handlerRef.bundlePath),
      params: payload,
      bridge,
      // The lowercased inbound header dict, the handler's 3rd argument
      // (e.g. Shopify dedups off x-shopify-webhook-id).
      extraArgs: [headers],
      ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
    })
  }
  return withRlsContext(
    actor,
    async (tx) => {
      if (isManifestHandler(registration.handler)) {
        const handlerRef = registration.handler as ManifestHandlerRef
        const manifest = registration._manifest ?? emptyManifest(appName)
        const bridge = createSandboxRpcBridge(
          appName,
          userActorId ?? "system",
          orgId,
          tx,
          manifest,
          scopes,
          userActorId ? "user" : "system",
          undefined,
          { actor },
        )
        const source = await loadBundle(handlerRef.bundlePath)
        return manifestExecutor({
          appName,
          orgId,
          // Inside the delivery's withRlsContext transaction.
          holdsTx: true,
          handlerRef,
          bundleSource: source,
          params: payload,
          bridge,
          // The lowercased inbound header dict, the handler's 3rd argument
          // (e.g. Shopify dedups off x-shopify-webhook-id).
          extraArgs: [headers],
          ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
        })
      }
      const ctx = createAppContext(appName, "system", orgId, tx)
      return (registration.handler as (payload: unknown, ctx: any) => Promise<unknown>)(
        payload,
        ctx,
      )
    },
    { pool: "jobs" },
  )
}

/**
 * How a handler's return reads. Manifest handlers report through a returned
 * `{ status, body? }` (they do not throw on a transient downstream failure);
 * a handler that returns nothing (legacy `Promise<void>`) succeeded.
 * - `ok`: 2xx or no status;
 * - `rejected`: a 4xx other than 408/429, the handler refusing the delivery
 *   (malformed envelope, unknown value): re-sending the same payload can only
 *   fail the same way, so it is never retried;
 * - `transient`: anything else (5xx, 408, 429, other non-2xx): retried.
 */
export type HandlerOutcome =
  | { kind: "ok"; body: Record<string, unknown> | null }
  | { kind: "rejected"; status: number; message: string }
  | { kind: "transient"; status: number }

export function classifyHandlerResult(result: unknown): HandlerOutcome {
  const status = extractHandlerStatus(result)
  if (status !== null && isPermanentRejection(status)) {
    return { kind: "rejected", status, message: extractRejectionMessage(result) }
  }
  if (status !== null && (status < 200 || status >= 300)) return { kind: "transient", status }
  return { kind: "ok", body: extractHandlerJsonBody(result) }
}

const MAX_REJECTION_MESSAGE_LENGTH = 500

function isPermanentRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

/** The handler's rejection text (its `body` string), bounded; a generic message when it gave none. */
function extractRejectionMessage(result: unknown): string {
  if (result && typeof result === "object" && "body" in result) {
    const body = (result as { body: unknown }).body
    if (typeof body === "string" && body.trim().length > 0) {
      return body.trim().slice(0, MAX_REJECTION_MESSAGE_LENGTH)
    }
  }
  return "Webhook rejected"
}

/**
 * The handler's 2xx body when it is a JSON object (a JSON-encoded string, the
 * manifest handler shape, or a plain object). Anything else yields `null`.
 */
function extractHandlerJsonBody(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object" || !("body" in result)) return null
  let body: unknown = (result as { body: unknown }).body
  if (typeof body === "string") {
    try {
      body = JSON.parse(body)
    } catch {
      return null
    }
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>
  }
  return null
}

/** A numeric HTTP-like status from a handler's return value, or null when it has none. */
function extractHandlerStatus(result: unknown): number | null {
  if (result && typeof result === "object" && "status" in result) {
    const status = (result as { status: unknown }).status
    if (typeof status === "number" && Number.isFinite(status)) return status
  }
  return null
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const WebhookHandlerRunTestAccess = {
  /** Test-only: override the manifest executor; pass nothing to restore. */
  setManifestExecutor(fn?: ManifestExecutor): void {
    manifestExecutor = fn ?? executeManifestWebhook
  },
}
