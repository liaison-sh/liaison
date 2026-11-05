// SPDX-License-Identifier: FSL-1.1-ALv2

import type { KnowledgeCreateDocument } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { roles as rolesTable } from "~/db/schema/kernel"
import { captureSpawnParentFrame } from "~/modules/agent/runtime/run-context"
import {
  capturedFrameWriteScopes,
  scopeUnknownError,
} from "~/modules/agent/scopes/write-required-scopes"
import { connectionSetupCall } from "~/modules/agent/tools/setup-state-tool"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { installFromCatalog } from "~/modules/apps/catalog-sources"
import {
  appIsOn,
  enableApp,
  getEnabledApps,
  isAppRegistered,
  recordAppOn,
  settledAppState,
} from "~/modules/apps/enabled-apps"
import {
  disableOrgApp,
  enableOrgApp,
  setOrgAppAccessChecked,
  turnOrgAppOn,
} from "~/modules/apps/org-app-admin"
import { OrgAppError } from "~/modules/apps/org-app-service"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { createRole, grantScope } from "~/modules/permissions/roles"
import type { PermissionMutationContext } from "~/modules/permissions/types"
import { createThread } from "~/modules/threads/thread"

/**
 * Org-configuration tool handler context (enable_app, create_role,
 * create_pinned_thread, capture_business_knowledge). The kernel runtime passes an `AppContext`
 * (`{ userId, orgId, db, ... }`); the direct-call integration tests pass
 * `{ orgId, userId }`. Either way, these handlers re-resolve the caller's
 * effective permissions from the DB so the actor used for RLS + the
 * scope-grant guard is the real persisted set — never a fabricated `["*"]` —
 * of the approver when a person approved the call.
 */
export interface OrgConfigToolCtx {
  orgId: string
  userId: string
  /** The person who approved a gated call (set by the runtime); null or absent
   *  for a direct call. */
  approverUserId?: string | null
}

/**
 * The actor whose authority a call runs with: the APPROVER of an approved
 * gated call (the agent must never act beyond what the deciding person holds),
 * else the caller.
 */
export async function resolveActor(ctx: OrgConfigToolCtx): Promise<UserContext> {
  const actingUserId = ctx.approverUserId ?? ctx.userId
  const perms = await withPrivilegedDb(ctx.orgId, "org-config-tool-load-perms", (tx) =>
    loadEffectivePermissions(tx, actingUserId, ctx.orgId),
  )
  return {
    actorType: "user",
    userId: actingUserId,
    orgId: ctx.orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } })?.code
  const causeCode = (err as { cause?: { code?: string } })?.cause?.code
  return code === "23505" || causeCode === "23505"
}

/** A refusal as the tool's answer: its code and a 4xx flow through the envelope. */
interface EnableAppRefusal {
  error: { code: string; message: string; status: number; retryable: boolean }
}

/**
 * An app the instance has not installed yet is installed from the catalog, the
 * App store's own install (`installFromCatalog`: same name check, instance
 * operator rule and registry refusal). A refusal names why; never a success.
 */
async function installMissingApp(
  ctx: OrgConfigToolCtx,
  appName: string,
): Promise<EnableAppRefusal | null> {
  try {
    await installFromCatalog({
      orgId: ctx.orgId,
      name: appName,
      installedBy: ctx.approverUserId ?? ctx.userId,
    })
  } catch (err) {
    if (err instanceof HTTPException) {
      return {
        error: {
          code: err.status === 404 ? "app_not_in_catalog" : "app_install_refused",
          message: `${appName} is not installed and could not be installed: ${err.message}`,
          status: err.status,
          retryable: err.status === 404 || err.status === 400,
        },
      }
    }
    throw err
  }
  if (!(await isAppRegistered(ctx.orgId, appName))) {
    return {
      error: {
        code: "app_install_failed",
        message: `${appName} was installed from the catalog but did not start for this workspace: ask an administrator to check it in Settings > Apps.`,
        status: 500,
        retryable: false,
      },
    }
  }
  return null
}

