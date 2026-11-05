// SPDX-License-Identifier: FSL-1.1-ALv2

import { sharedSurfaceDraftReadScope } from "@liaison/shared"
import type { SchemaObject, ValidateFunction } from "ajv"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { isUnsafePathSegment } from "~/lib/safe-path"
import { taintDisclosureLine, taintSurfaceLabelForTool } from "~/modules/agent/scopes/scope-taint"
import { readersTaintGap } from "~/modules/agent/scopes/taint-approval-audience"
import { authorityFacts, decidingScope } from "~/modules/approvals/authority"
import { validateEditedParams } from "~/modules/approvals/edit-validation"
import {
  isSharedSurfaceApproval,
  loadApprovalSummary,
  loadRequesterContext,
  lockedUpdateApproval,
  normalizeApprovalPayload,
  proposingTurnScopesUnionSql,
  splitToolName,
} from "~/modules/approvals/event-data"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import { humanizeStepSummary } from "~/modules/approvals/ref-provenance"
import {
  narrowPendingApprovalForTaint,
  rowTaintMustHold,
  type TaintNarrowRow,
} from "~/modules/approvals/taint-narrow"
import {
  approvalEditableFieldsRegistry,
  isManifestHandler,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { generateApprovalSummary } from "~/modules/apps/approval-summarizers"
import { outboundPlaceholderRefusal } from "~/modules/apps/outbound-placeholder-refusal"
import { createParamValidatorCache } from "~/modules/apps/param-validator"
import { pinnedOverlap } from "~/modules/apps/pinned-params"
import {
  isSealedMailApprovalPayload,
  MAIL_APPROVAL_CONTENT_KEYS,
  MAIL_APPROVAL_SEAL_ENVELOPE_KEYS,
  resealMailApprovalEdit,
  SealedMailEditRefusal,
  sealedMailRecipientCount,
  sealedMailValidationView,
} from "~/modules/mailbox-crypto/approval-payload"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"

const log = rootLogger.child({ module: "approval-edit" })

const K = drizzleSql.raw(schemaRef("kernel"))

// Compiled once per registered schema object and collected with it (see
// param-validator.ts): a re-registered tool carries a new schema object, and the
// old validator goes with the old registry entry.
const paramValidator = createParamValidatorCache({ allErrors: true })

export class UpdatePayloadError extends Error {
  status: 400 | 403 | 404 | 409
  code:
    | "invalid_edit"
    | "forbidden"
    | "not_found"
    | "stale_status"
    | "E_SCOPE_TAINT_BLOCKED"
    | "sealed_draft_not_editable"
  details?: unknown
  constructor(
    status: 400 | 403 | 404 | 409,
    code: UpdatePayloadError["code"],
    message: string,
    details?: unknown,
  ) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface UpdatePayloadArgs {
  orgId: string
  requestId: string
  fields: Record<string, unknown>
  actor: UserContext
  /**
   * A11: the agent making this edit, or a positive `null` when a PERSON is.
   *
   * An edit has two real callers and they answer differently, so neither the
   * live ALS frame alone nor a blanket null is right here. The kernel tool
   * `approval_update_payload` is an agent editing in its own turn and must stay
   * named; the `POST /api/approvals/:id/payload` route is a human, and passes
   * `null` so an unrelated agent's live turn cannot be credited with their edit.
   *
   * Omitted keeps the live-frame read, which is what any other in-turn caller
   * wants.
   */
  actingAgentId?: string | null
  /**
   * The editing turn's scope taint (rule 8g, scope-taint.ts), forwarded by the agent tool from
   * its dispatch. The pending row is restaged IN PLACE: this taint unions into its
   * `proposing_turn_scopes` and `taintAudienceMustHold`, its notified audience is re-narrowed to
   * holders of the union, and the edit is refused when nobody who may decide it holds the union.
   * Absent (a person's own edit through the route) means nothing new was read; the row's own
   * demand still stamps the edit's diff message.
   */
  turnTaintScopes?: readonly string[]
}

export interface UpdatePayloadResult {
  id: string
  currentPayload: Record<string, unknown>
  /** The fingerprint of the payload as it now stands: the editor has seen it (they wrote it). */
  payloadHash: string
  lastEdit: {
    editorUserId: string
    at: string
    diff: Array<{ field: string; from: unknown; to: unknown }>
  } | null
  /**
   * Set when the draft is end-to-end encrypted to its mailbox: the edited
   * content was sealed again and only ciphertext was stored. Says so in words,
   * so the agent reports what happened instead of reading a payload with no body.
   */
  sealedEdit?: { resealedFields: string[]; note: string }
}

interface ApprovalEditRow {
  id: string
  thread_id: string
  requested_by: string
  tool_name: string
  approve_scope: string | null
  current_payload: unknown
  notify_user_ids: string[]
  resource_owner_id: string | null
  status: string
  metadata: { taintAudienceMustHold?: unknown; taintDisclosedToReaders?: unknown } | null
}

export async function updatePayload(args: UpdatePayloadArgs): Promise<UpdatePayloadResult> {
  // 1. RLS read (404 if not visible).
  const row = await withRlsContext(args.actor, async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT id, thread_id, requested_by, tool_name, approve_scope, current_payload,
             notify_user_ids, resource_owner_id, status, metadata
      FROM ${K}.approval_requests WHERE id = ${args.requestId}
    `)
    return extractRows<ApprovalEditRow>(result)[0] ?? null
  })
  if (!row) {
    const hiddenRow = await loadHiddenApprovalForAuthCheck(args.orgId, args.requestId)
    if (hiddenRow) {
      const isRequester = hiddenRow.requested_by === args.actor.userId
      const inAudience =
        isSharedSurfaceApproval(hiddenRow) || hiddenRow.notify_user_ids.includes(args.actor.userId)
      if (!isRequester && inAudience) {
        const perms = await withPrivilegedDb(args.orgId, "edit-hidden-load-perms", (pdb) =>
          loadEffectivePermissions(pdb, args.actor.userId, args.orgId),
        )
        // The row's OWN deciding scope — never recomputed from the tool name.
        if (!hasScope(decidingScope(authorityFacts(hiddenRow)), perms.scopes)) {
          throw new UpdatePayloadError(403, "forbidden", "forbidden")
        }
      }
    }
    throw new UpdatePayloadError(404, "not_found", "not_found")
  }

  const { appName, toolShortName } = splitToolName(row.tool_name)
  // The row's persisted deciding scope (custom for dimension-constrained
  // approvals like skills) — the person who can SEE and DECIDE the row must be
  // able to edit it under the same scope, never a recomputed `<app>:approve`.
  const approveScope = decidingScope(authorityFacts(row))
  const sharedSurface = isSharedSurfaceApproval(row)
  // The resource OWNER of a personal-resource approval may edit their own
  // pending draft without holding `<app>:approve` — it is their mailbox.
  const isResourceOwner = row.resource_owner_id === args.actor.userId

  // 2. Authorization. Shared-surface drafts (ticket/mail replies) widen the
  //    audience to any holder of the `<app>:approve` capability — a teammate who
  //    can act on the ticket may edit a colleague's drafted reply, matching the
  //    visibility boundary `listApprovals` uses and the decide-path check. For
  //    privately-routed approvals the notify-set still gates who may edit.
  const isRequester = row.requested_by === args.actor.userId
  if (!isRequester && !isResourceOwner) {
    const inAudience = sharedSurface || row.notify_user_ids.includes(args.actor.userId)
    if (!inAudience) {
      throw new UpdatePayloadError(403, "forbidden", "forbidden")
    }
    const perms = await withPrivilegedDb(args.orgId, "edit-load-perms", (pdb) =>
      loadEffectivePermissions(pdb, args.actor.userId, args.orgId),
    )
    // Editing shapes what executes: the decide boundary, every taint scope included (rule 8c).
    if (
      !hasScope(approveScope, perms.scopes) ||
      !rowTaintMustHold(row.metadata).every((scope) => hasScope(scope, perms.scopes))
    ) {
      throw new UpdatePayloadError(403, "forbidden", "forbidden")
    }
  }

  // 3. Stale. A `deferred` bundle step is editable until the cascade claims it
  //    — once the head is approved the step moves past `deferred` and edits are
  //    stale, exactly as for a decided standalone approval.
  if (row.status !== "pending" && row.status !== "deferred") {
    throw new UpdatePayloadError(409, "stale_status", "stale_status", { currentStatus: row.status })
  }

  // 4. Field allowlist + widget-aware revision validation (Phase 16 Task A5).
  const editableFields =
    approvalEditableFieldsRegistry.get([args.orgId, appName, toolShortName]) ?? []
  const allowed = new Set(editableFields.map((f) => f.field))
  // Surfaced in every invalid_edit thrown below: the agent's tool result only shows
  // the error MESSAGE (see tool-bridge.ts's generic catch), not the `details` object,
  // so the editable-field allowlist must be spelled out in the message text itself —
  // otherwise a rejected edit gives the agent no way to self-correct and it falls back
  // to re-running the original create tool, spawning a duplicate approval gate.
  const editableFieldsList =
    editableFields.length > 0 ? editableFields.map((f) => f.field).join(", ") : "(none)"
  // A pinned param is the server's to set: its preflight pinned it and the
  // execution checks it. No edit may reach it, whatever editable field claims
  // to cover the path (the prefix match below would let a nested field
  // authorise overwriting its pinned parent).
  const pinned = toolRegistry.get([args.orgId, appName, toolShortName])?.pinnedParams ?? []
  for (const k of Object.keys(args.fields)) {
    const hit = pinnedOverlap(pinned, k)
    if (hit !== null) {
      throw new UpdatePayloadError(
        400,
        "invalid_edit",
        `field '${k}' is set by the server (the pinned param '${hit}') and cannot be edited; editable fields: ${editableFieldsList}`,
        { unknownField: k, editableFields: editableFields.map((f) => f.field) },
      )
    }
  }
  for (const k of Object.keys(args.fields)) {
    // A path segment that names the object machinery would write through to the
    // shared prototype of every object in the process, whatever the allowlist says.
    if (k.split(".").some(isUnsafePathSegment)) {
      throw new UpdatePayloadError(400, "invalid_edit", `field '${k}' is not a valid field path`, {
        unknownField: k,
        editableFields: editableFields.map((f) => f.field),
      })
    }
    // Allow either exact-match top-level fields (legacy text/richtext)
    // or dot-paths whose declared editable field is a prefix.
    if (
      !allowed.has(k) &&
      !editableFields.some((f) => k.startsWith(`${f.field}.`) || f.field.startsWith(`${k}.`))
    ) {
      throw new UpdatePayloadError(
        400,
        "invalid_edit",
        `field '${k}' is not editable on this approval; editable fields: ${editableFieldsList}. Do NOT re-run the original tool to work around this: either retry approval_update_payload with a valid field, or ask the user. If no field can be edited because the request should not exist at all, withdraw it with kernel__approval_withdraw and create a corrected request.`,
        { unknownField: k, editableFields: editableFields.map((f) => f.field) },
      )
    }
  }
  // An editable field must also be a parameter of the tool: an edit stored under
  // a key the tool's schema does not declare is never read by the handler, so the
  // save would succeed while the approved action still runs the old content.
  const tool = toolRegistry.get([args.orgId, appName, toolShortName])
  const schemaFields = toolParamNames(tool)
  if (schemaFields) {
    for (const k of Object.keys(args.fields)) {
      const top = k.split(".")[0]
      if (schemaFields.has(top)) continue
      throw new UpdatePayloadError(
        400,
        "invalid_edit",
        `field '${k}' is not a parameter of ${row.tool_name} (its parameters: ${[...schemaFields].join(", ") || "(none)"}), so the edit was not saved. The tool declares it editable by mistake; ask the user, or withdraw the request with kernel__approval_withdraw and create a corrected one.`,
        { unknownField: k, schemaFields: [...schemaFields] },
      )
    }
  }
  // An agent's edit is held to the same rule as its tool call: no unfilled placeholder in text
  // a person outside the org reads. A person editing through the route (`null`) is not judged.
  if (args.actingAgentId !== null) {
    const refusal = await outboundPlaceholderRefusal({
      orgId: args.orgId,
      userId: args.actor.userId,
      params: args.fields,
      outboundTextParams: tool?.outboundTextParams,
    })
    if (refusal) throw new UpdatePayloadError(400, "invalid_edit", refusal)
  }
  const revisionValidation = validateEditedParams({
    editableFields,
    originalParams: normalizeApprovalPayload(row.current_payload),
    revision: args.fields,
  })
  if (!revisionValidation.ok) {
    throw new UpdatePayloadError(
      400,
      "invalid_edit",
      `${revisionValidation.error}; editable fields: ${editableFieldsList}. Do NOT re-run the original tool to work around this: either retry approval_update_payload with a valid field, or ask the user. If no field can be edited because the request should not exist at all, withdraw it with kernel__approval_withdraw and create a corrected request.`,
      { message: revisionValidation.error, editableFields: editableFields.map((f) => f.field) },
    )
  }

  // 4b. Rule 8g: a tainted edit carries the turn's read into the row. Whether readers of the
  //     draft's surface lack the union decides the card's disclosure line; judged before the
  //     row lock (it reads every org member's grants).
  const turnTaint = [...(args.turnTaintScopes ?? [])]
  const unionTaint = [...new Set([...rowTaintMustHold(row.metadata), ...turnTaint])].sort()
  let disclosedToReaders = row.metadata?.taintDisclosedToReaders === true
  if (!disclosedToReaders && turnTaint.length > 0 && sharedSurface) {
    const draftReadScope = sharedSurfaceDraftReadScope(row.tool_name)
    if (draftReadScope) {
      disclosedToReaders =
        (await readersTaintGap({
          orgId: args.orgId,
          readerScopes: [draftReadScope, approveScope],
          taintScopes: unionTaint,
        })) !== null
    }
  }

  // 5. Privileged lock + schema validation + diff + UPDATE.
  const validate = compileToolSchema(tool)
  // 4c. Invariant K: a draft sealed to its mailbox never takes plaintext. Its
  //     edited content is sealed again here, before the row lock (sealing reads
  //     the mailbox and its key on connections of its own), and the locked
  //     update below stores that plan only if the row did not move meanwhile.
  const rowPayload = normalizeApprovalPayload(row.current_payload) as Record<string, unknown>
  const sealedPlan = isSealedMailApprovalPayload(rowPayload)
    ? await planSealedMailEdit({
        orgId: args.orgId,
        appName,
        toolShortName,
        requestId: row.id,
        payload: rowPayload,
        fields: args.fields,
        editableFields,
      })
    : null
  const result = await withPrivilegedDb(args.orgId, "approval-edit", async (tx) => {
    const locked = extractRows<
      {
        id: string
        thread_id: string
        current_payload: unknown
        status: string
        metadata: {
          minApprovers?: number
          approvedBy?: string[]
          taintAudienceMustHold?: unknown
        } | null
      } & TaintNarrowRow
    >(
      await tx.execute(drizzleSql`
        SELECT id, thread_id, current_payload, status, metadata, tool_name, requested_by,
               notify_user_ids, resource_owner_id, approve_scope, dimension_constraint
        FROM ${K}.approval_requests WHERE id = ${row.id} FOR UPDATE
      `),
    )[0]
    if (!locked || (locked.status !== "pending" && locked.status !== "deferred")) {
      throw new UpdatePayloadError(409, "stale_status", "stale_status", {
        currentStatus: locked?.status ?? "missing",
      })
    }

    const currentPayload = normalizeApprovalPayload(locked.current_payload)
    if (sealedPlan) {
      // The plan was sealed against the payload read before the lock. Another
      // edit landing in between would be silently overwritten by it.
      if (!deepEq(currentPayload, rowPayload)) {
        throw new UpdatePayloadError(409, "stale_status", "stale_status", {
          currentStatus: "edited_concurrently",
        })
      }
    }

    // Edit keys may be dot-paths (e.g. `customerEmail.body`) targeting a value
    // nested inside the payload. A shallow `{ ...current, ...fields }` (or a
    // JSONB `||` merge) would instead add a literal top-level key named
    // `"customerEmail.body"` and leave the real nested value untouched, so the
    // executed handler would still read the original agent content. Expand each
    // edit key into a nested patch and deep-merge it onto a clone of the current
    // payload, then validate and persist the fully-merged object.
    let merged = structuredClone(currentPayload)
    let diff: Array<{ field: string; from: unknown; to: unknown }> = []
    if (sealedPlan) {
      merged = sealedPlan.payload
      diff = sealedPlan.diff
    } else {
      for (const [k, to] of Object.entries(args.fields)) {
        const from = readDotPath(merged, k)
        if (deepEq(from, to)) continue
        diff.push({ field: k, from, to })
        setDotPath(merged, k, to)
      }
    }

    if (diff.length === 0) {
      return {
        id: locked.id,
        currentPayload,
        payloadHash: approvalPayloadHash(row.tool_name, currentPayload),
        lastEdit: null,
        mustHold: [] as string[],
      }
    }

    if (!sealedPlan) {
      // Blank the DERIVED payload keys of every edited field (editable-field
      // `invalidates` contract). The agent drafts both `textBody` and a
      // pre-rendered `htmlBody`; only `textBody` is editable, and email clients
      // render the HTML part — so without this, an edited draft still SENDS the
      // stale pre-edit htmlBody (approved one message, customer received the
      // other). Blanking (not deleting) keeps the schema's string type satisfied;
      // the send paths treat an empty htmlBody as absent and re-render from the
      // edited textBody.
      const invalidated = new Set<string>()
      for (const d of diff) {
        const declared = editableFields.find(
          (f) =>
            f.field === d.field ||
            d.field.startsWith(`${f.field}.`) ||
            f.field.startsWith(`${d.field}.`),
        )
        for (const key of declared?.invalidates ?? []) {
          if (invalidated.has(key)) continue
          const from = readDotPath(merged, key)
          if (from === undefined || from === "") continue
          invalidated.add(key)
          setDotPath(merged, key, typeof from === "string" ? "" : null)
          diff.push({ field: key, from, to: typeof from === "string" ? "" : null })
        }
      }
    }

    // Validate the fully-merged nested object (not just the inbound fields) so a
    // dot-path edit that produces an invalid combined payload is rejected.
    if (validate && !validate(sealedPlan ? sealedPlan.validationView : merged)) {
      throw new UpdatePayloadError(400, "invalid_edit", "invalid_edit", {
        errors: validate.errors,
      })
    }

    // N-eyes: a sign-off applies to the CONTENT the approver reviewed. Editing
    // the payload after a partial approval (minApprovers >= 2, first approver
    // recorded, row still pending) would otherwise let the edited content
    // execute carrying a sign-off given to the pre-edit version — so any
    // payload change resets the recorded distinct-approver set and every
    // approver must re-review the edited content.
    const priorApprovals = Array.isArray(locked.metadata?.approvedBy)
      ? locked.metadata.approvedBy.length
      : 0
    // Rule 8g: restaged in place, never a second approval. The row is narrowed to holders of
    // the union of its demand and this turn's taint, or the edit is refused.
    const narrowing = await narrowPendingApprovalForTaint(tx, args.orgId, locked, turnTaint)
    if (!narrowing.ok) {
      throw new UpdatePayloadError(403, "E_SCOPE_TAINT_BLOCKED", narrowing.message)
    }
    const taintSet =
      turnTaint.length > 0
        ? drizzleSql`, notify_user_ids = ${`{${narrowing.notifyUserIds.join(",")}}`}::uuid[], metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ taintAudienceMustHold: narrowing.mustHold, ...(disclosedToReaders ? { taintDisclosedToReaders: true } : {}) })}::jsonb, ${proposingTurnScopesUnionSql(turnTaint)}`
        : drizzleSql``
    const updated = await lockedUpdateApproval<{ current_payload: unknown }>(tx, {
      requestId: locked.id,
      from: ["pending", "deferred"],
      set:
        priorApprovals > 0
          ? drizzleSql`current_payload = ${JSON.stringify(merged)}::jsonb, metadata = metadata - 'approvedBy'${taintSet}`
          : drizzleSql`current_payload = ${JSON.stringify(merged)}::jsonb${taintSet}`,
      returning: drizzleSql`current_payload`,
    })
    if (!updated) {
      throw new UpdatePayloadError(409, "stale_status", "stale_status", {
        currentStatus: "decided_during_edit",
      })
    }

    const fieldList = diff.map((d) => d.field).join(", ")
    const editMetadata = { type: "payload-edit", diff, editorUserId: args.actor.userId }
    const editContent =
      priorApprovals > 0
        ? `Edited ${fieldList}, see diff. ${priorApprovals} prior sign-off${priorApprovals === 1 ? "" : "s"} reset: approvers must re-review the edited content.`
        : `Edited ${fieldList}, see diff.`
    // The diff quotes the payload before and after: it is stamped with everything the row
    // demands of its readers, never posted unscoped (rule 8g).
    let message = await sendMessage(tx as unknown as Parameters<typeof sendMessage>[0], {
      requiredScopes: narrowing.mustHold,
      orgId: args.orgId,
      userId: args.actor.userId,
      threadId: locked.thread_id,
      content: editContent,
      authorType: "system",
      agentId: args.actingAgentId,
      metadata: editMetadata,
    })
    if (!message) {
      // The editor is NOT a participant of the requester's private agent thread.
      // `sendMessage` refuses a post by a non-participant, so author the audit note
      // as the REQUESTER instead (always a participant of their own thread). The
      // displayed editor is unchanged because `metadata.editorUserId` (and the
      // card's `lastEdit`) still point at the real editor; only the system
      // message's author row differs.
      //
      // This used to be gated on `sharedSurface`, i.e. ticket/mail reply drafts
      // only. But authorization (above) already admits any editor in the approval's
      // notify-set, and that set routinely contains approvers who were never added
      // to the requester's thread — so on every OTHER kind of approval the editor
      // passed authorization and then hit a bare 403 from the audit write. Live
      // case: five `projects:create` approvals raised by one teammate's agent with
      // an invalid priority, which the approver could see, could not fix, and could
      // not approve. Failing the edit does not protect the thread — the editor is
      // authorized either way — it just makes the approval unrepairable by anyone
      // but its requester.
      message = await sendMessage(tx as unknown as Parameters<typeof sendMessage>[0], {
        requiredScopes: narrowing.mustHold,
        orgId: args.orgId,
        userId: row.requested_by,
        threadId: locked.thread_id,
        content: editContent,
        authorType: "system",
        agentId: args.actingAgentId,
        metadata: editMetadata,
      })
    }
    if (!message)
      // sendMessage returns null only when the editing actor is not a participant of the approval's
      // surface thread (the thread RLS rejects the post). Surface the REAL cause instead of a bare
      // "forbidden" — an editor who passed field-level authorization (notify-set + `<app>:approve`)
      // can still hit this if they were never added as a thread participant, which is otherwise
      // invisible and very hard to diagnose (see the conventions error-observability rule).
      throw new UpdatePayloadError(
        403,
        "forbidden",
        "cannot record the edit: you are not a participant of this approval's thread",
        { threadId: locked.thread_id },
      )
    const lastEdit = {
      editorUserId: args.actor.userId,
      at: new Date(message.createdAt).toISOString(),
      diff,
    }

    const eventData = await loadApprovalSummary(tx, args.orgId, locked.id, lastEdit)
    await tx.queueEvent({
      app: "kernel",
      entity: "approval_request",
      action: "update",
      entityId: locked.id,
      orgId: args.orgId,
      actorId: args.actor.userId,
      actorType: "user",
      // A11: see `UpdatePayloadArgs.actingAgentId` -- the agent when an agent
      // edits, a positive null when a person does.
      agentId: args.actingAgentId,
      data: eventData,
    })

    const nextPayload = normalizeApprovalPayload(updated.current_payload)
    return {
      id: locked.id,
      currentPayload: nextPayload,
      payloadHash: approvalPayloadHash(row.tool_name, nextPayload),
      lastEdit,
      mustHold: narrowing.mustHold,
    }
  })
  const { mustHold, ...unsealedResult } = result
  const publicResult: UpdatePayloadResult =
    sealedPlan && unsealedResult.lastEdit
      ? {
          ...unsealedResult,
          sealedEdit: {
            resealedFields: sealedPlan.resealedFields,
            note:
              sealedPlan.resealedFields.length > 0
                ? `This draft is end-to-end encrypted to its mailbox. The edited ${sealedPlan.resealedFields.join(", ")} was encrypted again and replaces the previous text: the approval card shows it and approving sends it. Only ciphertext is stored, so the payload above carries no readable body.`
                : "This draft is end-to-end encrypted to its mailbox. Its body is unchanged and stays encrypted; only the fields listed in the diff changed.",
          },
        }
      : unsealedResult
  if (publicResult.lastEdit) {
    // Rule 8e: the rebuilt card keeps saying why it waits, now over the union.
    const disclosureLine =
      disclosedToReaders && mustHold.length > 0
        ? taintDisclosureLine(
            mustHold,
            taintSurfaceLabelForTool(args.orgId, row.tool_name, tool?.writesToTable),
          )
        : null
    await refreshSummaryAfterEdit(
      args,
      row,
      publicResult.currentPayload,
      publicResult.lastEdit,
      disclosureLine,
    )
  }
  return publicResult
}

/**
 * The card's headline lines (recipient, amount, subject) come from the summary written when the
 * request was made. After an edit they would describe the old payload while the new one runs, so
 * the summary is rebuilt from the edited payload, under the requester's own access exactly as at
 * propose time, and the card is told. Skipped when the payload moved on again in between (that
 * edit rebuilds its own). Never fails the edit, which is already committed: a summarizer that
 * cannot run falls back to the generic summary of the payload.
 */
async function refreshSummaryAfterEdit(
  args: UpdatePayloadArgs,
  row: ApprovalEditRow,
  payload: Record<string, unknown>,
  lastEdit: NonNullable<UpdatePayloadResult["lastEdit"]>,
  disclosureLine: string | null,
): Promise<void> {
  try {
    const { appName, toolShortName } = splitToolName(row.tool_name)
    const requester = await loadRequesterContext(
      args.orgId,
      row.requested_by,
      "approval-edit-summary-requester",
    )
    const generated = await withRlsContext(requester, (tx) =>
      generateApprovalSummary(
        args.orgId,
        appName,
        toolShortName,
        payload,
        { tx, orgId: args.orgId, userId: row.requested_by, actor: requester },
        row.tool_name,
      ),
    )
    // A sequenced step's payload still cites earlier steps with @ref tokens:
    // the rebuilt summary reads them as those steps, as at propose time.
    const readable = await humanizeStepSummary(args.orgId, row.requested_by, payload, generated)
    const summary = disclosureLine
      ? { ...readable, lines: [...readable.lines.slice(0, 7), disclosureLine] }
      : readable
    await withPrivilegedDb(args.orgId, "approval-edit-summary", async (tx) => {
      const refreshed = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          UPDATE ${K}.approval_requests SET summary = ${JSON.stringify(summary)}::jsonb
          WHERE id = ${row.id} AND org_id = ${args.orgId}::uuid
            AND status IN ('pending', 'deferred')
            AND current_payload = ${JSON.stringify(payload)}::jsonb
          RETURNING id`),
      )
      if (refreshed.length === 0) return
      await tx.queueEvent({
        app: "kernel",
        entity: "approval_request",
        action: "update",
        entityId: row.id,
        orgId: args.orgId,
        actorId: args.actor.userId,
        actorType: "user",
        agentId: args.actingAgentId,
        data: await loadApprovalSummary(tx, args.orgId, row.id, lastEdit),
      })
    })
  } catch (err) {
    log.error(
      { err, approvalId: row.id, toolName: row.tool_name },
      "approval summary could not be rebuilt after an edit",
    )
  }
}

