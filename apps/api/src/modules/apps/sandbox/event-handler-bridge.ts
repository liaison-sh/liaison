// SPDX-License-Identifier: FSL-1.1-ALv2
import type { RlsClient } from "~/db"
import type { RlsSession } from "~/db/rls"
import type { ActorType } from "~/modules/apps/sandbox/bridge/context"
import type { AppManifestForBridge } from "~/modules/apps/sandbox/bridge/shared"
import { createSandboxRpcBridge, createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

/**
 * The bridge a manifest EVENT handler runs with. The handler holds its own
 * app's scopes (`<app>:*`) whoever caused the event, and a job it enqueues runs
 * with those same app scopes, as the app's cron runs of that job do.
 *
 * The event's actor is NOT stamped on such a job. It used to be, with the
 * `<app>:*` snapshot beside it, so the worker narrowed the job to whatever that
 * actor happened to hold in the app: a mailbox reconnect by someone holding no
 * mail scope enqueued a sync that failed on every attempt with "Job requested
 * scopes not held by user", and the mailbox stayed unsynced until the next cron.
 */
export function createEventHandlerBridge(args: {
  appName: string
  actorId: string
  orgId: string
  txDb: RlsClient
  manifest: AppManifestForBridge
  actorType: ActorType
}): Record<string, any> {
  return createSandboxRpcBridge(
    args.appName,
    args.actorId,
    args.orgId,
    args.txDb,
    args.manifest,
    [`${args.appName}:*`],
    args.actorType,
    undefined,
    { jobsAttributedToSystem: true },
  )
}

/**
 * The same bridge for a handler that holds no transaction across its run
 * (modules/apps/run-wide-tx.ts): each bridge call runs in its own short
 * transaction from `session`, with the same identity, scopes and job
 * attribution as above.
 */
export function createEventHandlerSessionBridge(args: {
  appName: string
  actorId: string
  orgId: string
  session: Pick<RlsSession, "run">
  manifest: AppManifestForBridge
  actorType: ActorType
}): Record<string, any> {
  return createSessionRpcBridge(
    args.appName,
    args.actorId,
    args.orgId,
    args.session,
    args.manifest,
    [`${args.appName}:*`],
    args.actorType,
    undefined,
    { jobsAttributedToSystem: true },
  )
}
