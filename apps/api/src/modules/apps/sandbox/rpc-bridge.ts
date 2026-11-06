// SPDX-License-Identifier: FSL-1.1-ALv2

import type { RlsClient } from "~/db"
import type { RlsSession } from "~/db/rls"
import { readOnlyRunBlockedError } from "~/modules/agent/runtime/read-only-run"
import {
  captureReadOnlyRun,
  captureSpawnParentFrame,
  currentRunContext,
} from "~/modules/agent/runtime/run-context"
import { UNDECLARED_WRITE_TARGET } from "~/modules/agent/scopes/scope-taint"
import { createAgentMethods } from "~/modules/apps/sandbox/bridge/agent"
import { createApprovalsMethods } from "~/modules/apps/sandbox/bridge/approvals"
import { createCalendarMethods } from "~/modules/apps/sandbox/bridge/calendar"
import {
  type ActorType,
  createBridgeContext,
  type RpcBridgeApprovalContext,
  type RpcBridgeOptions,
} from "~/modules/apps/sandbox/bridge/context"
import { createContractsMethods } from "~/modules/apps/sandbox/bridge/contracts"
import { createConversionMethods } from "~/modules/apps/sandbox/bridge/conversion"
import { createDbMethods } from "~/modules/apps/sandbox/bridge/db"
import { createEffectsMethods } from "~/modules/apps/sandbox/bridge/effects"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import { createFilesMethods } from "~/modules/apps/sandbox/bridge/files"
import { createIdentityMethods } from "~/modules/apps/sandbox/bridge/identity"
import { createKnowledgeMethods } from "~/modules/apps/sandbox/bridge/knowledge"
import { createKnowledgeCurationMethods } from "~/modules/apps/sandbox/bridge/knowledge-curation"
import { createMailMethods } from "~/modules/apps/sandbox/bridge/mail"
import { createPlatformMethods } from "~/modules/apps/sandbox/bridge/platform"
import { createProjectsMethods } from "~/modules/apps/sandbox/bridge/projects"
import { type AppManifestForBridge, withPgCause } from "~/modules/apps/sandbox/bridge/shared"
import { createTicketsMethods } from "~/modules/apps/sandbox/bridge/tickets"
import { buildBridgeExtensions } from "~/modules/apps/sandbox/bridge-extensions"

export { formatStreamError } from "~/modules/apps/sandbox/bridge/agent"
export type { RpcBridgeOptions } from "~/modules/apps/sandbox/bridge/context"
export { jsonArray, jsonObject } from "~/modules/apps/sandbox/bridge/context"
export type { AppManifestForBridge } from "~/modules/apps/sandbox/bridge/shared"
export {
  coerceJson,
  extractRoutineBoundDocId,
  SandboxBridgeTestAccess,
} from "~/modules/apps/sandbox/bridge/shared"

/**
 * The sandbox host bridge. One method table composed from the per-capability
 * factories in ./bridge, every one closing over the same per-bridge context
 * (built per call, never module state). Extensions merge and read-only
 * refusals apply to the composed table, exactly as before the split.
 */
export function createRpcBridge(
  appName: string,
  userId: string,
  orgId: string,
  txDb: RlsClient,
  manifest: AppManifestForBridge,
  callerScopes?: string[],
  actorType: ActorType = userId === "system" || userId.startsWith("system:") ? "system" : "user",
  approvalContext?: RpcBridgeApprovalContext,
  bridgeOptions?: RpcBridgeOptions,
): Record<string, any> {
  const rpcBridge: Record<string, any> = {}
  const ctx = createBridgeContext(
    appName,
    userId,
    orgId,
    txDb,
    manifest,
    callerScopes,
    actorType,
    approvalContext,
    bridgeOptions,
    rpcBridge,
  )
  const { bridgeReadOnlyRun } = ctx
  Object.assign(
    rpcBridge,
    createIdentityMethods(ctx),
    createDbMethods(ctx),
    createPlatformMethods(ctx),
    createAgentMethods(ctx),
    createEgressMethods(ctx),
    createMailMethods(ctx),
    createApprovalsMethods(ctx),
    createTicketsMethods(ctx),
    createCalendarMethods(ctx),
    createConversionMethods(ctx),
    createProjectsMethods(ctx),
    createKnowledgeMethods(ctx),
    createKnowledgeCurationMethods(ctx),
    createFilesMethods(ctx),
    createContractsMethods(ctx),
    createEffectsMethods(ctx),
  )

  // Merge this app's own bridge methods (registered at install time). App-specific
  // operations live with the app, not on the generic kernel surface, so the bridge
  // never branches on an app-name literal to expose them. Extension methods may
  // override a generic method of the same name for that app only.
  const extensions = buildBridgeExtensions({
    appName,
    orgId,
    userId,
    txDb,
    actorType,
    callerScopes,
    ...(bridgeOptions?.signal ? { signal: bridgeOptions.signal } : {}),
  })
  for (const [name, fn] of Object.entries(extensions)) {
    rpcBridge[name] = fn
  }

  // A read-only run writes NOTHING through this surface. The generic db writes,
  // `messages_post` and the cross-app dispatch check the mark themselves, where
  // they can name their own write target; every other write method is refused
  // here, after the app's extensions are merged, so an app cannot reintroduce a
  // write by overriding one. An ordinary run gets the object back untouched.
  if (bridgeReadOnlyRun) {
    for (const name of READ_ONLY_REFUSED_BRIDGE_METHODS) {
      if (typeof rpcBridge[name] !== "function") continue
      rpcBridge[name] = async () => {
        throw readOnlyRunBlockedError(UNDECLARED_WRITE_TARGET, `ctx.${name}`)
      }
    }
  }

  return rpcBridge
}