/**
 * What a call that changes nothing says, to the agent and through it to the
 * person: the app was already in that state, so approving the call would do
 * nothing, and turning it on (or off) again cannot fix an error the person
 * sees. A weak model otherwise promises that approving it "will fix it".
 */
function noChangeMessage(appName: string, on: boolean): string {
  return (
    `The ${appName} app is already ${on ? "on" : "off"} for this workspace: no change, nothing was asked of the person. ` +
    `Turning it ${on ? "on" : "off"} again cannot fix an error the person sees: never tell them it will. ` +
    "Read the error's own words for what it needs (kernel__config_export shows each app's config and settings), or say plainly that you do not know the fix."
  )
}

/**
 * BEFORE ANY GATE, for every caller (an agent, an MCP client, a routine): an
 * `enable_app` for an app that is already on has nothing to do. It answers at
 * once, idempotently (`changed: false` and why it fixes nothing), and no
 * approval card asks a person to approve a call that changes nothing.
 */
export async function enableAppNoChange(
  params: unknown,
  ctx: { orgId: string },
): Promise<{ enabled: string; changed: false; note: string } | null> {
  const appName =
    typeof params === "object" && params !== null ? Reflect.get(params, "appName") : null
  if (typeof appName !== "string" || !(await appIsOn(ctx.orgId, appName))) return null
  // On but missing from the curation list: recorded there, which nobody sees.
  await recordAppOn(ctx.orgId, appName)
  return { enabled: appName, changed: false, note: noChangeMessage(appName, true) }
}

/** The same idempotent answer for `apps_set_enabled` to the state the app is already in. */
export async function setAppEnabledNoChange(
  params: unknown,
  ctx: { orgId: string },
): Promise<{ appName: string; status: string; changed: false; note: string } | null> {
  if (typeof params !== "object" || params === null) return null
  const appName = Reflect.get(params, "appName")
  const enabled = Reflect.get(params, "enabled")
  if (typeof appName !== "string" || typeof enabled !== "boolean") return null
  if (!(await isAppRegistered(ctx.orgId, appName))) return null
  if ((await settledAppState(ctx.orgId, appName)) !== (enabled ? "on" : "off")) return null
  return {
    appName,
    status: enabled ? "active" : "disabled",
    changed: false,
    note: noChangeMessage(appName, enabled),
  }
}

export async function handleEnableApp(
  params: { appName: string },
  ctx: OrgConfigToolCtx,
): Promise<
  | { enabled: string; installed?: true; next: string }
  | { enabled: string; changed: false; note: string }
  | { error: string; code?: string }
  | EnableAppRefusal
> {
  let installed = false
  if (!(await isAppRegistered(ctx.orgId, params.appName))) {
    const refused = await installMissingApp(ctx, params.appName)
    if (refused) return refused
    installed = true
  }
  // Judged before anything below turns it back on.
  const wasOn = !installed && (await appIsOn(ctx.orgId, params.appName))
  // An app taken out of the workspace (`removed`) or turned Off comes back On
  // through the admin page's own paths (state, registration, routines,
  // connections), not only the enabledApps list, which alone would leave it Off.
  try {
    await turnOrgAppOn(ctx.orgId, params.appName, { actorId: ctx.userId, actorType: "agent" })
  } catch (err) {
    return refusal(err)
  }
  await enableApp(ctx.orgId, params.appName)
  if (wasOn)
    return { enabled: params.appName, changed: false, note: noChangeMessage(params.appName, true) }
  const next = enabledAppNext(ctx.orgId, params.appName)
  return {
    enabled: params.appName,
    ...(installed ? { installed: true as const } : {}),
    next,
  }
}

/**
 * What comes right after turning an app on: the person turned it on for a
 * reason, so the next step is THEIR goal (connecting it, when it has an OAuth
 * connection), never the setup checklist's next item.
 */
