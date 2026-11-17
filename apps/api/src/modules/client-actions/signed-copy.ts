// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Knowledge copy of a signed record, written as the person who sent it for signature.
//
// A record's signature is decided by a client and recorded by the target app's decided
// handler, which runs as the app's system identity: it holds no person, and Knowledge rightly
// refuses a system run (it checks the writer's own scopes and sensitivity grants, writes the
// writer as the document's creator, and its row rules show a closed document to named people
// only). So the copy is written, and read back, under the row-security context of the person
// who sent the record for signature (the member whose send minted its first client action),
// through Knowledge's normal tool and checks, as the app's declared ingestion call. No system
// context gains anything: the write is exactly what that person could write themselves.
//
// Who the sender is comes from the kernel's own client action rows, never from the app: the
// app names its target, and only a target of that app with a decided action has a sender.
// No copy is written (and the caller says so, then tries again later) when the sender is no
// longer an active member, or no longer holds the Knowledge write scope.
//
// The same path carries the other consequences of a decided record: a call the app declares in
// its `cross_app_calls` (a change request's task, its time plan) runs as that same sender, with
// their live permissions and nothing more (`callAsSender`). A decided handler never gains a
// wider system identity for it.

import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { CROSS_APP_INGESTIONS } from "~/modules/apps/cross-app-ingestions"
import { liveActor } from "~/modules/imports/authority"
import { hasScope } from "~/modules/permissions/permissions"

const K = () => sql.raw(schemaRef("kernel"))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CREATE_TOOL = "knowledge:create"
const ARCHIVE_TOOL = "knowledge:archive"
const WRITE_SCOPE = "knowledge:documents:create"
const ARCHIVE_SCOPE = "knowledge:documents:archive"

export type SignedCopyRefusal =
  | "NOT_AN_INGESTION"
  | "NOT_SIGNED"
  | "SENDER_INACTIVE"
  | "SENDER_CANNOT_WRITE_KNOWLEDGE"
  | "SENDER_NOT_ON_LIST"
  | "COPY_FAILED"

export type SignedCopyOutcome =
  | { status: "created"; documentId: string; senderUserId: string; archived: string[] }
  | { status: "not_made"; code: SignedCopyRefusal; message: string }

/**
 * The member who sent the target for signature: the creator of its first decided client
 * action, in this org, of this app. Null when the target has no decided action of the app.
 */
export async function senderOfSignedTarget(args: {
  orgId: string
  targetApp: string
  targetType: string
  targetId: string
}): Promise<string | null> {
  if (!UUID.test(args.targetId)) return null
  const rows = await withPrivilegedDb(args.orgId, "signed-copy-sender", async (tx) =>
    extractRows<{ created_by_user_id: string | null }>(
      await tx.execute(sql`
        SELECT a.created_by_user_id FROM ${K()}.client_actions a
         WHERE a.org_id = ${args.orgId}::uuid AND a.target_app = ${args.targetApp}
           AND a.target_type = ${args.targetType} AND a.target_id = ${args.targetId}::uuid
           AND a.created_by_user_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM ${K()}.client_actions d
              WHERE d.org_id = a.org_id AND d.target_app = a.target_app
                AND d.target_type = a.target_type AND d.target_id = a.target_id
                AND d.decision IN ('signed', 'accepted', 'approved'))
         ORDER BY a.created_at ASC, a.id ASC
         LIMIT 1`),
    ),
  )
  return rows[0]?.created_by_user_id ?? null
}

type Envelope = { data?: unknown; blocked?: unknown; error?: { code: string; message: string } }

/**
 * Write the Knowledge copy of one signed target as its sender, read it back under the
 * sender's row security, and archive the copies it supersedes (`archiveIds`, documents the
 * same ingestion wrote earlier). `create` is the `knowledge:create` params the app built.
 */
