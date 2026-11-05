// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared, precise tool/handler context for the Social app. Mirrors
// BoxtalToolCtx: a structural superset every handler reads from, so a single
// typed `ctx` flows through reads/post-back/sync without casts.

import type { CrossAppEnvelope, DbClient } from "@liaison/app-sdk"

export type { CrossAppEnvelope }

export interface SocialLogger {
  info?(msg: string, data?: unknown): void
  warn?(msg: string, data?: unknown): void
  error?(msg: string, data?: unknown): void
  debug?(msg: string, data?: unknown): void
}

/** Minimal fetch shape the platform adapters use (host-provided). This is the
 *  sandbox SDK contract: a plain serialized `{status, headers, body}` record
 *  where `body` is the raw response STRING — NOT a browser Response (no .ok /
 *  .json()/.text(); typing those compiles but throws "not a function" live). */
export type SocialFetch = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string | Record<string, unknown>
  },
) => Promise<{
  status: number
  headers?: Record<string, string>
  body: string
}>

/** Approval re-entry envelope (set on re-entry after a human approves). */
export interface SocialApproval {
  approvalRequestId: string
}

/**
 * The context every Social tool/handler receives. `db` is the generic CRUD
 * bridge; `fetch` is the host fetch; `connections` is the credentials accessor;
 * `config.get` reads kernel-minted app config; `requestApproval` opens a gated
 * approval; `enqueueJob` schedules async work (e.g. webhook parse); `emit`
 * publishes a declared app event.
 */
export interface SocialToolCtx {
  orgId: string
  /** The sandbox host's org accessor; `orgId` itself is unset there. */
  getOrgId?: () => string | Promise<string>
  db: DbClient
  fetch: SocialFetch
  connections: unknown
  config: { get(key: string): Promise<unknown> }
  approval?: SocialApproval
  // The host bridge's `requestApproval` expects snake_case
  // `{ tool_name, summary, current_payload, editable_fields? }` (NOT `{ tool, params }`)
  // and returns `{ approval_id }`. The re-entry then re-invokes `tool_name` with
  // `current_payload` and `ctx.approval` set. (Mirrors invoicing's MutationsCtx.)
  // `auto_approved: true` means carry on now, nothing was filed: a person's own
  // call that holds the deciding scope (approvals are for agents) is granted
  // inline, and so is a call an auto-approve policy answers.
  requestApproval?: (input: {
    tool_name: string
    summary: string
    /** Optional structured detail rendered on the approval card (subtitle + up
     *  to 8 lines + up to 10 entity links). Without it the card shows only the
     *  plain-string `summary` as a title with empty lines below — see the
     *  kernel's `HandlerApprovalInput` (apps/api/src/modules/apps/execute-tool.ts). */
    summary_detail?: {
      subtitle?: string
      lines?: string[]
      links?: Array<{ label: string; app: string; entityType: string; entityId: string }>
    }
    current_payload: unknown
    editable_fields?: string[]
  }) => Promise<
    { approval_id: string; auto_approved?: undefined } | { approval_id: string | null; auto_approved: true }
  >
  /** Read-only view of this app's own approvals. `pendingFor(key, toolNames?)`
   *  lists the requests still awaiting a decision on this app's tools whose
   *  payload carries `key`, newest first, as `[{ id, tool_name, target_id,
   *  payload, created_at }]` (a JSON string when called with primitives only). */
  approvals?: {
    pendingFor?: (payloadKey: string, toolNames?: string[]) => Promise<unknown>
  }
  enqueueJob?: (jobName: string, payload: unknown) => Promise<void>
  emit?: (event: { entity: string; action: string; entityId?: string; data?: unknown }) => Promise<void>
  // Resolve-or-create a kernel contact for an external author/participant
  // (§5/§6). Returns the contact row (`{ id }`); the app stores `id` as the
  // finding/conversation `contact_id` so a contact's social history is joinable.
  resolveContact?: (params: {
    email?: string
    name?: string
    externalId?: string
    clear?: boolean
  }) => Promise<{ id?: string } | null>
  executeTool?: (
    target: string,
    args: string | Record<string, unknown>,
  ) => Promise<CrossAppEnvelope>
  logger?: SocialLogger
}