// -- Session bridge (bridge-owned transactions) -------------------------------

/**
 * Bridge method groups that are EXTERNAL-I/O ONLY (no txDb use, verified:
 * imap-bridge.ts / smtp-bridge.ts never reference txDb). Invocations of these
 * run WITHOUT opening an RLS transaction — wrapping them would reintroduce
 * holding a pool connection across slow network I/O, the exact disease the
 * session bridge exists to cure. They execute against the poison-tx instance,
 * so any future txDb use inside them fails loudly instead of silently sharing
 * a stale transaction.
 */
/**
 * Bridge methods a READ-ONLY run (the Share anyway rerun, spec-security.md D4)
 * may not call, refused in `createRpcBridge` after the extensions merge.
 *
 * Listed by name rather than detected, because "does this method write" is not
 * visible from the closure. The list is deliberately over-inclusive: refusing a
 * read here only makes a disclosed answer thinner, which FX7 already accepts as
 * the cost, while missing a write repeats a side effect the requester never
 * asked to repeat. Pure reads (`*_get`, `*_search`, `*_list*`, `db_findMany`,
 * `db_findOne`, `db_count`, `config_get`, `connections_get*`, `time_civil`, the log
 * and codec helpers) are absent, so a rerun can still answer.
 *
 * A new write method goes here in the same change:
 * `tests/security/tool-side-effect-invariant.test.ts` enumerates the bridge and
 * fails on any method that is neither refused, self-guarding nor a reviewed read.
 *
 * NOT here, and deliberately: `db_insert`, `db_update`, `db_updateMany`,
 * `db_delete` and `messages_post` guard themselves with their real write target,
 * and `executeTool` forwards the mark so a nested READ still runs.
 *
 * KNOWN BOUND: `fetch` stays callable. It is how an app reads an external API,
 * and refusing it would empty most reruns; an outbound POST from an app's own
 * handler is therefore still reachable on a read-only run.
 */
