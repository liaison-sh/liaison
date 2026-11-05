// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The agent's adapter writes: `connector_adapter_save` and
 * `connector_adapter_restore`, registered HOST-side for the api-connector app
 * (manifest-descriptor `_registerHostTools`). A manifest tool cannot name the
 * scope that decides its approvals, and the app default (`api-connector:approve`)
 * belongs to the people who decide CRM writes; changing what a connection
 * points at is an administrator's decision, so these declare
 * `approveScope: "api-connector:admin"` and re-check it at execution.
 *
 * Binding (what the person approves is what runs): the preflight validates
 * the document with the server parser, compares it with the stored one and
 * pins `{priorHash, priorTarget, newTarget, credentialsPresent}` onto the call;
 * the card is rendered from those pins; execution refuses when the stored
 * document is no longer the one the plan was made against. Credentials never
 * survive a credential-target change (A4): when credentials are stored, such a
 * save is refused until the call says `confirmCredentialWipe: true`.
 */
import { type Adapter, type AdapterIssue, adapterWarnings } from "@liaison/api-connector-core"
import type { ApprovalSummary } from "@liaison/shared"
import { z } from "zod"
import { registerRequiredStepEmitter } from "~/modules/approvals/required-step"
import { toolRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import { MULTI_INSTANCE_IDENTIFIER_RE } from "~/modules/apps/connections/service"
import { assertDemoEgressAllowed, isDemoRestriction } from "~/modules/demo/demo-egress"
import { hasScope } from "~/modules/permissions/permissions"
import { parseAdapterDocument } from "./adapter-policy"
import { describeTarget } from "./authoring"
import { invalidateConnectionCaches } from "./cache"
import {
  AdapterChangedError,
  type AdapterSavePlan,
  API_CONNECTOR_APP,
  CredentialsChangedError,
  getAdapterVersion,
  loadUserScopes,
  planAdapterSave,
  upsertAdapterRow,
} from "./store"
import { apiConnectorLog } from "./transport"

export const API_CONNECTOR_ADMIN = "api-connector:admin"

const identifierParam = z
  .string()
  .regex(MULTI_INSTANCE_IDENTIFIER_RE, "a lowercase slug (letters, digits, -) of at most 40")
  .describe("The connection slug (for example crm or erp).")

// Set by the server's preflight and shown on the approval card; anything the
// caller passes here is replaced at staging.
const pinnedParams = {
  priorHash: z
    .string()
    .nullable()
    .optional()
    .describe("Set by the server when the call is staged; leave it out."),
  priorTarget: z
    .string()
    .nullable()
    .optional()
    .describe("Set by the server when the call is staged; leave it out."),
  newTarget: z
    .string()
    .optional()
    .describe("Set by the server when the call is staged; leave it out."),
  credentialsPresent: z
    .boolean()
    .optional()
    .describe("Set by the server when the call is staged; leave it out."),
}

const commonParams = {
  identifier: identifierParam,
  confirmCredentialWipe: z
    .boolean()
    .optional()
    .describe(
      "true only after telling the user that this change of the API's address or auth deletes the stored credentials, which they must enter again.",
    ),
  allowRemovingOperations: z
    .array(z.string().min(1).max(64))
    .max(100)
    .optional()
    .describe("Operations of the stored document this save removes on purpose, by name."),
}

export const saveAdapterParams = z.object({
  ...commonParams,
  adapter: z
    .union([z.record(z.string(), z.unknown()), z.string().min(2).max(300_000)])
    .describe(
      "The whole adapter document: a JSON object (or its JSON text). See connector_adapter_reference.",
    ),
  ...pinnedParams,
})

export const restoreAdapterParams = z.object({
  ...commonParams,
  versionId: z.string().uuid().describe("A version id from connector_adapter_versions."),
  ...pinnedParams,
})

type SaveParams = z.infer<typeof saveAdapterParams>
type RestoreParams = z.infer<typeof restoreAdapterParams>

/** What a host handler of these tools reads from its context. */
interface AuthoringCtx {
  orgId: string
  userId: string
  /** Set when the call runs on an approval: the person who approved it. */
  approverUserId?: string | null
}

interface ToolError {
  error: { code: string; message: string; retryable: boolean; status: number }
}

function refuse(code: string, message: string, status = 422, retryable = false): ToolError {
  return { error: { code, message, retryable, status } }
}

async function demoRefusal(orgId: string): Promise<ToolError | null> {
  try {
    await assertDemoEgressAllowed(orgId, "api_connector_change")
    return null
  } catch (err) {
    if (isDemoRestriction(err)) {
      return refuse("demo_restricted", err instanceof Error ? err.message : String(err), 403)
    }
    throw err
  }
}

/** The document a save carries: an object, or JSON text (a weak model's habit). */
function documentOf(raw: SaveParams["adapter"]): unknown {
  if (typeof raw !== "string") return raw
  const parsed = parseAdapterDocument(raw)
  return parsed.ok ? parsed.adapter : raw
}

/** The refusals every plan answers before anything is staged or written. */
function planRefusal(
  plan: Awaited<ReturnType<typeof planAdapterSave>>,
  params: { confirmCredentialWipe?: boolean; allowRemovingOperations?: string[] },
): ToolError | null {
  if (!plan.ok) {
    const shown = plan.issues.slice(0, 40).map((i) => `${i.path || "(document)"}: ${i.message}`)
    const more = plan.issues.length > 40 ? `; and ${plan.issues.length - 40} more` : ""
    return refuse(
      "invalid_adapter",
      `The adapter is invalid (${plan.issues.length} issue${plan.issues.length === 1 ? "" : "s"}): ${shown.join("; ")}${more}. Fix each and save again; nothing was saved and no approval was asked.`,
      422,
      true,
    )
  }
  const allowed = new Set(params.allowRemovingOperations ?? [])
  const dropped = plan.removedOperations.filter((name) => !allowed.has(name))
  if (dropped.length > 0) {
    return refuse(
      "removes_operations",
      `This document drops operations the connection has now: ${dropped.join(", ")}. Keep them (read every page of connector_adapter_get), or pass allowRemovingOperations with their names if the user wants them gone. Nothing was saved.`,
      422,
      true,
    )
  }
  if (plan.wipesCredentials && params.confirmCredentialWipe !== true) {
    return refuse(
      "confirm_credential_wipe",
      `This change moves the connection's credential target from ${describeTarget(plan.priorTarget)} to ${describeTarget(plan.newTarget)}, which deletes the stored credentials: they must be entered again afterwards. Tell the user, then call again with confirmCredentialWipe: true. Nothing was saved.`,
      409,
      true,
    )
  }
  return null
}

function pinsOf(plan: AdapterSavePlan) {
  return {
    priorHash: plan.priorHash,
    priorTarget: plan.priorTarget,
    newTarget: plan.newTarget,
    credentialsPresent: plan.credentialsPresent,
  }
}

/** Execution-time re-check: the person who approved holds api-connector:admin. */
async function approverRefusal(ctx: AuthoringCtx): Promise<ToolError | null> {
  const approver = ctx.approverUserId
  if (!approver) return null
  if (hasScope(API_CONNECTOR_ADMIN, await loadUserScopes(ctx.orgId, approver))) return null
  return refuse(
    "forbidden",
    `Saving an API connection's adapter is approved by an API connector admin (${API_CONNECTOR_ADMIN}); the approver does not hold it. Nothing was saved.`,
    403,
  )
}

/** Plan again at execution, refuse what drifted from the approved plan, then write. */
async function executeSave(
  ctx: AuthoringCtx,
  identifier: string,
  doc: unknown,
  params: SaveParams | RestoreParams,
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  const denied = (await approverRefusal(ctx)) ?? (await demoRefusal(ctx.orgId))
  if (denied) return denied
  const plan = await planAdapterSave(ctx.orgId, identifier, doc)
  const refused = planRefusal(plan, params)
  if (refused) return refused
  if (!plan.ok) return refuse("invalid_adapter", "The adapter is invalid.")
  // Fail closed, like connector_write: the pins are what the card showed and
  // the approver approved. A call without them (a preflight that never ran: a
  // sequenced step whose params carry references) runs nothing, and pins that
  // no longer match a fresh plan refuse the save.
  if (
    params.priorHash === undefined ||
    params.priorTarget === undefined ||
    params.newTarget === undefined ||
    params.credentialsPresent === undefined
  ) {
    return refuse(
      "not_pinned",
      `This save of "${identifier}" was not checked when it was staged, so nothing was saved. Call connector_adapter_save (or connector_adapter_restore) again on its own, without references in its params.`,
      409,
    )
  }
  if (
    params.priorHash !== plan.priorHash ||
    params.priorTarget !== plan.priorTarget ||
    params.newTarget !== plan.newTarget ||
    params.credentialsPresent !== plan.credentialsPresent
  ) {
    return refuse(
      "adapter_changed",
      `The adapter "${identifier}", its credential target or its stored credentials changed after this save was prepared and approved; nothing was saved. Read it again with connector_adapter_get and prepare the save anew.`,
      409,
    )
  }
  const warnings = adapterWarnings(plan.adapter)
  const saver = ctx.approverUserId ?? ctx.userId
  try {
    const { credentialsCleared } = await upsertAdapterRow(
      ctx.orgId,
      identifier,
      plan.adapter,
      saver,
      { expectPriorHash: plan.priorHash, expectCredentialsPresent: plan.credentialsPresent },
    )
    await invalidateConnectionCaches(ctx.orgId, identifier)
    return {
      saved: true,
      identifier,
      name: plan.adapter.name,
      adapterVersion: plan.adapter.version,
      operations: plan.adapter.operations.map((o) => `${o.name} (${o.kind})`),
      credentialsCleared,
      ...extra,
      ...saveFollowUp(identifier, credentialsCleared || !plan.credentialsPresent, warnings),
    }
  } catch (err) {
    if (err instanceof AdapterChangedError || err instanceof CredentialsChangedError) {
      return refuse("adapter_changed", err.message, 409)
    }
    apiConnectorLog.error({ err, orgId: ctx.orgId, identifier }, "adapter save failed")
    throw err
  }
}

/**
 * What a save's result tells the agent to do next. A connection saved without
 * credentials does not work: `askWith` names the card to send, and `next`
 * says, in words a weak model cannot read as done, that nothing was sent yet.
 * The result reaches the agent through the approval replay, fenced as data:
 * `requiredStep` is the code the platform turns into its own line outside
 * the fence (approvals/required-step.ts); the text fields stay inside it.
 */
export function saveFollowUp(
  identifier: string,
  needsCredentials: boolean,
  warnings: AdapterIssue[] = [],
): Record<string, unknown> {
  const warned =
    warnings.length > 0
      ? {
          warnings: warnings.map((w) => `${w.path}: ${w.message}`),
        }
      : {}
  const testFirst =
    warnings.length > 0
      ? " Read warnings: if connector_adapter_test then fails, fix those operations first."
      : ""
  if (!needsCredentials) {
    return {
      ...warned,
      next: `Test each read operation with connector_adapter_test before saying the connection works.${testFirst}`,
    }
  }
  return {
    ...warned,
    requiredStep: { code: "request_credentials", identifier },
    askWith: {
      tool: "kernel__request_secret",
      params: { kind: "api_connector_credentials", target: { identifier } },
    },
    next: `NOT WORKING YET: the connection has no credentials. Required now: call kernel__request_secret with askWith.params (a card where the person enters them; you never see them). No card exists until that call returns. Once they are saved, test a read operation with connector_adapter_test before saying it works, then carry on (an import's preview, for one).${testFirst}`,
  }
}

async function savePreflight(params: unknown, ctx: AuthoringCtx): Promise<unknown> {
  const p = saveAdapterParams.parse(params)
  const demo = await demoRefusal(ctx.orgId)
  if (demo) return demo
  const plan = await planAdapterSave(ctx.orgId, p.identifier, documentOf(p.adapter))
  const refused = planRefusal(plan, p)
  if (refused || !plan.ok) return refused
  return { ok: true, pinnedParams: pinsOf(plan) }
}

async function saveHandler(params: unknown, ctx: AuthoringCtx): Promise<unknown> {
  const p = saveAdapterParams.parse(params)
  return executeSave(ctx, p.identifier, documentOf(p.adapter), p)
}

async function restorePreflight(params: unknown, ctx: AuthoringCtx): Promise<unknown> {
  const p = restoreAdapterParams.parse(params)
  const demo = await demoRefusal(ctx.orgId)
  if (demo) return demo
  const version = await getAdapterVersion(ctx.orgId, p.identifier, p.versionId)
  if (!version) {
    return refuse(
      "unknown_version",
      `No kept version ${p.versionId} of "${p.identifier}" (see connector_adapter_versions).`,
      404,
    )
  }
  const plan = await planAdapterSave(ctx.orgId, p.identifier, version.adapter)
  const refused = planRefusal(plan, p)
  if (refused || !plan.ok) return refused
  return { ok: true, pinnedParams: pinsOf(plan) }
}

async function restoreHandler(params: unknown, ctx: AuthoringCtx): Promise<unknown> {
  const p = restoreAdapterParams.parse(params)
  const version = await getAdapterVersion(ctx.orgId, p.identifier, p.versionId)
  if (!version) {
    return refuse("unknown_version", `No kept version ${p.versionId} of "${p.identifier}".`, 404)
  }
  return executeSave(ctx, p.identifier, version.adapter, p, {
    restoredVersionId: p.versionId,
  })
}

// --- Approval cards ---
//
// Rendered from the document itself and a fresh plan against what is stored,
// never from the call's pins or other caller-supplied text: what the card
// shows is what the server sees.

function short(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const CARD_LINES = 8

type CardOperation = Pick<
  Adapter["operations"][number],
  "name" | "kind" | "method" | "path" | "readOnlyPost"
>

/**
 * The operations on the card: each with its method and path, every read-only
 * POST (a POST the connector treats as a read, so it runs without approval)
 * on a line of its own, the rest packed into the lines left.
 */
interface CardEntry {
  text: string
  /** How many operations the line names. */
  count: number
}

function operationLines(ops: CardOperation[], room: number): string[] {
  const isReadOnlyPost = (o: CardOperation) => o.kind === "read" && o.readOnlyPost === true
  const entries: CardEntry[] = ops.filter(isReadOnlyPost).map((o) => ({
    text: short(`Read-only POST (runs without approval): ${o.name} POST ${o.path}`),
    count: 1,
  }))
  let text = ""
  let count = 0
  for (const o of ops.filter((x) => !isReadOnlyPost(x))) {
    const item = `${o.name} (${o.kind}) ${o.method} ${o.path}`
    const joined = count > 0 ? `${text}; ${item}` : `Operations: ${item}`
    if (count > 0 && joined.length > 200) {
      entries.push({ text, count })
      text = short(`Operations: ${item}`)
      count = 1
    } else {
      text = short(joined)
      count++
    }
  }
  if (count > 0) entries.push({ text, count })
  if (entries.length <= room) return entries.map((e) => e.text)
  const kept = entries.slice(0, Math.max(0, room - 1))
  const hidden = ops.length - kept.reduce((n, e) => n + e.count, 0)
  return [
    ...kept.map((e) => e.text),
    `… and ${hidden} more operation${hidden === 1 ? "" : "s"} (the full document is in the request)`,
  ]
}

async function adapterCard(
  orgId: string,
  identifier: string,
  doc: unknown,
  head: string[],
): Promise<{ lines: string[]; adapter: Adapter | null }> {
  const plan = await planAdapterSave(orgId, identifier, doc)
  if (!plan.ok) {
    return {
      lines: [...head, "The document does not validate: the save will be refused"],
      adapter: null,
    }
  }
  const lines = [...head, short(`API: ${describeTarget(plan.newTarget)}`)]
  lines.push(
    plan.priorHash === null
      ? "A new connection"
      : "Replaces the current adapter (the previous one is kept in its history)",
  )
  if (plan.wipesCredentials) {
    lines.push(
      short(
        `Deletes the stored credentials: the API's address or auth changes (was ${describeTarget(plan.priorTarget)}). They must be entered again.`,
      ),
    )
  }
  lines.push(...operationLines(plan.adapter.operations, CARD_LINES - lines.length))
  return { lines: lines.slice(0, CARD_LINES), adapter: plan.adapter }
}

async function summarizeSave(params: unknown, ctx: { orgId: string }): Promise<ApprovalSummary> {
  const parsed = saveAdapterParams.safeParse(params)
  const p = parsed.success ? parsed.data : null
  const identifier = p?.identifier ?? "(no identifier)"
  const card = p
    ? await adapterCard(ctx.orgId, identifier, documentOf(p.adapter), [])
    : { lines: ["The request does not parse: the save will be refused"], adapter: null }
  return {
    kind: "api-connector.adapter_save",
    title: `Save the API connection ${identifier}`,
    subtitle: short(
      card.adapter ? `${card.adapter.name}, version ${card.adapter.version}` : "Adapter",
    ),
    impact: "internal",
    lines: card.lines,
  }
}

async function summarizeRestore(params: unknown, ctx: { orgId: string }): Promise<ApprovalSummary> {
  const parsed = restoreAdapterParams.safeParse(params)
  const p = parsed.success ? parsed.data : null
  const identifier = p?.identifier ?? "(no identifier)"
  const version = p ? await getAdapterVersion(ctx.orgId, p.identifier, p.versionId) : null
  const card = version
    ? await adapterCard(ctx.orgId, identifier, version.adapter, [
        short(
          `Version ${version.adapterVersion}, saved ${version.savedAt}${version.savedByName ? ` by ${version.savedByName}` : ""}`,
        ),
      ])
    : { lines: ["No such kept version: the restore will be refused"], adapter: null }
  return {
    kind: "api-connector.adapter_restore",
    title: `Restore an earlier adapter of ${identifier}`,
    subtitle: short(card.adapter?.name ?? "Adapter"),
    impact: "internal",
    lines: card.lines,
  }
}

/** Register the two host tools and their cards for `orgId` (called at app registration). */
export function registerAdapterAuthoringTools(orgId: string): void {
  const common = {
    appName: API_CONNECTOR_APP,
    deferLoading: true,
    requiredScopes: [API_CONNECTOR_ADMIN],
    trustBoundary: "user" as const,
    gated: true,
    approvalImpact: "internal" as const,
    noAutoApprove: true,
    approveScope: API_CONNECTOR_ADMIN,
    writesToTable: "app_api_connector.adapters",
    // Set only by the preflight: a caller's own values are dropped and a call
    // carrying an @ref to an earlier step is refused at staging (execute-tool.ts).
    pinnedParams: ["priorHash", "priorTarget", "newTarget", "credentialsPresent"],
  }
  const save = {
    ...common,
    name: "connector_adapter_save",
    // How a person asks for it ("connect our HubSpot", "an integration with
    // our ERP"): found by tool_search from the request's own words.
    searchKeywords: ["connect", "connection", "integration", "integrate", "crm", "erp", "adapter"],
    description:
      "Create or replace an API connection's adapter (CRM, ERP, any HTTP API). Validated first; a person approves. New baseUrl or auth wipes credentials: set confirmCredentialWipe only after telling the user. Guide: connector_adapter_reference.",
    params: saveAdapterParams,
    preflight: savePreflight,
    handler: saveHandler,
  }
  const restore = {
    ...common,
    name: "connector_adapter_restore",
    description:
      "Restore a kept version of an API connection's adapter (an id from connector_adapter_versions). Checked and approved like connector_adapter_save, credential wipe confirmation included.",
    params: restoreAdapterParams,
    preflight: restorePreflight,
    handler: restoreHandler,
  }
  toolRegistry.set([orgId, API_CONNECTOR_APP, "connector_adapter_save"], save)
  toolRegistry.set([orgId, API_CONNECTOR_APP, "connector_adapter_restore"], restore)
  // A save or restore that leaves the connection without credentials names
  // the secret card as a required step; only these host registrations may.
  registerRequiredStepEmitter(save, ["request_credentials"])
  registerRequiredStepEmitter(restore, ["request_credentials"])
  registerApprovalSummarizer(orgId, API_CONNECTOR_APP, "connector_adapter_save", summarizeSave)
  registerApprovalSummarizer(
    orgId,
    API_CONNECTOR_APP,
    "connector_adapter_restore",
    summarizeRestore,
  )
}