export async function writeSignedCopyAsSender(args: {
  orgId: string
  appName: string
  targetType: string
  targetId: string
  create: Record<string, unknown>
  archiveIds?: string[]
  /** A restricted record: its list. The writer reads its own document, so a sender off the
   *  list gets no copy written (the copy's readers are exactly the list). */
  readersOnly?: string[]
}): Promise<SignedCopyOutcome> {
  const paths = CROSS_APP_INGESTIONS[args.appName] ?? []
  if (!paths.includes(CREATE_TOOL))
    return {
      status: "not_made",
      code: "NOT_AN_INGESTION",
      message: `${args.appName} has no Knowledge ingestion. No copy was written.`,
    }
  const sender = await senderOfSignedTarget({
    orgId: args.orgId,
    targetApp: args.appName,
    targetType: args.targetType,
    targetId: args.targetId,
  })
  if (!sender)
    return {
      status: "not_made",
      code: "NOT_SIGNED",
      message: "Nobody's signature is recorded on this record yet. No copy was written.",
    }
  if (args.readersOnly && !args.readersOnly.includes(sender))
    return {
      status: "not_made",
      code: "SENDER_NOT_ON_LIST",
      message:
        "The person who sent it for signature is not on its list, and the copy's readers must be exactly the list, so the Knowledge copy was not made. It is tried again on the next signed version or the seal retry.",
    }
  const actor = await liveActor(args.orgId, sender)
  if (!actor)
    return {
      status: "not_made",
      code: "SENDER_INACTIVE",
      message:
        "The person who sent it for signature is no longer an active member, so the Knowledge copy was not made. It is tried again on the next signed version or the seal retry.",
    }
  if (!hasScope(WRITE_SCOPE, actor.scopes))
    return {
      status: "not_made",
      code: "SENDER_CANNOT_WRITE_KNOWLEDGE",
      message:
        "The person who sent it for signature can no longer write Knowledge documents, so the Knowledge copy was not made. It is tried again on the next signed version or the seal retry.",
    }

  const { executeToolCore } = await import("~/modules/apps/execute-tool")
  const idempotencyKey =
    typeof args.create.idempotencyKey === "string" ? args.create.idempotencyKey : undefined
  const created = (await executeToolCore({
    toolName: CREATE_TOOL,
    orgId: args.orgId,
    actor,
    params: { ...args.create },
    origin: "system",
    internalCall: { callerApp: args.appName, idempotencyKey },
  } as never)) as Envelope
  const documentId = (created.data as { id?: unknown } | undefined)?.id
  if (created.error || typeof documentId !== "string" || !UUID.test(documentId))
    return {
      status: "not_made",
      code: "COPY_FAILED",
      message: created.error
        ? `Knowledge refused the copy (${created.error.code}: ${created.error.message}). No copy was written.`
        : "Knowledge answered without a document. No copy was written.",
    }

  // Read back as the sender: the copy is theirs to read, under the same row rules as anyone.
  const seen = await withRlsContext(actor, async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(
        sql`SELECT id FROM ${sql.raw(`"${schemaRef("app_knowledge")}"`)}.documents WHERE id = ${documentId}::uuid`,
      ),
    ),
  )
  if (seen.length !== 1)
    return {
      status: "not_made",
      code: "COPY_FAILED",
      message: "The copy was written but its sender cannot read it back. No copy is recorded.",
    }

  // A closed record's copy is read by its list alone: its author (the sender) reads it only
  // while on that list, never as its author. The list follow keeps this in step afterwards.
  if (args.readersOnly) {
    await withPrivilegedDb(args.orgId, "signed-copy:closed-authorship", async (tx) => {
      await tx.execute(
        sql`UPDATE ${sql.raw(`"${schemaRef("app_knowledge")}"`)}.documents SET author_reads = false
             WHERE id = ${documentId}::uuid AND org_id = ${args.orgId}::uuid`,
      )
      await tx.execute(
        sql`SELECT ${K()}.recompute_search_acl('knowledge.document', ${documentId}::uuid, ${args.orgId}::uuid)`,
      )
    })
  }

  const archived: string[] = []
  if (paths.includes(ARCHIVE_TOOL) && hasScope(ARCHIVE_SCOPE, actor.scopes)) {
    for (const id of args.archiveIds ?? []) {
      if (!UUID.test(id) || id === documentId) continue
      const out = (await executeToolCore({
        toolName: ARCHIVE_TOOL,
        orgId: args.orgId,
        actor,
        params: { id },
        origin: "system",
        internalCall: { callerApp: args.appName },
      } as never)) as Envelope
      if (!out.error && !out.blocked) archived.push(id)
    }
  }
  return { status: "created", documentId, senderUserId: sender, archived }
}

export type AsSenderOutcome =
  | { status: "completed"; result: unknown; senderUserId: string }
  | { status: "pending_approval"; approvalId: string | null; senderUserId: string }
  | { status: "error"; code: string; message: string }

/**
 * One call the app declares in its `cross_app_calls`, run as the member who sent the target
 * for signature (or for approval), with that member's live scopes. The caller names the
 * target; the kernel finds the sender itself, so an app cannot pick whose name it acts in.
 * `idempotencyKey` is the step's own reference: a second call with it answers the first.
 */
export async function callAsSender(args: {
  orgId: string
  appName: string
  declaredCalls: readonly string[]
  targetType: string
  targetId: string
  tool: string
  params: Record<string, unknown>
  idempotencyKey?: string
}): Promise<AsSenderOutcome> {
  if (!args.declaredCalls.includes(args.tool) || args.tool.startsWith(`${args.appName}:`))
    return {
      status: "error",
      code: "CALL_NOT_DECLARED",
      message: `${args.appName} declares no call to ${args.tool}. Nothing was done.`,
    }
  const sender = await senderOfSignedTarget({
    orgId: args.orgId,
    targetApp: args.appName,
    targetType: args.targetType,
    targetId: args.targetId,
  })
  if (!sender)
    return {
      status: "error",
      code: "NOT_SIGNED",
      message: "Nobody's decision is recorded on this record yet. Nothing was done.",
    }
  const actor = await liveActor(args.orgId, sender)
  if (!actor)
    return {
      status: "error",
      code: "SENDER_INACTIVE",
      message:
        "The person who sent it is no longer an active member, so nothing was done in their name.",
    }
  const { executeToolCore } = await import("~/modules/apps/execute-tool")
  const env = (await executeToolCore({
    toolName: args.tool,
    orgId: args.orgId,
    actor,
    params: { ...args.params },
    origin: "system",
    internalCall: { callerApp: args.appName, idempotencyKey: args.idempotencyKey },
  } as never)) as Envelope
  if (env.error) return { status: "error", code: env.error.code, message: env.error.message }
  if (env.blocked) {
    const b = env.blocked as { approvalRequestId?: string | null }
    return {
      status: "pending_approval",
      approvalId: b.approvalRequestId ?? null,
      senderUserId: sender,
    }
  }
  return { status: "completed", result: env.data, senderUserId: sender }
}