const READ_ONLY_REFUSED_BRIDGE_METHODS: ReadonlySet<string> = new Set([
  // Settings-page writes (agentVisible: false tools): the mail providers switch, and the
  // synced sources' archive / run now (its list op is refused with them: never a read-only need).
  "mail_providersSet",
  "knowledge_syncedSources",
  // Kernel-generic writes
  "emit",
  "enqueueJob",
  "realtime_publish",
  "grants_setUserScopes",
  "agent_run",
  "agent_spawn",
  "requestApproval",
  "sequences_allocate",
  "pdf_render",
  "nextHandle",
  "invalidateIdempotency",
  "effects_claim",
  "effects_complete",
  "effects_release",
  "effects_settleUnknown",
  "effects_markUnknown",
  "mailbox_seal",
  "mailbox_sealAndInsert",
  "mailbox_enqueueClientJob",
  "smtp_send",
  "imap_writeBack",
  "bulk_fetchToBlob",
  "bulk_deleteBlob",
  "files_importFromUrl",
  "files_attachToParent",
  "files_reparent",
  "connections_disconnect",
  "mcp_createConnection",
  "approval_recordStarted",
  "approval_recordSucceeded",
  "approval_recordAwaitingOutput",
  "approval_recordEffectLanded",
  "approval_recordFailedNoEffect",
  "approval_recordAmbiguous",
  "config_setSecret",
  "contracts_setBinding",
  "contracts_grant",
  "files_importAttachment",
  // Spends the org's model credits on every call.
  "files_analyzeDocument",
  // Knowledge
  "knowledge_create",
  "knowledge_update",
  "knowledge_archive",
  "knowledge_restore",
  "knowledge_collection_create",
  "knowledge_collection_update",
  "knowledge_collection_delete",
  "knowledge_add_to_collection",
  "knowledge_remove_from_collection",
  "knowledge_verify",
  "knowledge_addFolderSource",
  "knowledge_source_link_create",
  // Tickets
  "tickets_validateAndApply",
  "tickets_setPriority",
  "tickets_create",
  "tickets_setCategory",
  "tickets_setLanguage",
  "tickets_setTeam",
  "tickets_setAudience",
  "tickets_assign",
  "tickets_merge",
  "tickets_markRead",
  "tickets_admin",
  "tickets_runJob",
  "tickets_runSync",
  "tickets_onGmailPushService",
  "tickets_processInboundMessage",
  "tickets_createFromMail",
  "tickets_conversion_closeAsMailConverted",
  "tickets_deleteIfUnreferenced",
  "tickets_pullMailReply",
  "tickets_summary_ensure",
  "tickets_summary_regenerate",
  "tickets_summary_runJob",
  // Calendar
  "calendar_onAccountConnected",
  "calendar_grantOrgAccess",
  "calendar_onAccountDisconnected",
  "calendar_runJob",
  "calendar_applyInitialSyncPages",
  "calendar_applyIncrementalSyncPages",
  "calendar_recoverFromSyncTokenGone",
  "calendar_importCalendars",
  "calendar_recordImportFailure",
  "calendar_retryImport",
  "calendar_setSelected",
  "calendar_handleWebhook",
  "calendar_recordWatchChannel",
  "calendar_channelToken",
  "calendar_stopWatchChannelOnly",
  "calendar_markCalendarPolled",
  "calendar_createEvent",
  "calendar_updateEvent",
  "calendar_deleteEvent",
  "calendar_applyPushResult",
  "calendar_handlePushConflict",
  "calendar_recordPushFailure",
  "calendar_revertToRemote",
  "calendar_applyRemoteDeletion",
  "calendar_markPushRejected",
  "calendar_notePushFailure",
  "calendar_finalizeRemoteDelete",
  "calendar_restoreRefusedDelete",
  // Mail
  "mail_writePage",
  "mail_completeIngest",
  "mail_purgeDisconnectedAccount",
  "mail_releaseForeignAccount",
  "mail_applyLabelDelta",
  "mail_conversion_markConverted",
  "mail_createFromTicket",
  "mail_appendInboundMessage",
  // Projects
  "projects_createProject",
  "projects_createTask",
  "projects_updateTask",
  "projects_moveTask",
  "projects_addStatus",
  "projects_updateStatus",
  "projects_updateProject",
  "projects_deleteStatus",
  "projects_deleteTask",
  "projects_mergeTasks",
  "projects_instantiateTemplate",
  "projects_addDependency",
  "projects_addComment",
  "projects_checklistAddItems",
  "projects_checklistRemoveItem",
  "projects_checklistSetValidation",
  "projects_checklistUpdateItem",
  "projects_labelsCreate",
  "projects_labelsUpdate",
  "projects_labelsArchive",
  "projects_labelsReorder",
  // Google Drive (bridge extension, merged above)
  "drive_onAccountDisconnected",
])

// `effects_*` (the effect ledger) write through the privileged pool, never txDb, and
// MUST be served by the one tx-less instance: each bridge build names its own claimer
// (`<instance>:<run>`), and only the claimer that claimed a key may complete, release or
// mark it. A per-call rebuild would hand `markUnknown` a stranger's claimer, leave the
// claim pending, and the next run would see it in flight instead of asking the remote side.
const SESSION_TXLESS_METHOD_PREFIXES = ["imap_", "smtp_", "codec_", "effects_"]
// Exact-name tx-less methods. `fetch` is the workhorse external-HTTP surface
// (domain-allowlist + pinned-host fetch, zero txDb use) — wrapping it would
// pin a connection for every outbound HTTP roundtrip. connections_* are NOT
// tx-less: they read connection rows via txDb.
// The api-connector's `connector_*` methods are external HTTP too (an adapter
// call can take seconds): they read and audit through the privileged pool and
// never touch txDb.
const SESSION_TXLESS_METHOD_NAMES = new Set([
  "fetch",
  "connector_list_operations",
  "connector_read",
  "connector_write",
  "connector_write_validate",
  // Adapter authoring reads: the privileged pool and, for the test call, the vendor.
  "connector_adapter_get",
  "connector_adapter_versions",
  "connector_adapter_reference",
  "connector_adapter_test",
])