function enabledAppNext(orgId: string, appName: string): string {
  const calls: string[] = []
  for (const [[, app, connection], config] of connectionConfigRegistry.entriesOf(orgId)) {
    if (app !== appName || config.type !== "oauth2") continue
    calls.push(`${app}/${connection}: ${connectionSetupCall(app, connection, "client_card")}`)
  }
  const connect =
    calls.length > 0
      ? ` If the person asked to connect it, do that now (${calls.join("; ")}; skip the client step when the connection's client is already set).`
      : ""
  return `The ${appName} app is on.${connect} Carry on with what the person asked for before any other setup step: never move on to something else (mail, the checklist) until it is done or the person says so.`
}

/** A refused change answers in words (the agent relays it); anything else throws. */
function refusal(err: unknown): { error: string; code: string } {
  if (err instanceof OrgAppError) return { error: err.message, code: err.code }
  throw err
}

/**
 * Turn an app On or Off for the whole workspace (S24, S19). Off stops
 * everything (navigation, agent tools, jobs, webhooks), keeps its data, and
 * turning it back On resumes it. Gated and admin-scoped at registration.
 */
export async function handleSetAppEnabled(
  params: { appName: string; enabled: boolean },
  ctx: OrgConfigToolCtx,
): Promise<
  | { appName: string; status: string; changed?: false; note?: string }
  | { error: string; code?: string }
> {
  if (!(await isAppRegistered(ctx.orgId, params.appName))) return { error: "app not installed" }
  // Re-checked at execution: the state can have changed since the call was staged.
  const noChange = await setAppEnabledNoChange(params, ctx)
  if (noChange) return noChange
  try {
    const actor = { actorId: ctx.userId, actorType: "agent" as const }
    const state = params.enabled
      ? await enableOrgApp(ctx.orgId, params.appName, actor)
      : await disableOrgApp(ctx.orgId, params.appName, actor)
    return { appName: params.appName, status: state.status }
  } catch (err) {
    return refusal(err)
  }
}

/**
 * Set who may use an app (S24, S20): everyone, or only the listed roles and
 * people. Org admins always keep it. Gated and admin-scoped at registration.
 */
export async function handleSetAppAccess(
  params: {
    appName: string
    mode: "everyone" | "restricted"
    roleIds?: string[]
    userIds?: string[]
  },
  ctx: OrgConfigToolCtx,
): Promise<{ appName: string; accessMode: string } | { error: string; code?: string }> {
  if (!(await isAppRegistered(ctx.orgId, params.appName))) return { error: "app not installed" }
  try {
    const state = await setOrgAppAccessChecked(
      ctx.orgId,
      params.appName,
      { mode: params.mode, roleIds: params.roleIds ?? [], userIds: params.userIds ?? [] },
      { actorId: ctx.userId, actorType: "agent" },
    )
    return { appName: params.appName, accessMode: state.accessMode }
  } catch (err) {
    return refusal(err)
  }
}

export async function handleCreateRole(
  params: { name: string; description?: string; scopes?: string[] },
  ctx: OrgConfigToolCtx,
): Promise<{ roleId: string } | { error: string }> {
  const actor = await resolveActor(ctx)
  try {
    const roleId = await withRlsContext(actor, async (tx) => {
      // Attribution follows authority: the actor is the person whose scopes
      // acted (the approver of an approved call, else the caller), and the
      // requester is kept as `requestedBy` when someone else asked.
      const role = await createRole(tx, {
        orgId: ctx.orgId,
        name: params.name,
        description: params.description,
        actorId: actor.userId,
        requestedBy: ctx.userId,
      })
      for (const scope of params.scopes ?? []) {
        await grantScope(tx, {
          roleId: role.id,
          orgId: ctx.orgId,
          scope,
          actorId: actor.userId,
          requestedBy: ctx.userId,
          actorScopes: actor.scopes as PermissionMutationContext["actorScopes"],
          actorDimensionGrants: actor.dimensionGrants,
        })
      }
      return role.id
    })
    return { roleId }
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "role already exists" }
    const status = (err as { status?: number })?.status
    if (status === 403) {
      return { error: "Cannot grant a scope you do not hold" }
    }
    throw err
  }
}