/**
 * Invariant K for an edit of a sealed mail draft. Envelope fields (to, cc) merge
 * as on any approval. Content fields are never merged as plaintext: they are
 * sealed again by `resealMailApprovalEdit` (the staging seal, bound to this
 * request id), and the diff records only that they changed. A content edit
 * that cannot be sealed is refused, never stored in the clear.
 */
async function planSealedMailEdit(input: {
  orgId: string
  appName: string
  toolShortName: string
  requestId: string
  payload: Record<string, unknown>
  fields: Record<string, unknown>
  editableFields: ReadonlyArray<{ field: string; invalidates?: string[] }>
}): Promise<{
  payload: Record<string, unknown>
  diff: Array<{ field: string; from: unknown; to: unknown }>
  validationView: Record<string, unknown>
  resealedFields: string[]
}> {
  const merged = structuredClone(input.payload)
  // A row that carries a stray plaintext content key next to its ciphertext
  // (written by an edit before this path existed) loses it here: the stored
  // draft is only ever the sealed one.
  for (const key of MAIL_APPROVAL_CONTENT_KEYS) delete merged[key]
  const diff: Array<{ field: string; from: unknown; to: unknown }> = []
  const contentEdits: Record<string, unknown> = {}
  for (const [k, to] of Object.entries(input.fields)) {
    const top = k.split(".")[0] ?? k
    if (MAIL_APPROVAL_SEAL_ENVELOPE_KEYS.has(top)) {
      throw new UpdatePayloadError(
        400,
        "invalid_edit",
        `field '${k}' is part of this draft's encryption and cannot be edited`,
      )
    }
    if (MAIL_APPROVAL_CONTENT_KEYS.has(top)) {
      if (top !== k) {
        throw new UpdatePayloadError(400, "invalid_edit", `field '${k}' is not a valid field path`)
      }
      contentEdits[k] = to
      continue
    }
    const from = readDotPath(merged, k)
    if (deepEq(from, to)) continue
    diff.push({ field: k, from, to })
    setDotPath(merged, k, to)
  }

  if (Object.keys(contentEdits).length === 0) {
    if (diff.length > 0) merged.recipientCount = sealedMailRecipientCount(merged)
    return {
      payload: merged,
      diff,
      validationView: sealedMailValidationView(merged),
      resealedFields: [],
    }
  }

  const invalidated = new Set<string>()
  for (const field of Object.keys(contentEdits)) {
    const declared = input.editableFields.find((f) => f.field === field)
    for (const key of declared?.invalidates ?? []) invalidated.add(key)
  }
  try {
    const resealed = await resealMailApprovalEdit({
      orgId: input.orgId,
      appName: input.appName,
      toolShortName: input.toolShortName,
      approvalRequestId: input.requestId,
      payload: merged,
      contentEdits,
      invalidated: [...invalidated],
      editableFields: input.editableFields.map((f) => f.field),
    })
    return {
      payload: resealed.payload,
      diff: [...diff, ...resealed.diff],
      validationView: resealed.plaintextView,
      resealedFields: resealed.diff.filter((d) => d.to !== null).map((d) => d.field),
    }
  } catch (err) {
    if (err instanceof SealedMailEditRefusal) {
      throw new UpdatePayloadError(409, "sealed_draft_not_editable", err.message)
    }
    throw err
  }
}

