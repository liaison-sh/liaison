// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 B1 — app-callable kernel.messages.post.
//
// Bundled apps that declare the `messages.post` capability call this through
// the RPC bridge (`ctx.messages.post(...)`). The function is a thin wrapper
// over the existing `sendMessage` primitive that:
//
//   * normalises the find-or-create-thread step (`contact_id` resolves via
//     `getOrCreateContactPrimaryThread`),
//   * enforces a 64 KB body cap,
//   * validates attachments are readable under the calling RLS context, and
//   * stamps `origin_app_id` / `origin_kind` into the message metadata so the
//     read path can attribute the post to its source app.
//
// The function takes the human/agent invoker's userId as `authorUserId`; the
// stored message has `authorType='system'` so the UI surfaces "Liaison · via
// invoicing" rather than impersonating the user.

import { and, eq, inArray } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { files } from "~/db/schema/kernel/files"
import { threads } from "~/db/schema/kernel/threads"
import { attachFilesToParent } from "~/modules/files/attach"
import { withoutSeededFlag } from "~/modules/notifications/seeded"
import { getOrCreateContactPrimaryThread } from "~/modules/threads/contact-primary"
import { publishMessageAttachments, sendMessage } from "~/modules/threads/message"

const MAX_BODY_BYTES = 64 * 1024

function err(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string }
  e.code = code
  return e
}

export interface PostAppMessageParams {
  orgId: string
  /** Capability-checked at the RPC bridge — passed through for metadata. */
  callingAppId: string
  /** The invoking user (real user or agent). Becomes `author_id`. */
  authorUserId: string
  thread_id?: string
  contact_id?: string
  body: string
  attachment_file_ids?: string[]
  metadata?: Record<string, unknown>
  /**
   * What the calling turn had read when the app tool posted, since the body may
   * quote it. `[]` only when no turn called the tool (a direct invocation).
   */
  requiredScopes: string[]
  /**
   * The agent acting in the turn whose app tool posted this. The sandbox bridge
   * callback has lost that turn's frame, so it comes from the frame captured
   * while the frame was still live; `null` when no turn called the tool.
   */
  agentId?: string | null
}

export interface PostAppMessageResult {
  message_id: string
  thread_id: string
}

export async function postAppMessage(
  db: RlsClient,
  p: PostAppMessageParams,
): Promise<PostAppMessageResult> {
  const hasThread = typeof p.thread_id === "string" && p.thread_id.length > 0
  const hasContact = typeof p.contact_id === "string" && p.contact_id.length > 0
  if (hasThread === hasContact) {
    throw err("bad_request", "exactly one of thread_id or contact_id must be set")
  }
  if (Buffer.byteLength(p.body, "utf8") > MAX_BODY_BYTES) {
    throw err("body_too_large", `body exceeds ${MAX_BODY_BYTES} bytes`)
  }

  let threadId: string
  if (hasThread) {
    const t = await db
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.id, p.thread_id as string), eq(threads.orgId, p.orgId)))
      .limit(1)
    if (t.length === 0) throw err("thread_not_found", `thread ${p.thread_id} not found`)
    threadId = t[0].id
  } else {
    const { id } = await getOrCreateContactPrimaryThread(
      p.orgId,
      p.contact_id as string,
      p.authorUserId,
    )
    threadId = id
  }

  if (p.attachment_file_ids && p.attachment_file_ids.length > 0) {
    await assertAttachmentsReadable(db, p.attachment_file_ids, p.orgId, p.callingAppId)
  }

  const result = await sendMessage(db, {
    requiredScopes: p.requiredScopes,
    orgId: p.orgId,
    userId: p.authorUserId,
    threadId,
    content: p.body,
    authorType: "system",
    // Authored as the system, and the agent is still named: the audit identity
    // is independent of the actor type (A11).
    agentId: p.agentId ?? null,
    metadata: {
      // An app cannot mark its post as seeded (notifications/seeded.ts).
      ...withoutSeededFlag(p.metadata),
      origin_app_id: p.callingAppId,
      origin_kind: "app_post",
      attachment_file_ids: p.attachment_file_ids ?? [],
    },
  })
  if (!result) throw err("forbidden", "calling user is not a participant of the target thread")

  // Materialise the referenced files as real message attachments so the
  // thread read-path (`listMessages`, which reads files parented to
  // `kernel:message`) surfaces them — the `messages.post` capability +
  // `assertAttachmentsReadable` above are the authorization; the attach runs
  // on the post author's behalf (a thread participant), so `kernel:threads:write`
  // is the operative parent scope. `attachFilesToParent` copies the source
  // file (idempotent via `copied_from_id`); the original id stays referenced in
  // `metadata.attachment_file_ids` for provenance.
  if (p.attachment_file_ids && p.attachment_file_ids.length > 0) {
    await attachFilesToParent(
      {
        sourceFileIds: p.attachment_file_ids,
        target: { app: "kernel", entityType: "message", entityId: result.id },
      },
      {
        rlsTx: db,
        privileged: (reason, fn) => withPrivilegedDb(p.orgId, reason, fn),
        orgId: p.orgId,
        userId: p.authorUserId,
        actorType: "system",
        scopes: ["kernel:threads:write"],
      },
    )
    // The create event went out before the files were attached, so this
    // update is how everyone already in the thread sees them without a reload.
    await publishMessageAttachments(db, {
      orgId: p.orgId,
      userId: p.authorUserId,
      threadId,
      messageId: result.id,
    })
  }

  return { message_id: result.id, thread_id: threadId }
}

/**
 * Attachment-ownership check. The K1 spec says an attached file must be
 * "readable by caller" — meaning the calling app must own the file (its
 * `kernel.files.app` matches), not merely have org-wide RLS visibility. This
 * prevents an app with the `messages.post` capability from attaching files
 * owned by other apps that share org-RLS visibility (Phase 17 fix S2).
 *
 * Files owned by the kernel (`app = 'kernel'`) are still attachable — they
 * are the host-rendered artifacts (e.g. K2-rendered PDFs stored under the
 * Documents app's identity via the kernel files module). The match is on
 * the file's `app` column equal to the calling app's identity or the
 * shared `kernel` namespace.
 */
async function assertAttachmentsReadable(
  db: RlsClient,
  fileIds: string[],
  orgId: string,
  callingAppId: string,
): Promise<void> {
  const rows = await db
    .select({ id: files.id, app: files.app })
    .from(files)
    .where(and(inArray(files.id, fileIds), eq(files.orgId, orgId)))
  const seen = new Map(rows.map((r) => [r.id, r.app]))
  for (const id of fileIds) {
    const ownerApp = seen.get(id)
    if (ownerApp === undefined) {
      throw err("attachment_unreadable", `file ${id} not readable by ${callingAppId}`)
    }
    if (ownerApp !== callingAppId && ownerApp !== "kernel") {
      throw err(
        "attachment_unreadable",
        `file ${id} owned by app '${ownerApp}', not by calling app '${callingAppId}'`,
      )
    }
  }
}