/** STAGE-TIME preflight for the gated `capture_business_knowledge`.
 *
 *  A gated tool call must NOT be parked for a human when the data it needs is
 *  missing: the approver clicks approve and gets a validation error only the
 *  agent could have fixed. Everything checkable before the write is checked
 *  here, so the agent is corrected in-loop instead.
 *
 *  `internal` is supplied by the handler when no sensitivity dimension is
 *  given; `confidential`/`restricted` are REFUSED here because this tool has no
 *  way to name the roles such a document must be shared with (the Knowledge
 *  create guard rejects a confidential doc with no `shareWithRoles`), so the
 *  agent must use the knowledge create tool for those. */
export async function captureBusinessKnowledgePreflight(params: {
  title?: unknown
  body?: unknown
  dimensions?: Record<string, string>
}): Promise<{ error: string } | Record<string, never>> {
  const title = typeof params.title === "string" ? params.title.trim() : ""
  const body = typeof params.body === "string" ? params.body.trim() : ""
  if (!title) return { error: "capture_business_knowledge needs a non-empty title." }
  if (!body) return { error: "capture_business_knowledge needs a non-empty body." }
  const sensitivity = params.dimensions?.sensitivity
  const allowed = ["public", "internal", "confidential", "restricted"]
  if (sensitivity !== undefined && !allowed.includes(sensitivity)) {
    return {
      error: `dimensions.sensitivity must be one of ${allowed.join(" | ")} (got "${sensitivity}").`,
    }
  }
  if (sensitivity === "confidential" || sensitivity === "restricted") {
    return {
      error:
        "capture_business_knowledge writes an org-wide document and cannot name the roles a " +
        "confidential/restricted document must be shared with. Use the knowledge create tool " +
        "with sensitivity + shareWithRoles: [{ roleId, access }] (roles_list gives the role ids) " +
        "for material that must not be org-wide readable.",
    }
  }
  return {}
}