async function loadHiddenApprovalForAuthCheck(
  orgId: string,
  requestId: string,
): Promise<Pick<
  ApprovalEditRow,
  "tool_name" | "approve_scope" | "notify_user_ids" | "requested_by" | "resource_owner_id"
> | null> {
  return await withPrivilegedDb(orgId, "approval-edit-hidden-auth-check", async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT tool_name, approve_scope, notify_user_ids, requested_by, resource_owner_id
      FROM ${K}.approval_requests
      WHERE id = ${requestId} AND org_id = ${orgId}::uuid
      LIMIT 1
    `)
    return (
      extractRows<
        Pick<
          ApprovalEditRow,
          "tool_name" | "approve_scope" | "notify_user_ids" | "requested_by" | "resource_owner_id"
        >
      >(result)[0] ?? null
    )
  })
}

function compileToolSchema(
  tool: ReturnType<typeof toolRegistry.get> | undefined,
): ValidateFunction | null {
  if (!tool || !isManifestHandler(tool.handler)) return null
  if (!tool.params || typeof tool.params !== "object" || !("type" in tool.params)) return null
  return paramValidator(tool.params as unknown as SchemaObject)
}

/**
 * The top-level parameter names a tool's schema declares (JSON Schema
 * `properties`, or a Zod object's `shape`), or null when the tool is not
 * registered or its schema does not enumerate them.
 */
function toolParamNames(tool: ReturnType<typeof toolRegistry.get> | undefined): Set<string> | null {
  const params = tool?.params as
    | { properties?: unknown; shape?: unknown; safeParse?: unknown }
    | undefined
  if (!params || typeof params !== "object") return null
  if ("type" in params && params.properties && typeof params.properties === "object") {
    return new Set(Object.keys(params.properties))
  }
  if (typeof params.safeParse === "function" && params.shape && typeof params.shape === "object") {
    return new Set(Object.keys(params.shape))
  }
  return null
}

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Reads a dot-path value out of a nested object; `undefined` if any segment is absent. */
function readDotPath(obj: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === "object" && Object.hasOwn(acc, key)
          ? (acc as Record<string, unknown>)[key]
          : undefined,
      obj,
    )
}

/**
 * Writes `value` at a dot-path inside `obj`, creating intermediate objects as
 * needed. A single-segment path sets a top-level key (the legacy text/richtext
 * case); multi-segment paths set the nested value the editable-field contract
 * actually targets.
 */
function setDotPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".")
  if (segments.some(isUnsafePathSegment)) throw new Error(`unsafe field path '${path}'`)
  let cursor: Record<string, unknown> = obj
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]
    const next = Object.hasOwn(cursor, key) ? cursor[key] : undefined
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cursor[key] = {}
    }
    cursor = cursor[key] as Record<string, unknown>
  }
  cursor[segments[segments.length - 1]] = value
}