function isTxlessSessionMethod(name: string): boolean {
  return (
    SESSION_TXLESS_METHOD_NAMES.has(name) ||
    SESSION_TXLESS_METHOD_PREFIXES.some((p) => name.startsWith(p))
  )
}

/**
 * Poison transaction: any property access throws. Used for (a) enumerating the
 * bridge's method names without a live transaction and (b) executing the
 * declared tx-less (external-I/O-only) methods, where a db touch is a bug.
 */
function poisonTx(context: string): RlsClient {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === "symbol" || prop === "then") return undefined
        throw new Error(
          `Sandbox bridge attempted db access via txDb.${String(prop)} ${context} — ` +
            "this bridge path runs without a transaction (createSessionRpcBridge). " +
            "If this method genuinely needs the database, remove it from " +
            "SESSION_TXLESS_METHOD_PREFIXES.",
        )
      },
    },
  ) as unknown as RlsClient
}

/**
 * Inline a postgres cause into the message of anything a bridge method throws.
 *
 * Only `message` survives the sandbox worker IPC boundary (the `.cause` chain
 * is dropped), so an error whose SQLSTATE lives on `.cause.code` reaches
 * executeTool's classifier statusless and codeless: a caller mistake such as
 * a slug passed where a uuid id is expected (22P02) then escapes as an
 * error-level log plus HTTP 500 instead of a typed `invalid_params`. Applying
 * this to EVERY bridge method is what makes that classification universal;
 * four hand-wrapped call sites (db_update / db_updateMany / db_delete /
 * tickets_markRead) left every other method uncovered. Those per-site wraps
 * stay: they also serve the ambient `createRpcBridge` path (atomic tools,
 * jobs), which does not pass through here, and double-wrapping is a no-op
 * because the rewrapped error carries no `.cause`.
 *
 * Errors that already carry their own typed classification are passed through
 * untouched: a `safe` app-sdk ToolError (its `safe`/`code`/`retryable` markers
 * would be lost by the rewrap) and anything with an HTTP `status` (the typed
 * 4xx path in executeTool).
 */
function inlinePgCause(err: unknown, methodName: string): unknown {
  if (!err || typeof err !== "object") return err
  const e = err as { cause?: { message?: string }; safe?: unknown; status?: unknown }
  if (!e.cause?.message) return err
  if (e.safe === true || e.status !== undefined) return err
  return withPgCause(err, `${methodName} failed`)
}

/**
 * The handler-facing view of an AMBIENT bridge (`createRpcBridge`, used by
 * `atomic: true` tools) with the same pg-cause inlining the session bridge
 * applies per method. Without it a 22P02 raised by any bridge method of an
 * atomic tool crossed the sandbox IPC as a bare "Failed query" text, so
 * executeTool could not classify it and logged a caller mistake at error
 * level with a 500. Returns a shallow copy: the bridge's own internal
 * cross-method calls keep the raw errors (and their `.cause`). Sync members
 * stay the same function so the executor's AsyncFunction dispatch holds.
 */
export function inlinePgCauseOnBridge(bridge: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [name, member] of Object.entries(bridge)) {
    if (typeof member !== "function" || member.constructor.name !== "AsyncFunction") {
      out[name] = member
      continue
    }
    out[name] = async (...args: unknown[]) => {
      try {
        return await member(...args)
      } catch (err) {
        throw inlinePgCause(err, name)
      }
    }
  }
  return out
}

/**
 * Session-scoped RPC bridge: same surface as `createRpcBridge`, but each
 * bridge METHOD INVOCATION runs in its own short-lived RLS transaction
 * (`session.run`), so the host holds NO Postgres connection while the sandbox
 * is doing IPC / external HTTP between calls. This makes pool demand
 * proportional to actual SQL time instead of handler wall-clock time.
 *
 * Semantics (deliberate, spec-pinned): one bridge call = one transaction. A
 * method's own writes + queued outbox events stay atomic; SEPARATE bridge
 * calls no longer roll back together when the handler later throws. Tools
 * that need whole-run atomicity keep the legacy ambient-transaction path via
 * `atomic: true` on their manifest declaration (see executeToolHandler).
 *
 * Implementation notes:
 * - The generic bridge + extensions capture `txDb` in closures at construction,
 *   so the wrapper reconstructs those closures per invocation with the live
 *   per-call transaction. Handler-lifetime state is preserved across rebuilds
 *   by injection: the ALS routine-tick id (captured HERE, in-frame) and the
 *   bulk.fetch cursor store travel via bridgeOptions into every rebuild.
 * - Construction is pure closure creation (no queries) — enumerating method
 *   names uses a poison tx that throws on any db touch.
 * - Declared external-I/O-only methods (imap_*, smtp_*) run WITHOUT a
 *   transaction so they never pin a connection during network I/O.
 */
