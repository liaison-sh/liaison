// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A read-only run: every method of the sandbox host bridge is refused, guards
// itself, or is a reviewed read. A new bridge method fails this file until it
// is classified.
//
// Pure (a poison transaction, no database or service), so the per-PR `static`
// job runs it (.github/workflows/ci.yml) besides the security suite: a bridge
// method nobody classified cannot reach main. The database-backed side-effect
// invariants are in tool-side-effect-invariant.test.ts.

import { describe, expect, it } from "bun:test"
import { TICKETS_ADMIN_READ_OPS } from "~/modules/apps/sandbox/bridge/tickets"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

// ─── 1. read-only run: the bridge ───────────────────────────────────────────

/** Bridge methods that check the read-only mark themselves, naming their real write target. */
const SELF_GUARDING = new Set([
  "db_insert",
  "db_insertNow",
  "db_update",
  "db_updateNow",
  "db_updateMany",
  "db_delete",
  // Refuses before its first op, naming each op's table (bridge/batch.ts).
  "db_batch",
  "messages_post",
  "executeTool",
  // Forwards the run's mark into the contract op's executeTool (bridge/contracts.ts:298).
  "contracts_call",
  // Serves the tickets app's reads and writes: on a read-only run it runs only the ops in
  // TICKETS_ADMIN_READ_OPS and refuses every other one (bridge/tickets.ts).
  "tickets_admin",
  // Lists the synced sources on a read-only run; refuses archive and run now (bridge/knowledge-curation.ts).
  "knowledge_syncedSources",
  // Looks a contact up and returns it unchanged on a read-only run: no link, no enrichment,
  // no create, and `clear` refuses (bridge/db.ts resolveContact, contacts/service.ts lookupOnly).
  "resolveContact",
  // Opt-outs: both refuse on a read-only run, naming kernel.suppressions (bridge/mail.ts).
  "mail_suppressionAdd",
  "mail_suppressionRemove",
])

/**
 * Bridge methods a read-only run may still call, each reviewed as a read (or
 * as a known bound, with the reason). Anything not refused and not listed fails.
 */