export async function handleCaptureBusinessKnowledge(
  params: { title: string; body: string; dimensions?: Record<string, string> },
  ctx: OrgConfigToolCtx,
): Promise<{ documentId: string } | { error: string }> {
  // Knowledge must be enabled to be usable — auto-enable before delegating.
  if (!(await getEnabledApps(ctx.orgId)).includes("knowledge")) {
    await enableApp(ctx.orgId, "knowledge")
  }
  const base = await resolveActor(ctx)
  const dims = params.dimensions ?? {}
  const team = dims.team ? [dims.team] : undefined
  const sensitivity = dims.sensitivity
  // Capturing foundational org knowledge is an inherently
  // privileged org-config primitive (like create_role). The Knowledge app
  // enforces per-value team/sensitivity dimension grants and does NOT honor the
  // kernel `{"*":["*"]}` wildcard for its specialized dimensions, and org-scoped
  // docs default to sensitivity "internal" even when none is supplied. Grant the
  // capturing actor exactly the knowledge dimensions this capture writes so the
  // owner can seed org knowledge without a pre-existing knowledge grant.
  const actor = {
    ...base,
    dimensionGrants: {
      ...base.dimensionGrants,
      team: [...(base.dimensionGrants.team ?? []), ...(team ?? [])],
      sensitivity: [...(base.dimensionGrants.sensitivity ?? []), sensitivity ?? "internal"],
    },
  }
  try {
    // The Knowledge app server-enforces placement: every created document must
    // be filed into a collection. A fresh org has no collections yet, so
    // find-or-create an org-shared "Business Basics" one before delegating.
    const collectionId = await withRlsContext(actor, async (tx) => {
      const { knowledgeActorFromContext } = await import("~/apps/knowledge/service")
      const { createKnowledgeCollection, listKnowledgeCollections } = await import(
        "~/apps/knowledge/collections"
      )
      const kActor = knowledgeActorFromContext(actor)
      const existing = await listKnowledgeCollections(tx, kActor)
      const match = existing.find((c) => c.name === "Business Basics") ?? existing[0]
      if (match) return match.id
      const created = await createKnowledgeCollection(
        tx,
        { name: "Business Basics", ownerUserId: null },
        kActor,
      )
      return created.id
    })
    // The document is created through the Knowledge SERVICE, in the same RLS
    // context as the collection above, NOT through the `knowledge:create` agent
    // tool. That tool's handler parks every organization-scoped create for human
    // approval, and `capture_business_knowledge` is ALREADY declared `gated:true`
    // at the kernel tool level: routing through it staged a SECOND approval,
    // returned a `{status:"pending_approval"}` envelope carrying no document id,
    // and left the human-approved capture permanently unwritten. One gate, one
    // human decision, then the write completes here.
    const requiredScopes = capturedFrameWriteScopes(captureSpawnParentFrame())
    if (requiredScopes === null) throw scopeUnknownError("capture_business_knowledge")
    const documentId = await withRlsContext(actor, async (tx) => {
      const { knowledgeActorFromContext, createKnowledgeDocument } = await import(
        "~/apps/knowledge/service"
      )
      const doc = await createKnowledgeDocument(
        tx,
        {
          documentScope: "organization",
          title: params.title,
          body: params.body,
          collectionIds: [collectionId],
          tagNames: [],
          team: team ?? [],
          sensitivity: (sensitivity ?? "internal") as KnowledgeCreateDocument["sensitivity"],
          verifyNow: false,
        },
        knowledgeActorFromContext(actor),
        requiredScopes,
      )
      return doc.id
    })
    if (!documentId) return { error: "knowledge create returned no document id" }
    return { documentId }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

export async function handleCreatePinnedThread(
  params: { title: string },
  ctx: OrgConfigToolCtx,
): Promise<{ threadId: string } | { error: string }> {
  const actor = await resolveActor(ctx)
  const thread = await withRlsContext(actor, (tx) =>
    createThread(tx, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      participantIds: [],
      title: params.title,
      isPinned: true,
    }),
  )
  return { threadId: thread.id }
}

/** STAGE-TIME preflight for the gated `create_role`.
 *
 *  WHY: a gated call must not be parked for a human when the data it needs is
 *  already known to be bad. A role name that is taken fails the unique index at
 *  EXECUTION, i.e. only after the approver clicked approve, with "role already
 *  exists" — something the agent could have seen from roles_list and fixed
 *  itself. Checked here so the agent re-names in-loop and no approval is made.
 *
 *  DELIBERATELY LEFT AT EXECUTION: "Cannot grant a scope you do not hold". That
 *  is decided against the APPROVING human's own scopes by design (the agent must
 *  never mint a role beyond the approver's authority); a preflight runs as the
 *  requester, so answering it here would answer it for the wrong identity. */
export async function createRolePreflight(
  params: { name?: unknown },
  ctx: OrgConfigToolCtx,
): Promise<unknown> {
  const name = typeof params.name === "string" ? params.name : ""
  if (!name) return { ok: true }
  const taken = await withPrivilegedDb(ctx.orgId, "create-role-preflight", async (tx) => {
    const [r] = await tx
      .select({ id: rolesTable.id })
      .from(rolesTable)
      .where(and(eq(rolesTable.orgId, ctx.orgId), eq(rolesTable.name, name)))
      .limit(1)
    return Boolean(r)
  })
  if (taken) return { error: "role already exists" }
  return { ok: true }
}