export function createSessionRpcBridge(
  appName: string,
  userId: string,
  orgId: string,
  session: RlsSession,
  manifest: AppManifestForBridge,
  callerScopes?: string[],
  actorType: "user" | "agent" | "system" | "mcp" = userId === "system" ||
  userId.startsWith("system:")
    ? "system"
    : "user",
  approvalContext?: {
    approvalRequestId: string
    approvalDeciderId: string
    toolName: string
    approvalExecutionId?: string
  },
  bridgeOptions?: Parameters<typeof createRpcBridge>[8],
): Record<string, any> {
  // Handler-lifetime state, captured once (in the caller's ALS frame) and
  // injected into every per-call bridge rebuild.
  const sharedOptions: NonNullable<Parameters<typeof createRpcBridge>[8]> = {
    ...bridgeOptions,
    routineIdOverride: bridgeOptions?.routineIdOverride ?? currentRunContext()?.routineId,
    // Captured HERE, in the caller's frame: the per-call rebuild below runs
    // outside it, so a read-only run would otherwise rebuild as a writable one.
    readOnlyRunOverride: bridgeOptions?.readOnlyRunOverride ?? captureReadOnlyRun(),
    spawnParentFrameOverride:
      bridgeOptions?.spawnParentFrameOverride !== undefined
        ? bridgeOptions.spawnParentFrameOverride
        : captureSpawnParentFrame({ includeCallingTool: true }),
    // Captured here too: a per-call bridge REBUILD happens outside the frame,
    // so without this every rebuilt bridge would see no turn and write an
    // untagged document.
    writeParentFrameOverride:
      bridgeOptions?.writeParentFrameOverride !== undefined
        ? bridgeOptions.writeParentFrameOverride
        : captureSpawnParentFrame(),
    bulkCursorStore:
      bridgeOptions?.bulkCursorStore ??
      new Map<string, { iterator: AsyncIterator<unknown[]> | null; done: boolean }>(),
    mailboxSnapshot: bridgeOptions?.mailboxSnapshot ?? { value: null },
    attachmentBytesLedger: bridgeOptions?.attachmentBytesLedger ?? {
      importAttachment: { cumulative: 0 },
      getAttachmentBytes: { cumulative: 0 },
    },
    withShortTx: <T>(fn: (tx: RlsClient) => Promise<T>) => session.run(fn),
  }

  const buildWith = (tx: RlsClient): Record<string, any> =>
    createRpcBridge(
      appName,
      userId,
      orgId,
      tx,
      manifest,
      callerScopes,
      actorType,
      approvalContext,
      sharedOptions,
    )

  // Enumerate the method surface once. Construction only creates closures; the
  // poison tx guarantees that assumption (a query during construction throws).
  const enumerationInstance = buildWith(poisonTx("during bridge construction"))
  const txlessInstance = buildWith(poisonTx("inside a tx-less (external-I/O-only) method"))

  const sessionBridge: Record<string, any> = {}
  for (const [name, member] of Object.entries(enumerationInstance)) {
    if (typeof member !== "function") {
      sessionBridge[name] = member
      continue
    }
    // SYNC bridge methods (getUserId/getOrgId — plain closures over captured
    // ids) MUST stay genuinely synchronous: the in-process executor dispatches
    // on `fn.constructor.name === "AsyncFunction"` (a sync method wrapped in an
    // async wrapper would marshal the PROMISE into QuickJS) and pre-bakes the
    // sync getters at construction. They cannot touch the db (db access is
    // async), so the poison-tx instance is safe to serve them from.
    if (member.constructor.name !== "AsyncFunction") {
      sessionBridge[name] = txlessInstance[name]
      continue
    }
    if (isTxlessSessionMethod(name)) {
      // External-I/O-only, no tx — still wrapped so a pg cause raised by a
      // helper inside one of them survives the IPC boundary.
      const txlessMethod = txlessInstance[name]
      sessionBridge[name] = async (...args: unknown[]) => {
        try {
          return await txlessMethod(...args)
        } catch (err) {
          throw inlinePgCause(err, name)
        }
      }
      continue
    }
    // NOTE: must be a genuine `async` function (not a promise-returning arrow):
    // the executor's AsyncFunction check above decides QuickJS marshaling.
    sessionBridge[name] = async (...args: unknown[]) => {
      try {
        return await session.run((tx) => buildWith(tx)[name](...args))
      } catch (err) {
        throw inlinePgCause(err, name)
      }
    }
  }
  return sessionBridge
}