const REVIEWED_NOT_REFUSED: Record<string, string> = {
  _approvalContext_get: "read",
  // A step's saved cursor for a status view (bridge/steps.ts); its writes are refused.
  steps_get: "read",
  agent_awaitRun: "read",
  approvals_pendingFor: "read",
  approvals_statusOf: "read",
  bulk_iterateJsonl_next: "read",
  calendar_findCalendarsForPollFallback: "read",
  calendar_findAccountsForListRefresh: "read",
  // The caller's view of one event; checks calendar:events:read (bridge/calendar.ts).
  calendar_getEventForCaller: "read",
  // find_free_slots' inputs: the caller's and org teammates' busy events, profile zone and the
  // recorded grant, all SELECTs; the Google free/busy query runs in the app via fetch.
  calendar_freeBusyContext: "read",
  mail_providersGet: "read",
  // A timeline source's rows, inside a read-only savepoint that is rolled back (contacts/activity.ts).
  mail_activityRead: "read (withReadOnlySource)",
  calendar_activityRead: "read (withReadOnlySource)",
  projects_activityRead: "read (withReadOnlySource)",
  tickets_activityRead: "read (withReadOnlySource)",
  mail_suppressionCheck: "read",
  calendar_findCalendarsForWatchRenewal: "read",
  calendar_findStalePendingPushes: "read",
  calendar_getAccount: "read",
  calendar_getCalendar: "read",
  calendar_getEvent: "read",
  calendar_listAccounts: "read",
  calendar_listCalendars: "read",
  calendar_listEvents: "read",
  calendar_searchEvents: "read",
  callerHasScope: "read",
  config_get: "read",
  config_has: "read",
  crypto_hmacSha256Base64ForConfig: "read",
  crypto_verifyHmacForConfig: "read",
  time_civil: "read",
  // A decided client action of the calling app's own target, as recorded (bridge/client-actions.ts).
  client_actions_record: "read",
  // The id of the contact group the calling app keeps under a key, or null (bridge/client-actions.ts).
  client_actions_own_group: "read",
  // Renders a filled rich-text source to bytes in memory; stores nothing (bridge/rich-text.ts).
  rich_text_render: "read",
  // An uploaded PDF checked, or a frozen one scanned again, in the render service and the
  // virus scanner; stores nothing, and a hit only raises the security event (bridge/pdf-upload.ts).
  pdf_upload_check: "read; a virus hit raises a security event only",
  pdf_upload_rescan: "read; a virus hit raises a security event only",
  // The calling turn's agent and whether a person is behind it, from the captured frame.
  turn_get: "read",
  // A provider throttle signal (connection-limiter.ts): delays later calls, writes no data.
  limiter_pause: "throttle signal, no data written",
  connections_describe: "read",
  connections_getAccounts: "read",
  connections_getCredentials: "read",
  connections_getSettings: "read",
  connections_getToken: "read",
  contracts_binding: "read",
  contracts_providers: "read",
  db_count: "read",
  db_findMany: "read",
  db_findOne: "read",
  files_getAttachmentBytes: "read",
  files_listAttachments: "read",
  getCallerApp: "read",
  getIngestionCallerApp: "read",
  getOrgId: "read",
  getOrgSettings: "read",
  getUserId: "read",
  getUserSettings: "read",
  hasOnlineUsers: "read",
  hasScope: "read",
  kernel_findContactsByExternalId: "read",
  kernel_findOne: "read",
  kernel_findByIds: "read",
  // Directory reads of the app's own org (bridge/directory.ts).
  kernel_caller: "read",
  kernel_roles: "read",
  kernel_findUsersByEmail: "read",
  // Platform-held SQL connections: a READ ONLY transaction on the app's own
  // connection (connections/sql/service.ts); the audit line is the kernel's.
  sql_query: "read",
  sql_reads: "read",
  sql_schema: "read",
  sql_probe: "read",
  accounts_list: "read",
  kernel_listApprovals: "read",
  knowledge_appSource: "read",
  knowledge_attentionItems: "read",
  knowledge_create_validate: "read",
  knowledge_find_by_title: "read",
  knowledge_get: "read",
  knowledge_search: "read",
  knowledge_update_validate: "read",
  listContactsByExternalId: "read",
  log_debug: "read",
  log_error: "read",
  log_info: "read",
  log_warn: "read",
  mail_conversion_readConversation: "read",
  mail_buildSendGuard: "read (computes the send check value; stores nothing)",
  mail_checkSendGuard: "read (evaluates the send check at send; stores nothing)",
  mail_search: "read",
  mcp_checkConnectionWrite: "read",
  mcp_listConnections: "read",
  projects_attentionItems: "read",
  projects_checklistGet: "read",
  projects_companyProjects: "read",
  projects_dealSendState: "read",
  projects_dealsFollowupCandidates: "read",
  projects_dealsRollup: "read",
  projects_dealsSearch: "read",
  projects_get: "read",
  projects_labelsList: "read",
  projects_labelsTree: "read",
  projects_listComments: "read",
  projects_listTemplates: "read",
  projects_portfolioRollup: "read",
  projects_tasksAggregate: "read",
  projects_resolveAssignee: "read",
  projects_search: "read",
  projects_taskTimeGet: "read",
  projects_budgetGet: "read",
  projects_marginCost: "read",
  projects_costRatesList: "read",
  projects_capacityGet: "read",
  projects_timesheetGet: "read",
  projects_timesheetExport:
    "read (stages one file only the caller reads, like a dashboard PDF; writes no record)",
  projects_daysOffList: "read",
  projects_timeSettingsGet: "read",
  projects_reconcileFacts: "read",
  projects_reconcileLinesRead: "read",
  projects_milestoneStatusRead: "read",
  projects_clientReportsList: "read",
  projects_clientReportGet: "read",
  projects_clientReportSources: "read",
  projects_clientReportSendPreflight: "read (checks a send before its card; stores nothing)",
  projects_timePlanSetPreflight: "read (checks a plan change before its card; stores nothing)",
  projects_milestoneClientActionView: "read",
  projects_tasksByAssignee: "read",
  projects_tasksByProject: "read",
  pubsub_verifyGoogleOidcJwt: "read",
  store_count: "read",
  store_get: "read",
  store_query: "read",
  tickets_attentionItems: "read",
  tickets_conversion_readTicket: "read",
  tickets_get: "read",
  tickets_inboxCounts: "read",
  tickets_listForContact: "read",
  tickets_listSyncableAccounts: "read",
  tickets_search: "read",
  imap_fetch: "read of the connected mailbox (no flag or move op)",
  evidence_rehash: "read: SHA-256 of the agreements app's own stored evidence files, never bytes",
  fetch: "KNOWN BOUND (rpc-bridge.ts:155-157): outbound HTTP stays callable on a read-only run",
}

/**
 * Bridge writes that were once missing from the refusal list (neither refused nor checking the
 * mark themselves). Kept as a named regression: each must stay a refusal on a read-only run.
 */
const READ_ONLY_GAPS = [
  "config_setSecret",
  "contracts_setBinding",
  "contracts_grant",
  "files_importAttachment",
  "projects_addComment",
  "projects_checklistAddItems",
  "projects_checklistRemoveItem",
  "projects_checklistSetValidation",
  "projects_checklistUpdateItem",
]

