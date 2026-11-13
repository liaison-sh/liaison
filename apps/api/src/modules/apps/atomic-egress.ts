// SPDX-License-Identifier: FSL-1.1-ALv2
//
// No outside call inside a whole-run transaction.
//
// A sandboxed job declared `atomic: true` runs on ONE transaction from start
// to end (infra/jobs/job-context.ts, "ambient"): it holds a pooled connection,
// and every row it touched stays locked, for its whole wall clock. A provider
// call, a remote query or a nested run inside that run holds them across its
// latency. So an atomic job's bridge keeps only the methods that stay in the
// database or the local process (ATOMIC_LOCAL_METHOD_PREFIXES and
// ATOMIC_LOCAL_METHODS), and refuses EVERY other method with
// `atomic_run_egress_refused`: a new bridge method is refused by default until
// it is reviewed as local. A job that needs both splits into steps: read, call
// the provider, then write in one bridge call (or `ctx.steps.run`).
//
// The jobs that do egress inside an atomic run today are listed in
// contract/atomic-egress.allowlist.json. The list only shrinks
// (atomic-egress.guard.test.ts pins it under a frozen baseline): an app whose
// job is split removes its row.
//
// A sandboxed TOOL declared `atomic: true` gets the same refusal: a tool that
// needs several writes to land together uses one `ctx.db.batch` call and does
// its outside calls before or after it. No bundled app declares an atomic
// tool; the in-tree tools still atomic are listed in
// contract/atomic-tools.allowlist.json, shrink-only (atomic-egress.guard.test.ts).
//
// Core apps are not concerned: their jobs declare no `atomic`.
import allowlist from "./contract/atomic-egress.allowlist.json"
import toolAllowlist from "./contract/atomic-tools.allowlist.json"

/**
 * Prefixes of bridge methods an atomic job keeps: the app's own rows and data
 * store, kernel row reads, logs, crypto, and the effect ledger
 * and step state (their own short writes on the privileged pool).
 */
export const ATOMIC_LOCAL_METHOD_PREFIXES: readonly string[] = [
  "db_",
  "store_",
  "kernel_",
  "log_",
  "crypto_",
  "effects_",
  "_steps_",
  "steps_",
]

/** Single bridge methods an atomic job keeps: database, Redis or local-process work only. */
export const ATOMIC_LOCAL_METHODS: ReadonlySet<string> = new Set([
  "_approvalContext_get",
  "accounts_list",
  "accounts_setMetadata",
  "approval_recordAmbiguous",
  "approval_recordAwaitingOutput",
  "approval_recordEffectLanded",
  "approval_recordFailedNoEffect",
  "approval_recordStarted",
  "approval_recordSucceeded",
  "approvals_pendingFor",
  "approvals_statusOf",
  "callerHasScope",
  "config_setSecret",
  "connections_describe",
  "connections_getAccounts",
  "connections_getSettings",
  "contracts_binding",
  "contracts_providers",
  "files_attachToParent",
  "files_listAttachments",
  "files_reparent",
  "limiter_pause",
  "pages_link",
  "config_get",
  "config_has",
  "emit",
  "enqueueJob",
  "jobs_enqueue",
  "timers_wakeIn",
  "getCallerApp",
  "getIngestionCallerApp",
  "getOrgId",
  "getOrgSettings",
  "getUserId",
  "getUserSettings",
  "hasOnlineUsers",
  "hasScope",
  "invalidateIdempotency",
  "listContactsByExternalId",
  "messages_post",
  "nextHandle",
  "realtime_publish",
  "requestApproval",
  "resolveContact",
  "sequences_allocate",
  "time_civil",
])

/** True when an atomic job may call bridge method `name` (it stays local). */
export function isAtomicLocalMethod(name: string): boolean {
  return (
    ATOMIC_LOCAL_METHODS.has(name) || ATOMIC_LOCAL_METHOD_PREFIXES.some((p) => name.startsWith(p))
  )
}

/**
 * Bridge methods known to reach outside the database (a provider, a remote
 * database, another run, a model). Not the refusal set: every non-local method
 * is refused. Named so the guard test proves the long ones stay refused.
 */
export const ATOMIC_REFUSED_EGRESS_METHODS: readonly string[] = [
  "fetch",
  "bulk_fetchToBlob",
  "files_importFromUrl",
  "files_analyzeDocument",
  "pdf_render",
  "connections_getToken",
  "imap_fetch",
  "imap_writeBack",
  "smtp_send",
  "executeTool",
  "contracts_call",
  "agent_run",
  "agent_spawn",
  "sql_query",
  "sql_reads",
  "sql_schema",
  "sql_probe",
  "api_read",
  "api_write",
  "api_adapterTest",
  "api_customer",
]

export interface AtomicEgressAllowance {
  app: string
  job: string
  /** What the job calls outside, for whoever splits it. */
  egress: string
}

export interface AtomicToolAllowance {
  app: string
  tool: string
  /** Why it is still atomic, for whoever splits it. */
  why: string
}

const ALLOWED_TOOLS = new Set(
  (toolAllowlist as AtomicToolAllowance[]).map((r) => `${r.app}\u0000${r.tool}`),
)

const ALLOWED = new Set((allowlist as AtomicEgressAllowance[]).map((r) => `${r.app}\u0000${r.job}`))

/** True when `app`'s atomic job `job` may still call outside (a listed offender). */
export function atomicEgressAllowed(app: string, job: string): boolean {
  return ALLOWED.has(`${app}\u0000${job}`)
}

function refused(method: string, app: string, job: string, kind = "job"): Error {
  const err = new Error(
    `ctx.${method} is refused in the atomic ${kind} "${app}:${job}": an atomic run holds one ` +
      "database transaction for its whole run, so it may not call outside. Drop `atomic`, or " +
      `split the ${kind} into steps (read, call, then write in one bridge call).`,
  ) as Error & { status: number; code: string }
  err.status = 409
  err.code = "atomic_run_egress_refused"
  return err
}

/**
 * Refuse every non-local method of an atomic job's bridge (mutated in place),
 * unless the job is a listed offender. Applied last, after app extensions.
 */
export function guardAtomicJobEgress(
  bridge: Record<string, unknown>,
  app: string,
  job: string,
): void {
  if (atomicEgressAllowed(app, job)) return
  refuseEgress(bridge, app, job, "job")
}

/**
 * Refuse every non-local method of an atomic TOOL's bridge (mutated in place),
 * unless the tool is a listed offender (contract/atomic-tools.allowlist.json:
 * in-tree tools that have not been split yet; the list only shrinks).
 */
export function guardAtomicToolEgress(
  bridge: Record<string, unknown>,
  app: string,
  tool: string,
): void {
  if (ALLOWED_TOOLS.has(`${app}\u0000${tool}`)) return
  refuseEgress(bridge, app, tool, "tool")
}

function refuseEgress(
  bridge: Record<string, unknown>,
  app: string,
  name: string,
  kind: "job" | "tool",
): void {
  for (const method of Object.keys(bridge)) {
    if (typeof bridge[method] !== "function" || isAtomicLocalMethod(method)) continue
    bridge[method] = async () => {
      throw refused(method, app, name, kind)
    }
  }
}