const POISON = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined
      throw new Error(`poison tx: ${String(prop)}`)
    },
  },
)

function bridgeFor(readOnlyRun: boolean): Record<string, any> {
  return createRpcBridge(
    "inv_app",
    "00000000-0000-4000-8000-0000000000aa",
    "00000000-0000-4000-8000-0000000000bb",
    POISON as any,
    { name: "inv_app", schema: {}, events: { emits: [] } },
    ["inv_app:read"],
    "user",
    undefined,
    { readOnlyRunOverride: readOnlyRun, callChain: [] } as any,
  )
}

/** The refusal wrapper createRpcBridge installs on a read-only run. */
function isRefusalWrapper(fn: unknown): boolean {
  return typeof fn === "function" && /readOnlyRunBlockedError\(/.test(String(fn))
}

describe("S3f-1: a read-only run refuses every bridge write", () => {
  it("every bridge method is refused, guards itself, or is a reviewed read", () => {
    const ordinary = bridgeFor(false)
    const ro = bridgeFor(true)
    expect(Object.keys(ro).sort()).toEqual(Object.keys(ordinary).sort())
    const unclassified: string[] = []
    for (const name of Object.keys(ro).sort()) {
      if (isRefusalWrapper(ro[name])) continue
      if (SELF_GUARDING.has(name)) continue
      if (name in REVIEWED_NOT_REFUSED) continue
      if (READ_ONLY_GAPS.includes(name)) continue
      unclassified.push(name)
    }
    expect(unclassified).toEqual([])
    // No stale review entry.
    expect(Object.keys(REVIEWED_NOT_REFUSED).filter((n) => !(n in ro))).toEqual([])
  })

  it("a self-guarding write refuses on a read-only run", async () => {
    const ro = bridgeFor(true)
    for (const name of [
      "db_insert",
      "db_insertNow",
      "db_update",
      "db_updateNow",
      "db_delete",
      "db_batch",
    ]) {
      let msg = ""
      try {
        const arg =
          name === "db_batch"
            ? JSON.stringify({ ops: [{ insert: "items", data: { a: 1 } }] })
            : JSON.stringify({ entity: "items", data: { a: 1 }, where: { id: "x" } })
        await ro[name](arg)
      } catch (err) {
        msg = String((err as Error).message)
      }
      expect(`${name}: ${msg}`.toLowerCase()).toContain("read_only_run")
    }
  })

  it("tickets_admin on a read-only run refuses its write ops and lets its read ops through", async () => {
    const ro = createRpcBridge(
      "tickets",
      "00000000-0000-4000-8000-0000000000aa",
      "00000000-0000-4000-8000-0000000000bb",
      POISON as any,
      { name: "tickets", schema: {}, events: { emits: [] } },
      ["tickets:tickets:read"],
      "user",
      undefined,
      { readOnlyRunOverride: true, callChain: [] } as any,
    )
    for (const op of ["categoriesCreate", "addNote", "apiKeysCreate", "ticketsMove"]) {
      const msg = await ro.tickets_admin(op, "{}").then(
        () => "",
        (err: Error) => String(err.message),
      )
      expect(`${op}: ${msg}`.toLowerCase()).toContain("read_only_run")
    }
    for (const op of TICKETS_ADMIN_READ_OPS) {
      // A read op reaches the app (the poison database fails it there), never the refusal.
      const msg = await ro.tickets_admin(op, "{}").then(
        () => "",
        (err: Error) => String(err.message),
      )
      expect(`${op}: ${msg}`.toLowerCase()).not.toContain("read_only_run")
    }
  })

  it("knowledge_syncedSources on a read-only run refuses archive and run now", async () => {
    const ro = createRpcBridge(
      "knowledge",
      "00000000-0000-4000-8000-0000000000aa",
      "00000000-0000-4000-8000-0000000000bb",
      POISON as any,
      { name: "knowledge", schema: {}, events: { emits: [] } },
      ["knowledge:documents:read"],
      "user",
      undefined,
      { readOnlyRunOverride: true, callChain: [] } as any,
    )
    for (const op of ["archive", "run_now"]) {
      const msg = await ro.knowledge_syncedSources(op, '{"id":"x"}').then(
        () => "",
        (err: Error) => String(err.message),
      )
      expect(`${op}: ${msg}`.toLowerCase()).toContain("read_only_run")
    }
  })

  it("every bridge write refuses on a read-only run (no write left out of the list)", async () => {
    const ro = bridgeFor(true)
    const notRefused = READ_ONLY_GAPS.filter((n) => !isRefusalWrapper(ro[n]))
    expect(notRefused).toEqual([])
  })
})
